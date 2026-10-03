import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { generateGeminiImage, generateText } from "./providers.js";

const app = express();
const port = Number(process.env.PORT || 3030);
const host = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const root = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.LARKY_DATA_FILE || path.join(root, "data.json");
const firstLoginFile =
  process.env.LARKY_CREDENTIAL_FILE || path.join(root, "admin-first-login.txt");
const isProduction = process.env.NODE_ENV === "production";
const sessionDuration = 1000 * 60 * 60 * 24 * 7;
const unbanCode = process.env.LARKY_UNBAN_CODE || "301";
const adminEmails = new Set([
  "leon.batzel@freenet.de",
  "ytcoolcaster3@gmail.com",
]);
const ownerEmail = "leon.batzel@freenet.de";
const availablePermissions = [
  { id: "developerMode", label: "Dev-Modus und Diagnosewerte" },
  { id: "manageUsers", label: "Nutzer, Verifizierung und Moderation" },
  { id: "viewAllChats", label: "Alle Chatverläufe ansehen" },
  { id: "manageSettings", label: "KI-Anbieter und Systemeinstellungen" },
  { id: "manageLockdown", label: "System-Lockdown steuern" },
  { id: "viewAudit", label: "Sicherheitsprotokoll einsehen" },
];
const loginAttempts = new Map();
const unbanAttempts = new Map();
const sessions = new Map();

const defaultSettings = {
  provider: "gemini",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  model: process.env.OLLAMA_MODEL || "llama3.2",
  imageUrl: process.env.IMAGE_API_URL || "http://127.0.0.1:7860",
  defaultImageLimit: 5,
};

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return {
      users: {},
      chats: {},
      settings: defaultSettings,
      lockdown: { enabled: false, reason: "" },
      audit: [],
      imageUsage: {},
    };
  }
}

let store = loadStore();
store.users ??= {};
store.chats ??= {};
store.roles ??= {};
store.settings = { ...defaultSettings, ...store.settings };
store.lockdown ??= { enabled: false, reason: "" };
store.audit ??= [];
store.imageUsage ??= {};

function saveStore() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store), { mode: 0o600 });
  try {
    fs.renameSync(temporaryFile, dataFile);
  } catch (error) {
    if (!["EPERM", "EEXIST"].includes(error.code)) throw error;
    fs.copyFileSync(temporaryFile, dataFile);
    fs.unlinkSync(temporaryFile);
  }
  try {
    fs.chmodSync(dataFile, 0o600);
  } catch {}
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, passwordHash: hash };
}

function passwordMatches(password, account) {
  if (!account?.salt || !account?.passwordHash) return false;
  const candidate = crypto.scryptSync(password, account.salt, 64);
  const saved = Buffer.from(account.passwordHash, "hex");
  return (
    candidate.length === saved.length &&
    crypto.timingSafeEqual(candidate, saved)
  );
}

function addAudit(actor, action, target, details = {}) {
  store.audit.unshift({
    id: crypto.randomUUID(),
    actor,
    action,
    target,
    details,
    createdAt: Date.now(),
  });
  store.audit.length = Math.min(store.audit.length, 500);
}

function publicUser(user) {
  const day = new Date().toISOString().slice(0, 10);
  const usage =
    store.imageUsage[user.id]?.day === day
      ? store.imageUsage[user.id].count
      : 0;
  const restriction = getRestriction(user);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    roleId: user.roleId || null,
    roleName: store.roles[user.roleId]?.name || (user.role === "admin" ? "Administrator" : "Nutzer"),
    permissions: effectivePermissions(user),
    verified: Boolean(user.verified),
    canUseDeveloperMode: effectivePermissions(user).includes("developerMode"),
    imageDailyLimit: user.imageDailyLimit,
    imagesUsedToday: usage,
    createdAt: user.createdAt,
    restriction,
  };
}

function getRestriction(user) {
  const now = Date.now();
  if (user.ban && (!user.ban.until || user.ban.until > now))
    return { type: "ban", ...user.ban };
  if (user.timeout && (!user.timeout.until || user.timeout.until > now))
    return { type: "timeout", ...user.timeout };
  return null;
}

function cookieToken(req) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("larky_session="));
  return cookie
    ? decodeURIComponent(cookie.slice("larky_session=".length))
    : "";
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `larky_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${isProduction ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `larky_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isProduction ? "; Secure" : ""}`,
  );
}

function authenticate(req, res, next) {
  const token = cookieToken(req);
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Bitte melde dich an." });
  }
  const user = store.users[session.userId];
  if (!user) return res.status(401).json({ error: "Konto nicht gefunden." });
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireActive(req, res, next) {
  if (req.user.role !== "admin" && store.lockdown.enabled) {
    return res
      .status(423)
      .json({
        kind: "lockdown",
        reason:
          store.lockdown.reason || "Das System ist vorübergehend gesperrt.",
      });
  }
  const restriction = getRestriction(req.user);
  if (restriction)
    return res.status(403).json({ kind: restriction.type, restriction });
  next();
}

function effectivePermissions(user) {
  if (user.role === "admin" || user.email === ownerEmail)
    return availablePermissions.map((permission) => permission.id);
  const assigned = store.roles[user.roleId]?.permissions || [];
  const permissions = new Set([
    ...(user.canUseDeveloperMode ? ["developerMode"] : []),
    ...assigned,
  ]);
  return [...permissions];
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (store.lockdown.enabled && req.user.role !== "admin")
      return res.status(423).json({ kind: "lockdown", reason: store.lockdown.reason });
    if (effectivePermissions(req.user).includes(permission)) return next();
    return res.status(403).json({ error: "Dir fehlt die Berechtigung für diese Aktion." });
  };
}

function requireOwner(req, res, next) {
  if (req.user.email === ownerEmail) return next();
  return res.status(403).json({ error: "Nur Leon kann Rollen und Systemrechte verwalten." });
}

function rateLimit(map, key, max, windowMs) {
  const now = Date.now();
  const record = map.get(key);
  if (!record || record.resetAt < now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  record.count += 1;
  return record.count <= max;
}

function handleRouteError(res, error, fallback) {
  console.error(error);
  return res
    .status(error?.statusCode || 502)
    .json({ error: error?.statusCode ? error.message : fallback });
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const allowedRemoteHosts = new Set(
    (process.env.LARKY_ALLOWED_AI_HOSTS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    localHost
      ? !["http:", "https:"].includes(url.protocol)
      : url.protocol !== "https:" || !allowedRemoteHosts.has(hostname)
  ) {
    throw new Error(
      "Nutze localhost oder einen per LARKY_ALLOWED_AI_HOSTS freigegebenen HTTPS-Host.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function modeInstruction(mode) {
  if (mode === "rewrite")
    return "Formuliere den Text klar, natürlich und korrekt um. Antworte nur mit der überarbeiteten Fassung.";
  if (mode === "code")
    return "Schreibe sauberen, direkt nutzbaren Code. Erkläre knapp wichtige Entscheidungen.";
  if (mode === "tests")
    return "Erstelle passende automatisierte Tests als Codeentwurf. Nenne Framework-Annahmen. Führe keinen Code aus.";
  return "Du bist Larky, ein hilfreicher Gaming-KI-Assistent. Antworte auf Deutsch, sofern der Nutzer nicht anders schreibt.";
}

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
  }),
);
app.use(express.json({ limit: "12mb" }));

const allowedDevOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  let sameOrigin = false;
  if (origin) {
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {}
  }
  if (origin && !allowedDevOrigins.has(origin) && !sameOrigin)
    return res.status(403).json({ error: "Ungültiger Seitenursprung." });
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", (req, res) => {
  if (store.lockdown.enabled)
    return res
      .status(423)
      .json({
        kind: "lockdown",
        reason: store.lockdown.reason,
        error: "Registrierungen sind im Lockdown gesperrt.",
      });
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body.password || "");
  const displayName = String(req.body.displayName || "")
    .trim()
    .slice(0, 40);
  if (
    !/^\S+@\S+\.\S+$/.test(email) ||
    password.length < 10 ||
    password.length > 256 ||
    !displayName
  ) {
    return res
      .status(400)
      .json({
        error:
          "Name, gültige E-Mail und ein Passwort mit mindestens 10 Zeichen sind erforderlich.",
      });
  }
  if (adminEmails.has(email))
    return res
      .status(409)
      .json({
        error:
          "Dieses Admin-Konto wird lokal eingerichtet und kann nicht registriert werden.",
      });
  if (Object.values(store.users).some((user) => user.email === email))
    return res
      .status(409)
      .json({ error: "Für diese E-Mail gibt es bereits ein Konto." });
  const credentials = passwordHash(password);
  const user = {
    id: crypto.randomUUID(),
    email,
    displayName,
    role: "user",
    verified: false,
    imageDailyLimit: store.settings.defaultImageLimit,
    ...credentials,
    createdAt: Date.now(),
    ban: null,
    timeout: null,
  };
  store.users[user.id] = user;
  addAudit("system", "account-created", email);
  saveStore();
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + sessionDuration,
  });
  setSessionCookie(res, token);
  res.status(201).json({ user: publicUser(user), lockdown: store.lockdown });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body.password || "");
  if (password.length > 256)
    return res
      .status(400)
      .json({ error: "E-Mail oder Passwort ist nicht korrekt." });
  const key = `${req.ip}:${email}`;
  if (!rateLimit(loginAttempts, key, 10, 15 * 60 * 1000))
    return res
      .status(429)
      .json({
        error: "Zu viele Anmeldeversuche. Bitte später erneut versuchen.",
      });
  const user = Object.values(store.users).find((item) => item.email === email);
  if (!user || !passwordMatches(password, user))
    return res
      .status(401)
      .json({ error: "E-Mail oder Passwort ist nicht korrekt." });
  const restriction = getRestriction(user);
  if (restriction)
    return res
      .status(403)
      .json({
        kind: restriction.type,
        restriction,
        error:
          restriction.type === "ban"
            ? "Dieses Konto ist gesperrt."
            : "Dieses Konto ist vorübergehend pausiert.",
      });
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + sessionDuration,
  });
  setSessionCookie(res, token);
  addAudit(user.email, "login", user.email);
  saveStore();
  res.json({ user: publicUser(user), lockdown: store.lockdown });
});

app.post("/api/auth/logout", authenticate, (req, res) => {
  sessions.delete(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/unban", (req, res) => {
  if (store.lockdown.enabled)
    return res
      .status(423)
      .json({
        kind: "lockdown",
        reason: store.lockdown.reason,
        error: "Entsperrungen sind im Lockdown gesperrt.",
      });
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const code = String(req.body.code || "");
  const key = `${req.ip}:${email}`;
  if (!rateLimit(unbanAttempts, key, 5, 15 * 60 * 1000))
    return res
      .status(429)
      .json({ error: "Zu viele Versuche. Bitte später erneut versuchen." });
  const user = Object.values(store.users).find((item) => item.email === email);
  const codeBuffer = Buffer.from(code);
  const expectedBuffer = Buffer.from(unbanCode);
  const matches =
    codeBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(codeBuffer, expectedBuffer);
  if (!user?.ban || !matches)
    return res
      .status(400)
      .json({ error: "E-Mail oder Entsperrcode ist nicht korrekt." });
  user.ban = null;
  addAudit("break-glass-code", "ban-lifted", user.email, {
    reason: "Entsperrcode verwendet",
  });
  saveStore();
  res.json({
    ok: true,
    message: "Die Kontosperre wurde aufgehoben. Du kannst dich jetzt anmelden.",
  });
});

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({ user: publicUser(req.user), lockdown: store.lockdown });
});

app.get("/api/config", authenticate, requireActive, (_req, res) =>
  res.json({ settings: store.settings, geminiConfigured: Boolean(process.env.GEMINI_API_KEY) }),
);

app.get("/api/chats", authenticate, requireActive, (req, res) => {
  const chats = Object.values(store.chats)
    .filter((chat) => chat.userId === req.user.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ conversations: chats });
});

app.delete("/api/chats/:id", authenticate, requireActive, (req, res) => {
  const chat = store.chats[req.params.id];
  if (!chat || (chat.userId !== req.user.id && req.user.role !== "admin"))
    return res.status(404).json({ error: "Chat nicht gefunden." });
  delete store.chats[chat.id];
  saveStore();
  res.json({ ok: true });
});

app.post("/api/chat", authenticate, requireActive, async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  const mode = String(req.body.mode || "chat");
  if (!prompt || prompt.length > 12000)
    return res
      .status(400)
      .json({ error: "Die Nachricht fehlt oder ist zu lang." });
  try {
    const providerSettings = {
      ...store.settings,
      ...(store.settings.provider === "ollama"
        ? { ollamaUrl: normalizeBaseUrl(store.settings.ollamaUrl) }
        : {}),
    };
    const chatId = String(req.body.conversationId || crypto.randomUUID());
    let chat = store.chats[chatId];
    if (chat && chat.userId !== req.user.id && req.user.role !== "admin")
      return res
        .status(403)
        .json({ error: "Dieser Chat gehört einem anderen Konto." });
    chat ??= {
      id: chatId,
      userId: req.user.id,
      userEmail: req.user.email,
      title: prompt.slice(0, 52),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const history = chat.messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-30);
    const result = await generateText(providerSettings, {
      systemPrompt: modeInstruction(mode),
      messages: [
        ...history.map(({ role, content }) => ({ role, content })),
        { role: "user", content: prompt },
      ],
    });
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: Date.now(),
    };
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: result.content || "Das Modell hat keine Antwort geliefert.",
      createdAt: Date.now(),
    };
    chat.messages.push(userMessage, assistantMessage);
    chat.updatedAt = Date.now();
    store.chats[chatId] = chat;
    saveStore();
    res.json({ conversation: chat, answer: assistantMessage });
  } catch (error) {
    handleRouteError(
      res,
      error,
      "Lokales Modell nicht erreichbar. Prüfe Ollama und seine URL im Admin-Bereich.",
    );
  }
});

app.post("/api/dev/chat", authenticate, requireActive, async (req, res) => {
  if (!effectivePermissions(req.user).includes("developerMode")) {
    return res
      .status(403)
      .json({ error: "Der Admin muss dir den Dev-Modus freigeben." });
  }
  const prompt = String(req.body.prompt || "").trim();
  const developerOptions = req.body.options || {};
  const temperature = Number(developerOptions.temperature ?? 0.7);
  const topP = Number(developerOptions.topP ?? 0.9);
  const contextLength = Number(developerOptions.contextLength ?? 4096);
  const systemPrompt = String(developerOptions.systemPrompt || "").slice(
    0,
    4000,
  );
  if (!prompt || prompt.length > 12000)
    return res
      .status(400)
      .json({ error: "Die Eingabe fehlt oder ist zu lang." });
  if (
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2 ||
    !Number.isFinite(topP) ||
    topP < 0.01 ||
    topP > 1 ||
    !Number.isInteger(contextLength) ||
    contextLength < 512 ||
    contextLength > 32768
  ) {
    return res
      .status(400)
      .json({
        error:
          "Temperatur, Top P oder Kontextgröße liegen außerhalb des erlaubten Bereichs.",
      });
  }
  try {
    const providerSettings = {
      ...store.settings,
      ...(store.settings.provider === "ollama"
        ? { ollamaUrl: normalizeBaseUrl(store.settings.ollamaUrl) }
        : {}),
    };
    const chatId = String(req.body.conversationId || crypto.randomUUID());
    let chat = store.chats[chatId];
    if (chat && chat.userId !== req.user.id && req.user.role !== "admin")
      return res
        .status(403)
        .json({ error: "Dieser Chat gehört einem anderen Konto." });
    chat ??= {
      id: chatId,
      userId: req.user.id,
      userEmail: req.user.email,
      title: `Dev: ${prompt.slice(0, 44)}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const history = chat.messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-30);
    const startedAt = performance.now();
    const result = await generateText(providerSettings, {
      systemPrompt:
        systemPrompt ||
        "Du bist Larky im Dev-Modus. Antworte präzise und erläutere technische Annahmen.",
      messages: [
        ...history.map(({ role, content }) => ({ role, content })),
        { role: "user", content: prompt },
      ],
      options: { temperature, topP, contextLength },
    });
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: Date.now(),
    };
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: result.content || "Das Modell hat keine Antwort geliefert.",
      createdAt: Date.now(),
    };
    chat.messages.push(userMessage, assistantMessage);
    chat.updatedAt = Date.now();
    store.chats[chatId] = chat;
    saveStore();
    res.json({
      conversation: chat,
      answer: assistantMessage,
      diagnostics: {
        model: result.model,
        latencyMs: Math.round(performance.now() - startedAt),
        promptTokens: result.usage.promptTokenCount ?? null,
        responseTokens: result.usage.candidatesTokenCount ?? null,
        totalDurationMs: result.usage.totalDuration
          ? Math.round(result.usage.totalDuration / 1_000_000)
          : null,
        options: { temperature, topP, contextLength },
      },
    });
  } catch (error) {
    handleRouteError(
      res,
      error,
      "Lokales Modell nicht erreichbar. Prüfe Ollama und seine URL im Admin-Bereich.",
    );
  }
});

app.post("/api/images", authenticate, requireActive, async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  const sourceImage = String(req.body.sourceImage || "");
  if (!prompt || prompt.length > 4000)
    return res
      .status(400)
      .json({ error: "Eine Bildbeschreibung ist erforderlich." });
  const day = new Date().toISOString().slice(0, 10);
  const usage = store.imageUsage[req.user.id];
  const used = usage?.day === day ? usage.count : 0;
  const limit = req.user.imageDailyLimit ?? store.settings.defaultImageLimit;
  if (used >= limit)
    return res
      .status(429)
      .json({
        kind: "quota",
        error: `Dein Tageslimit von ${limit} Bildern ist erreicht.`,
      });
  store.imageUsage[req.user.id] = { day, count: used + 1 };
  saveStore();
  try {
    let image;
    let imageText = "";
    if (store.settings.provider === "gemini") {
      const result = await generateGeminiImage(
        store.settings,
        prompt,
        sourceImage,
      );
      image = result.image;
      imageText = result.content;
    } else {
      const imageUrl = normalizeBaseUrl(store.settings.imageUrl);
      const endpoint = sourceImage ? "img2img" : "txt2img";
      const upstream = await fetch(`${imageUrl}/sdapi/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          negative_prompt: "low quality, blurry, watermark",
          steps: 20,
          width: 768,
          height: 768,
          ...(sourceImage
            ? {
                init_images: [
                  sourceImage.replace(/^data:image\/[^;]+;base64,/, ""),
                ],
                denoising_strength: 0.55,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!upstream.ok) throw new Error("Bildserver-Anfrage fehlgeschlagen.");
      const result = await upstream.json();
      if (!result.images?.[0])
        throw new Error("Der Bildserver hat kein Bild zurückgegeben.");
      image = `data:image/png;base64,${result.images[0]}`;
    }
    const conversationId = String(
      req.body.conversationId || crypto.randomUUID(),
    );
    let chat = store.chats[conversationId];
    if (chat && chat.userId !== req.user.id && req.user.role !== "admin")
      return res
        .status(403)
        .json({ error: "Dieser Chat gehört einem anderen Konto." });
    chat ??= {
      id: conversationId,
      userId: req.user.id,
      userEmail: req.user.email,
      title: prompt.slice(0, 52),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: Date.now(),
    };
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content:
        imageText ||
        (sourceImage
          ? "Dein bearbeitetes Bild ist fertig."
          : "Dein Bild ist fertig."),
      image,
      createdAt: Date.now(),
    };
    chat.messages.push(userMessage, assistantMessage);
    chat.updatedAt = Date.now();
    store.chats[conversationId] = chat;
    saveStore();
    res.json({
      conversation: chat,
      answer: assistantMessage,
      usage: { used: used + 1, limit },
    });
  } catch (error) {
    const latest = store.imageUsage[req.user.id];
    if (latest?.day === day) latest.count = Math.max(0, latest.count - 1);
    saveStore();
    handleRouteError(
      res,
      error,
      "Lokaler Bildserver nicht erreichbar. Prüfe die Admin-Einstellungen.",
    );
  }
});

app.get("/api/owner/roles", authenticate, requireOwner, (_req, res) => {
  res.json({ roles: Object.values(store.roles), availablePermissions });
});

app.post("/api/owner/roles", authenticate, requireOwner, (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 40);
  const roleId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const permissions = [...new Set((Array.isArray(req.body.permissions) ? req.body.permissions : []).filter((item) => availablePermissions.some((permission) => permission.id === item)))];
  if (!roleId || !permissions.length) return res.status(400).json({ error: "Rollenname und mindestens ein gültiges Recht sind erforderlich." });
  if (store.roles[roleId]) return res.status(409).json({ error: "Diese Rolle existiert bereits." });
  const role = { id: roleId, name, permissions, createdBy: req.user.email, createdAt: Date.now() };
  store.roles[roleId] = role;
  addAudit(req.user.email, "role-created", role.name, { permissions });
  saveStore();
  res.status(201).json({ role });
});

app.patch("/api/owner/roles/:id", authenticate, requireOwner, (req, res) => {
  const role = store.roles[req.params.id];
  if (!role) return res.status(404).json({ error: "Rolle nicht gefunden." });
  const name = req.body.name === undefined ? role.name : String(req.body.name).trim().slice(0, 40);
  const permissions = req.body.permissions === undefined ? role.permissions : [...new Set((Array.isArray(req.body.permissions) ? req.body.permissions : []).filter((item) => availablePermissions.some((permission) => permission.id === item)))];
  if (!name || !permissions.length) return res.status(400).json({ error: "Rollenname und mindestens ein Recht sind erforderlich." });
  role.name = name;
  role.permissions = permissions;
  role.updatedAt = Date.now();
  addAudit(req.user.email, "role-updated", role.name, { permissions });
  saveStore();
  res.json({ role });
});

app.delete("/api/owner/roles/:id", authenticate, requireOwner, (req, res) => {
  const role = store.roles[req.params.id];
  if (!role) return res.status(404).json({ error: "Rolle nicht gefunden." });
  if (Object.values(store.users).some((user) => user.roleId === role.id)) return res.status(409).json({ error: "Die Rolle ist noch Nutzern zugewiesen." });
  delete store.roles[role.id];
  addAudit(req.user.email, "role-deleted", role.name);
  saveStore();
  res.json({ ok: true });
});

app.patch("/api/owner/users/:id/role", authenticate, requireOwner, (req, res) => {
  const user = store.users[req.params.id];
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden." });
  if (user.role === "admin") return res.status(403).json({ error: "Admin-Konten können keine zusätzliche Rolle erhalten." });
  const roleId = req.body.roleId ? String(req.body.roleId) : null;
  if (roleId && !store.roles[roleId]) return res.status(404).json({ error: "Rolle nicht gefunden." });
  user.roleId = roleId;
  addAudit(req.user.email, "role-assigned", user.email, { roleId });
  revokeSessions(user.id);
  saveStore();
  res.json({ user: publicUser(user) });
});

app.get("/api/admin/users", authenticate, requirePermission("manageUsers"), (_req, res) => {
  res.json({
    users: Object.values(store.users)
      .map(publicUser)
      .sort((a, b) => a.email.localeCompare(b.email)),
  });
});

app.patch("/api/admin/users/:id", authenticate, requirePermission("manageUsers"), (req, res) => {
  const user = store.users[req.params.id];
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden." });
  const {
    verified,
    canUseDeveloperMode,
    imageDailyLimit,
    action,
    reason,
    durationMinutes,
  } = req.body;
  if (typeof verified === "boolean") user.verified = verified;
  if (typeof canUseDeveloperMode === "boolean" && user.role !== "admin") {
    user.canUseDeveloperMode = canUseDeveloperMode;
    addAudit(req.user.email, "developer-mode-access-changed", user.email, {
      enabled: canUseDeveloperMode,
    });
  }
  if (imageDailyLimit !== undefined) {
    const limit = Number(imageDailyLimit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100)
      return res
        .status(400)
        .json({ error: "Das Tageslimit muss zwischen 0 und 100 liegen." });
    user.imageDailyLimit = limit;
  }
  if (action) {
    if (user.role === "admin")
      return res
        .status(403)
        .json({ error: "Admin-Konten können nicht moderiert werden." });
    const note = String(reason || "")
      .trim()
      .slice(0, 500);
    const minutes = Number(durationMinutes);
    if (
      ["timeout", "ban"].includes(action) &&
      (!note || !Number.isFinite(minutes) || minutes < 0 || minutes > 525600)
    ) {
      return res
        .status(400)
        .json({
          error:
            "Grund und eine gültige Dauer in Minuten sind erforderlich. 0 bedeutet dauerhaft.",
        });
    }
    if (action === "timeout") {
      user.timeout = {
        reason: note,
        by: req.user.email,
        until: minutes === 0 ? null : Date.now() + minutes * 60_000,
        createdAt: Date.now(),
      };
      addAudit(req.user.email, "timeout", user.email, {
        reason: note,
        durationMinutes: minutes,
      });
      revokeSessions(user.id);
    } else if (action === "ban") {
      user.ban = {
        reason: note,
        by: req.user.email,
        until: minutes === 0 ? null : Date.now() + minutes * 60_000,
        createdAt: Date.now(),
      };
      user.timeout = null;
      addAudit(req.user.email, "ban", user.email, {
        reason: note,
        durationMinutes: minutes,
      });
      revokeSessions(user.id);
    } else if (action === "kick") {
      addAudit(req.user.email, "kick", user.email, { reason: note });
      revokeSessions(user.id);
    } else if (action === "unban") {
      user.ban = null;
      addAudit(req.user.email, "unban", user.email, { reason: note });
    } else if (action === "untimeout") {
      user.timeout = null;
      addAudit(req.user.email, "untimeout", user.email, { reason: note });
    } else
      return res.status(400).json({ error: "Unbekannte Moderationsaktion." });
  }
  saveStore();
  res.json({ user: publicUser(user) });
});

function revokeSessions(userId) {
  for (const [token, session] of sessions)
    if (session.userId === userId) sessions.delete(token);
}

app.get("/api/admin/chats", authenticate, requirePermission("viewAllChats"), (_req, res) => {
  const chats = Object.values(store.chats).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  res.json({ conversations: chats });
});

app.get("/api/admin/settings", authenticate, requirePermission("manageSettings"), (_req, res) =>
  res.json({
    settings: store.settings,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  }),
);
app.patch("/api/admin/settings", authenticate, requirePermission("manageSettings"), (req, res) => {
  try {
    const next = { ...store.settings };
    if (["gemini", "ollama"].includes(req.body.provider))
      next.provider = req.body.provider;
    if (req.body.geminiModel)
      next.geminiModel = String(req.body.geminiModel).trim().slice(0, 120);
    if (req.body.geminiImageModel)
      next.geminiImageModel = String(req.body.geminiImageModel)
        .trim()
        .slice(0, 120);
    if (req.body.ollamaUrl)
      next.ollamaUrl = normalizeBaseUrl(req.body.ollamaUrl);
    if (req.body.imageUrl) next.imageUrl = normalizeBaseUrl(req.body.imageUrl);
    if (req.body.model)
      next.model = String(req.body.model).trim().slice(0, 120);
    if (req.body.defaultImageLimit !== undefined) {
      const limit = Number(req.body.defaultImageLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > 100)
        return res
          .status(400)
          .json({ error: "Das Standardlimit muss zwischen 0 und 100 liegen." });
      next.defaultImageLimit = limit;
    }
    store.settings = next;
    addAudit(req.user.email, "settings-updated", "system");
    saveStore();
    res.json({
      settings: store.settings,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  } catch (error) {
    res
      .status(400)
      .json({
        error:
          error instanceof Error ? error.message : "Ungültige Einstellungen.",
      });
  }
});

app.post("/api/admin/lockdown", authenticate, requirePermission("manageLockdown"), (req, res) => {
  const enabled = Boolean(req.body.enabled);
  const reason = String(req.body.reason || "")
    .trim()
    .slice(0, 500);
  if (enabled && !reason)
    return res
      .status(400)
      .json({ error: "Bitte gib einen Grund für den Lockdown an." });
  store.lockdown = {
    enabled,
    reason: enabled ? reason : "",
    by: req.user.email,
    updatedAt: Date.now(),
  };
  addAudit(
    req.user.email,
    enabled ? "lockdown-enabled" : "lockdown-disabled",
    "system",
    { reason },
  );
  saveStore();
  res.json({ lockdown: store.lockdown });
});

app.get("/api/admin/audit", authenticate, requirePermission("viewAudit"), (_req, res) =>
  res.json({ events: store.audit }),
);

app.post(
  "/api/admin/probe/gemini",
  authenticate,
  requirePermission("manageSettings"),
  async (_req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey)
      return res
        .status(503)
        .json({ error: "GEMINI_API_KEY fehlt in der Serverumgebung." });
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        {
          headers: { "x-goog-api-key": apiKey },
          signal: AbortSignal.timeout(10000),
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        return res
          .status(502)
          .json({
            error: "Gemini hat den Schlüssel oder den Modellzugriff abgelehnt.",
          });
      const models = (result.models || [])
        .map((model) => model.name?.replace(/^models\//, ""))
        .filter(Boolean);
      res.json({ configured: true, models });
    } catch (error) {
      handleRouteError(res, error, "Google Gemini ist nicht erreichbar.");
    }
  },
);

app.post(
  "/api/admin/probe/ollama",
  authenticate,
  requirePermission("manageSettings"),
  async (_req, res) => {
    try {
      const url = normalizeBaseUrl(store.settings.ollamaUrl);
      const response = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok)
        return res
          .status(502)
          .json({ error: "Ollama hat die Verbindung abgelehnt." });
      const data = await response.json();
      res.json({ models: (data.models || []).map((model) => model.name) });
    } catch (error) {
      handleRouteError(
        res,
        error,
        "Ollama ist nicht erreichbar. Prüfe, ob der lokale Server läuft.",
      );
    }
  },
);

app.post(
  "/api/admin/probe/images",
  authenticate,
  requirePermission("manageSettings"),
  async (_req, res) => {
    try {
      const url = normalizeBaseUrl(store.settings.imageUrl);
      const response = await fetch(`${url}/sdapi/v1/options`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok)
        return res
          .status(502)
          .json({ error: "Der Bildserver hat die Verbindung abgelehnt." });
      res.json({ connected: true });
    } catch (error) {
      handleRouteError(
        res,
        error,
        "Der lokale Bildserver ist nicht erreichbar.",
      );
    }
  },
);

if (isProduction) {
  const clientDirectory = path.resolve(root, "../dist");
  app.use(express.static(clientDirectory, { index: false }));
  app.get(/.*/, (_req, res) =>
    res.sendFile(path.join(clientDirectory, "index.html")),
  );
}

const initialPasswords = [];
for (const [email, displayName, environmentKey] of [
  ["leon.batzel@freenet.de", "Leon", "LARKY_LEON_PASSWORD"],
  ["ytcoolcaster3@gmail.com", "ytcoolcaster3", "LARKY_YTCOOLCASTER_PASSWORD"],
]) {
  let user = Object.values(store.users).find((item) => item.email === email);
  const resetPassword = process.env.LARKY_RESET_ADMIN_PASSWORDS === "1";
  if (!user || resetPassword) {
    const password =
      process.env[environmentKey] ||
      crypto.randomBytes(18).toString("base64url");
    const credentials = passwordHash(password);
    if (user) Object.assign(user, credentials);
    else
      user = {
        id: crypto.randomUUID(),
        email,
        displayName,
        role: "admin",
        verified: true,
        imageDailyLimit: 100,
        ...credentials,
        createdAt: Date.now(),
        ban: null,
        timeout: null,
      };
    store.users[user.id] = user;
    initialPasswords.push({
      email,
      password,
      configured: Boolean(process.env[environmentKey]),
    });
  } else {
    user.role = "admin";
    user.verified = true;
    user.canUseDeveloperMode = true;
  }
}
if (initialPasswords.length) {
  saveStore();
  const generated = initialPasswords.filter(
    (credential) => !credential.configured,
  );
  if (generated.length) {
    const contents = generated
      .map((credential) => `${credential.email}\n${credential.password}`)
      .join("\n\n");
    fs.writeFileSync(firstLoginFile, `${contents}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(firstLoginFile, 0o600);
    } catch {}
  }
}

app.listen(port, host, () => {
  console.log(`Larky API bereit unter http://${host}:${port}`);
  if (initialPasswords.some((credential) => !credential.configured))
    console.log(
      "Admin-Erstzugang liegt lokal in server/admin-first-login.txt. Datei nach dem Notieren sicher entfernen.",
    );
});
