/* ================================================================
   Provider conversation-history builders — SINGLE SOURCE OF TRUTH

   Every AI call path (streaming and non-streaming) MUST build its
   request messages through these functions. Hand-rolled mapping at a
   call site is how "Role 'function' is not supported" and
   "Function call is missing a thought_signature"400s shipped: the
   fix went into one path and its twin diverged.

   Invariants enforced here (locked down by history.selftest.ts):
   - Gemini: no "function" role ever; functionResponse parts live in
     "user" turns, grouped per model turn; thought signatures that
     accompanied a functionCall are echoed back on it.
   - Anthropic: tool_results for one assistant turn live in a SINGLE
     user message; roles strictly alternate; first message is user;
     no empty content.
   - OpenAI/Copilot chat-completions: tool messages carry
     tool_call_id; assistant tool_calls are answered or stripped;
     extra_content only ever sent to Gemini-compatible endpoints.
   - All: dangling tool_calls (aborted runs) are stripped, orphan
     tool results dropped — every provider 400s on both.
   ================================================================ */

import type { Content, Part } from "@google/generative-ai";
import { logger } from "./logger.js";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Carrier for provider-specific extras. Normalized shape is
   *  { thoughtSignature }; the Gemini OpenAI-compat wire shape
   *  { google: { thought_signature } } is re-derived at send time. */
  extra_content?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  attachments?: Array<{ id: string; name: string; mimeType: string; size: number; data: string }>;
}

/** Pull a Gemini thought signature out of any shape seen in the wild:
 *  native SDK { thoughtSignature } or OpenAI-compat
 *  { google: { thought_signature } }. */
export function pickThoughtSignature(extra: Record<string, unknown> | undefined): string | undefined {
  if (!extra) return undefined;
  const direct = extra.thoughtSignature;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const google = extra.google as { thought_signature?: unknown } | undefined;
  const nested = google?.thought_signature;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return undefined;
}

/** Strip tool artifacts every provider rejects:
 *  - tool results whose tool_call_id has no owning assistant tool_calls entry
 *  - tool_calls that were never answered by a result (aborted runs leave the
 *    conversation dangling; OpenAI/Anthropic/Gemini all400 on this)
 *  - assistant messages left with neither text nor tool_calls
 *  Tool-call ids are unique per session (see call sites), so the id set is
 *  a safe correlation key. */
export function normalizeToolFlow(messages: ChatMessage[]): ChatMessage[] {
  // Collect ids from ASSISTANT tool_calls only — building this set from the
  // tool messages themselves would let orphan results validate their own ids.
  const askedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) askedIds.add(tc.id);
    }
  }

  let dropped = 0;
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      if (!m.tool_call_id || !askedIds.has(m.tool_call_id)) {
        dropped += 1;
        continue;
      }
      out.push(m);
      continue;
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const kept = m.tool_calls.filter((tc) => hasLaterResult(messages, tc.id));
      if (kept.length === 0) {
        dropped += m.tool_calls.length;
        if (!m.content) continue; // nothing left of this message
        out.push({ ...m, tool_calls: undefined });
        continue;
      }
      if (kept.length !== m.tool_calls.length) {
        dropped += m.tool_calls.length - kept.length;
        out.push({ ...m, tool_calls: kept });
        continue;
      }
      out.push(m);
      continue;
    }

    // Anthropic rejects empty content blocks outright.
    if (!m.content && !(m.attachments && m.attachments.length > 0)) {
      dropped += 1;
      continue;
    }
    out.push(m);
  }

  if (dropped > 0) {
    logger.warn("history.normalized", { dropped, remaining: out.length });
  }
  return out;
}

/** True when a tool message referencing this id appears AFTER the assistant
 *  turn that asked for it (a later round's tool message with a colliding id
 *  must not count as an answer). */
function hasLaterResult(messages: ChatMessage[], toolCallId: string): boolean {
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id === toolCallId) return true;
  }
  return false;
}

/* ----------------------------------------------------------------
   OpenAI Chat Completions (+ Copilot chat-completions fallback,
   Mistral, OpenRouter, Ollama, custom providers)
   ---------------------------------------------------------------- */
export function buildOpenAIContents(
  messages: ChatMessage[],
  opts: { geminiCompat?: boolean } = {}
): Array<Record<string, unknown>> {
  const cleaned = normalizeToolFlow(messages);

  return cleaned.map((m) => {
    let content: string | Array<Record<string, unknown>> = m.content;
    if (m.role === "user" && m.attachments && m.attachments.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const att of m.attachments) {
        if (att.mimeType.startsWith("image/") || att.mimeType === "application/pdf") {
          parts.push({ type: "image_url", image_url: { url: `data:${att.mimeType};base64,${att.data}` } });
        }
      }
      content = parts;
    }

    const msg: Record<string, unknown> = { role: m.role, content };

    if (m.tool_calls && m.tool_calls.length > 0) {
      msg.tool_calls = m.tool_calls.map((tc) => {
        const entry: Record<string, unknown> = {
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments }
        };
        // extra_content is a Gemini-compat extension. Sending it to OpenAI
        // (or any strict gateway) after a mid-session provider switch gets
        // the whole request rejected — only re-emit it for Gemini endpoints,
        // in the shape those endpoints returned it.
        const signature = pickThoughtSignature(tc.extra_content);
        if (opts.geminiCompat && signature) {
          entry.extra_content = { google: { thought_signature: signature } };
        }
        return entry;
      });
    }

    if (m.role === "tool") {
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
    }

    return msg;
  });
}

/** True when the endpoint speaks Gemini over the OpenAI surface (Gemini's
 *  own /openai base, OpenRouter's google/* models, custom providers pointed
 *  at googleapis). Only these understand extra_content thought signatures. */
export function isGeminiCompatEndpoint(baseUrlOrId: string): boolean {
  return (
    baseUrlOrId.includes("generativelanguage.googleapis.com") ||
    baseUrlOrId.includes("openrouter.ai") ||
    baseUrlOrId === "gemini" ||
    baseUrlOrId === "openrouter"
  );
}

/* ----------------------------------------------------------------
   Copilot Responses API (GPT-5+ models)
   ---------------------------------------------------------------- */
export function buildCopilotResponsesInput(
  messages: ChatMessage[],
  opts: { isReasoning: boolean }
): Array<Record<string, unknown>> {
  const cleaned = normalizeToolFlow(messages);
  const input: Array<Record<string, unknown>> = [];

  for (const m of cleaned) {
    if (m.role === "system") {
      input.push({ role: opts.isReasoning ? "developer" : "system", content: m.content });
    } else if (m.role === "user") {
      if (m.attachments && m.attachments.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        if (m.content) parts.push({ type: "input_text", text: m.content });
        for (const att of m.attachments) {
          if (att.mimeType.startsWith("image/")) {
            parts.push({ type: "input_image", image_url: `data:${att.mimeType};base64,${att.data}` });
          }
        }
        input.push({ role: "user", content: parts });
      } else {
        input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
      }
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        if (m.content) input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
        for (const tc of m.tool_calls) {
          input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
        }
      } else {
        input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
    }
  }

  return input;
}

/* ----------------------------------------------------------------
   Anthropic Messages API
   ---------------------------------------------------------------- */
export function buildAnthropicContents(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
} {
  const system = messages.find((m) => m.role === "system" && m.content)?.content;
  const cleaned = normalizeToolFlow(messages.filter((m) => m.role !== "system"));

  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  // Anthropic rejects consecutive same-role messages, so same-role blocks
  // are always appended onto the previous entry instead of pushed fresh.
  const pushBlocks = (role: "user" | "assistant", blocks: Array<Record<string, unknown>>) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as Array<Record<string, unknown>>).push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };

  for (let i = 0; i < cleaned.length; i++) {
    const m = cleaned[i]!;
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      pushBlocks("assistant", blocks);
    } else if (m.role === "tool") {
      // All tool_results answering one assistant turn MUST be in a single
      // user message — separate messages break tool_use correlation and
      // violate role alternation.
      const blocks: Array<Record<string, unknown>> = [];
      while (i < cleaned.length && cleaned[i]!.role === "tool") {
        const tm = cleaned[i]!;
        blocks.push({ type: "tool_result", tool_use_id: tm.tool_call_id ?? "", content: tm.content });
        i += 1;
      }
      i -= 1; // outer loop increments
      pushBlocks("user", blocks);
    } else {
      const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
      if (m.attachments && m.attachments.length > 0) {
        const blocks: Array<Record<string, unknown>> = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const att of m.attachments) {
          if (att.mimeType.startsWith("image/")) {
            blocks.push({ type: "image", source: { type: "base64", media_type: att.mimeType, data: att.data } });
          } else if (att.mimeType === "application/pdf") {
            blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data } });
          }
        }
        pushBlocks(role, blocks);
      } else {
        pushBlocks(role, [{ type: "text", text: m.content }]);
      }
    }
  }

  // Anthropic requires the first message to be from the user.
  if (out.length === 0) {
    out.push({ role: "user", content: [{ type: "text", text: "(start)" }] });
  } else if (out[0]!.role !== "user") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(start)" }] });
  }

  return { system, messages: out };
}

/* ----------------------------------------------------------------
   Gemini (native SDK — generateContent/generateContentStream)
   ---------------------------------------------------------------- */

/** Build Gemini `contents` from chat messages.
 *  Gemini has NO "function" role (REST 400: "Role 'function' is not
 *  supported") — functionResponse parts go in "user" turns, with all
 *  responses for one model turn grouped into a single Content so the
 *  part count matches the preceding functionCall count.
 *  Trailing tool results are not history: they form the new turn and are
 *  returned separately to be sent as the request's final user Content.
 *  Thinking models require each functionCall's thoughtSignature to be
 *  echoed back on the part, or the API400s. */
export function buildGeminiContents(chatMessages: ChatMessage[]): { history: Content[]; newTurnParts: Part[] } {
  const messages = normalizeToolFlow(chatMessages);

  let split = messages.length - 1;
  if (messages[split]?.role === "tool") {
    while (split > 0 && messages[split - 1]?.role === "tool") split -= 1;
  }

  const history: Content[] = [];
  for (let i = 0; i < split; i++) {
    const m = messages[i];

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = JSON.parse(tc.function.arguments);
        } catch {
          /* empty */
        }
        const thoughtSignature = pickThoughtSignature(tc.extra_content);
        parts.push({
          functionCall: { name: tc.function.name, args: argsObj },
          ...(thoughtSignature ? { thoughtSignature } : {})
        } as Part);
      }
      history.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const parts: Part[] = [];
      while (i < split && messages[i]!.role === "tool") {
        const tm = messages[i]!;
        let resultObj: unknown;
        try {
          resultObj = JSON.parse(tm.content);
        } catch {
          resultObj = { result: tm.content };
        }
        parts.push({ functionResponse: { name: tm.name ?? "unknown", response: resultObj as Record<string, unknown> } });
        i += 1;
      }
      i -= 1; // outer loop increments
      history.push({ role: "user", parts });
    } else {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.attachments) {
        for (const att of m.attachments) {
          parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
        }
      }
      history.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
  }

  const pending = messages.slice(split);
  const newTurnParts: Part[] = [];
  if (pending[0]?.role === "tool") {
    for (const tm of pending) {
      let resultObj: unknown;
      try {
        resultObj = JSON.parse(tm.content);
      } catch {
        resultObj = { result: tm.content };
      }
      newTurnParts.push({ functionResponse: { name: tm.name ?? "unknown", response: resultObj as Record<string, unknown> } });
    }
  } else if (pending[0]) {
    if (pending[0].content) newTurnParts.push({ text: pending[0].content });
    for (const att of pending[0].attachments ?? []) {
      newTurnParts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
    }
  }

  return { history, newTurnParts };
}
