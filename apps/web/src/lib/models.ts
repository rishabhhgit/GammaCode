/** Known model context window sizes (in tokens) - matches server defaults */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // GPT-5 series (400K context)
  "gpt-5": 400000,
  "gpt-5.1": 400000,
  "gpt-5.2": 400000,
  "gpt-5.3": 400000,
  "gpt-5.4": 400000,
  "gpt-5-mini": 400000,
  "gpt-5.1-mini": 400000,
  "gpt-5-codex": 400000,
  // GPT-4.5 (128K)
  "gpt-4.5": 128000,
  "gpt-4.5-mini": 128000,
  // GPT-4.1 (1M)
  "gpt-4.1": 1047576,
  "gpt-4.1-mini": 1047576,
  "gpt-4.1-nano": 1047576,
  // GPT-4o
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  // GPT-4 Turbo
  "gpt-4-turbo": 128000,
  // GPT-4
  "gpt-4": 128000,
  // Reasoning
  o1: 200000,
  "o1-mini": 128000,
  "o1-preview": 200000,
  "o1-pro": 200000,
  o3: 200000,
  "o3-mini": 200000,
  "o3-pro": 200000,
  "o4-mini": 200000,
  // Claude 4
  "claude-opus-4-20250514": 200000,
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-haiku-4-5": 200000,
  // Claude 3.5
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-5-haiku-20241022": 200000,
  // Claude 3
  "claude-3-opus-20240229": 200000,
  "claude-3-sonnet-20240229": 200000,
  "claude-3-haiku-20240307": 200000,
  // Gemini (1M context)
  "gemini-3.8-flash": 1048576,
  "gemini-3.7-flash": 1048576,
  "gemini-3.6-flash": 1048576,
  "gemini-3.5-flash": 1048576,
  "gemini-3.5-flash-lite": 1048576,
  "gemini-3.1-pro-preview": 1048576,
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash": 1048576,
  // Mistral
  "mistral-medium-latest": 256000,
  "mistral-small-latest": 256000,
  "codestral-latest": 256000,
  "ministral-14b-latest": 256000,
  "ministral-8b-latest": 128000,
  "ministral-3b-latest": 128000,
  // Grok
  "grok-2": 131072,
  "grok-beta": 131072,
  "grok-code-fast-1": 131072,
  // ChatGPT
  "chatgpt-4o-latest": 128000,
  // DeepSeek (128K)
  "deepseek-chat": 128000,
  "deepseek-coder": 128000,
  "deepseek-reasoner": 128000,
  // Llama
  "llama-4-maverick": 200000,
  "llama-3.3-70b": 128000,
  "llama-3.1-405b": 128000,
  // CodeLlama
  "codellama-70b": 128000,
  "codellama-34b": 128000,
  // Qwen
  "qwen2.5-coder": 32768,
  // Kimi
  "kimi-k2.5": 200000,
  // MiniMax
  "minimax-m2.5": 100000,
};

/** Get context limit for a model - uses server-provided limits first, then falls back to hardcoded */
export function getModelContextLimit(
  modelId: string,
  serverLimits?: Record<string, number>,
): number {
  if (serverLimits && serverLimits[modelId]) return serverLimits[modelId];
  if (MODEL_CONTEXT_LIMITS[modelId]) return MODEL_CONTEXT_LIMITS[modelId];
  const base = modelId
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  if (MODEL_CONTEXT_LIMITS[base]) return MODEL_CONTEXT_LIMITS[base];
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(key)) return limit;
  }
  return 128000;
}

/** Format context limit for display */
export function getModelContextLabel(
  modelId: string,
  serverLimits?: Record<string, number>,
): string | undefined {
  const limit = getModelContextLimit(modelId, serverLimits);
  if (limit >= 1000000) return `${(limit / 1000000).toFixed(1)}M`;
  if (limit >= 100000) return `${(limit / 1000).toFixed(0)}K`;
  if (limit >= 1000) return `${(limit / 1000).toFixed(0)}K`;
  return undefined;
}

/** Format token count for display (e.g. 12345 → "12.3K", 1234567 → "1.2M") */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/** Known exact model-ID → display-name mappings (hoisted: prettifyModelId is
 *  called per message row, and rebuilding this object each time added up). */
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gpt-4": "GPT 4",
  "gpt-4-turbo": "GPT 4 Turbo",
  "gpt-4o": "GPT 4o",
  "gpt-4o-mini": "GPT 4o Mini",
  "gpt-4.1": "GPT 4.1",
  "gpt-4.1-mini": "GPT 4.1 Mini",
  "gpt-4.1-nano": "GPT 4.1 Nano",
  "gpt-4.5-preview": "GPT 4.5 Preview",
  "gpt-5": "GPT 5",
  "gpt-5-mini": "GPT 5 Mini",
  "gpt-5-turbo": "GPT 5 Turbo",
  "gpt-5.2-codex": "GPT 5.2 Codex",
  "gpt-5.3": "GPT 5.3",
  "gpt-5.3-codex": "GPT 5.3 Codex",
  "gpt-5.4": "GPT 5.4",
  o1: "O1",
  "o1-mini": "O1 Mini",
  "o1-preview": "O1 Preview",
  o3: "O3",
  "o3-mini": "O3 Mini",
  "o4-mini": "O4 Mini",
  "chatgpt-4o-latest": "ChatGPT 4o Latest",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "claude-3-5-haiku": "Claude 3.5 Haiku",
  "claude-3-opus": "Claude 3 Opus",
  "claude-3-sonnet": "Claude 3 Sonnet",
  "claude-3-haiku": "Claude 3 Haiku",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "grok-code-fast-1": "Grok Code Fast 1",
  "mistral-medium-latest": "Mistral Medium 3.5",
  "mistral-small-latest": "Mistral Small 4",
  "codestral-latest": "Codestral",
  "ministral-14b-latest": "Ministral 14B",
  "ministral-8b-latest": "Ministral 8B",
  "ministral-3b-latest": "Ministral 3B",
};

/** Convert raw model IDs into human-friendly display names */
export function prettifyModelId(raw: string): string {
  const known = MODEL_DISPLAY_NAMES;

  const stripped = raw
    .replace(/-\d{4}-?\d{2}-?\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  if (known[stripped]) return known[stripped];
  if (known[raw]) return known[raw];

  if (raw.includes("/")) {
    const parts = raw.split("/");
    const modelPart = parts[parts.length - 1] ?? raw;
    return prettifyModelId(modelPart);
  }

  if (stripped.startsWith("claude-")) {
    return stripped
      .replace("claude-", "Claude ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  if (stripped.startsWith("gemini-")) {
    return stripped
      .replace("gemini-", "Gemini ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  if (stripped.startsWith("grok-")) {
    return stripped
      .replace("grok-", "Grok ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  return stripped
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}
