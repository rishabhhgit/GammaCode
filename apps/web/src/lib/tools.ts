/** JSON.parse of tool-call arguments, memoized per tool-call object. Message
 *  rows re-parse the same strings on every render, and streamed token updates
 *  re-render the whole tool list — a large write_file payload was parsed
 *  dozens of times per second. */
const toolArgsCache = new WeakMap<object, Record<string, unknown>>();

export function parseToolArgs(tc: {
  arguments?: string;
}): Record<string, unknown> {
  const cached = toolArgsCache.get(tc);
  if (cached) return cached;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  toolArgsCache.set(tc, parsed);
  return parsed;
}

/** Consistent human-readable label for every tool call — used in both the
 *  completed-message blocks and the live streaming blocks so the UI never
 *  mixes raw snake_case names with humanized text. */
export function formatToolLabel(
  name: string,
  args: Record<string, unknown>,
): string {
  const filePath = args.path as string | undefined;
  switch (name) {
    case "run_command":
      return `$ ${(args.command as string) || name}`;
    case "read_file":
      return `Read ${filePath || ""}`;
    case "write_file":
    case "write_files":
      return `Write ${filePath || "(multiple files)"}`;
    case "edit_file":
      return `Edit ${filePath || ""}`;
    case "list_files":
      return `List ${filePath || "."}`;
    case "grep_search":
      return `Grep "${(args.pattern as string) || ""}"`;
    default:
      return name;
  }
}
