/* ================================================================
   Regression selftest for history.ts — run: pnpm --filter @gamma-code/server exec tsx src/history.selftest.ts
   Locks the invariants that previously shipped as Gemini/Anthropic
   400s: no "function" role, tool_result grouping, alternation,
   thought-signature echo, dangling-tool stripping, extra_content
   sanitization. Exits non-zero on any failure.
   ================================================================ */

import {
  buildOpenAIContents,
  buildAnthropicContents,
  buildGeminiContents,
  buildCopilotResponsesInput,
  normalizeToolFlow,
  pickThoughtSignature,
  isGeminiCompatEndpoint,
  type ChatMessage
} from "./history.js";

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
  }
}

/* ---- Fixture: multi-round conversation with parallel tool calls ---- */
const multiRound: ChatMessage[] = [
  { role: "system", content: "You are a coding assistant." },
  { role: "user", content: "Read package.json and the README." },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_a",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"package.json"}' },
        extra_content: { thoughtSignature: "sig-A" }
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
        extra_content: { thoughtSignature: "sig-B" }
      }
    ]
  },
  { role: "tool", content: '{"name":"@gamma-code/server"}', tool_call_id: "call_a", name: "read_file" },
  { role: "tool", content: "# GammaCode", tool_call_id: "call_b", name: "read_file" },
  {
    role: "assistant",
    content: "The server package is @gamma-code/server.",
    tool_calls: [
      {
        id: "call_c",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
        extra_content: { thoughtSignature: "sig-C" }
      }
    ]
  },
  { role: "tool", content: "/* server source */", tool_call_id: "call_c", name: "read_file" }
];

/* ---- 1. Gemini ---- */
{
  const { history, newTurnParts } = buildGeminiContents(multiRound);

  check("gemini: no function role anywhere", history.every((c) => c.role === "user" || c.role === "model"));

  const functionResponses = history.filter((c) => c.parts.some((p) => "functionResponse" in p));
  check("gemini: parallel functionResponses grouped in ONE user turn", functionResponses.length === 1);
  check("gemini: that grouped turn has 2 functionResponse parts", functionResponses[0]?.parts.length === 2);

  const modelTurns = history.filter((c) => c.role === "model");
  const withSigs = modelTurns.flatMap((c) =>
    c.parts.filter((p) => {
      if (!("functionCall" in p)) return false;
      return typeof (p as unknown as Record<string, unknown>).thoughtSignature === "string";
    })
  );
  check("gemini: thought signatures echoed on all 3 functionCalls", withSigs.length === 3);

  check("gemini: newTurnParts is a single functionResponse", newTurnParts.length === 1 && "functionResponse" in newTurnParts[0]!);

  // Trailing tool results NOT duplicated into history
  const lastHistory = history[history.length - 1]!;
  check("gemini: last history entry is not the pending functionResponse", !lastHistory.parts.some((p) => "functionResponse" in p) || lastHistory !== newTurnParts as never);
}

/* ---- 2. Anthropic ---- */
{
  const { system, messages } = buildAnthropicContents(multiRound);
  check("anthropic: system extracted", system === "You are a coding assistant.");
  check("anthropic: first message is user", messages[0]?.role === "user");

  // Alternation
  let alternates = true;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]!.role === messages[i - 1]!.role) alternates = false;
  }
  check("anthropic: roles strictly alternate", alternates, messages);

  // The parallel round's two results must share ONE user message; the later
  // single-call round legitimately forms its own user message.
  const toolResultMsgs = messages.filter(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === "tool_result")
  );
  const blocksOf = (m: (typeof toolResultMsgs)[number]) =>
    ((m.content ?? []) as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === "tool_result");
  const parallelMsg = toolResultMsgs.find((m) => blocksOf(m).some((b) => b.tool_use_id === "call_a"));
  const callBAlone = toolResultMsgs.find(
    (m) => m !== parallelMsg && blocksOf(m).some((b) => b.tool_use_id === "call_b")
  );
  check("anthropic: both parallel tool_results in ONE user message", parallelMsg !== undefined && callBAlone === undefined, toolResultMsgs);
  check("anthropic: that message holds 2 tool_result blocks", parallelMsg !== undefined && blocksOf(parallelMsg).length === 2);
  check(
    "anthropic: tool_result tool_use_ids match the assistant tool_use ids",
    parallelMsg !== undefined &&
      blocksOf(parallelMsg).some((b) => b.tool_use_id === "call_a") &&
      blocksOf(parallelMsg).some((b) => b.tool_use_id === "call_b")
  );

  // tool_use blocks present with correct ids
  const assistantMsg = messages.find(
    (m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === "tool_use")
  );
  const toolUseBlocks = ((assistantMsg?.content ?? []) as Array<{ type: string; id?: string }>).filter((b) => b.type === "tool_use");
  check("anthropic: 2 tool_use blocks in first assistant turn", toolUseBlocks.length === 2);
}

/* ---- 3. OpenAI (strict — no extra_content) ---- */
{
  const contents = buildOpenAIContents(multiRound, { geminiCompat: false });
  const toolMsg = contents.find((m) => m.role === "tool");
  check("openai: tool messages carry tool_call_id", toolMsg?.tool_call_id === "call_a");

  const assistant = contents.find((m) => m.role === "assistant" && m.tool_calls);
  const tcs = (assistant?.tool_calls ?? []) as Array<Record<string, unknown>>;
  check("openai: assistant tool_calls have id/type/function", tcs.length === 2 && tcs.every((t) => t.id && t.type === "function" && t.function));

  check("openai: extra_content NOT sent to strict providers", tcs.every((t) => !("extra_content" in t)));
  check("openai: no role 'tool' entry without tool_call_id", contents.every((m) => m.role !== "tool" || typeof m.tool_call_id === "string"));

  // Gemini-compat: extra_content echoed in google shape
  const compat = buildOpenAIContents(multiRound, { geminiCompat: true });
  const compatAssistant = compat.find((m) => m.role === "assistant" && m.tool_calls);
  const compatTcs = (compatAssistant?.tool_calls ?? []) as Array<Record<string, unknown>>;
  const withExtra = compatTcs.filter((t) => "extra_content" in t) as Array<{ extra_content: { google: { thought_signature: string } } }>;
  check("openai-compat: 2 tool_calls with google-shaped extra_content", withExtra.length === 2);
  check(
    "openai-compat: thought_signature values preserved",
    withExtra.every((t) => typeof t.extra_content?.google?.thought_signature === "string")
  );
}

/* ---- 4. Copilot Responses API ---- */
{
  const input = buildCopilotResponsesInput(multiRound, { isReasoning: false });
  check("responses: system role present", input[0]?.role === "system");
  const fnCalls = input.filter((i) => i.type === "function_call") as Array<{ call_id: string }>;
  const fnOutputs = input.filter((i) => i.type === "function_call_output") as Array<{ call_id: string }>;
  check("responses: 3 function_call items", fnCalls.length === 3);
  check("responses: 3 function_call_output items", fnOutputs.length === 3);
  const callIds = new Set(fnCalls.map((c) => c.call_id));
  check("responses: every output references a known call_id", fnOutputs.every((o) => callIds.has(o.call_id)));
}

/* ---- 5. normalizeToolFlow guards ---- */
{
  // Dangling assistant tool_calls (abort mid-round): stripped
  const dangling: ChatMessage[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "orphan_1", type: "function", function: { name: "read_file", arguments: "{}" } }]
    }
  ];
  const cleaned = normalizeToolFlow(dangling);
  check("normalize: dangling unanswered tool_calls dropped", cleaned.length === 1 && cleaned[0]!.role === "user", cleaned);

  // Orphan tool result (result without owning assistant turn): dropped
  const orphanResult: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", content: "{}", tool_call_id: "never_asked", name: "read_file" },
    { role: "assistant", content: "done" }
  ];
  const cleaned2 = normalizeToolFlow(orphanResult);
  check("normalize: orphan tool result dropped", cleaned2.every((m) => m.role !== "tool"));

  // Partially answered: only answered calls kept
  const partial: ChatMessage[] = [
    { role: "user", content: "do two things" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "ok_1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "missing_2", type: "function", function: { name: "b", arguments: "{}" } }
      ]
    },
    { role: "tool", content: "done", tool_call_id: "ok_1", name: "a" }
  ];
  const cleaned3 = normalizeToolFlow(partial);
  const keptCalls = (cleaned3[1]?.tool_calls ?? []) as Array<{ id: string }>;
  check("normalize: unanswered tool_calls stripped, answered kept", keptCalls.length === 1 && keptCalls[0]?.id === "ok_1", cleaned3);

  // Empty text-only messages dropped (Anthropic rejects empty content)
  const empties: ChatMessage[] = [
    { role: "user", content: "" },
    { role: "assistant", content: "real" }
  ];
  check("normalize: empty text messages dropped", normalizeToolFlow(empties).length === 1);
}

/* ---- 6. pickThoughtSignature shapes ---- */
{
  check("sig: native shape", pickThoughtSignature({ thoughtSignature: "s1" }) === "s1");
  check("sig: compat google shape", pickThoughtSignature({ google: { thought_signature: "s2" } }) === "s2");
  check("sig: missing → undefined", pickThoughtSignature(undefined) === undefined);
  check("sig: unrelated extras → undefined", pickThoughtSignature({ other: 1 }) === undefined);
}

/* ---- 7. isGeminiCompatEndpoint ---- */
{
  check("compat: googleapis base", isGeminiCompatEndpoint("https://generativelanguage.googleapis.com/v1beta/openai"));
  check("compat: openrouter", isGeminiCompatEndpoint("https://openrouter.ai/api/v1"));
  check("compat: mistral not gemini", !isGeminiCompatEndpoint("https://api.mistral.ai/v1"));
  check("compat: openai not gemini", !isGeminiCompatEndpoint("https://api.openai.com/v1"));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll history selftests passed.");
