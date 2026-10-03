import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BadgeCheck,
  Ban,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Crown,
  FileImage,
  ImagePlus,
  LockKeyhole,
  LogOut,
  Code2,
  Menu,
  MessageCircle,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Timer,
  Trash2,
  Users,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import "./App.css";

type Mode = "chat" | "rewrite" | "image" | "edit" | "code" | "tests";
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string;
  createdAt: number;
};
type Conversation = {
  id: string;
  userId?: string;
  userEmail?: string;
  title: string;
  updatedAt: number;
  messages: Message[];
};
type Restriction = {
  type: "ban" | "timeout";
  reason: string;
  by: string;
  until: number | null;
  createdAt: number;
};
type User = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  roleId: string | null;
  roleName: string;
  permissions: string[];
  verified: boolean;
  canUseDeveloperMode: boolean;
  imageDailyLimit: number;
  imagesUsedToday: number;
  createdAt: number;
  restriction: Restriction | null;
};
type Settings = {
  provider: "gemini" | "ollama";
  geminiModel: string;
  geminiImageModel: string;
  ollamaUrl: string;
  model: string;
  imageUrl: string;
  defaultImageLimit: number;
};
type CustomRole = { id: string; name: string; permissions: string[] };
type PermissionOption = { id: string; label: string };
type Lockdown = {
  enabled: boolean;
  reason: string;
  by?: string;
  updatedAt?: number;
};
type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
  createdAt: number;
};
type ErrorBody = {
  error?: string;
  kind?: string;
  restriction?: Restriction;
  reason?: string;
};

const modeLabels: Record<Mode, string> = {
  chat: "Chat",
  rewrite: "Umformulieren",
  image: "Bild erstellen",
  edit: "Bild bearbeiten",
  code: "Code schreiben",
  tests: "Tests erstellen",
};
const now = () => Date.now();
const defaultSettings: Settings = {
  provider: "gemini",
  geminiModel: "gemini-2.5-flash",
  geminiImageModel: "gemini-2.5-flash-image",
  ollamaUrl: "http://127.0.0.1:11434",
  model: "llama3.2",
  imageUrl: "http://127.0.0.1:7860",
  defaultImageLimit: 5,
};
const modes: { key: Mode; label: string; icon: typeof Sparkles }[] = [
  { key: "rewrite", label: "Text neu formulieren", icon: WandSparkles },
  { key: "image", label: "Bild generieren", icon: ImagePlus },
  { key: "edit", label: "Bild bearbeiten", icon: FileImage },
  { key: "code", label: "Code schreiben", icon: Zap },
  { key: "tests", label: "Tests erstellen", icon: CheckCheck },
];

class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody;

  constructor(status: number, body: ErrorBody) {
    super(body.error || "Die Anfrage ist fehlgeschlagen.");
    this.status = status;
    this.body = body;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & ErrorBody;
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function prettyTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function relativeTime(timestamp: number) {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 86_400_000)
    return new Date(timestamp).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  if (elapsed < 172_800_000) return "Gestern";
  return new Date(timestamp).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
  });
}

function Logo({ small = false }: { small?: boolean }) {
  return (
    <div
      className={`brand-mark${small ? " brand-mark-small" : ""}`}
      aria-label="Larky Logo"
    >
      <Crown size={small ? 14 : 20} strokeWidth={2.5} />
      <span>L</span>
    </div>
  );
}

function VerifiedMark() {
  return (
    <BadgeCheck
      className="verified-mark"
      size={15}
      aria-label="Verifizierter Nutzer"
    />
  );
}

function restrictionText(restriction: Restriction) {
  return restriction.until
    ? `bis ${prettyTime(restriction.until)}`
    : "unbefristet";
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loginRestriction, setLoginRestriction] = useState<Restriction | null>(
    null,
  );
  const [showUnbanModal, setShowUnbanModal] = useState(false);
  const [unbanCode, setUnbanCode] = useState("");
  const [lockdown, setLockdown] = useState<Lockdown>({
    enabled: false,
    reason: "",
  });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [screen, setScreen] = useState<"chat" | "admin">("chat");
  const [adminTab, setAdminTab] = useState<
    "users" | "chats" | "systems" | "audit" | "roles"
  >("users");
  const [adminUsers, setAdminUsers] = useState<User[]>([]);
  const [adminChats, setAdminChats] = useState<Conversation[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [permissionOptions, setPermissionOptions] = useState<PermissionOption[]>([]);
  const [roleName, setRoleName] = useState("");
  const [rolePermissions, setRolePermissions] = useState<string[]>(["developerMode"]);
  const [providerTab, setProviderTab] = useState<"gemini" | "ollama">("gemini");
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [geminiStatus, setGeminiStatus] = useState<"unknown" | "connected" | "offline">("unknown");
  const [selectedAdminChat, setSelectedAdminChat] = useState<string | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState<
    "unknown" | "connected" | "offline"
  >("unknown");
  const [imageStatus, setImageStatus] = useState<
    "unknown" | "connected" | "offline"
  >("unknown");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [developerOptions, setDeveloperOptions] = useState({
    temperature: 0.7,
    topP: 0.9,
    contextLength: 4096,
    systemPrompt: "",
  });
  const [developerDiagnostics, setDeveloperDiagnostics] = useState<{
    model: string;
    latencyMs: number;
    promptTokens: number | null;
    responseTokens: number | null;
    totalDurationMs: number | null;
  } | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [lockdownReason, setLockdownReason] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [moderationTarget, setModerationTarget] = useState<User | null>(null);
  const [moderationAction, setModerationAction] = useState<
    "timeout" | "kick" | "ban" | null
  >(null);
  const [moderationReason, setModerationReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [unbanStatus, setUnbanStatus] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeId,
  );
  const isAdmin = user?.role === "admin";
  const isOwner = user?.email === "leon.batzel@freenet.de";
  const userPermissions = user?.permissions ?? [];
  const canAccessAdmin = isAdmin || userPermissions.length > 0;
  const canManageUsers = isAdmin || userPermissions.includes("manageUsers");
  const activeModel = settings.provider === "gemini" ? settings.geminiModel : settings.model;
  const providerStatus = settings.provider === "gemini" ? geminiStatus : ollamaStatus;

  function canOpenAdminTab(tab: "users" | "chats" | "systems" | "audit" | "roles") {
    if (isAdmin) return true;
    if (tab === "roles") return isOwner;
    const permission = {
      users: "manageUsers",
      chats: "viewAllChats",
      systems: "manageSettings",
      audit: "viewAudit",
    }[tab];
    return userPermissions.includes(permission);
  }

  function reportError(error: unknown) {
    if (error instanceof ApiError) {
      if (error.body.kind === "lockdown")
        setLockdown({
          enabled: true,
          reason: error.body.reason || "Das System ist gesperrt.",
        });
      if (error.body.restriction) setLoginRestriction(error.body.restriction);
      if (error.status === 401) {
        setUser(null);
        setConversations([]);
      }
      setStatus(error.message);
    } else
      setStatus(
        error instanceof Error
          ? error.message
          : "Die Anfrage ist fehlgeschlagen.",
      );
  }

  async function loadAdminData() {
    const permissions = new Set(user?.permissions ?? []);
    const all = user?.role === "admin";
    const [userData, chatData, settingsData, auditData] = await Promise.all([
      all || permissions.has("manageUsers") ? api<{ users: User[] }>("/admin/users") : Promise.resolve({ users: [] }),
      all || permissions.has("viewAllChats") ? api<{ conversations: Conversation[] }>("/admin/chats") : Promise.resolve({ conversations: [] }),
      all || permissions.has("manageSettings") ? api<{ settings: Settings; geminiConfigured: boolean }>("/admin/settings") : Promise.resolve(null),
      all || permissions.has("viewAudit") ? api<{ events: AuditEvent[] }>("/admin/audit") : Promise.resolve({ events: [] }),
    ]);
    setAdminUsers(userData.users);
    setAdminChats(chatData.conversations);
    setAuditEvents(auditData.events);
    if (settingsData) {
      setSettings(settingsData.settings);
      setGeminiConfigured(settingsData.geminiConfigured);
      setProviderTab(settingsData.settings.provider);
    }
    if (isOwner) {
      const roleData = await api<{ roles: CustomRole[]; availablePermissions: PermissionOption[] }>("/owner/roles");
      setCustomRoles(roleData.roles);
      setPermissionOptions(roleData.availablePermissions);
    }
  }

  const loadAdminDataFromEffect = useEffectEvent(() => {
    void loadAdminData().catch(reportError);
  });

  useEffect(() => {
    let active = true;
    api<{ user: User; lockdown: Lockdown }>("/auth/me")
      .then((data) => {
        if (active)
          startTransition(() => {
            setUser(data.user);
            setLockdown(data.lockdown);
          });
      })
      .catch((error: unknown) => {
        if (active && (!(error instanceof ApiError) || error.status !== 401))
          reportError(error);
      })
      .finally(() => {
        if (active) startTransition(() => setAuthReady(true));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const userId = user?.id;
    const userRole = user?.role;
    const permissionList = user?.permissions ?? [];
    if (!userId || (lockdown.enabled && userRole !== "admin")) return;
    let active = true;
    Promise.all([
      api<{ conversations: Conversation[] }>("/chats"),
      api<{ settings: Settings; geminiConfigured: boolean }>("/config"),
    ])
      .then(([chatData, configData]) => {
        if (!active) return;
        startTransition(() => {
          setConversations(chatData.conversations);
          setActiveId((current) =>
            current &&
            chatData.conversations.some((chat) => chat.id === current)
              ? current
              : (chatData.conversations[0]?.id ?? null),
          );
          setSettings(configData.settings);
          setGeminiConfigured(configData.geminiConfigured);
          setProviderTab(configData.settings.provider);
        });
      })
      .catch((error: unknown) => {
        if (active) reportError(error);
      });
    if (permissionList.length > 0) loadAdminDataFromEffect();
    return () => {
      active = false;
    };
  }, [user?.id, user?.role, user?.permissions, lockdown.enabled]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages.length, busy]);

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setStatus("");
    setLoginRestriction(null);
    try {
      const path = authMode === "login" ? "/auth/login" : "/auth/register";
      const body =
        authMode === "login"
          ? { email, password }
          : { email, password, displayName };
      const data = await api<{ user: User; lockdown: Lockdown }>(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setUser(data.user);
      setLockdown(data.lockdown);
      setPassword("");
      setStatus("");
    } catch (error) {
      if (error instanceof ApiError && error.body.restriction)
        setLoginRestriction(error.body.restriction);
      setStatus(
        error instanceof Error ? error.message : "Anmeldung fehlgeschlagen.",
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {}
    setUser(null);
    setConversations([]);
    setAdminUsers([]);
    setAdminChats([]);
    setLoginRestriction(null);
    setScreen("chat");
    setStatus("");
  }

  async function submitUnban(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUnbanStatus("");
    try {
      const result = await api<{ message: string }>("/auth/unban", {
        method: "POST",
        body: JSON.stringify({ email, code: unbanCode }),
      });
      setUnbanStatus(result.message);
      setLoginRestriction(null);
      setShowUnbanModal(false);
      setUnbanCode("");
      setStatus(result.message);
    } catch (error) {
      setUnbanStatus(
        error instanceof Error ? error.message : "Entsperren fehlgeschlagen.",
      );
    }
  }

  async function createConversation() {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: "Neuer Chat",
      updatedAt: Date.now(),
      messages: [],
    };
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setScreen("chat");
    setMobileNavOpen(false);
    setDraft("");
    setStatus("");
  }

  async function deleteConversation(conversation: Conversation) {
    try {
      await api(`/chats/${encodeURIComponent(conversation.id)}`, {
        method: "DELETE",
      });
      setConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );
      if (activeId === conversation.id) setActiveId(null);
    } catch (error) {
      reportError(error);
    }
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setStatus("");
    try {
      const result = await api<{ settings: Settings; geminiConfigured: boolean }>("/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(settings),
      });
      setSettings(result.settings);
      setProviderTab(result.settings.provider);
      setGeminiConfigured(result.geminiConfigured);
      setStatus("Einstellungen gespeichert.");
    } catch (error) {
      reportError(error);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function testOllama() {
    setOllamaStatus("unknown");
    try {
      const result = await api<{ models: string[] }>("/admin/probe/ollama", {
        method: "POST",
      });
      setOllamaStatus("connected");
      setStatus(
        `Ollama verbunden · ${result.models.length} Modelle${result.models.length ? `: ${result.models.slice(0, 4).join(", ")}` : ""}`,
      );
    } catch (error) {
      setOllamaStatus("offline");
      reportError(error);
    }
  }

  async function selectProvider(provider: "gemini" | "ollama") {
    setProviderTab(provider);
    const nextSettings = { ...settings, provider };
    setSettings(nextSettings);
    try {
      const result = await api<{ settings: Settings; geminiConfigured: boolean }>("/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(nextSettings),
      });
      setSettings(result.settings);
      setGeminiConfigured(result.geminiConfigured);
    } catch (error) {
      reportError(error);
    }
  }

  async function testGemini() {
    setGeminiStatus("unknown");
    try {
      const result = await api<{ models: string[]; configured: boolean }>("/admin/probe/gemini", { method: "POST" });
      setGeminiConfigured(result.configured);
      setGeminiStatus("connected");
      setStatus(`Google Gemini verbunden · ${result.models.length} Modelle verfügbar.`);
    } catch (error) {
      setGeminiStatus("offline");
      reportError(error);
    }
  }

  async function testImageBackend() {
    try {
      await api("/admin/probe/images", { method: "POST" });
      setImageStatus("connected");
      setStatus("Automatic1111 / Forge API verbunden.");
    } catch (error) {
      setImageStatus("offline");
      reportError(error);
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || busy || !user) return;
    const conversation = activeConversation ?? {
      id: crypto.randomUUID(),
      title: text.slice(0, 42),
      updatedAt: now(),
      messages: [],
    };
    const priorMessages = conversation.messages;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      image: attachedImage ?? undefined,
      createdAt: now(),
    };
    const optimistic = {
      ...conversation,
      title: priorMessages.length ? conversation.title : text.slice(0, 52),
      messages: [...priorMessages, userMessage],
      updatedAt: now(),
    };
    setConversations((current) => [
      optimistic,
      ...current.filter((item) => item.id !== optimistic.id),
    ]);
    setActiveId(conversation.id);
    setDraft("");
    setBusy(true);
    setStatus("");
    try {
      const endpoint = developerMode
        ? "/dev/chat"
        : mode === "image" || mode === "edit"
          ? "/images"
          : "/chat";
      const body =
        endpoint === "/images"
          ? {
              prompt: text,
              sourceImage: mode === "edit" ? attachedImage : undefined,
              conversationId: conversation.id,
            }
          : endpoint === "/dev/chat"
            ? {
                prompt: text,
                conversationId: conversation.id,
                options: developerOptions,
              }
            : { prompt: text, mode, conversationId: conversation.id };
      const result = await api<{
        conversation: Conversation;
        answer: Message;
        usage?: { used: number };
        diagnostics?: {
          model: string;
          latencyMs: number;
          promptTokens: number | null;
          responseTokens: number | null;
          totalDurationMs: number | null;
        };
      }>(endpoint, { method: "POST", body: JSON.stringify(body) });
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      setAttachedImage(null);
      if (endpoint !== "/images") {
        if (settings.provider === "gemini") setGeminiStatus("connected");
        else setOllamaStatus("connected");
      }
      setImageStatus(endpoint === "/images" ? "connected" : imageStatus);
      setDeveloperDiagnostics(result.diagnostics ?? null);
      if (result.usage && user)
        setUser((current) =>
          current
            ? {
                ...current,
                imagesUsedToday: result.usage?.used ?? current.imagesUsedToday,
              }
            : current,
        );
    } catch (error) {
      setConversations((current) =>
        current.map((item) =>
          item.id === conversation.id ? conversation : item,
        ),
      );
      setDraft(text);
      if (mode === "image" || mode === "edit") setImageStatus("offline");
      else if (settings.provider === "gemini") setGeminiStatus("offline");
      else setOllamaStatus("offline");
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function handleImageFile(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedImage(
        typeof reader.result === "string" ? reader.result : null,
      );
      setMode("edit");
    };
    reader.readAsDataURL(file);
  }

  async function toggleVerified(target: User) {
    try {
      const result = await api<{ user: User }>(`/admin/users/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ verified: !target.verified }),
      });
      setAdminUsers((current) =>
        current.map((item) => (item.id === target.id ? result.user : item)),
      );
    } catch (error) {
      reportError(error);
    }
  }

  async function toggleDeveloperAccess(target: User) {
    try {
      const result = await api<{ user: User }>(`/admin/users/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          canUseDeveloperMode: !target.canUseDeveloperMode,
        }),
      });
      setAdminUsers((current) =>
        current.map((item) => (item.id === target.id ? result.user : item)),
      );
      setStatus(
        `Dev-Modus ${result.user.canUseDeveloperMode ? "freigegeben für" : "entzogen für"} ${target.displayName}.`,
      );
    } catch (error) {
      reportError(error);
    }
  }

  async function createRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = await api<{ role: CustomRole }>("/owner/roles", { method: "POST", body: JSON.stringify({ name: roleName, permissions: rolePermissions }) });
      setCustomRoles((current) => [...current, result.role]);
      setRoleName("");
      setStatus(`Rolle „${result.role.name}“ erstellt.`);
    } catch (error) { reportError(error); }
  }

  async function updateRole(role: CustomRole, permissions: string[]) {
    try {
      const result = await api<{ role: CustomRole }>(`/owner/roles/${role.id}`, { method: "PATCH", body: JSON.stringify({ permissions }) });
      setCustomRoles((current) => current.map((item) => item.id === role.id ? result.role : item));
      setStatus(`Rechte für „${role.name}“ gespeichert.`);
    } catch (error) { reportError(error); }
  }

  async function deleteRole(role: CustomRole) {
    try {
      await api(`/owner/roles/${role.id}`, { method: "DELETE" });
      setCustomRoles((current) => current.filter((item) => item.id !== role.id));
      setStatus(`Rolle „${role.name}“ gelöscht.`);
    } catch (error) { reportError(error); }
  }

  async function assignRole(target: User, roleId: string) {
    try {
      const result = await api<{ user: User }>(`/owner/users/${target.id}/role`, { method: "PATCH", body: JSON.stringify({ roleId: roleId || null }) });
      setAdminUsers((current) => current.map((item) => item.id === target.id ? result.user : item));
      setStatus(`Rolle für ${target.displayName} aktualisiert.`);
    } catch (error) { reportError(error); }
  }

  async function saveImageLimit(target: User, limit: number) {
    try {
      const result = await api<{ user: User }>(`/admin/users/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ imageDailyLimit: limit }),
      });
      setAdminUsers((current) =>
        current.map((item) => (item.id === target.id ? result.user : item)),
      );
      setStatus(`Bildlimit für ${target.displayName} gespeichert.`);
    } catch (error) {
      reportError(error);
    }
  }

  function openModeration(target: User, action: "timeout" | "kick" | "ban") {
    setModerationTarget(target);
    setModerationAction(action);
    setModerationReason("");
    setDurationMinutes(action === "timeout" ? 60 : 1440);
  }

  async function performModeration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!moderationTarget || !moderationAction) return;
    try {
      await api(`/admin/users/${moderationTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          action: moderationAction,
          reason: moderationReason,
          durationMinutes,
        }),
      });
      setModerationTarget(null);
      setModerationAction(null);
      setStatus(
        `${moderationTarget.displayName}: ${moderationAction === "kick" ? "abgemeldet" : moderationAction === "ban" ? "gebannt" : "zeitweise gesperrt"}.`,
      );
      await loadAdminData();
    } catch (error) {
      reportError(error);
    }
  }

  async function changeRestriction(
    target: User,
    action: "unban" | "untimeout",
  ) {
    try {
      await api(`/admin/users/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, reason: "Durch Admin aufgehoben" }),
      });
      await loadAdminData();
    } catch (error) {
      reportError(error);
    }
  }

  async function changeLockdown(enabled: boolean) {
    try {
      const result = await api<{ lockdown: Lockdown }>("/admin/lockdown", {
        method: "POST",
        body: JSON.stringify({ enabled, reason: lockdownReason }),
      });
      setLockdown(result.lockdown);
      setLockdownReason("");
      setStatus(
        enabled
          ? "Lockdown ist aktiv. Admins haben weiter Zugriff."
          : "Lockdown wurde beendet.",
      );
    } catch (error) {
      reportError(error);
    }
  }

  const filteredConversations = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredUsers = adminUsers.filter((target) =>
    `${target.displayName} ${target.email}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selectedChat = adminChats.find(
    (conversation) => conversation.id === selectedAdminChat,
  );

  if (!authReady)
    return (
      <div className="boot-screen">
        <Logo />
        <span>LARKY WIRD GESTARTET</span>
      </div>
    );

  if (!user)
    return (
      <>
        <main className="auth-shell">
          <section className="auth-panel">
            <button
              className="auth-brand"
              type="button"
              onClick={() => {
                setAuthMode("login");
                setStatus("");
              }}
            >
              <Logo />
              <span>
                LARKY<small>GAMING AI COMPANION</small>
              </span>
            </button>
            {loginRestriction ? (
              <>
                <div className={`restriction-mark ${loginRestriction.type}`}>
                  <Shield size={25} />
                </div>
                <div className="eyebrow">KONTOSTATUS</div>
                <h1>
                  {loginRestriction.type === "ban"
                    ? "Konto gesperrt"
                    : "Zugriff pausiert"}
                </h1>
                <div className="restriction-details">
                  <strong>
                    {loginRestriction.type === "ban" ? "GEBANNT" : "TIMEOUT"} ·{" "}
                    {restrictionText(loginRestriction)}
                  </strong>
                  <p>{loginRestriction.reason || "Kein Grund angegeben."}</p>
                  <small>Maßnahme durch {loginRestriction.by}</small>
                </div>
                {status && (
                  <div className="notice" role="status">
                    {status}
                  </div>
                )}
                <button
                  className="primary-action auth-submit"
                  type="button"
                  onClick={() => {
                    setLoginRestriction(null);
                    setStatus("");
                  }}
                >
                  Zur Anmeldung
                </button>
                {loginRestriction.type === "ban" && (
                  <button
                    className="breakglass-button"
                    type="button"
                    onClick={() => {
                      setUnbanStatus("");
                      setUnbanCode("");
                      setShowUnbanModal(true);
                    }}
                  >
                    Mit Entsperrcode freischalten
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="eyebrow">
                  <LockKeyhole size={14} /> LOKALES KONTO
                </div>
                <h1>
                  {authMode === "login"
                    ? "Willkommen zurück."
                    : "Konto erstellen."}
                </h1>
                <p className="auth-subtitle">
                  {authMode === "login"
                    ? "Melde dich an, um deine Chats fortzusetzen."
                    : "Deine Chats bleiben auf diesem PC."}
                </p>
                <div className="auth-tabs">
                  <button
                    className={authMode === "login" ? "selected" : ""}
                    type="button"
                    onClick={() => {
                      setAuthMode("login");
                      setStatus("");
                    }}
                  >
                    Anmelden
                  </button>
                  <button
                    className={authMode === "register" ? "selected" : ""}
                    type="button"
                    onClick={() => {
                      setAuthMode("register");
                      setStatus("");
                    }}
                  >
                    Registrieren
                  </button>
                </div>
                <form className="auth-form" onSubmit={submitAuth}>
                  {authMode === "register" && (
                    <label>
                      ANZEIGENAME
                      <input
                        autoComplete="nickname"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        required
                        maxLength={40}
                      />
                    </label>
                  )}
                  <label>
                    E-MAIL
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    PASSWORT
                    <input
                      type="password"
                      autoComplete={
                        authMode === "login"
                          ? "current-password"
                          : "new-password"
                      }
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      minLength={authMode === "register" ? 10 : 1}
                      required
                    />
                    {authMode === "register" && (
                      <small>Mindestens 10 Zeichen</small>
                    )}
                  </label>
                  {status && (
                    <div className="notice" role="alert">
                      {status}
                    </div>
                  )}
                  <button
                    className="primary-action auth-submit"
                    disabled={authBusy}
                    type="submit"
                  >
                    {authBusy
                      ? "Einen Moment …"
                      : authMode === "login"
                        ? "Anmelden"
                        : "Konto erstellen"}{" "}
                    <ArrowUp size={15} />
                  </button>
                </form>
                <div className="auth-privacy">
                  <LockKeyhole size={14} />
                  <span>Lokale Anmeldung · keine Cloud-Konten</span>
                </div>
              </>
            )}
          </section>
          <div className="auth-side-art">
            <div className="art-circuit" />
            <div className="auth-emblem">
              <Logo />
            </div>
            <span className="art-word">LARKY</span>
            <span className="art-caption">DEIN KI-BEGLEITER</span>
            <div className="art-pills">
              <span>
                <Zap size={15} /> SCHNELL
              </span>
              <span>
                <Shield size={15} /> PRIVAT
              </span>
              <span>
                <Sparkles size={15} /> LOKAL
              </span>
            </div>
          </div>
        </main>
        {showUnbanModal && (
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget)
                setShowUnbanModal(false);
            }}
          >
            <section
              className="dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="unban-title"
            >
              <button
                className="dialog-close"
                type="button"
                aria-label="Schließen"
                onClick={() => setShowUnbanModal(false)}
              >
                <X size={18} />
              </button>
              <div className="panel-icon gold">
                <LockKeyhole size={19} />
              </div>
              <h2 id="unban-title">Konto entsperren</h2>
              <p>Gib den Entsperrcode ein. Der Versuch wird protokolliert.</p>
              <form onSubmit={submitUnban}>
                <label className="field-label">
                  E-MAIL
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <label className="field-label">
                  ENTSPERRCODE
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={unbanCode}
                    onChange={(event) => setUnbanCode(event.target.value)}
                    required
                  />
                </label>
                {unbanStatus && (
                  <div className="notice" role="status">
                    {unbanStatus}
                  </div>
                )}
                <button className="primary-action" type="submit">
                  Sperre aufheben
                </button>
              </form>
            </section>
          </div>
        )}
      </>
    );

  if (user.restriction?.type === "timeout")
    return (
      <main className="restriction-screen">
        <div className="restriction-mark timeout">
          <Timer size={28} />
        </div>
        <div className="eyebrow">ZUGRIFF PAUSIERT</div>
        <h1>Du bist gerade im Timeout.</h1>
        <p>{user.restriction.reason}</p>
        <div className="restriction-details">
          <strong>
            Bis{" "}
            {user.restriction.until
              ? prettyTime(user.restriction.until)
              : "auf Weiteres"}
          </strong>
          <small>Maßnahme durch {user.restriction.by}</small>
        </div>
        <button
          className="secondary-action"
          onClick={() => void logout()}
          type="button"
        >
          <LogOut size={16} /> Abmelden
        </button>
      </main>
    );

  if (lockdown.enabled && !isAdmin)
    return (
      <main className="lockdown-screen">
        <div className="lockdown-symbol">
          <Shield size={35} />
        </div>
        <div className="eyebrow">SYSTEMSTATUS · ADMIN-SCHUTZ</div>
        <h1>LOCKDOWN</h1>
        <p>
          Das System ist vorübergehend gesperrt. Währenddessen können nur Admins
          die Chats und Einstellungen verwalten.
        </p>
        <section className="lockdown-reason">
          <span>GRUND</span>
          <strong>{lockdown.reason || "Kein Grund angegeben."}</strong>
          {lockdown.by && <small>Aktiviert von {lockdown.by}</small>}
        </section>
        <button
          className="secondary-action"
          onClick={() => void logout()}
          type="button"
        >
          <LogOut size={16} /> Abmelden
        </button>
      </main>
    );

  return (
    <main className="app-shell">
      {mobileNavOpen && (
        <button
          className="drawer-scrim"
          type="button"
          aria-label="Navigation schließen"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside className={`sidebar${mobileNavOpen ? " mobile-open" : ""}`}>
        <button
          className="brand-lockup"
          type="button"
          onClick={() => {
            setScreen("chat");
            setStatus("");
          }}
        >
          <Logo />
          <span className="brand-name">
            LARKY<span>GAMING AI COMPANION</span>
          </span>
        </button>
        <button
          className="new-chat-button"
          type="button"
          onClick={() => void createConversation()}
        >
          <Plus size={19} /> Neuer Chat <span>⌘ K</span>
        </button>
        <label className="search-box">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              canManageUsers && screen === "admin" && adminTab === "users"
                ? "Nutzer suchen"
                : "Chats durchsuchen"
            }
          />
          <span>/</span>
        </label>
        <div className="side-label">
          {isAdmin && screen === "admin" && adminTab === "users"
            ? "NUTZER"
            : "DEINE CHATS"}{" "}
          <span>
            {canManageUsers && screen === "admin" && adminTab === "users"
              ? adminUsers.length
              : filteredConversations.length}
          </span>
        </div>
        {canManageUsers && screen === "admin" && adminTab === "users" ? (
          <nav className="conversation-list" aria-label="Nutzerliste">
            {filteredUsers.map((target) => (
              <button
                type="button"
                className="admin-sidebar-user"
                key={target.id}
                onClick={() =>
                  setStatus(`${target.displayName} · ${target.email}`)
                }
              >
                <span>
                  {target.displayName}
                  {target.verified && <VerifiedMark />}
                </span>
                <small>{target.role === "admin" ? "ADMIN" : "NUTZER"}</small>
              </button>
            ))}
          </nav>
        ) : (
          <nav className="conversation-list" aria-label="Gespeicherte Chats">
            {filteredConversations.map((conversation) => (
              <div
                className={`conversation-row${conversation.id === activeId && screen === "chat" ? " selected" : ""}`}
                key={conversation.id}
              >
                <button
                  type="button"
                  className="conversation-select"
                  onClick={() => {
                    setActiveId(conversation.id);
                    setScreen("chat");
                    setStatus("");
                  }}
                >
                  <MessageCircle size={16} />
                  <span>{conversation.title}</span>
                </button>
                <button
                  className="conversation-delete"
                  title="Chat löschen"
                  aria-label={`${conversation.title} löschen`}
                  onClick={() => void deleteConversation(conversation)}
                >
                  <Trash2 size={15} />
                </button>
                <time>{relativeTime(conversation.updatedAt)}</time>
              </div>
            ))}
            {filteredConversations.length === 0 && (
              <p className="empty-list">Noch keine Chats gespeichert.</p>
            )}
          </nav>
        )}
        <div className="sidebar-spacer" />
        <div className="local-card">
          <LockKeyhole size={17} />
          <span>
            <strong>LOKAL & PRIVAT</strong>
            <small>KI greift nicht selbst auf Dateien zu.</small>
          </span>
          <span className="local-dot" />
        </div>
        {canAccessAdmin && (
          <button
            className={`admin-link${screen === "admin" ? " active" : ""}`}
            onClick={() => {
              setScreen("admin");
              setStatus("");
            }}
            type="button"
          >
            <Settings2 size={18} /> Admin & Systeme <ArrowDown size={15} />
          </button>
        )}
        <div className="profile-row">
          <div className="avatar">
            {user.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <strong>
              {user.displayName} {user.verified && <VerifiedMark />}
            </strong>
            <small>
              {isAdmin
                ? "Administrator"
                : `${user.imagesUsedToday} / ${user.imageDailyLimit} Bilder heute`}
            </small>
          </div>
          <button
            className="profile-logout"
            type="button"
            title="Abmelden"
            onClick={() => void logout()}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <section className="workspace">
        <button
          className="mobile-menu-button"
          type="button"
          aria-label="Chatliste öffnen"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu size={18} />
        </button>
        {user.canUseDeveloperMode && screen === "chat" && (
          <button
            className={`developer-toggle${developerMode ? " active" : ""}`}
            type="button"
            aria-pressed={developerMode}
            onClick={() => {
              setDeveloperMode((enabled) => !enabled);
              setDeveloperDiagnostics(null);
              setMode("chat");
            }}
          >
            <Code2 size={17} />
            <span>DEV</span>
          </button>
        )}
        {user.canUseDeveloperMode && developerMode && screen === "chat" && (
          <section
            className="developer-panel"
            aria-label="Dev-Modus Einstellungen"
          >
            <header>
              <div>
                <strong>
                  <Code2 size={17} /> Dev-Werkbank
                </strong>
                <small>{activeModel} · {settings.provider === "gemini" ? "Google Gemini" : "Ollama Backup"}</small>
              </div>
              <button
                type="button"
                aria-label="Dev-Modus schließen"
                onClick={() => setDeveloperMode(false)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="developer-fields">
              <label>
                TEMPERATUR{" "}
                <output>{developerOptions.temperature.toFixed(1)}</output>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={developerOptions.temperature}
                  onChange={(event) =>
                    setDeveloperOptions((current) => ({
                      ...current,
                      temperature: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label>
                TOP P <output>{developerOptions.topP.toFixed(2)}</output>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={developerOptions.topP}
                  onChange={(event) =>
                    setDeveloperOptions((current) => ({
                      ...current,
                      topP: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label>
                KONTEXTFENSTER
                <select
                  value={developerOptions.contextLength}
                  onChange={(event) =>
                    setDeveloperOptions((current) => ({
                      ...current,
                      contextLength: Number(event.target.value),
                    }))
                  }
                >
                  <option value={2048}>2 048 Tokens</option>
                  <option value={4096}>4 096 Tokens</option>
                  <option value={8192}>8 192 Tokens</option>
                  <option value={16384}>16 384 Tokens</option>
                  <option value={32768}>32 768 Tokens</option>
                </select>
              </label>
              <label className="developer-system">
                SYSTEMPROMPT
                <textarea
                  value={developerOptions.systemPrompt}
                  onChange={(event) =>
                    setDeveloperOptions((current) => ({
                      ...current,
                      systemPrompt: event.target.value,
                    }))
                  }
                  placeholder="Optionaler Prompt für diese Anfrage"
                  rows={3}
                  maxLength={4000}
                />
              </label>
            </div>
            {developerDiagnostics && (
              <div className="developer-diagnostics">
                <span>
                  <Activity size={14} /> {developerDiagnostics.latencyMs} ms
                </span>
                <span>
                  {developerDiagnostics.promptTokens ?? "–"} IN /{" "}
                  {developerDiagnostics.responseTokens ?? "–"} OUT TOKENS
                </span>
              </div>
            )}
            <p className="developer-note">
              Änderungen gelten für deine nächste lokale Modellanfrage.
            </p>
          </section>
        )}
        <header className="topbar">
          <div className="breadcrumbs">
            <span>LARKY</span>
            <b>/</b>
            <strong>
              {screen === "admin"
                ? `ADMIN · ${adminTab.toUpperCase()}`
                : (activeConversation?.title ?? "NEUER CHAT")}
            </strong>
          </div>
          <div className="topbar-actions">
            <button
              className="connection-pill"
              type="button"
              onClick={() =>
                canAccessAdmin
                  ? (setScreen("admin"), setAdminTab("systems"))
                  : undefined
              }
            >
              <span className={`status-dot ${providerStatus}`} />
              {settings.provider === "gemini"
                ? geminiStatus === "connected" ? "GEMINI ONLINE" : geminiConfigured ? "GEMINI BEREIT" : "GEMINI EINRICHTEN"
                : ollamaStatus === "connected" ? "OLLAMA ONLINE" : "OLLAMA BACKUP"}
              <ChevronDown size={14} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="Sicherheit und Datenschutz"
              onClick={() =>
                setStatus(
                  "Larky durchsucht deinen PC nicht. Dateien werden nur nach manueller Auswahl angehängt.",
                )
              }
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>

        {screen === "admin" && canAccessAdmin ? (
          <section className="admin-page">
            <div className="admin-heading">
              <div className="eyebrow">
                <Shield size={16} /> ADMIN CONTROL CENTER
              </div>
              <h1>
                System <span>&</span> Nutzer
              </h1>
              <p>
                Verwalte Konten, Inhalte, lokale Modelle und den Systemzugriff.
              </p>
            </div>
            <nav className="admin-tabs" aria-label="Adminbereiche">
              {(
                [
                  ["users", "Nutzer", Users],
                  ["chats", "Alle Chats", MessageCircle],
                  ["systems", "Systeme", SlidersHorizontal],
                  ["audit", "Protokoll", Activity],
                ] as const
              ).filter(([key]) => canOpenAdminTab(key)).map(([key, label, Icon]) => (
                <button
                  type="button"
                  key={key}
                  className={adminTab === key ? "active" : ""}
                  onClick={() => {
                    setAdminTab(key);
                    setSelectedAdminChat(null);
                    setStatus("");
                  }}
                >
                  <Icon size={17} />
                  {label}
                  {key === "users" ? (
                    <span>{adminUsers.length}</span>
                  ) : key === "chats" ? (
                    <span>{adminChats.length}</span>
                  ) : null}
                </button>
              ))}
              {isOwner && <button type="button" className={adminTab === "roles" ? "active" : ""} onClick={() => { setAdminTab("roles"); setStatus(""); setSelectedAdminChat(null); }}><ShieldCheck size={17} /> Rollen</button>}
            </nav>
            {status && (
              <div className="notice" role="status">
                {status}
                <button
                  type="button"
                  aria-label="Meldung schließen"
                  onClick={() => setStatus("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}

            {adminTab === "roles" && isOwner && (
              <div className="admin-content roles-content">
                <div className="admin-section-title"><div><h2>Rollen & Systemrechte</h2><p>Nur Leon kann Rollen erstellen und Rechte vergeben. Änderungen greifen bei der nächsten Anmeldung.</p></div><span>{customRoles.length} ROLLEN</span></div>
                <form className="role-create-panel" onSubmit={(event) => void createRole(event)}>
                  <label className="field-label">NEUER ROLLENNAME<input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="z. B. Moderator, Support, Entwickler" maxLength={40} required /></label>
                  <strong>RECHTE FÜR DIESE ROLLE</strong>
                  <div className="permission-grid">{permissionOptions.map((permission) => <label key={permission.id}><input type="checkbox" checked={rolePermissions.includes(permission.id)} onChange={(event) => setRolePermissions((current) => event.target.checked ? [...current, permission.id] : current.filter((id) => id !== permission.id))} />{permission.label}</label>)}</div>
                  <button className="primary-action" type="submit" disabled={!roleName.trim() || rolePermissions.length === 0}><Plus size={16} /> Rolle erstellen</button>
                </form>
                <div className="role-list">{customRoles.map((role) => <article className="role-card" key={role.id}>
                  <header><div><strong>{role.name}</strong><small>{role.id}</small></div><button className="danger-action" type="button" title="Rolle löschen" onClick={() => void deleteRole(role)}><Trash2 size={16} /> Löschen</button></header>
                  <div className="permission-grid">{permissionOptions.map((permission) => <label key={permission.id}><input type="checkbox" checked={role.permissions.includes(permission.id)} onChange={(event) => { const next = new Set(role.permissions); if (event.target.checked) next.add(permission.id); else next.delete(permission.id); void updateRole(role, [...next]); }} />{permission.label}</label>)}</div>
                  <small className="role-assignee-count">{adminUsers.filter((target) => target.roleId === role.id).length} Nutzer zugewiesen. Zuweisung erfolgt im Tab „Nutzer“.</small>
                </article>)}{customRoles.length === 0 && <div className="admin-empty">Noch keine benutzerdefinierten Rollen angelegt.</div>}</div>
              </div>
            )}
            {adminTab === "users" && (
              <div className="admin-content">
                <div className="admin-section-title">
                  <div>
                    <h2>Nutzerkonten</h2>
                    <p>
                      Verifizierung, tägliches Bildlimit und Moderation pro
                      Konto.
                    </p>
                  </div>
                  <span>{filteredUsers.length} KONTEN</span>
                </div>
                <div className="user-list">
                  {filteredUsers.map((target) => (
                    <article className="user-card" key={target.id}>
                      <div className="user-card-main">
                        <div
                          className={`user-avatar large ${target.role === "admin" ? "admin" : ""}`}
                        >
                          {target.displayName.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="user-identity">
                          <strong>
                            {target.displayName}
                            {target.verified && <VerifiedMark />}
                          </strong>
                          <span>{target.email}</span>
                          <small>
                            {target.role === "admin"
                              ? "ADMIN"
                              : `Dabei seit ${new Date(target.createdAt).toLocaleDateString("de-DE")}`}
                          </small>
                        </div>
                        <div
                          className={`user-state ${target.restriction ? "restricted" : ""}`}
                        >
                          {target.restriction
                            ? target.restriction.type === "ban"
                              ? "GEBANNT"
                              : "TIMEOUT"
                            : "AKTIV"}
                        </div>
                      </div>
                      <div className="user-controls">
                        <button
                          className={`verify-control${target.verified ? " on" : ""}`}
                          type="button"
                          onClick={() => void toggleVerified(target)}
                        >
                          <BadgeCheck size={17} />
                          {target.verified ? "Verifiziert" : "Verifizieren"}
                        </button>
                        <label className="quota-control">
                          BILDER / TAG
                          <input
                            aria-label={`Bildlimit für ${target.displayName}`}
                            type="number"
                            min="0"
                            max="100"
                            value={target.imageDailyLimit}
                            onChange={(event) =>
                              setAdminUsers((current) =>
                                current.map((item) =>
                                  item.id === target.id
                                    ? {
                                        ...item,
                                        imageDailyLimit: Number(
                                          event.target.value,
                                        ),
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                          <button
                            type="button"
                            title="Bildlimit speichern"
                            onClick={() =>
                              void saveImageLimit(
                                target,
                                target.imageDailyLimit,
                              )
                            }
                          >
                            <Check size={15} />
                          </button>
                        </label>
                        {target.role === "admin" ? (
                          <span className="dev-access-badge">
                            <Code2 size={15} /> DEV-MODUS
                          </span>
                        ) : (
                          <label className="dev-access-control">
                            <input
                              type="checkbox"
                              checked={target.canUseDeveloperMode}
                              onChange={() =>
                                void toggleDeveloperAccess(target)
                              }
                            />
                            <Code2 size={16} /> DEV-MODUS
                          </label>
                        )}
                        {isOwner && target.role !== "admin" && (
                          <label className="role-assignment">
                            ROLLE
                            <select value={target.roleId ?? ""} onChange={(event) => void assignRole(target, event.target.value)}>
                              <option value="">Nutzer</option>
                              {customRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                            </select>
                          </label>
                        )}
                        {target.role !== "admin" && (
                          <div className="moderation-actions">
                            {target.restriction?.type === "ban" && (
                              <button
                                className="unban-control"
                                type="button"
                                title="Ban aufheben"
                                onClick={() =>
                                  void changeRestriction(target, "unban")
                                }
                              >
                                <ShieldCheck size={17} />
                              </button>
                            )}
                            {target.restriction?.type === "timeout" && (
                              <button
                                className="unban-control"
                                type="button"
                                title="Timeout aufheben"
                                onClick={() =>
                                  void changeRestriction(target, "untimeout")
                                }
                              >
                                <ShieldCheck size={17} />
                              </button>
                            )}
                            <button
                              type="button"
                              title="Timeout"
                              onClick={() => openModeration(target, "timeout")}
                            >
                              <Timer size={17} />
                            </button>
                            <button
                              type="button"
                              title="Kick"
                              onClick={() => openModeration(target, "kick")}
                            >
                              <LogOut size={17} />
                            </button>
                            <button
                              className="ban-control"
                              type="button"
                              title="Bannen"
                              onClick={() => openModeration(target, "ban")}
                            >
                              <Ban size={17} />
                            </button>
                          </div>
                        )}
                      </div>
                      {target.restriction && (
                        <div className="restriction-summary">
                          <strong>
                            {target.restriction.type === "ban"
                              ? "Gebannt"
                              : "Timeout"}{" "}
                            · {restrictionText(target.restriction)}
                          </strong>
                          <span>Grund: {target.restriction.reason}</span>
                          <small>durch {target.restriction.by}</small>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            )}

            {adminTab === "chats" && (
              <div className="admin-content">
                <div className="admin-section-title">
                  <div>
                    <h2>Alle Chatverläufe</h2>
                    <p>Nur Admins sehen die Nachrichten aller Nutzer.</p>
                  </div>
                  <span>{adminChats.length} CHATS</span>
                </div>
                {selectedChat ? (
                  <section className="admin-chat-view">
                    <div className="admin-chat-title">
                      <button
                        className="secondary-action compact"
                        type="button"
                        onClick={() => setSelectedAdminChat(null)}
                      >
                        <ArrowLeft size={15} /> Alle Chats
                      </button>
                      <div>
                        <strong>{selectedChat.title}</strong>
                        <small>
                          {selectedChat.userEmail} ·{" "}
                          {prettyTime(selectedChat.updatedAt)}
                        </small>
                      </div>
                    </div>
                    <div className="admin-message-list">
                      {selectedChat.messages.map((message) => (
                        <article
                          className={`admin-message ${message.role}`}
                          key={message.id}
                        >
                          <strong>
                            {message.role === "assistant"
                              ? "Larky"
                              : selectedChat.userEmail}
                          </strong>
                          {message.image && (
                            <img
                              src={message.image}
                              alt="Im Chat geteiltes Bild"
                            />
                          )}
                          <p>{message.content}</p>
                          <time>{prettyTime(message.createdAt)}</time>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : (
                  <div className="admin-chat-list">
                    {adminChats
                      .filter((chat) =>
                        `${chat.title} ${chat.userEmail}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((chat) => (
                        <button
                          className="admin-chat-row"
                          type="button"
                          key={chat.id}
                          onClick={() => setSelectedAdminChat(chat.id)}
                        >
                          <MessageCircle size={19} />
                          <span>
                            <strong>{chat.title}</strong>
                            <small>
                              {chat.userEmail} · {chat.messages.length}{" "}
                              Nachrichten
                            </small>
                          </span>
                          <time>{relativeTime(chat.updatedAt)}</time>
                          <ArrowUp size={15} />
                        </button>
                      ))}
                    {adminChats.length === 0 && (
                      <div className="admin-empty">
                        Noch keine Chats vorhanden.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {adminTab === "systems" && (
              <div className="admin-content">
                <div className="admin-section-title">
                  <div>
                    <h2>Systemsteuerung</h2>
                    <p>Lokale KI-Dienste und Zugriffsschutz.</p>
                  </div>
                </div>
                <nav className="provider-tabs" aria-label="KI-Anbieter">
                  <button className={providerTab === "gemini" ? "active" : ""} type="button" onClick={() => void selectProvider("gemini")}><Sparkles size={17} /> Google Gemini <span>PRIMÄR</span></button>
                  <button className={providerTab === "ollama" ? "active" : ""} type="button" onClick={() => void selectProvider("ollama")}><Bot size={17} /> Ollama <span>BACKUP</span></button>
                </nav>
                <div className="admin-grid">
                  {providerTab === "gemini" && <section className="admin-panel">
                    <div className="panel-heading"><div className="panel-icon blue"><Sparkles size={20} /></div><div><h2>Google Gemini</h2><p>Chat-Antworten und Bildgenerierung</p></div><span className={`service-badge ${geminiStatus === "connected" ? "connected" : geminiStatus === "offline" ? "offline" : ""}`}>{geminiStatus === "connected" ? "VERBUNDEN" : geminiConfigured ? "SCHLÜSSEL GESETZT" : "SCHLÜSSEL FEHLT"}</span></div>
                    <label className="field-label">CHAT-MODELL<input value={settings.geminiModel} onChange={(event) => setSettings((current) => ({ ...current, geminiModel: event.target.value }))} placeholder="gemini-2.5-flash" /></label>
                    <label className="field-label">BILD-MODELL<input value={settings.geminiImageModel} onChange={(event) => setSettings((current) => ({ ...current, geminiImageModel: event.target.value }))} placeholder="gemini-2.5-flash-image" /></label>
                    <button className="primary-action" type="button" onClick={() => void testGemini()}><Activity size={17} /> Google-Verbindung testen</button>
                    <p className="help-copy">Der Schlüssel wird nur serverseitig aus <code>GEMINI_API_KEY</code> gelesen und nie an den Browser gesendet. Verwende einen frisch erzeugten Schlüssel.</p>
                  </section>}
                  {providerTab === "ollama" && <section className="admin-panel">
                    <div className="panel-heading">
                      <div className="panel-icon blue">
                        <Bot size={20} />
                      </div>
                      <div>
                        <h2>Sprachmodell</h2>
                        <p>Antworten über Ollama auf diesem PC</p>
                      </div>
                      <span className={`service-badge ${ollamaStatus}`}>
                        {ollamaStatus === "connected"
                          ? "VERBUNDEN"
                          : ollamaStatus === "offline"
                            ? "OFFLINE"
                            : "NICHT GEPRÜFT"}
                      </span>
                    </div>
                    <label className="field-label">
                      OLLAMA SERVER URL
                      <input
                        value={settings.ollamaUrl}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            ollamaUrl: event.target.value,
                          }))
                        }
                        placeholder="http://127.0.0.1:11434"
                      />
                    </label>
                    <label className="field-label">
                      MODELLNAME
                      <input
                        value={settings.model}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            model: event.target.value,
                          }))
                        }
                        placeholder="llama3.2"
                      />
                    </label>
                    <button
                      className="primary-action"
                      type="button"
                      onClick={() => void testOllama()}
                    >
                      <Activity size={17} /> Verbindung testen
                    </button>
                    <p className="help-copy">
                      Ollama muss lokal laufen. Setze{" "}
                      <code>OLLAMA_ORIGINS=http://localhost:5173</code>.
                    </p>
                  </section>}
                  {providerTab === "ollama" && <section className="admin-panel">
                    <div className="panel-heading">
                      <div className="panel-icon gold">
                        <ImagePlus size={20} />
                      </div>
                      <div>
                        <h2>Bildserver</h2>
                        <p>Automatic1111 oder Forge API</p>
                      </div>
                      <span className={`service-badge ${imageStatus}`}>
                        {imageStatus === "connected"
                          ? "VERBUNDEN"
                          : imageStatus === "offline"
                            ? "OFFLINE"
                            : "NICHT GEPRÜFT"}
                      </span>
                    </div>
                    <label className="field-label">
                      WEBUI API URL
                      <input
                        value={settings.imageUrl}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            imageUrl: event.target.value,
                          }))
                        }
                        placeholder="http://127.0.0.1:7860"
                      />
                    </label>
                    <div className="feature-row">
                      <Check size={16} /> Text-zu-Bild Generierung{" "}
                      <span>txt2img</span>
                    </div>
                    <div className="feature-row">
                      <Check size={16} /> Bild-zu-Bild Bearbeitung{" "}
                      <span>img2img</span>
                    </div>
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => void testImageBackend()}
                    >
                      <Activity size={17} /> Bildserver prüfen
                    </button>
                    <p className="help-copy">
                      WebUI mit <code>--api</code> und erlaubtem Vite-Ursprung
                      starten.
                    </p>
                  </section>}
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div className="panel-icon green">
                        <LockKeyhole size={20} />
                      </div>
                      <div>
                        <h2>Bildlimits</h2>
                        <p>Standard für neue Konten</p>
                      </div>
                    </div>
                    <label className="field-label">
                      BILDER PRO NUTZER / TAG
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={settings.defaultImageLimit}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            defaultImageLimit: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <p className="help-copy">
                      Individuelle Limits verwaltest du im Tab „Nutzer“. Limit 0
                      sperrt die Generierung.
                    </p>
                  </section>
                  <section
                    className={`admin-panel lockdown-panel${lockdown.enabled ? " locked" : ""}`}
                  >
                    <div className="panel-heading">
                      <div
                        className={`panel-icon ${lockdown.enabled ? "gold" : "green"}`}
                      >
                        <Shield size={20} />
                      </div>
                      <div>
                        <h2>
                          {lockdown.enabled
                            ? "Lockdown aktiv"
                            : "System-Lockdown"}
                        </h2>
                        <p>Admins behalten immer Zugriff.</p>
                      </div>
                      <span
                        className={`service-badge ${lockdown.enabled ? "offline" : "connected"}`}
                      >
                        {lockdown.enabled ? "AKTIV" : "AUS"}
                      </span>
                    </div>
                    {lockdown.enabled ? (
                      <>
                        <div className="lockdown-current">
                          <strong>Grund</strong>
                          <p>{lockdown.reason}</p>
                          <small>Aktiviert von {lockdown.by}</small>
                        </div>
                        <button
                          className="primary-action"
                          type="button"
                          onClick={() => void changeLockdown(false)}
                        >
                          <ShieldCheck size={17} /> Lockdown beenden
                        </button>
                      </>
                    ) : (
                      <>
                        <label className="field-label">
                          GRUND FÜR DEN LOCKDOWN
                          <input
                            value={lockdownReason}
                            onChange={(event) =>
                              setLockdownReason(event.target.value)
                            }
                            placeholder="z. B. Wartung oder Sicherheitsprüfung"
                          />
                        </label>
                        <button
                          className="danger-action lockdown-trigger"
                          type="button"
                          disabled={!lockdownReason.trim()}
                          onClick={() => void changeLockdown(true)}
                        >
                          <Shield size={17} /> System in Lockdown versetzen
                        </button>
                      </>
                    )}
                  </section>
                  <section className="admin-panel privacy-panel">
                    <div className="panel-heading">
                      <div className="panel-icon violet">
                        <LockKeyhole size={20} />
                      </div>
                      <div>
                        <h2>Datenschutz & Zugriff</h2>
                        <p>Lokale Funktionen und Nutzerdaten</p>
                      </div>
                    </div>
                    <div className="privacy-row">
                      <div>
                        <strong>PC-Dateien & Suche</strong>
                        <small>Kein autonomer Dateizugriff vorhanden</small>
                      </div>
                      <span className="private-label">
                        <Check size={14} /> AUS
                      </span>
                    </div>
                    <div className="privacy-row">
                      <div>
                        <strong>Nutzer-Chats</strong>
                        <small>Admin kann alle Verläufe einsehen</small>
                      </div>
                      <span>{adminChats.length} CHATS</span>
                    </div>
                    <button
                      className="danger-action"
                      type="button"
                      onClick={() => void logout()}
                    >
                      <LogOut size={16} /> Admin abmelden
                    </button>
                  </section>
                </div>
                <div className="settings-actions">
                  <button
                    className="primary-action"
                    disabled={settingsSaving}
                    type="button"
                    onClick={() => void saveSettings()}
                  >
                    <Check size={17} />
                    {settingsSaving ? "Speichern …" : "Einstellungen speichern"}
                  </button>
                </div>
              </div>
            )}

            {adminTab === "audit" && (
              <div className="admin-content">
                <div className="admin-section-title">
                  <div>
                    <h2>Sicherheitsprotokoll</h2>
                    <p>Anmeldungen, Moderation und Systemänderungen.</p>
                  </div>
                  <span>{auditEvents.length} EREIGNISSE</span>
                </div>
                <div className="audit-list">
                  {auditEvents.map((event) => (
                    <article className="audit-row" key={event.id}>
                      <span className="audit-mark">
                        <Activity size={16} />
                      </span>
                      <div>
                        <strong>{event.action}</strong>
                        <small>
                          {event.actor} → {event.target}
                          {typeof event.details.reason === "string"
                            ? ` · ${event.details.reason}`
                            : ""}
                        </small>
                      </div>
                      <time>{prettyTime(event.createdAt)}</time>
                    </article>
                  ))}
                  {auditEvents.length === 0 && (
                    <div className="admin-empty">
                      Noch keine protokollierten Ereignisse.
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        ) : (
          <>
            <div className="chat-header">
              <div className="assistant-avatar">
                <Logo small />
              </div>
              <div className="assistant-title">
                <strong>
                  Larky <span className="verified">✓</span>
                </strong>
                <small>
                  <span className={`status-dot ${providerStatus}`} />{" "}
                  {providerStatus === "connected" ? `Online · ${activeModel}` : settings.provider === "gemini" ? geminiConfigured ? "Gemini · Verbindung noch nicht geprüft" : "GEMINI_API_KEY fehlt am Server" : "Ollama Backup · Verbindung ausstehend"}
                </small>
              </div>
              <div className="chat-tools">
                <button
                  className="model-selector"
                  type="button"
                  onClick={() =>
                    canAccessAdmin
                      ? (setScreen("admin"), setAdminTab("systems"))
                      : setStatus(`Modell: ${activeModel}`)
                  }
                >
                  <Bot size={17} />
                  {settings.provider === "gemini" ? <Sparkles size={17} /> : <Bot size={17} />}
                  {activeModel}
                  <ChevronDown size={14} />
                </button>
                {showModelMenu && (
                  <div className="model-popover">
                    <strong>Aktives Modell</strong>
                    <p>{activeModel}</p>
                    <button
                      onClick={() => {
                        setScreen("admin");
                        setAdminTab("systems");
                        setShowModelMenu(false);
                      }}
                    >
                      Im Admin ändern <ArrowLeft size={14} />
                    </button>
                  </div>
                )}
              </div>
              <button
                className="icon-button"
                title="Neuer Chat"
                aria-label="Neuer Chat"
                onClick={() => void createConversation()}
              >
                <SquarePen size={18} />
              </button>
            </div>
            <div className="chat-scroll">
              {activeConversation?.messages.length ? (
                <div className="message-stack">
                  {activeConversation.messages.map((message) => (
                    <article
                      className={`message-row ${message.role}`}
                      key={message.id}
                    >
                      {message.role === "assistant" && (
                        <div className="message-avatar">
                          <Logo small />
                        </div>
                      )}
                      <div className="message-content">
                        <div className={`message-bubble ${message.role}`}>
                          {message.image && (
                            <img
                              className="message-image"
                              src={message.image}
                              alt="Im Chat geteiltes Bild"
                            />
                          )}
                          <p>{message.content}</p>
                        </div>
                        <time>{relativeTime(message.createdAt)}</time>
                      </div>
                      {message.role === "user" && (
                        <div className="user-avatar">
                          {user.displayName.slice(0, 1).toUpperCase()}
                          {user.verified && <VerifiedMark />}
                        </div>
                      )}
                    </article>
                  ))}
                  {busy && (
                    <div className="typing-row">
                      <div className="message-avatar">
                        <Logo small />
                      </div>
                      <div className="typing">
                        <i />
                        <i />
                        <i />
                        <span>Larky denkt nach</span>
                      </div>
                    </div>
                  )}
                  <div ref={messageEnd} />
                </div>
              ) : (
                <div className="welcome">
                  <div className="welcome-glow">
                    <Logo />
                  </div>
                  <div className="eyebrow">DEIN GAMING KI-BEGLEITER</div>
                  <h1>Was geht, {user.displayName}?</h1>
                  <p>Dein lokaler Copilot für Ideen, Code und neue Welten.</p>
                  <div className="welcome-tags">
                    <span>
                      <Zap size={15} /> SCHNELL
                    </span>
                    <span>
                      <LockKeyhole size={15} /> PRIVAT
                    </span>
                    <span>
                      <Sparkles size={15} /> KREATIV
                    </span>
                  </div>
                  <div className="quick-grid">
                    {modes.map(({ key, label, icon: Icon }) => (
                      <button
                        type="button"
                        key={key}
                        onClick={() => {
                          setMode(key);
                          if (key === "edit") fileInput.current?.click();
                        }}
                      >
                        <Icon size={20} />
                        <span>{label}</span>
                        <ArrowUp size={15} />
                      </button>
                    ))}
                  </div>
                  <div className="starter-note">
                    <span className={`status-dot ${providerStatus}`} />{" "}
                    {providerStatus === "connected"
                      ? `Verbunden mit ${activeModel}`
                      : settings.provider === "gemini"
                        ? geminiConfigured
                          ? "Google Gemini · Verbindung noch nicht geprüft"
                          : "Gemini-Schlüssel im Server einrichten."
                        : "Ollama-Backup im Admin-Bereich verbinden."}
                  </div>
                </div>
              )}
            </div>
            <div className="composer-area">
              {status && (
                <div className="notice" role="status">
                  {status}
                  <button
                    type="button"
                    aria-label="Meldung schließen"
                    onClick={() => setStatus("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {mode !== "chat" && (
                <div className="mode-chip">
                  <Sparkles size={15} /> {modeLabels[mode]}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("chat");
                      setAttachedImage(null);
                    }}
                    aria-label="Modus schließen"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {attachedImage && (
                <div className="attachment-preview">
                  <img src={attachedImage} alt="Bildvorschau" />
                  <span>Bild bereit zur Bearbeitung</span>
                  <button
                    type="button"
                    aria-label="Bild entfernen"
                    onClick={() => setAttachedImage(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className="composer">
                <div className="composer-input">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder={
                      mode === "image"
                        ? "Beschreibe das Bild, das du erstellen möchtest …"
                        : mode === "edit"
                          ? "Wie soll das Bild verändert werden?"
                          : "Schreib Larky eine Nachricht …"
                    }
                    rows={2}
                  />
                  <div className="composer-meta">
                    <div>
                      <button
                        className="composer-tool"
                        type="button"
                        title="Bild anhängen"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Paperclip size={18} />
                      </button>
                      <button
                        className="composer-tool"
                        type="button"
                        title="Bild erstellen"
                        onClick={() => setMode("image")}
                      >
                        <ImagePlus size={18} />
                      </button>
                      <button
                        className="composer-tool"
                        type="button"
                        title="Werkzeug auswählen"
                        aria-expanded={showToolMenu}
                        onClick={() => setShowToolMenu((visible) => !visible)}
                      >
                        <WandSparkles size={18} />
                      </button>
                      <span className="privacy-hint">
                        <LockKeyhole size={12} /> LOKAL
                      </span>
                    </div>
                    <span>
                      ENTER <b>↵</b>
                    </span>
                  </div>
                </div>
                <button
                  className="send-button"
                  type="button"
                  aria-label="Nachricht senden"
                  disabled={!draft.trim() || busy}
                  onClick={() => void sendMessage()}
                >
                  {busy ? (
                    <span className="send-spinner" />
                  ) : (
                    <Send size={19} />
                  )}
                </button>
                {showToolMenu && (
                  <div className="tool-popover" role="menu">
                    {modes.map(({ key, label, icon: Icon }) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={key}
                        onClick={() => {
                          setMode(key);
                          setShowToolMenu(false);
                          if (key === "edit") fileInput.current?.click();
                        }}
                      >
                        <Icon size={17} />
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="composer-footer">
                <span>
                  <span
                    className={`status-dot ${mode === "image" || mode === "edit" ? imageStatus : providerStatus}`}
                  />
                  {mode === "image" || mode === "edit"
                    ? `BILDER ${user.imagesUsedToday} / ${user.imageDailyLimit} HEUTE`
                    : `${settings.provider === "gemini" ? "GEMINI" : "OLLAMA BACKUP"} ${providerStatus === "connected" ? "VERBUNDEN" : "NICHT GEPRÜFT"}`}
                </span>
                <span>KI-ANTWORTEN KÖNNEN FEHLER ENTHALTEN</span>
              </div>
              <input
                ref={fileInput}
                className="visually-hidden"
                type="file"
                accept="image/*"
                onChange={(event) => handleImageFile(event.target.files?.[0])}
              />
            </div>
          </>
        )}
      </section>
      {moderationTarget && moderationAction && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setModerationTarget(null);
          }}
        >
          <section
            className="dialog moderation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="moderation-title"
          >
            <button
              className="dialog-close"
              type="button"
              aria-label="Schließen"
              onClick={() => setModerationTarget(null)}
            >
              <X size={19} />
            </button>
            <div className="panel-icon gold">
              {moderationAction === "ban" ? (
                <Ban size={20} />
              ) : moderationAction === "kick" ? (
                <LogOut size={20} />
              ) : (
                <Timer size={20} />
              )}
            </div>
            <h2 id="moderation-title">
              {moderationAction === "ban"
                ? "Nutzer bannen"
                : moderationAction === "kick"
                  ? "Nutzer kicken"
                  : "Timeout setzen"}
            </h2>
            <p>
              {moderationTarget.displayName} · {moderationTarget.email}
            </p>
            <form onSubmit={(event) => void performModeration(event)}>
              <label className="field-label">
                GRUND
                <textarea
                  value={moderationReason}
                  onChange={(event) => setModerationReason(event.target.value)}
                  required={moderationAction !== "kick"}
                  rows={3}
                  maxLength={500}
                  placeholder="Grund für die Maßnahme"
                />
              </label>
              {moderationAction !== "kick" && (
                <label className="field-label">
                  DAUER IN MINUTEN
                  <input
                    type="number"
                    min="0"
                    max="525600"
                    value={durationMinutes}
                    onChange={(event) =>
                      setDurationMinutes(Number(event.target.value))
                    }
                  />
                  <small>0 = unbefristet</small>
                </label>
              )}
              <button
                className={
                  moderationAction === "ban"
                    ? "danger-action modal-submit"
                    : "primary-action"
                }
                type="submit"
              >
                Maßnahme bestätigen
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
