import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface SearchRequest {
  /** Workspace root — all returned paths are relative to it. */
  root: string;
  /** Regex source supplied by the caller. */
  pattern: string;
  /** Directory to search, relative to the root. Defaults to the root. */
  searchPath?: string;
  /** Optional file-name filter, e.g. `*.ts`. */
  include?: string;
  /** Directory names that are never descended into. */
  ignoredDirectories: ReadonlySet<string>;
  /** Hard cap on reported matches (the AI only ever sees a page of them). */
  maxMatches?: number;
  /** Hard cap on files inspected so a hostile pattern can't hang the server. */
  maxFiles?: number;
  /** Content reader — pass the workspace cache so repeat searches are free. */
  readFile: (absolutePath: string) => Promise<string>;
}

export interface SearchResult {
  /** `relative/path:line:content` rows, in directory order. */
  lines: string[];
  /** Matches found before the cap was applied. */
  total: number;
  /** Set when the pattern itself is invalid. */
  error?: string;
}

const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_FILES = 20_000;
const MAX_DEPTH = 14;
const MAX_LINE_LENGTH = 500;

function compileInclude(include?: string): (fileName: string) => boolean {
  if (!include) return () => true;
  const escaped = include
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const matcher = new RegExp(`^${escaped}$`, "i");
  return (fileName) => matcher.test(fileName);
}

/** In-process fallback used when neither ripgrep nor grep is installed.
 *  Walks the tree with readdir, reads through the caller's content cache and
 *  applies the regex per line — fast enough for the workspaces this tool
 *  targets, and it works on platforms with no search binary at all. */
export async function searchWorkspace(request: SearchRequest): Promise<SearchResult> {
  let matcher: RegExp;
  try {
    matcher = new RegExp(request.pattern, "g");
  } catch (err) {
    return { lines: [], total: 0, error: `Invalid regular expression: ${(err as Error).message}` };
  }

  const includeMatches = compileInclude(request.include);
  const maxMatches = request.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFiles = request.maxFiles ?? DEFAULT_MAX_FILES;
  const rootDir = path.resolve(request.root);
  const baseDir = path.resolve(rootDir, request.searchPath || ".");
  const relativeBase = path.relative(rootDir, baseDir);
  if (relativeBase.startsWith("..") || path.isAbsolute(relativeBase)) {
    return { lines: [], total: 0, error: "Search path is outside the workspace" };
  }

  const lines: string[] = [];
  let total = 0;
  let inspected = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || inspected >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    // Files first, then directories: shallow matches appear early in the output.
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? 1 : -1;
      return left.name.localeCompare(right.name);
    });

    for (const entry of entries) {
      if (inspected >= maxFiles) return;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (request.ignoredDirectories.has(entry.name)) continue;
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !includeMatches(entry.name)) continue;

      inspected++;
      let content: string;
      try {
        content = await request.readFile(absolutePath);
      } catch {
        continue;
      }
      if (!content) continue;

      const relativePath = path.relative(request.root, absolutePath).split(path.sep).join("/");
      const fileLines = content.split("\n");
      for (let index = 0; index < fileLines.length; index++) {
        matcher.lastIndex = 0;
        if (!matcher.test(fileLines[index]!)) continue;
        total++;
        if (lines.length < maxMatches) {
          const text = fileLines[index]!;
          lines.push(
            `${relativePath}:${index + 1}:${text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text}`
          );
        }
        if (lines.length >= maxMatches && total > maxMatches) return;
      }
    }
  };

  let baseStat;
  try {
    baseStat = await stat(baseDir);
  } catch {
    return { lines: [], total: 0, error: `No such directory: ${request.searchPath || "."}` };
  }

  if (baseStat.isFile()) {
    const content = await request.readFile(baseDir).catch(() => "");
    const relativePath = path.relative(request.root, baseDir).split(path.sep).join("/");
    content.split("\n").forEach((line, index) => {
      matcher.lastIndex = 0;
      if (!matcher.test(line)) return;
      total++;
      if (lines.length < maxMatches) lines.push(`${relativePath}:${index + 1}:${line}`);
    });
  } else {
    await visit(baseDir, 0);
  }

  return { lines, total };
}
