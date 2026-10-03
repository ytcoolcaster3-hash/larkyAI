function geminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (key) return key;
  const error = new Error("GEMINI_API_KEY fehlt auf dem Server.");
  error.statusCode = 503;
  throw error;
}

async function geminiRequest(model, payload, signal) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey(),
      },
      body: JSON.stringify(payload),
      signal: signal || AbortSignal.timeout(180000),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      response.status === 429
        ? "Gemini-Anfragelimit erreicht. Bitte später erneut versuchen."
        : "Gemini-Anfrage fehlgeschlagen. Prüfe Modell und API-Key in der Serverkonfiguration.",
    );
    error.statusCode = response.status === 429 ? 429 : 502;
    throw error;
  }
  return result;
}

export async function generateText(
  settings,
  { messages, systemPrompt, options = {}, signal },
) {
  if (settings.provider === "gemini") {
    const result = await geminiRequest(
      settings.geminiModel,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((message) => ({
          role:
            message.role === "assistant" || message.role === "model"
              ? "model"
              : "user",
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          topP: options.topP ?? 0.9,
        },
      },
      signal,
    );
    return {
      content: (result.candidates?.[0]?.content?.parts || [])
        .map((part) => part.text || "")
        .join("")
        .trim(),
      usage: result.usageMetadata || {},
      model: settings.geminiModel,
    };
  }

  const response = await fetch(
    `${settings.ollamaUrl.replace(/\/$/, "")}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
          top_p: options.topP ?? 0.9,
          num_ctx: options.contextLength ?? 4096,
        },
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((message) => ({
            role: message.role === "model" ? "assistant" : message.role,
            content: message.content,
          })),
        ],
      }),
      signal: signal || AbortSignal.timeout(120000),
    },
  );
  if (!response.ok) {
    const error = new Error(
      "Ollama-Anfrage fehlgeschlagen. Prüfe den Backup-Server und das Modell.",
    );
    error.statusCode = 502;
    throw error;
  }
  const result = await response.json();
  return {
    content: result.message?.content || "",
    usage: {
      promptTokenCount: result.prompt_eval_count,
      candidatesTokenCount: result.eval_count,
      totalDuration: result.total_duration,
    },
    model: settings.model,
  };
}

export async function generateGeminiImage(settings, prompt, sourceImage) {
  const parts = [{ text: prompt }];
  if (sourceImage) {
    const match = sourceImage.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s,
    );
    if (!match)
      throw new Error(
        "Das ausgewählte Bildformat konnte nicht gelesen werden.",
      );
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  const result = await geminiRequest(settings.geminiImageModel, {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
  });
  const outputParts = result.candidates?.[0]?.content?.parts || [];
  const imagePart = outputParts.find((part) => part.inlineData?.data);
  if (!imagePart)
    throw new Error(
      "Gemini hat kein Bild zurückgegeben. Prüfe Modellzugriff und Bild-API-Freigabe.",
    );
  const mimeType = imagePart.inlineData.mimeType || "image/png";
  const content = outputParts
    .map((part) => part.text || "")
    .join("")
    .trim();
  return {
    image: `data:${mimeType};base64,${imagePart.inlineData.data}`,
    content,
  };
}
