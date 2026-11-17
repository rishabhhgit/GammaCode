import path from "node:path";

export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Robust workspace path resolution that handles model quirks:
 *  - leading slashes (e.g. `/src/index.ts` -> `src/index.ts`)
 *  - quotes and whitespace (e.g. ` 'src/index.ts' `)
 *  - synthetic roots (e.g. `workspace/src/...`, `project/src/...`, `/workspace/...`)
 *  - full absolute paths already inside workspaceRoot
 *  Returns null if path traverses outside workspaceRoot. */
export function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath: string
): { absPath: string; relPath: string } | null {
  if (!rawPath || typeof rawPath !== "string") return null;
  let clean = rawPath.trim().replace(/^['"`]|['"`]$/g, "").trim();
  if (!clean) return null;

  // Normalize backslashes
  clean = clean.replace(/\\/g, "/");

  // Check if it's already an absolute path pointing inside workspaceRoot
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  const cleanLower = clean.toLowerCase();
  if (cleanLower.startsWith(normalizedRoot)) {
    const rel = clean.slice(normalizedRoot.length).replace(/^\/+/, "");
    const absPath = path.resolve(workspaceRoot, rel);
    return isPathInside(workspaceRoot, absPath) ? { absPath, relPath: path.relative(workspaceRoot, absPath) } : null;
  }

  // Strip synthetic container / project root prefixes that models often assume
  const wsBase = path.basename(workspaceRoot).toLowerCase();
  const prefixes = [
    "/workspace/", "workspace/",
    "/project/", "project/",
    "/app/", "app/",
    `/${wsBase}/`, `${wsBase}/`
  ];
  for (const prefix of prefixes) {
    if (cleanLower.startsWith(prefix)) {
      clean = clean.slice(prefix.length);
      break;
    }
  }

  // Strip leading slashes (e.g. "/src/App.tsx" -> "src/App.tsx")
  clean = clean.replace(/^\/+/, "");

  const absPath = path.resolve(workspaceRoot, clean);
  if (!isPathInside(workspaceRoot, absPath)) {
    return null;
  }
  return { absPath, relPath: path.relative(workspaceRoot, absPath) };
}

export function extractFilePath(args: Record<string, unknown>): string {
  return String(
    args.path ??
    args.filePath ??
    args.file_path ??
    args.filename ??
    args.fileName ??
    args.file ??
    ""
  );
}

export function extractFileContent(args: Record<string, unknown>): string {
  if (typeof args.content === "string") return args.content;
  if (typeof args.code === "string") return args.code;
  if (typeof args.text === "string") return args.text;
  if (typeof args.file_content === "string") return args.file_content;
  if (args.content !== undefined && args.content !== null) return String(args.content);
  return "";
}
