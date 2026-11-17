import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, exec, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, watch, writeSync, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { config as loadDotenv } from "dotenv";
import nodePty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import { searchWorkspace } from "./search.js";
import { registerTool } from "./registry.js";
import { getToolPermission, getPluginPermission, type ToolAction } from "./permissions.js";
import { isPathInside, resolveWorkspacePath as resolveWorkspacePathHelper, extractFilePath, extractFileContent } from "./paths.js";
import { loadConfig } from "./config.js";
import { listSkills, readSkill, type SkillEntry } from "./skills.js";
import { resolveAgents, getDefaultAgent, getAgentById } from "./agents.js";
import { loadPlugins, type PluginRuntime } from "./plugins.js";
import { GoogleGenerativeAI, SchemaType, FunctionCallingMode, type Tool, type ToolConfig } from "@google/generative-ai";
import { loadShares, createShare, getShare, deleteShare } from "./sharing.js";
import { detectCi } from "./ci.js";
import { logger } from "./logger.js";
import { decryptString, encryptString, isEncryptionEnabled } from "./crypto.js";
import {
  buildOpenAIContents,
  buildAnthropicContents,
  buildCopilotResponsesInput,
  buildGeminiContents,
  isGeminiCompatEndpoint,
  pickThoughtSignature,
  type ChatMessage
} from "./history.js";
import {
  acquireProviderSlot,
  isRateLimitAttemptAllowed,
  parseRetryAfterMs,
  resolveRetryWait,
  RateLimitError
} from "./ratelimit.js";
import {
  APP_NAME,
  appendMessageSchema,
  createCommandRunSchema,
  createSessionSchema,
  healthResponseSchema,
  saveKeyInputSchema,
  workspaceSnapshotSchema,
  type AuthMethod,
  type AppConfig,
  type CommandRun,
  type FileEntry,
  type ProviderId,
  type SessionDetail,
  type SessionSummary,
  type ToolCall,
  type FileChange
} from "@gamma-code/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from server directory
loadDotenv({ path: path.join(__dirname, "../.env") });

let workspaceRoot = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(__dirname, "../../..");
const port = Number(process.env.PORT ?? 3030);

/* Tunables for long-running agentic work. Large refactors routinely need
 * dozens of tool rounds; the old hard cap of 15 aborted big tasks mid-flight.
 * The command timeout default is 5 minutes so builds/installs don't get killed. */
const MAX_TOOL_ROUNDS = (() => {
  const configured = Number(process.env.GAMMA_CODE_MAX_TOOL_ROUNDS);
  if (!Number.isFinite(configured) || configured <= 0) return 50;
  return Math.min(Math.floor(configured), 200);
})();
const COMMAND_TIMEOUT_MS = (() => {
  const configured = Number(process.env.GAMMA_CODE_COMMAND_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 300_000;
  return Math.floor(configured);
})();
const SSE_KEEPALIVE_MS = 25_000;
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const configured = Number(process.env.GAMMA_CODE_STREAM_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 180_000;
  return Math.floor(configured);
})();

const allowedExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md", ".html", ".yml", ".yaml"
]);

const ignoredDirectories = new Set([".git", "node_modules", "dist", ".turbo", ".vite"]);
const textEncoder = new TextEncoder();
const MAX_WORKSPACE_FILE_BYTES = Number(process.env.GAMMA_CODE_MAX_FILE_BYTES ?? 250_000);
const MAX_WORKSPACE_FILES = Number(process.env.GAMMA_CODE_MAX_WORKSPACE_FILES ?? 5_000);
const MAX_WORKSPACE_DEPTH = 12;

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const gzipAsync = promisify(gzip);

/** Run a shell command without blocking the event loop — the old execSync
 *  froze every SSE stream and HTTP request for the whole command duration. */
async function runShell(
  command: string,
  options: { cwd: string; timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" }
  }) as Promise<{ stdout: string; stderr: string }>;
}

/** True when `target` resolves inside `root`. Uses a boundary-aware check so
 *  a sibling like `.../proj-secrets` cannot pass a prefix check against root
 *  `.../proj`. */
const resolveWorkspacePath = (rawPath: string) => resolveWorkspacePathHelper(workspaceRoot, rawPath);

/** Strip characters unsafe for git args and reject traversal segments.
 *  Allows `\` so Windows-style paths work in /api/git/revert. */
function sanitizeGitRef(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._\-/\\]/g, "");
  const segments = cleaned.split(/[\\/]/);
  if (segments.some((s) => s === "..")) return "";
  return cleaned;
}

/** Strip token-like values from text before logging (OAuth bodies, URLs). */
function redactSecrets(text: string): string {
  return text
    .replace(/("(?:access_token|refresh_token|device_code|client_secret)"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]");
}

/** Async git invocation — argument array, no shell, no blocked event loop. */
async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.trim();
}

/** Branch + porcelain status from a single `git status --branch` call.
 *  Spawning git costs 150-200ms on Windows, so the result is cached for a
 *  few seconds. Explicit writes flush it (callers want fresh status); the
 *  file watcher keeps it — TTL already bounds staleness, so one save no
 *  longer pays for two git spawns. */
const GIT_TTL_MS = 3_000;
let gitInfoCache: { root: string; expiresAt: number; branch?: string; status: string; ok: boolean } | null = null;

function parseBranchHeader(header: string): string | undefined {
  if (!header) return undefined;
  if (header.startsWith("No commits yet on ")) {
    return header.slice("No commits yet on ".length).trim() || undefined;
  }
  const beforeTracking = header.split("...")[0] ?? "";
  return beforeTracking.split(" ")[0] || undefined;
}

async function getGitInfo(): Promise<{ branch?: string; status: string; ok: boolean }> {
  const now = Date.now();
  if (gitInfoCache && gitInfoCache.root === workspaceRoot && gitInfoCache.expiresAt > now) {
    return { branch: gitInfoCache.branch, status: gitInfoCache.status, ok: gitInfoCache.ok };
  }

  let branch: string | undefined;
  let status = "";
  let ok = true;
  try {
    // Pathspec limits the scan to the workspace — when the enclosing repo is
    // large (a home-directory .git, a monorepo) this cuts the walk sharply.
    const raw = await runGit(["status", "--porcelain", "--branch", "--", "."]);
    const [header, ...rest] = raw.split("\n");
    if (header?.startsWith("## ")) branch = parseBranchHeader(header.slice(3));
    status = rest.join("\n").trim();
  } catch {
    // Not a git repository or git unavailable — callers handle empty values
    ok = false;
  }

  gitInfoCache = { root: workspaceRoot, expiresAt: now + GIT_TTL_MS, branch, status, ok };
  return { branch, status, ok };
}

/** Bounded worker pool — runs `fn` over `items` with at most `limit` in flight
 *  so large workspaces scan in parallel without exhausting file descriptors. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

type SearchResult = { output: string; exitCode: number | null; missing: boolean };
/** One search-tool invocation. Never throws: missing binaries are reported via
 *  `missing`, non-zero exits keep their code so "no matches" (1) is
 *  distinguishable from a broken pattern (2). */
async function searchOnce(command: string, args: string[]): Promise<SearchResult> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024
    });
    return { output: stdout, exitCode: 0, missing: false };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    if (error.code === "ENOENT") return { output: "", exitCode: null, missing: true };
    return {
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      exitCode: typeof error.code === "number" ? error.code : null,
      missing: false
    };
  }
}

/* ----------------------------------------------------------------
   Workspace scan caches
   /api/workspace (and loadWorkspace after every save/message)
   used to re-read every file in the tree from disk each time.
   - file content is cached per path keyed by (mtime, size) so
     unchanged files are never re-read
   - path listings (AI file tree, project context) are cached and
     invalidated via an epoch bump whenever we know files changed
   ---------------------------------------------------------------- */
const fileContentCache = new Map<string, { mtimeMs: number; size: number; content: string; checkedAt: number }>();
const FILE_CONTENT_CACHE_MAX = 20_000;
const READ_STAT_GRACE_MS = 1500;
const knownDirectories = new Set<string>();

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  if (knownDirectories.has(dirPath)) return;
  await mkdir(dirPath, { recursive: true });
  knownDirectories.add(dirPath);
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}
const PATH_LISTING_TTL_MS = 5_000;
const PROJECT_CONTEXT_TTL_MS = 10_000;
let workspaceEpoch = 0;
let fileTreeCache: { root: string; epoch: number; expiresAt: number; value: string } | null = null;
let projectContextCache: { root: string; epoch: number; expiresAt: number; value: string } | null = null;
/** Whole-file-list cache for /api/workspace. The editor calls this endpoint
 *  after every message/save; re-walking + re-reading the tree each time was
 *  the single biggest read cost. Bumped on writes, and TTL-bounded so
 *  out-of-band edits (terminal, git) show up within FILES_TTL_MS. */
const FILES_TTL_MS = 30_000;
let filesCache: { root: string; epoch: number; expiresAt: number; value: FileEntry[] } | null = null;
/** Bumped every time the file list is re-scanned — cheap identity token for
 *  the serialized-snapshot memo. */
let filesVersion = 0;

/** Called whenever files in the workspace may have changed (writes, restores,
 *  git operations, workspace switches) so path-based caches refresh.
 *  `keepGit` leaves the git cache to its TTL — used by the watcher, which
 *  fires ~150ms after our own writes and would otherwise discard the fresh
 *  status the client just fetched (two git spawns per save). */
function invalidateWorkspaceCaches(options?: { keepGit?: boolean }): void {
  workspaceEpoch++;
  fileTreeCache = null;
  projectContextCache = null;
  filesCache = null;
  if (!options?.keepGit) gitInfoCache = null;
}

/* ----------------------------------------------------------------
   External-change watcher
   Lets the file-list cache hold for a long TTL while edits made
   outside the app (terminal, git, another editor) still invalidate it
   on the next request instead of waiting for a timer.
   ---------------------------------------------------------------- */
const WATCH_DEBOUNCE_MS = 150;
let workspaceWatcher: FSWatcher | null = null;
let watchDebounce: ReturnType<typeof setTimeout> | null = null;

function isIgnoredWatchPath(filename: string): boolean {
  return filename
    .split(/[\\/]/)
    .some((segment) => ignoredDirectories.has(segment));
}

function startWorkspaceWatcher(): void {
  if (process.env.GAMMA_CODE_DISABLE_WATCH === "1") return;
  try {
    workspaceWatcher = watch(
      workspaceRoot,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (filename && isIgnoredWatchPath(filename.toString())) return;
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          watchDebounce = null;
          invalidateWorkspaceCaches({ keepGit: true });
        }, WATCH_DEBOUNCE_MS);
      }
    );
    workspaceWatcher.on("error", (err) => {
      logger.warn("watch.failed", { error: err.message });
      workspaceWatcher?.close();
      workspaceWatcher = null;
    });
    logger.info("watch.started", { root: workspaceRoot });
  } catch (err) {
    // Recursive watch unsupported on this platform — TTL bounds staleness.
    logger.warn("watch.unsupported", { error: (err as Error).message });
  }
}

async function gitCurrentBranch(): Promise<string | undefined> {
  // `symbolic-ref` answers on a repository that has no commits yet, where
  // `rev-parse --abbrev-ref HEAD` fails; rev-parse covers a detached HEAD.
  const strategies: string[][] = [
    ["symbolic-ref", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"]
  ];
  for (const args of strategies) {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspaceRoot,
        encoding: "utf8"
      });
      const name = stdout.trim();
      if (name) return name;
    } catch {
      // try the next strategy
    }
  }
  // Not a git repo or git not available
  return undefined;
}

const webPassword = process.env.GAMMA_CODE_WEB_PASSWORD ?? "";
const allowedOrigins = new Set<string>(
  (process.env.GAMMA_CODE_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);

const promptSuggestions = [
  { id: "fix", label: "Find what is broken in the active file" },
  { id: "plan", label: "Outline the next implementation steps" },
  { id: "run", label: "Run the web and desktop apps locally" }
];

let resolvedConfig: AppConfig | null = null;
let resolvedConfigPaths: { globalPath: string; projectPath: string } | null = null;
let activeAgentId: string = "build";
let pluginRuntime: PluginRuntime | null = null;
const ciContext = detectCi();

// Per-session tool approvals (in-memory, session-scoped)
const sessionToolApprovals = new Map<string, Set<ToolAction>>();
// Pending approval promises keyed by toolCallId
const pendingToolApprovals = new Map<string, {
  sessionId: string;
  action: ToolAction;
  resolve: (allowed: boolean) => void;
}>();

/** Server-side session storage — extends the wire type with workspace tagging */
type StoredSession = SessionDetail & {
  workspace?: string;
  sharedId?: string;
  /** Cumulative AI usage for this session (persists across reloads) */
  usageTotals?: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextTokens: number;
  };
};

const sessionStore = new Map<string, StoredSession>();
const commandRunStore = new Map<string, CommandRun>();

// Abort controllers for in-flight AI streaming requests (keyed by session id)
const activeAbortControllers = new Map<string, AbortController>();

/** Retire a controller only if it is still the session's active one. A newer
 *  stream may have replaced it; an older request finishing (or failing) late
 *  must not evict the newer controller. */
function clearAbortController(sessionId: string, controller: AbortController) {
  if (activeAbortControllers.get(sessionId) === controller) {
    activeAbortControllers.delete(sessionId);
  }
}
// Child processes for running terminal commands (keyed by run id)
const activeChildProcesses = new Map<string, ChildProcess>();

/* ================================================================
   SSE Streaming Infrastructure
   ================================================================ */

// Per-session event emitter for streaming tokens to connected SSE clients
// Events: "token" (delta text), "done" (final), "error" (error message)
const sessionEmitters = new Map<string, EventEmitter>();

function getSessionEmitter(sessionId: string): EventEmitter {
  let emitter = sessionEmitters.get(sessionId);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(20);
    sessionEmitters.set(sessionId, emitter);
  }
  return emitter;
}

// Per-run event emitter for streaming terminal output
const terminalEmitters = new Map<string, EventEmitter>();

function getTerminalEmitter(runId: string): EventEmitter {
  let emitter = terminalEmitters.get(runId);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(20);
    terminalEmitters.set(runId, emitter);
  }
  return emitter;
}

/* ================================================================
   Auth Key Store — in-memory storage for API keys
   ================================================================ */

const storedKeys = new Map<string, string>();

/* ================================================================
   Persistence versioning helpers
   ================================================================ */

type PersistedPayload<T> = {
  version: number;
  data: T;
  updatedAt?: string;
};

const PERSIST_VERSION = 1;

function wrapPersisted<T>(data: T): PersistedPayload<T> {
  return { version: PERSIST_VERSION, data, updatedAt: new Date().toISOString() };
}

function unwrapPersisted<T>(raw: unknown, fallback: T): { data: T; version: number } {
  if (raw && typeof raw === "object" && "version" in raw && "data" in raw) {
    const payload = raw as PersistedPayload<T>;
    return { data: payload.data ?? fallback, version: Number(payload.version ?? 0) || 0 };
  }
  return { data: (raw as T) ?? fallback, version: 0 };
}

/* ----------------------------------------------------------------
   Persistent auth storage — ~/.gamma-code/auth.json
   Stores GitHub OAuth token and manually-entered API keys so they
   survive server restarts.
   ---------------------------------------------------------------- */
const AUTH_DIR = path.join(homedir(), ".gamma-code");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

async function loadPersistedAuth(): Promise<void> {
  try {
    const raw = await readFile(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const { data, version } = unwrapPersisted<Record<string, string>>(parsed, {});
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" && value.length > 0) {
        const decrypted = decryptString(value);
        if (decrypted === null) {
          logger.warn("auth.decrypt_failed", { key });
          continue;
        }
        storedKeys.set(key, decrypted);
      }
    }
    // Migrate old github-oauth key to copilot-oauth
    if (storedKeys.has("github-oauth") && !storedKeys.has("copilot-oauth")) {
      storedKeys.set("copilot-oauth", storedKeys.get("github-oauth")!);
      storedKeys.delete("github-oauth");
      logger.info("auth.migrated", { from: "github-oauth", to: "copilot-oauth" });
    }
    logger.info("auth.loaded", { count: Object.keys(data).length, file: AUTH_FILE });
    if (version === 0) {
      // Upgrade legacy format on next persist
      void persistAuth();
    }
  } catch {
    // File doesn't exist or is invalid — that's fine, first run
    logger.info("auth.missing", { file: AUTH_FILE });
  }
}

/** Persist all stored keys to disk */
async function persistAuth(): Promise<void> {
  try {
    await mkdir(AUTH_DIR, { recursive: true });
    const toSave: Record<string, string> = {};
    for (const [key, value] of storedKeys.entries()) {
      toSave[key] = isEncryptionEnabled() ? encryptString(value) : value;
    }
    const wrapped = wrapPersisted(toSave);
    await writeFile(AUTH_FILE, JSON.stringify(wrapped, null, 2), "utf8");
    logger.info("auth.persisted", { count: Object.keys(toSave).length, file: AUTH_FILE });
  } catch (err) {
    logger.error("auth.persist_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/* ----------------------------------------------------------------
   Persistent session storage — ~/.gamma-code/sessions.json
   Saves all chat sessions to disk so they survive server restarts.
   Uses debounced writes to avoid thrashing on rapid updates.
   ---------------------------------------------------------------- */
const SESSIONS_FILE = path.join(AUTH_DIR, "sessions.json");

let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;
const SESSION_PERSIST_DEBOUNCE_MS = 500;

async function loadPersistedSessions(): Promise<void> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const { data, version } = unwrapPersisted<Record<string, StoredSession>>(parsed, {});
    let count = 0;
    for (const [id, session] of Object.entries(data)) {
      if (session && typeof session === "object" && session.id) {
        sessionStore.set(id, session);
        count++;
      }
    }
    logger.info("sessions.loaded", { count, file: SESSIONS_FILE });
    if (version === 0) {
      persistSessions();
    }
  } catch {
    logger.info("sessions.missing", { file: SESSIONS_FILE });
  }
}

let lastPersistedSessionsJson: string | null = null;
function persistSessions(): void {
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(async () => {
    try {
      await mkdir(AUTH_DIR, { recursive: true });
      const toSave: Record<string, StoredSession> = {};
      for (const [id, session] of sessionStore.entries()) {
        toSave[id] = session;
      }
      // Compact stringify: pretty-printing megabytes of transcripts was a
      // multi-hundred-ms main-thread stall on every debounced persist.
      const dataJson = JSON.stringify(toSave);
      if (dataJson === lastPersistedSessionsJson) return; // no semantic change — skip the disk write
      lastPersistedSessionsJson = dataJson;
      const wrapped = { version: PERSIST_VERSION, data: toSave, updatedAt: new Date().toISOString() };
      await writeFile(SESSIONS_FILE, JSON.stringify(wrapped), "utf8");
      logger.info("sessions.persisted", { count: Object.keys(toSave).length, file: SESSIONS_FILE });
    } catch (err) {
      logger.error("sessions.persist_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, SESSION_PERSIST_DEBOUNCE_MS);
}

/* ----------------------------------------------------------------
   Persistent project/workspace list — ~/.gamma-code/projects.json
   Tracks recently-opened project folders so the user can switch
   between them quickly.
   ---------------------------------------------------------------- */
const PROJECTS_FILE = path.join(AUTH_DIR, "projects.json");

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number; // epoch ms
}

let recentProjects: RecentProject[] = [];

async function loadPersistedProjects(): Promise<void> {
  try {
    const raw = await readFile(PROJECTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const { data, version } = unwrapPersisted<RecentProject[]>(parsed, []);
    if (Array.isArray(data)) {
      recentProjects = data;
      logger.info("projects.loaded", { count: recentProjects.length, file: PROJECTS_FILE });
    }
    if (version === 0) {
      void persistProjects();
    }
  } catch {
    logger.info("projects.missing", { file: PROJECTS_FILE });
  }
}

async function persistProjects(): Promise<void> {
  try {
    await mkdir(AUTH_DIR, { recursive: true });
    const wrapped = wrapPersisted(recentProjects);
    await writeFile(PROJECTS_FILE, JSON.stringify(wrapped, null, 2), "utf8");
  } catch (err) {
    logger.error("projects.persist_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

function touchProject(projectPath: string): void {
  const name = path.basename(projectPath);
  const existing = recentProjects.findIndex((p) => p.path === projectPath);
  if (existing !== -1) {
    recentProjects[existing].lastOpened = Date.now();
  } else {
    recentProjects.push({ path: projectPath, name, lastOpened: Date.now() });
  }
  // Keep max 20, sorted by most recent
  recentProjects.sort((a, b) => b.lastOpened - a.lastOpened);
  recentProjects = recentProjects.slice(0, 20);
  void persistProjects();
}

/* ----------------------------------------------------------------
   Persistent custom provider config — ~/.gamma-code/custom-provider.json
   Stores user-defined custom API endpoint, key, and model.
   ---------------------------------------------------------------- */
const CUSTOM_PROVIDER_FILE = path.join(AUTH_DIR, "custom-provider.json");

interface CustomProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let customProvider: CustomProviderConfig = { baseUrl: "", apiKey: "", model: "" };

async function loadPersistedCustomProvider(): Promise<void> {
  try {
    const raw = await readFile(CUSTOM_PROVIDER_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const { data } = unwrapPersisted<CustomProviderConfig>(parsed, { baseUrl: "", apiKey: "", model: "" });
    customProvider = data;
    logger.info("custom-provider.loaded", { baseUrl: customProvider.baseUrl ? "(set)" : "(empty)" });
  } catch {
    logger.info("custom-provider.missing", { file: CUSTOM_PROVIDER_FILE });
  }
}

async function persistCustomProvider(): Promise<void> {
  try {
    await mkdir(AUTH_DIR, { recursive: true });
    const wrapped = wrapPersisted(customProvider);
    await writeFile(CUSTOM_PROVIDER_FILE, JSON.stringify(wrapped, null, 2), "utf8");
    logger.info("custom-provider.persisted");
  } catch (err) {
    logger.error("custom-provider.persist_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// GitHub OAuth Device Flow state
interface GitHubDeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

let githubDeviceFlow: GitHubDeviceFlowState | null = null;

// GitHub Copilot OAuth App client_id — the shared Copilot client
const COPILOT_CLIENT_ID = process.env.COPILOT_CLIENT_ID ?? "Ov23li8tweQw6odWQebz";

function getKeyForProvider(providerId: string): string | undefined {
  if (providerId === "copilot") {
    // Copilot: OAuth token is the primary auth method
    const oauthToken = storedKeys.get("copilot-oauth");
    if (oauthToken) return oauthToken;
    // Allow env var fallback
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    return undefined;
  }

  if (providerId === "custom") {
    return customProvider.apiKey || undefined;
  }

  // Other providers: stored key > env var
  const stored = storedKeys.get(providerId);
  if (stored) return stored;

  const config = providerConfigs.find((c) => c.id === providerId);
  if (!config) return undefined;

  return process.env[config.envKey];
}

/**
 * Async version of getKeyForProvider — currently just delegates to sync version.
 * Kept async in case we add token refresh flows in the future.
 */
async function getKeyForProviderAsync(providerId: string): Promise<string | undefined> {
  return getKeyForProvider(providerId);
}

function getAuthMethod(config: ProviderConfig): AuthMethod {
  if (config.id === "copilot") {
    if (storedKeys.has("copilot-oauth")) return "oauth";
    if (process.env.GITHUB_TOKEN) return "env";
    return "none";
  }
  if (storedKeys.has(config.id)) return "stored_key";
  if (process.env[config.envKey]) return "env";
  return "none";
}

async function startGitHubDeviceFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}> {
  logger.info(`[auth] Starting GitHub Copilot device flow with client_id: ${COPILOT_CLIENT_ID}`);

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user"
    })
  });

  const responseText = await response.text();
  logger.info(`[auth] GitHub device/code response (${response.status}): ${redactSecrets(responseText).slice(0, 500)}`);

  if (!response.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${response.status} ${responseText.slice(0, 300)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new Error(`GitHub returned non-JSON response: ${responseText.slice(0, 200)}`);
  }

  // GitHub sometimes returns 200 with an error field
  if (data.error) {
    throw new Error(`GitHub error: ${String(data.error_description ?? data.error)}`);
  }

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(`GitHub response missing required fields: ${responseText.slice(0, 200)}`);
  }

  githubDeviceFlow = {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
    interval: Number(data.interval) || 5
  };

  logger.info(`[auth] Device flow started. User code: ${githubDeviceFlow.userCode}, URI: ${githubDeviceFlow.verificationUri}`);

  return {
    deviceCode: githubDeviceFlow.deviceCode,
    userCode: githubDeviceFlow.userCode,
    verificationUri: githubDeviceFlow.verificationUri,
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5
  };
}

async function pollGitHubDeviceFlow(deviceCode: string): Promise<{
  status: "pending" | "completed" | "expired" | "error";
  token?: string;
  error?: string;
  interval?: number;
}> {
  if (githubDeviceFlow && Date.now() > githubDeviceFlow.expiresAt) {
    logger.info("[auth] Device code expired");
    githubDeviceFlow = null;
    return { status: "expired", error: "Device code expired. Please start a new login." };
  }

  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });

    const responseText = await response.text();
    logger.info(`[auth] GitHub poll response (${response.status}): ${redactSecrets(responseText).slice(0, 300)}`);

    if (!response.ok) {
      return { status: "error", error: `HTTP ${response.status}: ${responseText.slice(0, 200)}` };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      return { status: "error", error: `Non-JSON response: ${responseText.slice(0, 200)}` };
    }

    if (data.access_token) {
      const oauthToken = String(data.access_token);
      // Store as copilot-oauth — this token works with api.githubcopilot.com
      storedKeys.set("copilot-oauth", oauthToken);
      invalidateModelCache("copilot");
      githubDeviceFlow = null;
      logger.info("[auth] GitHub Copilot OAuth completed — token stored as copilot-oauth");

      // Persist the OAuth token to disk for restart survival
      void persistAuth();

      return { status: "completed", token: oauthToken };
    }

    const errorCode = String(data.error ?? "");

    if (errorCode === "authorization_pending") {
      return { status: "pending" };
    }

    if (errorCode === "slow_down") {
      // GitHub tells us to increase our interval — pass it back to client
      const newInterval = Number(data.interval) || 10;
      logger.info(`[auth] GitHub slow_down — new interval: ${newInterval}s`);
      return { status: "pending", interval: newInterval };
    }

    if (errorCode === "expired_token") {
      githubDeviceFlow = null;
      return { status: "expired", error: "Device code expired." };
    }

    if (errorCode === "incorrect_client_credentials") {
      githubDeviceFlow = null;
      return { status: "error", error: "Invalid GitHub OAuth App client_id. Set COPILOT_CLIENT_ID env var with your own GitHub OAuth App client ID." };
    }

    if (errorCode === "incorrect_device_code") {
      githubDeviceFlow = null;
      return { status: "error", error: "Invalid device code. Please start a new login." };
    }

    // Any other error
    const errorDesc = String(data.error_description ?? data.error ?? "Unknown error");
    logger.info(`[auth] GitHub poll error: ${errorDesc}`);
    return { status: "error", error: errorDesc };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Poll failed";
    logger.error(`[auth] GitHub poll exception: ${msg}`);
    return { status: "error", error: msg };
  }
}

/* ================================================================
   AI Provider Configuration
   ================================================================ */

interface ProviderConfig {
  id: string;
  label: string;
  envKey: string;
  baseUrl: string;
  defaultModel: string;
  /** Fallback static model IDs when dynamic fetch fails */
  fallbackModels: string[];
  format: "openai" | "anthropic" | "copilot" | "gemini";
}

const providerConfigs: ProviderConfig[] = [
  {
    id: "copilot",
    label: "Copilot",
    envKey: "GITHUB_TOKEN",
    baseUrl: "https://api.githubcopilot.com",
    defaultModel: "claude-sonnet-4.6",
    fallbackModels: [
      "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-opus-4.6", "claude-opus-4.5", "claude-haiku-4.5",
      "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5", "gpt-5-mini",
      "gpt-4.1", "gpt-4o", "o4-mini", "o3-mini",
      "gemini-3.6-flash", "gemini-3.1-pro-preview",
      "grok-code-fast-1"
    ],
    format: "copilot"
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    fallbackModels: [
      "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
      "gpt-4o-mini", "o4-mini", "o3-mini"
    ],
    format: "openai"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    fallbackModels: [
      "claude-sonnet-4-20250514", "claude-opus-4-20250514",
      "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"
    ],
    format: "anthropic"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o",
    fallbackModels: [
      "openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-4.1", "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "anthropic/claude-haiku-4.5",
      "google/gemini-3.5-flash", "google/gemini-3.1-pro-preview",
      "deepseek/deepseek-chat", "deepseek/deepseek-r1",
      "meta-llama/llama-4-maverick", "mistralai/mistral-large-4-0"
    ],
    format: "openai"
  },
  {
    id: "mistral",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "codestral-latest",
    fallbackModels: [
      "codestral-latest", "mistral-medium-latest", "mistral-small-latest",
      "ministral-14b-latest", "ministral-8b-latest", "ministral-3b-latest"
    ],
    format: "openai"
  },
  {
    id: "gemini",
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    fallbackModels: [
      "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash",
      "gemini-3.5-flash", "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"
    ],
    format: "gemini"
  },
  {
    id: "ollama",
    label: "Ollama (Local)",
    envKey: "OLLAMA_API_KEY",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "codellama:latest",
    fallbackModels: [
      "codellama:latest", "codellama:7b", "codellama:13b",
      "llama3:8b", "llama3:70b", 
      "qwen2.5-coder:7b", "qwen2.5-coder:14b",
      "phi3:mini", "phi3:medium",
      "deepseek-coder:6.7b", "mistral:7b"
    ],
    format: "openai"
  },
  {
    id: "custom",
    label: "Custom",
    envKey: "",
    baseUrl: "",
    defaultModel: "",
    fallbackModels: [],
    format: "openai"
  }
];

function getProviderStatus(config: ProviderConfig): "connected" | "disconnected" | "experimental" {
  if (config.id === "copilot") {
    const hasOAuth = storedKeys.has("copilot-oauth");
    const hasEnv = !!process.env[config.envKey];
    if (hasOAuth || hasEnv) return "connected";
    return "disconnected";
  }

  if (config.id === "ollama") {
    return "experimental";
  }

  if (config.id === "custom") {
    if (customProvider.baseUrl && customProvider.apiKey) return "connected";
    return "disconnected";
  }

  const key = getKeyForProvider(config.id);
  if (!key) return "disconnected";
  return "connected";
}

/* ================================================================
   Provider Usage / Quota Tracking
   ================================================================ */

/** Provider usage info returned to clients */
interface ProviderUsageInfo {
  providerId: string;
  /** Usage as a percentage (0-100). null if unknown. */
  usagePercent: number | null;
  /** Human-readable usage label, e.g. "42 / 300 premium requests" */
  usageLabel: string;
  /** Detailed breakdown for hover tooltip */
  details: string;
  /** Whether this provider has real quota data (vs local tracking only) */
  hasQuota: boolean;
}

/** Cached Copilot rate limit data from API response headers */
let copilotRateLimitCache: {
  limit?: number;       // x-ratelimit-limit (monthly premium request limit)
  remaining?: number;   // x-ratelimit-remaining
  used?: number;        // x-ratelimit-used
  reset?: string;       // x-ratelimit-reset timestamp
  updatedAt: number;
} = { updatedAt: 0 };

/** Cumulative token usage tracked locally per provider (for providers without usage APIs) */
const localUsageTracker = new Map<string, { inputTokens: number; outputTokens: number; requestCount: number }>();

function trackLocalUsage(providerId: string, usage?: UsageData) {
  const existing = localUsageTracker.get(providerId) ?? { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  existing.requestCount += 1;
  if (usage) {
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
  }
  localUsageTracker.set(providerId, existing);
}

/** Capture rate limit headers from a Copilot API response */
function captureCopilotRateLimits(headers: Headers) {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const used = headers.get("x-ratelimit-used");
  const reset = headers.get("x-ratelimit-reset");
  if (limit || remaining || used) {
    copilotRateLimitCache = {
      limit: limit ? parseInt(limit, 10) : copilotRateLimitCache.limit,
      remaining: remaining ? parseInt(remaining, 10) : copilotRateLimitCache.remaining,
      used: used ? parseInt(used, 10) : copilotRateLimitCache.used,
      reset: reset ?? copilotRateLimitCache.reset,
      updatedAt: Date.now(),
    };
    logger.info(`[copilot-ratelimit] limit=${copilotRateLimitCache.limit} used=${copilotRateLimitCache.used} remaining=${copilotRateLimitCache.remaining}`);
  }
}

/** Fetch OpenRouter key usage data. The Settings/status UI polls this, so the
 *  result is memoized for a minute (keyed by the API key, so rotation busts it). */
const OPENROUTER_USAGE_TTL_MS = 60_000;
let openRouterUsageCache: { apiKey: string; expiresAt: number; value: ProviderUsageInfo } | null = null;
async function fetchOpenRouterUsage(): Promise<ProviderUsageInfo> {
  const apiKey = await getKeyForProviderAsync("openrouter");
  if (!apiKey) {
    return { providerId: "openrouter", usagePercent: null, usageLabel: "No API key", details: "Set an API key in Settings", hasQuota: false };
  }

  const now = Date.now();
  if (openRouterUsageCache && openRouterUsageCache.apiKey === apiKey && openRouterUsageCache.expiresAt > now) {
    return openRouterUsageCache.value;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      data: {
        label: string;
        limit: number | null;
        limit_remaining: number | null;
        usage: number;
        usage_monthly: number;
        is_free_tier: boolean;
      };
    };
    const d = data.data;
    const hasLimit = d.limit !== null && d.limit > 0;
    const usagePercent = hasLimit ? Math.min(((d.usage / d.limit!) * 100), 100) : null;
    const usageLabel = hasLimit
      ? `$${d.usage.toFixed(2)} / $${d.limit!.toFixed(2)}`
      : `$${d.usage.toFixed(2)} used`;
    const details = [
      `Total: $${d.usage.toFixed(4)}`,
      `Monthly: $${d.usage_monthly.toFixed(4)}`,
      hasLimit ? `Limit: $${d.limit!.toFixed(2)}` : "No limit set",
      hasLimit ? `Remaining: $${d.limit_remaining!.toFixed(2)}` : "",
      d.is_free_tier ? "Free tier" : "Paid account",
    ].filter(Boolean).join("\n");

    const result: ProviderUsageInfo = { providerId: "openrouter", usagePercent, usageLabel, details, hasQuota: hasLimit };
    openRouterUsageCache = { apiKey, expiresAt: Date.now() + OPENROUTER_USAGE_TTL_MS, value: result };
    return result;
  } catch (err) {
    logger.error("provider-usage.openrouter_failed", { error: err instanceof Error ? err.message : String(err) });
    const result: ProviderUsageInfo = { providerId: "openrouter", usagePercent: null, usageLabel: "Error fetching", details: "Failed to fetch usage", hasQuota: false };
    openRouterUsageCache = { apiKey, expiresAt: Date.now() + OPENROUTER_USAGE_TTL_MS, value: result };
    return result;
  }
}

/** Get Copilot usage from cached rate limit headers */
function getCopilotUsage(): ProviderUsageInfo {
  const local = localUsageTracker.get("copilot");
  const rl = copilotRateLimitCache;

  if (rl.limit && rl.limit > 0 && rl.used !== undefined) {
    const usagePercent = Math.min((rl.used / rl.limit) * 100, 100);
    const usageLabel = `${rl.used} / ${rl.limit} premium requests`;
    const details = [
      `Premium requests used: ${rl.used}`,
      `Limit: ${rl.limit}`,
      `Remaining: ${rl.remaining ?? "?"}`,
      rl.reset ? `Resets: ${new Date(parseInt(rl.reset, 10) * 1000).toLocaleDateString()}` : "",
      local ? `Session: ${local.requestCount} requests, ${(local.inputTokens + local.outputTokens).toLocaleString()} tokens` : "",
    ].filter(Boolean).join("\n");

    return { providerId: "copilot", usagePercent, usageLabel, details, hasQuota: true };
  }

  // No rate limit data yet — fall back to local tracking
  if (local) {
    return {
      providerId: "copilot",
      usagePercent: null,
      usageLabel: `${local.requestCount} requests`,
      details: `Requests: ${local.requestCount}\nTokens: ${(local.inputTokens + local.outputTokens).toLocaleString()}\n(Premium quota data available after first API call)`,
      hasQuota: false,
    };
  }

  return { providerId: "copilot", usagePercent: null, usageLabel: "No usage yet", details: "Make a request to see usage", hasQuota: false };
}

/** Get local-only usage for OpenAI / Anthropic (no public usage API) */
function getLocalUsage(providerId: string): ProviderUsageInfo {
  const local = localUsageTracker.get(providerId);
  if (local) {
    const totalTokens = local.inputTokens + local.outputTokens;
    return {
      providerId,
      usagePercent: null,
      usageLabel: `${local.requestCount} requests`,
      details: `Requests: ${local.requestCount}\nInput tokens: ${local.inputTokens.toLocaleString()}\nOutput tokens: ${local.outputTokens.toLocaleString()}\nTotal tokens: ${totalTokens.toLocaleString()}`,
      hasQuota: false,
    };
  }
  return { providerId, usagePercent: null, usageLabel: "No usage yet", details: "Make a request to see usage", hasQuota: false };
}

/** Fetch usage for all providers */
async function getAllProviderUsage(): Promise<ProviderUsageInfo[]> {
  const results: ProviderUsageInfo[] = [];

  // Copilot — from rate limit headers cache
  results.push(getCopilotUsage());

  // OpenRouter — live API call
  const orKey = await getKeyForProviderAsync("openrouter");
  if (orKey) {
    results.push(await fetchOpenRouterUsage());
  } else {
    results.push({ providerId: "openrouter", usagePercent: null, usageLabel: "No API key", details: "Set an API key in Settings", hasQuota: false });
  }

  // OpenAI — local tracking only
  results.push(getLocalUsage("openai"));

  // Anthropic — local tracking only
  results.push(getLocalUsage("anthropic"));

  // Gemini — local tracking only
  results.push(getLocalUsage("gemini"));

  return results;
}

/* ================================================================
   Dynamic Model Fetching — queries each provider's API for available models
   ================================================================ */

interface ModelCache {
  models: string[];
  fetchedAt: number;
}

const modelCache = new Map<string, ModelCache>();
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** OpenAI chat model prefixes — filter out embedding, TTS, whisper, DALL-E etc. */
const OPENAI_CHAT_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
const OPENAI_EXCLUDE_PATTERNS = ["realtime", "audio", "search", "transcribe"];

/** Copilot chat-compatible model prefixes — only models matching these are shown */
const COPILOT_CHAT_PREFIXES = [
  "gpt-", "claude-", "o1", "o3", "o4",
  "gemini-", "chatgpt-", "grok-",
];
const COPILOT_EXCLUDE_PATTERNS = [
  "embed", "whisper", "tts", "dall-e", "davinci", "babbage",
  "moderation", "text-embedding", "code-search", "text-search",
  "text-similarity", "curie", "ada", "realtime", "audio", "transcribe"
];

/** Check if a Copilot model is chat-compatible */
function isCopilotChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (COPILOT_EXCLUDE_PATTERNS.some((p) => lower.includes(p))) return false;
  return COPILOT_CHAT_PREFIXES.some((p) => lower.startsWith(p));
}

/** GPT-5+ models (except gpt-5-mini) need the Responses API (/responses) instead of /chat/completions */
function shouldUseCopilotResponsesApi(model: string): boolean {
  const lower = model.toLowerCase();
  // gpt-5, gpt-5.2-codex, gpt-5.3-codex, gpt-5.4, etc. → Responses API
  // gpt-5-mini → Chat Completions API (not Responses)
  if (lower.startsWith("gpt-5") && !lower.startsWith("gpt-5-mini")) return true;
  return false;
}

/** Check if a model is a reasoning model (no temperature, uses developer role) */
function isCopilotReasoningModel(model: string): boolean {
  const lower = model.toLowerCase();
  // o1, o3, o4 series are reasoning models
  if (lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return true;
  // gpt-5 main models are reasoning (but gpt-5-mini and gpt-5-chat are not)
  if (lower.startsWith("gpt-5") && !lower.startsWith("gpt-5-mini") && !lower.startsWith("gpt-5-chat")) return true;
  return false;
}

/** Strip date suffixes from model IDs for deduplication.
 *  e.g. "gpt-4o-2024-08-06" → "gpt-4o", "gpt-4.1-2025-04-14" → "gpt-4.1"
 */
function stripDateSuffix(id: string): string {
  return id.replace(/-\d{4}-?\d{2}-?\d{2}$/, "").replace(/-\d{8}$/, "");
}

/** Deduplicate models: for models with the same base ID (after stripping date suffixes),
 *  keep only the base (non-dated) version. If all versions have dates, keep the latest (last sorted). */
function deduplicateModels(models: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const key = stripDateSuffix(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const result: string[] = [];
  for (const [key, variants] of groups) {
    // Prefer the base (non-dated) version
    const base = variants.find((v) => v === key);
    if (base) {
      result.push(base);
    } else {
      // All have dates — pick the latest (sorted descending, take first)
      variants.sort().reverse();
      result.push(variants[0]);
    }
  }
  return result.sort();
}

async function fetchModelsForProvider(config: ProviderConfig): Promise<string[]> {
  // Ollama doesn't require an API key
  if (config.id === "ollama") {
    try {
      const res = await fetch(`${config.baseUrl}/models`);
      if (!res.ok) throw new Error(`Ollama /models returned ${res.status}`);
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const models = (data.models ?? [])
        .map((m) => m.name)
        .sort();
      if (models.length > 0) {
        modelCache.set(config.id, { models, fetchedAt: Date.now() });
        logger.info(`[models] Fetched ${models.length} models for ${config.label}`);
        return models;
      }
    } catch {
      // Ollama not available — this is expected if not installed
      // Cache the failure so we don't keep retrying
      modelCache.set(config.id, { models: [], fetchedAt: Date.now() });
    }
    // Fall back to static list if Ollama is not available
    return config.fallbackModels;
  }

  const apiKey = await getKeyForProviderAsync(config.id);
  if (!apiKey) return config.fallbackModels;

  // Check cache
  const cached = modelCache.get(config.id);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL) {
    return cached.models;
  }

  try {
    let models: string[] = [];

    if (config.format === "copilot") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Openai-Intent": "conversation-edits",
          "User-Agent": "GammaCode/1.0",
          "x-initiator": "user"
        }
      });
        if (!res.ok) throw new Error(`Copilot /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter(isCopilotChatModel)
        .sort();
    } else if (config.format === "openai" && config.id === "openai") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`OpenAI /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => OPENAI_CHAT_PREFIXES.some((p) => id.startsWith(p)))
        .filter((id) => !OPENAI_EXCLUDE_PATTERNS.some((p) => id.includes(p)))
        .sort();
    } else if (config.id === "mistral") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`Mistral /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      // Only chat-capable Mistral models — exclude embed/ocr/moderation/tts/fim etc.
      const chatModels = new Set([
        "codestral-latest", "codestral-2508",
        "mistral-medium-latest", "mistral-small-latest",
        "mistral-medium-3.5", "mistral-medium-3-5", "mistral-medium-3", "mistral-medium-2604", "mistral-medium",
        "mistral-small-2603",
        "ministral-14b-latest", "ministral-8b-latest", "ministral-3b-latest",
        "ministral-14b-2512", "ministral-8b-2512", "ministral-3b-2512",
        "magistral-medium-latest", "magistral-small-latest",
        "mistral-code-latest"
      ]);
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => chatModels.has(id))
        .sort();
    } else if (config.format === "anthropic") {
      const res = await fetch(`${config.baseUrl}/models?limit=1000`, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }
      });
      if (!res.ok) throw new Error(`Anthropic /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      models = (data.data ?? []).map((m) => m.id);
    } else if (config.id === "openrouter") {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
      // OpenRouter returns hundreds of models — take top popular ones
      models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => {
          // Include only top popular models from major providers
          const popular = [
            "openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-4.1", "openai/gpt-4.1-mini",
            "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "anthropic/claude-haiku-4.5",
            "google/gemini-3.5-flash", "google/gemini-3.1-pro-preview",
            "deepseek/deepseek-chat", "deepseek/deepseek-r1",
            "meta-llama/llama-4-maverick", "mistralai/mistral-large-4-0",
            "cohere/command-a-plus"
          ];
          return popular.includes(id);
        });
    } else if (config.format === "gemini") {
      const res = await fetch(`${config.baseUrl}/models?key=${apiKey}`);
      if (!res.ok) throw new Error(`Gemini /models returned ${res.status}`);
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      // Only show latest supported Gemini models
      const latestGemini = new Set([
        "gemini-2.5-flash", "gemini-2.5-pro",
        "gemini-3.5-flash", "gemini-3.5-flash-lite",
        "gemini-3.1-pro-preview"
      ]);
      models = (data.models ?? [])
        .map((m) => m.name.replace("models/", ""))
        .filter((id) => {
          if (!id.includes("gemini") || id.includes(":batch")) return false;
          // Accept exact latest models or any gemini-3.x/2.5 model
          return latestGemini.has(id) || id.startsWith("gemini-3.") || id.startsWith("gemini-2.5");
        })
        .sort();
    }

    if (models.length > 0) {
      models = deduplicateModels(models);
      modelCache.set(config.id, { models, fetchedAt: Date.now() });
      logger.info(`[models] Fetched ${models.length} models for ${config.label}`);
      return models;
    }
  } catch (err) {
    logger.warn("models.fetch_failed", { provider: config.label, error: err instanceof Error ? err.message : String(err) });
  }

  // Fall back to static list
  return config.fallbackModels;
}

/** Get models for a provider — returns cached dynamic list or fallback */
async function getModelsForProvider(config: ProviderConfig): Promise<string[]> {
  return fetchModelsForProvider(config);
}

/** Invalidate model cache for a provider (e.g., after auth change) */
function invalidateModelCache(providerId?: string): void {
  if (providerId) {
    modelCache.delete(providerId);
  } else {
    modelCache.clear();
  }
}

function resolveProvider(providerLabel: string): ProviderConfig | null {
  const needle = providerLabel.trim().toLowerCase();
  // Accept id ("mistral"), label ("Mistral"), or any case variation — the UI
  // sends labels, but scripts/tests naturally use the ids from /api/auth/status.
  const found = providerConfigs.find(
    (c) => c.label === providerLabel || c.id === needle || c.label.toLowerCase() === needle
  );
  if (!found) return null;
  // Custom provider: override baseUrl and model from stored config
  if (found.id === "custom" && customProvider.baseUrl) {
    return { ...found, baseUrl: customProvider.baseUrl, defaultModel: customProvider.model };
  }
  return found;
}

function resolveModel(config: ProviderConfig, uiModel: string): string {
  // Model IDs are now passed directly from the UI — no translation needed
  return uiModel || config.defaultModel;
}

function getSystemPrompt(): string {
  // Build project context (cached — package.json + root listing rarely change)
  const projectContext = getProjectContext();

  return `You are Gamma Code, an elite AI coding assistant. You write, debug, and ship code. You are autonomous — you do the work, not just describe it.

IMPORTANT: Before you begin work, think about what the code you're editing is supposed to do based on the filenames and directory structure.

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it.
Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks.
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand.
IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
IMPORTANT: Keep your responses short. You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library.
- When you create a new component, first look at existing components to see how they're written.
- When you edit a piece of code, first look at the code's surrounding context to understand the code's choice of frameworks and libraries.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys.

# Doing tasks
The user will primarily request you perform software engineering tasks. For these tasks the following steps are recommended:
1. Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively.
2. Implement the solution using all tools available to you
3. Verify the solution if possible with tests. Check the README or search codebase to determine the testing approach.
4. VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck) to ensure your code is correct.

NEVER commit changes unless the user explicitly asks you to.

# Tool usage policy
- When doing file search, prefer to use grep_search to find relevant code first.
- If you intend to call multiple tools and there are no dependencies between the calls, make all of the independent calls in the same function_calls block.
- IMPORTANT: The user does not see the full output of the tool responses, so if you need the output of the tool for the response make sure to summarize it for the user.

You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

# Tools (USE THEM - DO NOT DESCRIBE WHAT YOU WOULD DO, ACTUALLY DO IT)

## run_command
Execute shell commands in the workspace. Use this for builds, tests, git, npm install, pip, node, any CLI.
- ALWAYS run commands, never suggest them to the user
- If a command fails, read the error output and fix the issue yourself
- Server commands (npm run dev, vite, next dev) run in the background — you CAN use them. After starting, tell the user it's running.
- Example: To verify a build compiles, run: npm run build

## read_file
Read the contents of any file. ALWAYS use this before editing a file to understand its current state.
- NEVER guess or paraphrase file contents — always read first and copy exact text for edit_file
- Use this to understand code structure before making changes

## write_file
Create or overwrite a file with complete content. Use for creating new files.
- Write complete, working code - no placeholders or TODOs
- Include all necessary imports and exports
- Skip read_file when creating a brand-new file - just write it
- Example: Creating a new component with all required code

## write_files
Create or overwrite MULTIPLE files in a single tool call - much faster than calling write_file once per file.
- Use this whenever you are writing 2 or more files (scaffolding a project, adding several components, config + sources)
- Each entry has its own path and its own complete content
- One call = one round trip; separate write_file calls cost one round each

## edit_file
Make surgical edits to existing files by replacing specific text. SAFER than write_file for changes.
- ALWAYS call read_file first and copy the exact text — never guess old_string
- Use enough context in old_string to make it unique (3-5 lines)
- Only one replacement per call

## list_files
List files and directories in the workspace. Use to understand project structure.
- Returns entries with type indicators (dir/ or file)
- Use to explore before reading or editing files

## grep_search
Search for patterns across all files. USE THIS to find code, functions, variables, imports.
- Returns matching lines with file paths and line numbers
- Supports regex patterns
- Example: Find all uses of a function: grep_search pattern="handleClick"

# Behavior
- When asked to build something: read existing code → plan → write code → test → confirm it works
- When asked to fix something: read the file → understand the issue → fix it → verify
- When asked to run something: just run it, show output
- When unsure: read more files to understand context before acting
- Code should be production-quality: proper error handling, types, clean structure
- Use the project's existing style, frameworks, and conventions

# Autonomy — finish the job in ONE turn
- Do the WHOLE task yourself: explore → change → verify. Keep calling tools for as many rounds as it takes. Never stop after just 1-2 steps.
- Never end your turn with a plan, a question ("should I…?"), or an offer ("want me to…?"). If the action is clearly implied by the request, do it now and report what happened.
- A failed command or rejected edit is a STEP, not an ending: read the error, fix the cause, and retry. Only give up if the failure is genuinely impossible to resolve — then say exactly what blocked you.
- Before saying "done": run the project's verification (check package.json scripts — typecheck, lint, build, test) and fix anything it reports.
- COMPLETION CONTRACT: if you changed files or ran commands this turn, your final message MUST start with "DONE: " followed by a one-line summary and the verification you ran. Stopping without it means "not finished" and you will be sent back to work.
- Users watching the stream expect continuous work, not a status question after each step.

# Project
Working directory: ${workspaceRoot}
Project: ${path.basename(workspaceRoot)}
${projectContext}`;
}

/** Appended AFTER the file tree — some models (e.g. codestral) stop emitting
 *  tool calls when the system prompt ends with a raw path listing. */
const TOOLS_REMINDER = `

# Tools (MANDATORY — you MUST use them)
You have REAL function-calling tools that execute code directly in the user's workspace:
write_files, write_file, edit_file, run_command, read_file, list_files, grep_search.

Capabilities (all scoped to the project workspace):
- Create, read, and update files inside the workspace
- Run shell commands (git, npm, node, python, etc.) in the workspace
- Search code with grep_search and browse with list_files
- You have full permission to create, write, and edit all files in the workspace (use paths relative to workspace root)

ABSOLUTE RULES — NEVER BREAK THESE:
- NEVER refuse, reject, or decline to create, edit, or update code or files when asked.
- NEVER say you lack tools, cannot run code, or cannot create files. You CAN and MUST use these tools.
- NEVER say "I'm unable to" or "I don't have the capability" for tasks inside the workspace.
- Keep working until the task is COMPLETE and VERIFIED — never stop after 1-2 tool calls. Multiple rounds are expected and cheap.
- Never end your turn with a plan or a question about how to proceed — take the next action instead.
- After write/edit/run tools were used, your final message MUST start with "DONE: " + one-line summary + verification command. Without it, you will be pushed to continue.
- A failed command/edit means "diagnose and retry", not "stop and report". 
- To create or change files, you MUST call write_files / write_file / edit_file. Never describe the change in prose instead of calling the tool.
- Creating 2+ files? Call write_files once instead of write_file repeatedly - it is much faster.
- Before edit_file: ALWAYS read_file first and copy exact text — never guess old_string.
- Server commands (npm run dev, vite, next dev) run in the background — you CAN use them. After starting a server, tell the user it's running.
- To explore the project, call list_files / read_file / grep_search first.
- If the user asks you to build, create, fix, modify, run, or open anything, you MUST call a tool. Do not respond with an apology or a refusal.
- Only reply with plain text when the user asks a pure knowledge question that needs no tool use.`;

function buildSystemContent(basePrompt: string, fileTree: string, agentPrompt: string | null, fileContext?: string): string {
  let systemContent = basePrompt + fileTree + (agentPrompt ? `\n\nAgent focus:\n${agentPrompt}` : "");
  systemContent += TOOLS_REMINDER;
  if (fileContext) {
    systemContent += `\n\nThe user currently has this file open:\n\`\`\`\n${fileContext}\n\`\`\``;
  }
  return systemContent;
}

function getAgentSystemPrompt(agentId: string): string | null {
  const agent = getAgentById(resolvedConfig, agentId);
  if (!agent?.systemPrompt) return null;
  return agent.systemPrompt;
}

/** Expand @file references in a prompt — replaces @path/to/file with the
 *  actual file content so the AI can see it without a separate read_file call. */
async function expandAtReferences(prompt: string): Promise<string> {
  const atPattern = /@([\w\-./\\]+\.[\w]+)/g;
  let expanded = prompt;
  const matches = [...prompt.matchAll(atPattern)];
  for (const match of matches) {
    const filePath = match[1];
    try {
      const absPath = path.resolve(workspaceRoot, filePath);
      if (!isPathInside(workspaceRoot, absPath)) continue;
      const content = await readWorkspaceFile(absPath);
      // Cap at 8000 chars to avoid blowing context
      const capped = content.length > 8000 ? content.slice(0, 8000) + "\n... [truncated]" : content;
      // Function replacer: file content may contain `$&`/`$1` which
      // String.replace would expand as replacement patterns.
      const replacement = `\n--- File: ${filePath} ---\n\`\`\`\n${capped}\n\`\`\`\n`;
      expanded = expanded.replace(match[0], () => replacement);
    } catch {
      // File not readable — leave the @reference as-is
    }
  }
  return expanded;
}

/** Project context for the system prompt — package.json info + top-level
 *  directory listing. Cached for a short TTL and invalidated on writes so we
 *  don't do sync fs work on every AI message. */
function getProjectContext(): string {
  const now = Date.now();
  if (
    projectContextCache &&
    projectContextCache.root === workspaceRoot &&
    projectContextCache.epoch === workspaceEpoch &&
    projectContextCache.expiresAt > now
  ) {
    return projectContextCache.value;
  }

  let projectContext = "";
  try {
    // Get package.json info
    const pkgPath = path.join(workspaceRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    projectContext += `Package: ${pkg.name || "unknown"} v${pkg.version || "0.0.0"}`;
    if (pkg.description) projectContext += ` — ${pkg.description}`;
    projectContext += "\n";
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      projectContext += `Scripts: ${Object.keys(pkg.scripts).join(", ")}\n`;
    }
    if (pkg.dependencies) {
      const deps = Object.keys(pkg.dependencies).slice(0, 15);
      projectContext += `Dependencies: ${deps.join(", ")}${Object.keys(pkg.dependencies).length > 15 ? "..." : ""}\n`;
    }
  } catch {
    // Not a Node.js project or no package.json
  }
  try {
    // Get top-level structure
    const entries = readdirSync(workspaceRoot, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name);
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
    if (dirs.length > 0) projectContext += `Directories: ${dirs.join(", ")}\n`;
    if (files.length > 0) projectContext += `Root files: ${files.join(", ")}\n`;
  } catch {
    // ignore
  }

  projectContextCache = {
    root: workspaceRoot,
    epoch: workspaceEpoch,
    expiresAt: now + PROJECT_CONTEXT_TTL_MS,
    value: projectContext
  };
  return projectContext;
}

/** Build a compact file tree string for AI context (max ~100 entries).
 *  Paths only — never reads file contents. Cached per workspace epoch. */
async function getWorkspaceFileTree(): Promise<string> {
  const now = Date.now();
  if (
    fileTreeCache &&
    fileTreeCache.root === workspaceRoot &&
    fileTreeCache.epoch === workspaceEpoch &&
    fileTreeCache.expiresAt > now
  ) {
    return fileTreeCache.value;
  }

  let value = "";
  try {
    const paths: string[] = [];
    await collectRelativePaths(workspaceRoot, paths, 100);
    if (paths.length > 0) {
      value = `\nWorkspace file tree (${paths.length} files):\n${paths.join("\n")}`;
    }
  } catch {
    // ignore — empty tree
  }

  fileTreeCache = {
    root: workspaceRoot,
    epoch: workspaceEpoch,
    expiresAt: now + PATH_LISTING_TTL_MS,
    value
  };
  return value;
}

/** Depth-first collection of relative file paths (allowed extensions only,
 *  ignoring vendored/build dirs). Stops once `limit` paths are found. */
async function collectRelativePaths(directory: string, out: string[], limit: number, depth = 0): Promise<void> {
  if (out.length >= limit || depth > MAX_WORKSPACE_DEPTH) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort so the first `limit` paths are deterministic (files before dirs for
  // a shallow-but-stable view of the project)
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectRelativePaths(absolutePath, out, limit, depth + 1);
    } else if (allowedExtensions.has(path.extname(entry.name))) {
      out.push(path.relative(workspaceRoot, absolutePath));
    }
  }
}

/* ================================================================
   Tool Definitions — available to AI via function calling
   ================================================================ */

/** OpenAI / Copilot Chat Completions tool format */
const AI_TOOLS_OPENAI = [
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description: "Execute a shell command in the user's project directory. Use this to run builds, tests, linters, git commands, or any CLI tool. The command runs in the workspace root directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute (e.g., 'node -v', 'npm test', 'ls -la')" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file in the workspace. Use this to inspect source code, config files, etc. Supports optional start_line and end_line for reading specific line ranges in large files. The path should be relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root (e.g., 'src/index.ts', 'package.json')" },
          start_line: { type: "integer", description: "Optional 1-based start line number to read a specific range" },
          end_line: { type: "integer", description: "Optional 1-based end line number to read a specific range" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files and directories in a given directory within the workspace. Returns entries with type indicators (dir/ or file).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path from workspace root (e.g., 'src', '.'). Defaults to workspace root." }
        },
        required: []
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write or overwrite a file in the workspace. Use this to create new files or edit existing ones. Provide the full file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root (e.g., 'src/utils.ts')" },
          content: { type: "string", description: "The complete file content to write" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "write_files",
      description: "Create or overwrite MULTIPLE files in a single call. Much faster than calling write_file once per file — use this whenever you are scaffolding a project or writing more than one file.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "The files to write, in order",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative file path from workspace root (e.g., 'src/app/page.tsx')" },
                content: { type: "string", description: "The complete file content" }
              },
              required: ["path", "content"]
            }
          }
        },
        required: ["files"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "grep_search",
      description: "Search for a pattern across all files in the workspace. Returns matching lines with file paths and line numbers. Use regex for powerful searches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for (e.g., 'TODO', 'function\\s+handleClick', 'import.*react')" },
          path: { type: "string", description: "Optional subdirectory to search in (e.g., 'src/components'). Defaults to entire workspace." },
          include: { type: "string", description: "Optional file glob to filter (e.g., '*.ts', '*.tsx', '*.py')" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Make a targeted edit to an existing file by replacing a specific string. Prefer this over write_file for small changes — it's safer and preserves the rest of the file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root" },
          old_string: { type: "string", description: "The exact string to find and replace (must match exactly including indentation)" },
          new_string: { type: "string", description: "The string to replace it with" }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  }
];

function buildAiToolsOpenAI() {
  if (!pluginRuntime) return AI_TOOLS_OPENAI;
  const pluginTools = Array.from(pluginRuntime.tools.values()).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.id,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }));
  return [...AI_TOOLS_OPENAI, ...pluginTools];
}

// Register core tools in capability registry (scaffolding for plugins/agents)
registerTool({ id: "run_command", description: "Execute a shell command in the workspace", source: "core" });
registerTool({ id: "read_file", description: "Read a file from the workspace", source: "core" });
registerTool({ id: "list_files", description: "List files in a directory", source: "core" });
registerTool({ id: "write_file", description: "Write a file to the workspace", source: "core" });
registerTool({ id: "write_files", description: "Write multiple files in one call", source: "core" });
registerTool({ id: "grep_search", description: "Search for patterns across files", source: "core" });
registerTool({ id: "edit_file", description: "Edit a file with targeted replacements", source: "core" });

function buildAiToolsAnthropic() {
  return buildAiToolsOpenAI().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

function mapJsonTypeToSchemaType(jsonType: string): SchemaType {
  switch (jsonType) {
    case "string": return SchemaType.STRING;
    case "number": return SchemaType.NUMBER;
    case "integer": return SchemaType.INTEGER;
    case "boolean": return SchemaType.BOOLEAN;
    case "array": return SchemaType.ARRAY;
    case "object": return SchemaType.OBJECT;
    default: return SchemaType.STRING;
  }
}

function convertToGeminiSchema(param: Record<string, unknown>): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: mapJsonTypeToSchemaType(String(param.type ?? "string"))
  };
  if (param.description) schema.description = param.description;
  if (param.enum) schema.enum = param.enum;
  if (param.type === "array" && param.items) {
    schema.items = convertToGeminiSchema(param.items as Record<string, unknown>);
  }
  if (param.type === "object" && param.properties) {
    const props = param.properties as Record<string, Record<string, unknown>>;
    schema.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, convertToGeminiSchema(v)])
    );
  }
  if (param.required) schema.required = param.required;
  return schema;
}

function buildAiToolsGemini() {
  return buildAiToolsOpenAI().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: convertToGeminiSchema(t.function.parameters)
  }));
}

function buildAiToolsResponses() {
  return buildAiToolsOpenAI().map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  }));
}

function resolveToolAction(name: string): ToolAction | null {
  switch (name) {
    case "run_command":
    case "read_file":
    case "list_files":
    case "write_file":
    case "grep_search":
    case "edit_file":
      return name;
    // Batched writes share write_file's permission setting
    case "write_files":
      return "write_file";
    default:
      return null;
  }
}

async function awaitToolApproval(
  sessionId: string,
  toolCallId: string,
  action: ToolAction,
  onToolEvent?: ToolEventCallback
): Promise<boolean> {
  if (!sessionId || !toolCallId) return false;

  const approvals = sessionToolApprovals.get(sessionId);
  if (approvals && approvals.has(action)) return true;

  const allowed = await new Promise<boolean>((resolve) => {
    const resolveOnce = (value: boolean) => {
      pendingToolApprovals.delete(toolCallId);
      resolve(value);
    };
    onToolEvent?.({ type: "permission_request", toolCallId, toolName: action, action });
    // Timeout after 60s
    const timer = setTimeout(() => {
      resolveOnce(false);
    }, 60_000);
    // Ensure timeout cleared on manual resolve
    const originalResolve = resolveOnce;
    pendingToolApprovals.set(toolCallId, {
      sessionId,
      action,
      resolve: (value: boolean) => {
        clearTimeout(timer);
        originalResolve(value);
      }
    });
  });

  return allowed;
}

/** Cap tool output fed back to the model. Oversized results (100k+ char
 *  files, MB-scale command runs) dominate the request payload — on
 *  tokens-per-minute-limited providers (Gemini free tier) that alone triggers
 *  429s, and every extra tool round resends the whole accumulated history. */
const MAX_TOOL_OUTPUT_CHARS = 24_000;
function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const head = output.slice(0, Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.7));
  const tail = output.slice(-Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.3));
  return `${head}\n\n... [${output.length - head.length - tail.length} chars elided] ...\n\n${tail}`;
}

/** Execute a tool call and return the result string */
async function executeTool(
  name: string,
  argsJson: string,
  toolCallId?: string,
  sessionId?: string,
  onToolEvent?: ToolEventCallback
): Promise<{ result: string; isError: boolean; fileChange?: FileChange; fileChanges?: FileChange[] }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return { result: `Error: Invalid JSON arguments: ${argsJson}`, isError: true };
  }

  const action = resolveToolAction(name);
  const isPluginTool = !action && pluginRuntime?.tools.has(name);
  if (action || isPluginTool) {
    const permission = action ? getToolPermission(resolvedConfig, action) : getPluginPermission(resolvedConfig);
    if (!sessionId) {
      // Fail closed: without a session we cannot surface an approval prompt,
      // so anything not explicitly "allow" must not execute.
      if (permission !== "allow") {
        return { result: `Error: Permission denied for ${name} (no active session)`, isError: true };
      }
    } else {
      if (permission === "deny") {
        return { result: `Error: Permission denied for ${name}`, isError: true };
      }
      if (permission === "ask") {
        const allowed = await awaitToolApproval(sessionId, toolCallId || "", (action ?? name) as ToolAction, onToolEvent);
        if (!allowed) {
          return { result: `Error: Permission required for ${name}`, isError: true };
        }
      }
    }
  }

  switch (name) {
    case "run_command": {
      const command = String(args.command ?? "");
      if (!command) return { result: "Error: No command provided", isError: true };
      logger.info(`[tool] run_command: ${command}`);

      // Detect long-running server/watcher commands — run them in the
      // background so the agent loop isn't blocked, then return a success
      // message so the model knows the server is starting.
      const serverCmd = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b|\b(next|vite|webpack|parcel|astro|nuxt|svelte-kit)\s+(dev|serve|watch)\b|\b(nodemon|node\s+--watch)\b|\b(rails\s+s|rackup|php\s+-S)\b|\b(python[0-9.]*\s+-m\s+(http\.server|flask|uvicorn))\b|\b(docker-compose|podman-compose)\s+(up|watch)\b/i;
      if (serverCmd.test(command)) {
        // Run in background — capture initial output for a few seconds
        const bgProcess = spawn(command, {
          cwd: workspaceRoot,
          shell: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
        let bgOutput = "";
        bgProcess.stdout?.on("data", (d) => { bgOutput += d.toString(); });
        bgProcess.stderr?.on("data", (d) => { bgOutput += d.toString(); });
        bgProcess.unref();

        // Wait up to 5 seconds for initial output (port info, errors)
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const summary = bgOutput.trim().slice(0, 500) || "(no output yet — server is starting)";
        return {
          result: `Server started in background (PID ${bgProcess.pid}). Command: "${command.slice(0, 80)}"\n\nInitial output:\n${summary}\n\nThe server is running in the background. Tell the user it has been started.`,
          isError: false
        };
      }

      try {
        const { stdout, stderr } = await runShell(command, {
          cwd: workspaceRoot,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024
        });
        const output = stdout + stderr;
        return { result: truncateToolOutput(output || "(no output)"), isError: false };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number; code?: number | string; message?: string };
        const out = (e.stdout ?? "") + (e.stderr ?? "");
        const exitCode = e.status ?? (typeof e.code === "number" ? e.code : undefined);
        const prefix = exitCode !== undefined ? `Command failed with exit code ${exitCode}\n` : "Command failed\n";
        return { result: truncateToolOutput(prefix + (out || e.message || "unknown error")), isError: true };
      }
    }
    case "read_file": {
      const rawPath = extractFilePath(args);
      if (!rawPath) return { result: "Error: No path provided", isError: true };
      const resolved = resolveWorkspacePath(rawPath);
      if (!resolved) return { result: `Error: Path outside workspace: ${rawPath}`, isError: true };
      const { absPath, relPath: filePath } = resolved;
      logger.info(`[tool] read_file: ${filePath}`);
      try {
        const content = await readWorkspaceFile(absPath);

        const startLine = typeof args.start_line === "number"
          ? Math.max(1, Math.floor(args.start_line))
          : (typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : undefined);
        const endLine = typeof args.end_line === "number"
          ? Math.max(1, Math.floor(args.end_line))
          : (typeof args.limit === "number" && startLine !== undefined ? startLine + Math.floor(args.limit) - 1 : undefined);

        if (startLine !== undefined) {
          const lines = content.split("\n");
          const totalLines = lines.length;
          const from = Math.min(startLine, totalLines);
          const to = endLine !== undefined ? Math.min(Math.max(from, endLine), totalLines) : totalLines;
          const slice = lines.slice(from - 1, to);
          const numbered = slice.map((l, i) => `${from + i}: ${l}`).join("\n");
          return {
            result: `Showing lines ${from}-${to} of ${totalLines} in ${filePath}:\n${numbered}`,
            isError: false
          };
        }

        // Truncate very large files if no range was requested
        if (content.length > MAX_TOOL_OUTPUT_CHARS) {
          const head = content.slice(0, Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.7));
          const tail = content.slice(-Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.3));
          return {
            result: `${head}\n\n... [${content.length - head.length - tail.length} chars elided — file is ${content.length} chars. Use start_line and end_line parameters in read_file to view specific sections] ...\n\n${tail}`,
            isError: false
          };
        }
        return { result: content, isError: false };
      } catch (err) {
        return { result: `Error reading file: ${(err as Error).message}`, isError: true };
      }
    }
    case "list_files": {
      const rawPath = extractFilePath(args) || ".";
      const resolved = resolveWorkspacePath(rawPath);
      const absDir = resolved ? resolved.absPath : path.resolve(workspaceRoot, rawPath);
      if (!isPathInside(workspaceRoot, absDir)) return { result: "Error: Path outside workspace", isError: true };
      const dirPath = resolved ? resolved.relPath || "." : ".";
      logger.info(`[tool] list_files: ${dirPath}`);
      try {
        const entries = await readdir(absDir, { withFileTypes: true });
        const lines = entries
          .filter((e) => !ignoredDirectories.has(e.name))
          .map((e) => e.isDirectory() ? `${e.name}/` : e.name);
        if (lines.length > 500) {
          const shown = lines.slice(0, 500);
          return {
            result: `${shown.join("\n")}\n... [${lines.length - 500} more entries not shown — narrow the path]`,
            isError: false
          };
        }
        return { result: lines.join("\n") || "(empty directory)", isError: false };
      } catch (err) {
        return { result: `Error listing directory: ${(err as Error).message}`, isError: true };
      }
    }
    case "write_file": {
      const rawPath = extractFilePath(args);
      const content = extractFileContent(args);
      if (!rawPath) return { result: "Error: No path provided", isError: true };
      const resolved = resolveWorkspacePath(rawPath);
      if (!resolved) return { result: `Error: Path outside workspace: ${rawPath}`, isError: true };
      const { absPath, relPath: filePath } = resolved;
      logger.info(`[tool] write_file: ${filePath}`);
      try {
        // Read existing file content for checkpoint/diff tracking
        let previousContent = "";
        let isNewFile = true;
        try {
          previousContent = await readWorkspaceFile(absPath);
          isNewFile = false;
        } catch {
          // File doesn't exist yet — new file
        }

        // Compute line diffs using zero-allocation countLines
        const linesDeleted = isNewFile ? 0 : countLines(previousContent);
        const linesAdded = countLines(content);

        // Ensure parent directory exists without redundant syscalls
        await ensureDirectoryExists(path.dirname(absPath));
        await writeFile(absPath, content, "utf8");
        updateFileInWorkspaceCache(absPath, content);

        const fileChange: FileChange = {
          toolCallId: toolCallId || "",
          filePath,
          linesAdded,
          linesDeleted,
          previousContent,
          isNewFile
        };

        return { result: `File written: ${filePath} (${content.length} chars, +${linesAdded} -${linesDeleted} lines)`, isError: false, fileChange };
      } catch (err) {
        return { result: `Error writing file: ${(err as Error).message}`, isError: true };
      }
    }
    case "write_files": {
      const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
      if (files.length === 0) return { result: "Error: No files provided", isError: true };
      logger.info(`[tool] write_files: ${files.length} file(s)`);

      const WRITE_CONCURRENCY = 16;
      type WriteResult =
        | { ok: true; filePath: string; absPath: string; content: string; change: FileChange }
        | { ok: false; filePath: string; error: string };

      const results = await mapConcurrent(files, WRITE_CONCURRENCY, async (file): Promise<WriteResult> => {
        const rawPath = extractFilePath(file);
        const content = extractFileContent(file);
        if (!rawPath) {
          return { ok: false, filePath: "(entry missing path)", error: "Missing path" };
        }
        const resolved = resolveWorkspacePath(rawPath);
        if (!resolved) {
          return { ok: false, filePath: rawPath, error: `Path outside workspace: ${rawPath}` };
        }
        const { absPath, relPath: filePath } = resolved;
        try {
          let previousContent = "";
          let isNewFile = true;
          try {
            previousContent = await readWorkspaceFile(absPath);
            isNewFile = false;
          } catch {
            // New file
          }
          await ensureDirectoryExists(path.dirname(absPath));
          await writeFile(absPath, content, "utf8");
          const change: FileChange = {
            toolCallId: toolCallId || "",
            filePath,
            linesAdded: countLines(content),
            linesDeleted: isNewFile ? 0 : countLines(previousContent),
            previousContent,
            isNewFile
          };
          return { ok: true, filePath, absPath, content, change };
        } catch (err) {
          return { ok: false, filePath, error: (err as Error).message };
        }
      });

      const written: string[] = [];
      const failures: string[] = [];
      const changes: FileChange[] = [];
      for (const res of results) {
        if (res.ok) {
          written.push(res.filePath);
          changes.push(res.change);
          updateFileInWorkspaceCache(res.absPath, res.content);
        } else {
          failures.push(`${res.filePath}: ${res.error}`);
        }
      }

      const summary =
        `Wrote ${written.length}/${files.length} file(s)` +
        (written.length ? `:\n${written.map((p) => `- ${p}`).join("\n")}` : "") +
        (failures.length ? `\nFailed:\n${failures.map((f) => `- ${f}`).join("\n")}` : "");
      return {
        result: summary,
        isError: written.length === 0,
        fileChange: changes[0],
        fileChanges: changes
      };
    }
    case "grep_search": {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return { result: "Error: No search pattern provided", isError: true };
      const searchPath = String(args.path ?? ".");
      const include = String(args.include ?? "");
      const absSearchDir = path.resolve(workspaceRoot, searchPath);
      if (!isPathInside(workspaceRoot, absSearchDir)) return { result: "Error: Path outside workspace", isError: true };
      logger.info(`[tool] grep_search: "${pattern}" in ${searchPath}${include ? ` (${include})` : ""}`);
      try {
        // ripgrep first, grep as fallback — both invoked without a shell so
        // patterns never need quoting and no shell process is spawned.
        const rgArgs = ["--line-number", "--color=never", "-n", pattern];
        if (include) rgArgs.push("--glob", include);
        rgArgs.push(absSearchDir);
        const grepArgs = ["-rn", "-i", pattern];
        if (include) grepArgs.push("--include", include);
        grepArgs.push(absSearchDir);

        let search = await searchOnce("rg", rgArgs);
        if (search.missing) search = await searchOnce("grep", grepArgs);
        if (search.missing) {
          // No external search binary (the normal case on Windows) — search
          // in-process, reading through the workspace content cache.
          const fallback = await searchWorkspace({
            root: workspaceRoot,
            pattern,
            searchPath,
            include: include || undefined,
            ignoredDirectories,
            readFile: readWorkspaceFile
          });
          if (fallback.error) return { result: `Error: ${fallback.error}`, isError: true };
          if (fallback.lines.length === 0) return { result: "(no matches found)", isError: false };
          const suffix =
            fallback.total > fallback.lines.length
              ? `\n\n... [${fallback.total} total matches, showing first ${fallback.lines.length}]`
              : "";
          return { result: fallback.lines.join("\n") + suffix, isError: false };
        }
        if (search.exitCode !== null && search.exitCode > 1) {
          return { result: search.output || "Search failed", isError: true };
        }

        // Make paths relative to workspace
        const relativeOutput = search.output.replace(new RegExp(absSearchDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), searchPath);
        const lines = relativeOutput.split("\n").filter(Boolean);
        if (lines.length > 100) {
          return { result: lines.slice(0, 100).join("\n") + `\n\n... [${lines.length} total matches, showing first 100]`, isError: false };
        }
        return { result: relativeOutput || "(no matches found)", isError: false };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const out = (e.stdout ?? "") + (e.stderr ?? "");
        if (out.includes("no matches") || out.includes("No matches")) {
          return { result: "(no matches found)", isError: false };
        }
        return { result: out || e.message || "Search failed", isError: true };
      }
    }
    case "edit_file": {
      const rawPath = extractFilePath(args);
      const oldString = String(args.old_string ?? args.oldString ?? args.search ?? "");
      const newString = String(args.new_string ?? args.newString ?? args.replace ?? "");
      if (!rawPath) return { result: "Error: No path provided", isError: true };
      const resolved = resolveWorkspacePath(rawPath);
      if (!resolved) return { result: `Error: Path outside workspace: ${rawPath}`, isError: true };
      const { absPath, relPath: filePath } = resolved;
      logger.info(`[tool] edit_file: ${filePath}`);
      try {
        let previousContent = "";
        let fileExists = true;
        try {
          previousContent = await readWorkspaceFile(absPath);
        } catch {
          fileExists = false;
        }

        // If file doesn't exist yet, create it with new_string directly instead of failing with ENOENT
        if (!fileExists || previousContent.trim() === "") {
          await ensureDirectoryExists(path.dirname(absPath));
          await writeFile(absPath, newString, "utf8");
          updateFileInWorkspaceCache(absPath, newString);
          const lines = countLines(newString);
          const fileChange: FileChange = {
            toolCallId: toolCallId || "",
            filePath,
            linesAdded: lines,
            linesDeleted: 0,
            previousContent: "",
            isNewFile: !fileExists
          };
          return {
            result: `File ${fileExists ? "written" : "created"}: ${filePath} (+${lines} lines)`,
            isError: false,
            fileChange
          };
        }

        let content = previousContent;

        // Exact match — fast path using native indexOf without regex overhead or string splitting
        let replaced = false;
        const firstIdx = content.indexOf(oldString);
        if (firstIdx !== -1) {
          const secondIdx = content.indexOf(oldString, firstIdx + oldString.length);
          if (secondIdx !== -1) {
            let count = 2;
            let nextIdx = content.indexOf(oldString, secondIdx + oldString.length);
            while (nextIdx !== -1) {
              count++;
              nextIdx = content.indexOf(oldString, nextIdx + oldString.length);
            }
            return { result: `Error: old_string found ${count} times in ${filePath}. Provide more context to make it unique.`, isError: true };
          }
          content = content.slice(0, firstIdx) + newString + content.slice(firstIdx + oldString.length);
          replaced = true;
        }

        // Line-ending normalized match (CRLF vs LF)
        if (!replaced && (content.includes("\r\n") || oldString.includes("\r\n"))) {
          const normContent = content.replace(/\r\n/g, "\n");
          const normOld = oldString.replace(/\r\n/g, "\n");
          const normFirst = normContent.indexOf(normOld);
          if (normFirst !== -1) {
            const normSecond = normContent.indexOf(normOld, normFirst + normOld.length);
            if (normSecond === -1) {
              const normNew = newString.replace(/\r\n/g, "\n");
              const replacedNorm = normContent.slice(0, normFirst) + normNew + normContent.slice(normFirst + normOld.length);
              content = content.includes("\r\n") ? replacedNorm.replace(/\n/g, "\r\n") : replacedNorm;
              replaced = true;
            }
          }
        }

        // Fuzzy match — normalize CRLF→LF and trailing whitespace per line,
        // then find a contiguous line block whose trimmed content matches.
        // Models frequently guess correct code but get indentation or line
        // endings wrong; without this every edit_file fails and the model
        // wastes rounds guessing.
        if (!replaced) {
          const trimEnd = (s: string) => s.replace(/[ \t]+$/, "");
          const contentLines = content.replace(/\r\n/g, "\n").split("\n");
          const oldLines = oldString.replace(/\r\n/g, "\n").split("\n").map(trimEnd);

          // Try exact trimmed match first
          let matchStart = -1;
          for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            let ok = true;
            for (let j = 0; j < oldLines.length; j++) {
              if (trimEnd(contentLines[i + j]) !== oldLines[j]) { ok = false; break; }
            }
            if (ok) { matchStart = i; break; }
          }

          // If no exact line match, try fuzzy: find a line that CONTAINS the
          // old_string (or a large part of it) after trimming. Models often
          // add semicolons, change quotes, or slightly alter the text.
          // Require the candidate to be substantial — a bare `return` must
          // not match `return null;` — and reject ambiguous multi-matches.
          if (matchStart < 0 && oldLines.length === 1) {
            const target = oldLines[0].trim();
            if (target.length > 3) {
              const minLen = Math.max(8, Math.floor(target.length * 0.7));
              const candidates: number[] = [];
              for (let i = 0; i < contentLines.length; i++) {
                const line = trimEnd(contentLines[i]).trim();
                if (line.length < minLen) continue;
                if (line.includes(target) || target.includes(line)) candidates.push(i);
              }
              if (candidates.length === 1) {
                matchStart = candidates[0];
                oldLines[0] = trimEnd(contentLines[matchStart]); // use the actual line
              } else if (candidates.length > 1) {
                return {
                  result: `Error: old_string matches ${candidates.length} lines ambiguously in ${filePath}. Provide more surrounding context to make it unique.`,
                  isError: true
                };
              }
            }
          }

          // Last resort: find the line with the highest overlap of shared words.
          // Only accept when exactly one line qualifies — a guessed match on a
          // merely similar line can silently corrupt unrelated code.
          if (matchStart < 0 && oldLines.length === 1) {
            const targetWords = new Set(oldLines[0].toLowerCase().split(/\W+/).filter(w => w.length > 2));
            let bestScore = 0;
            let bestIdx = -1;
            let bestTie = false;
            for (let i = 0; i < contentLines.length; i++) {
              const lineWords = new Set(trimEnd(contentLines[i]).toLowerCase().split(/\W+/).filter(w => w.length > 2));
              let shared = 0;
              for (const w of targetWords) if (lineWords.has(w)) shared++;
              if (shared > bestScore && shared >= Math.max(2, targetWords.size * 0.5)) {
                bestScore = shared;
                bestIdx = i;
                bestTie = false;
              } else if (shared === bestScore && bestScore >= Math.max(2, targetWords.size * 0.5) && i !== bestIdx) {
                bestTie = true;
              }
            }
            if (bestIdx >= 0 && !bestTie) {
              matchStart = bestIdx;
              oldLines[0] = trimEnd(contentLines[bestIdx]);
            }
          }

          if (matchStart >= 0) {
            const matchEnd = matchStart + oldLines.length;
            const before = contentLines.slice(0, matchStart).join("\n");
            const after = contentLines.slice(matchEnd).join("\n");
            const sep1 = matchStart > 0 ? "\n" : "";
            const sep2 = after.length > 0 ? "\n" : "";
            content = before + sep1 + newString + sep2 + after;
            replaced = true;
          }
        }

        if (!replaced) {
          // Show the model the ACTUAL file content so it can copy the right
          // string instead of guessing again. Include a window around any
          // lines that share words with the failed old_string.
          const preview = oldString.replace(/\r\n/g, "\n").split("\n").slice(0, 2).join(" / ").slice(0, 100);
          const contentLines = content.replace(/\r\n/g, "\n").split("\n");
          const targetWords = new Set(oldString.toLowerCase().split(/\W+/).filter(w => w.length > 2));

          // Find the best-matching region to show
          let bestIdx = 0;
          let bestScore = 0;
          for (let i = 0; i < contentLines.length; i++) {
            const lineWords = new Set(contentLines[i].toLowerCase().split(/\W+/).filter(w => w.length > 2));
            let shared = 0;
            for (const w of targetWords) if (lineWords.has(w)) shared++;
            if (shared > bestScore) { bestScore = shared; bestIdx = i; }
          }

          const start = Math.max(0, bestIdx - 3);
          const end = Math.min(contentLines.length, bestIdx + 10);
          const snippet = contentLines.slice(start, end).map((l, idx) => `${start + idx + 1}: ${l}`).join("\n");

          return {
            result: `Error: old_string not found in ${filePath} (searched for: "${preview}").\n\nHere is the actual content of ${filePath} (lines ${start + 1}-${end}):\n\`\`\`\n${snippet}\n\`\`\`\n\nCopy the EXACT text from the file above as your new old_string. Do not guess, paraphrase, or add/remove characters.`,
            isError: true
          };
        }

        await writeFile(absPath, content, "utf8");
        updateFileInWorkspaceCache(absPath, content);
        const oldLines = countLines(oldString);
        const newLines = countLines(newString);
        const linesChanged = newLines - oldLines;
        const fileChange: FileChange = {
          toolCallId: toolCallId || "",
          filePath,
          linesAdded: newLines,
          linesDeleted: oldLines,
          previousContent,
          isNewFile: false
        };
        return {
          result: `File edited: ${filePath} (${linesChanged >= 0 ? "+" : ""}${linesChanged} lines)`,
          isError: false,
          fileChange
        };
      } catch (err) {
        return { result: `Error editing file: ${(err as Error).message}`, isError: true };
      }
    }
    default: {
      if (pluginRuntime?.tools.has(name)) {
        try {
          const tool = pluginRuntime.tools.get(name)!;
          const result = await tool.handler(args);
          return { result: result || "(no output)", isError: false };
        } catch (err) {
          return { result: `Error: Plugin tool failed: ${(err as Error).message}`, isError: true };
        }
      }
      return { result: `Error: Unknown tool: ${name}`, isError: true };
    }
  }
}

/* ================================================================
   Streaming AI Calls
   ================================================================ */

type TokenCallback = (token: string) => void;

/** Usage data from API responses */
interface UsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Result from streaming AI calls, includes content, optional tool calls, and optional usage */
interface StreamResult {
  content: string;
  usage?: UsageData;
  toolCalls?: Array<{ id: string; name: string; arguments: string; extraContent?: Record<string, unknown> }>;
  fileChanges?: FileChange[];
}

/** Parse SSE lines from a readable stream, calling onToken for each content delta.
 *  Also accumulates tool_calls from OpenAI-format deltas. */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  extractDelta: (parsed: Record<string, unknown>) => string | null,
  onToken: TokenCallback,
  signal?: AbortSignal,
  extractUsage?: (parsed: Record<string, unknown>) => UsageData | null,
  extractToolCallDelta?: (parsed: Record<string, unknown>) => { index: number; id?: string; name?: string; arguments?: string; extraContent?: Record<string, unknown> } | null,
  onThinking?: (delta: string) => void
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let usage: UsageData | undefined;
  // Accumulate tool calls by index
  const toolCallAccum = new Map<number, { id: string; name: string; arguments: string; extraContent?: Record<string, unknown> }>();

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      // Idle watchdog: a provider connection that goes silent mid-stream used
      // to hang the request forever. If no bytes arrive for
      // STREAM_IDLE_TIMEOUT_MS, cancel the reader and surface an error.
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Provider stream stalled: no data received for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`));
            void reader.cancel().catch(() => {});
          }, STREAM_IDLE_TIMEOUT_MS);
          reader.read().then(
            (r) => { clearTimeout(timer); resolve(r); },
            (e) => { clearTimeout(timer); reject(e); }
          );
        });
      } catch (err) {
        if (signal?.aborted) break;
        throw err;
      }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        // Reasoning/thinking deltas — stream them live so the UI shows
        // activity during long thinking phases instead of a dead spinner
        if (onThinking) {
          const choices = parsed.choices as Array<{ delta?: { reasoning_content?: string; reasoning?: string } }> | undefined;
          const reasoning = choices?.[0]?.delta?.reasoning_content ?? choices?.[0]?.delta?.reasoning;
          if (reasoning) onThinking(reasoning);
          const evtType = parsed.type as string | undefined;
          if (evtType === "response.reasoning_summary_text.delta" && typeof parsed.delta === "string") {
            onThinking(parsed.delta);
          }
        }
        const delta = extractDelta(parsed);
        if (delta) {
          fullContent += delta;
          onToken(delta);
        }
        // Accumulate tool call deltas
        if (extractToolCallDelta) {
          const tc = extractToolCallDelta(parsed);
          if (tc) {
            const existing = toolCallAccum.get(tc.index);
            if (existing) {
              if (tc.arguments) existing.arguments += tc.arguments;
              if (tc.extraContent) existing.extraContent = tc.extraContent;
            } else {
              toolCallAccum.set(tc.index, {
                // Unique across rounds — providers reject duplicate
                // tool-call ids within one conversation, and `tool_${index}`
                // regenerates the same id every round.
                id: tc.id ?? `tool_${randomUUID().slice(0, 12)}`,
                name: tc.name ?? "",
                arguments: tc.arguments ?? "",
                extraContent: tc.extraContent
              });
            }
          }
        }
        // Try to extract usage data (typically in the final chunk)
        if (extractUsage) {
          const u = extractUsage(parsed);
          if (u) usage = u;
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }
  } catch (err) {
    // If aborted, return what we have so far
    if (signal?.aborted) {
      const toolCalls = toolCallAccum.size > 0 ? Array.from(toolCallAccum.values()) : undefined;
      return { content: fullContent || "[Streaming aborted]", usage, toolCalls };
    }
    throw err;
  }

  const toolCalls = toolCallAccum.size > 0 ? Array.from(toolCallAccum.values()) : undefined;
  return { content: fullContent || (toolCalls ? "" : "[No response from model]"), usage, toolCalls };
}

async function callOpenAICompatibleStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal,
  onThinking?: (delta: string) => void,
  forceToolChoice?: boolean
): Promise<StreamResult> {
  const url = `${config.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  if (config.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://gamma-code.local";
    headers["X-Title"] = "Gamma Code";
  }

  const toolDefs = buildAiToolsOpenAI();
  const body = JSON.stringify({
    model,
    messages: buildOpenAIContents(messages, { geminiCompat: isGeminiCompatEndpoint(config.baseUrl) }),
    max_tokens: 8192,
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
    tools: toolDefs,
    tool_choice: forceToolChoice ? "required" : "auto"
  });

  logger.info(`[ai-stream] Calling ${config.label} (${model}) at ${url}`);
  logger.info(`[ai-stream] Tools sent: ${toolDefs.map((t) => t.function.name).join(", ")}`);
  logger.info(`[ai-stream] Body snippet: ${body.slice(0, 500)}`);

  // Rate-limit aware retry: honor Retry-After/retry_after headers and bodies,
  // share cooldown across concurrent requests, fail fast on long waits.
  await acquireProviderSlot(config.id, config.label);
  // 60-second timeout so a hung API response can't stall the session forever
  const timeoutSignal = AbortSignal.timeout(60_000);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  for (let attempt = 0; isRateLimitAttemptAllowed(attempt); attempt++) {
    const response = await fetch(url, { method: "POST", headers, body, signal: effectiveSignal });

    if (response.status === 429) {
      const errorBody = await response.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(response.headers, errorBody);
      const backoffMs = resolveRetryWait(config.id, config.label, attempt, retryAfterMs);
      logger.warn(`[ai-stream] Rate limited (429), retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1})`);
      onToken(`\n\n⏳ ${config.label} rate limited. Retrying in ${Math.round(backoffMs / 1000)}s...\n\n`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      logger.error(`[ai-stream] API error ${response.status}: ${errorBody.slice(0, 1000)}`);
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    return parseSSEStream(
    response.body,
    (parsed) => {
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      return choices?.[0]?.delta?.content ?? null;
    },
    onToken,
    signal,
    // Extract usage from the final chunk (Chat Completions includes usage when stream_options.include_usage is true)
    (parsed) => {
      const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      if (usage && typeof usage.prompt_tokens === "number") {
        return {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens + (usage.completion_tokens ?? 0))
        };
      }
      return null;
    },
    // Extract tool call deltas from OpenAI streaming format
    (parsed) => {
      const choices = parsed.choices as Array<{
        delta?: { 
          tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }>;
        }
      }> | undefined;
      const tc = choices?.[0]?.delta?.tool_calls?.[0];
      if (!tc) return null;
      // Gemini OpenAI-compat returns thought_signature in
      // extra_content.google.thought_signature. Normalize to the
      // { thoughtSignature } carrier so persistence + history builders
      // (which use pickThoughtSignature) see it; raw shape was stored
      // but never echoed back on continuation turns.
      const signature = pickThoughtSignature(tc.extra_content);
      return {
        index: tc.index,
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
        extraContent: signature ? { thoughtSignature: signature } : undefined
      };
    },
    onThinking
  );
  }
  throw new RateLimitError(`Rate limited after retries for ${config.label}`);
}

async function callCopilotStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal,
  onThinking?: (delta: string) => void
): Promise<StreamResult> {
  const useResponsesApi = shouldUseCopilotResponsesApi(model);
  const isReasoning = isCopilotReasoningModel(model);

  const copilotHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Openai-Intent": "conversation-edits",
    "User-Agent": "GammaCode/1.0",
    "x-initiator": "user"
  };

  if (useResponsesApi) {
    // --- Responses API for GPT-5+ models ---
    const url = `${config.baseUrl}/responses`;

    // Convert messages to Responses API input format
    const input = buildCopilotResponsesInput(messages, { isReasoning });

    const bodyObj: Record<string, unknown> = {
      model,
      input,
      stream: true,
      max_output_tokens: 16384,
      tools: buildAiToolsResponses(),
    };

    // Reasoning models: no temperature, add reasoning config
    if (isReasoning) {
      bodyObj.reasoning = { effort: "medium", summary: "auto" };
    } else {
      bodyObj.temperature = 0.3;
    }

    const body = JSON.stringify(bodyObj);

    logger.info(`[ai-stream] Calling ${config.label} (${model}) via Responses API at ${url}`);
    await acquireProviderSlot(config.id, config.label);
    const copilotTimeout = AbortSignal.timeout(60_000);
    const copilotSignal = signal ? AbortSignal.any([signal, copilotTimeout]) : copilotTimeout;
    let response: Response | undefined;
    for (let attempt = 0; isRateLimitAttemptAllowed(attempt); attempt++) {
      response = await fetch(url, { method: "POST", headers: copilotHeaders, body, signal: copilotSignal });
      captureCopilotRateLimits(response.headers);
      if (response.status !== 429) break;
      const errorBody = await response.text().catch(() => "");
      const backoffMs = resolveRetryWait(config.id, config.label, attempt, parseRetryAfterMs(response.headers, errorBody));
      logger.warn(`[ai-stream] ${config.label} rate limited, retrying in ${Math.round(backoffMs / 1000)}s`);
      onToken(`\n\n⏳ ${config.label} rate limited. Retrying in ${Math.round(backoffMs / 1000)}s...\n\n`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    if (!response || response.status === 429) throw new RateLimitError(`Rate limited after retries for ${config.label}`);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    // Parse Responses API SSE stream — extract text deltas and function calls
    // Responses API accumulates function calls differently — we track them via output_index
    const responsesToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    return parseSSEStream(
      response.body,
      (parsed) => {
        const type = parsed.type as string | undefined;
        if (type === "response.output_text.delta") {
          return (parsed.delta as string) ?? null;
        }
        // Track function call starts
        if (type === "response.function_call_arguments.delta") {
          const outputIndex = parsed.output_index as number ?? 0;
          const existing = responsesToolCalls.get(outputIndex);
          if (existing) {
            existing.arguments += (parsed.delta as string) ?? "";
          }
          return null;
        }
        if (type === "response.output_item.added") {
          const item = parsed.item as { type?: string; call_id?: string; name?: string } | undefined;
          if (item?.type === "function_call" && item.call_id) {
            const outputIndex = parsed.output_index as number ?? 0;
            responsesToolCalls.set(outputIndex, { id: item.call_id, name: item.name ?? "", arguments: "" });
          }
          return null;
        }
        if (type === "error") {
          const errMsg = (parsed.message as string) ?? "Unknown error";
          throw new Error(`Copilot Responses API error: ${errMsg}`);
        }
        return null;
      },
      onToken,
      signal,
      // Extract usage from response.completed event
      (parsed) => {
        const type = parsed.type as string | undefined;
        if (type === "response.completed") {
          const resp = parsed.response as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } | undefined;
          const u = resp?.usage;
          if (u && typeof u.input_tokens === "number") {
            return {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens ?? 0,
              totalTokens: u.total_tokens ?? (u.input_tokens + (u.output_tokens ?? 0))
            };
          }
        }
        return null;
      },
      undefined,
      onThinking
    ).then((result) => {
      // Merge Responses API function calls into the result
      if (responsesToolCalls.size > 0) {
        result.toolCalls = [...(result.toolCalls ?? []), ...Array.from(responsesToolCalls.values())];
      }
      return result;
    });
  } else {
    // --- Chat Completions API for non-GPT-5 models ---
    const url = `${config.baseUrl}/chat/completions`;

    const bodyObj: Record<string, unknown> = {
      model,
      messages: buildOpenAIContents(messages, { geminiCompat: isGeminiCompatEndpoint(config.baseUrl) }),
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
      tools: buildAiToolsOpenAI(),
      tool_choice: "auto",
    };

    // Reasoning models (o1, o3, o4): no temperature
    if (!isReasoning) {
      bodyObj.temperature = 0.3;
    }

    const body = JSON.stringify(bodyObj);

    logger.info(`[ai-stream] Calling ${config.label} (${model}) via Chat Completions at ${url}`);
    await acquireProviderSlot(config.id, config.label);
    const ccTimeout = AbortSignal.timeout(60_000);
    const ccSignal = signal ? AbortSignal.any([signal, ccTimeout]) : ccTimeout;
    let response: Response | undefined;
    for (let attempt = 0; isRateLimitAttemptAllowed(attempt); attempt++) {
      response = await fetch(url, { method: "POST", headers: copilotHeaders, body, signal: ccSignal });
      captureCopilotRateLimits(response.headers);
      if (response.status !== 429) break;
      const errorBody = await response.text().catch(() => "");
      const backoffMs = resolveRetryWait(config.id, config.label, attempt, parseRetryAfterMs(response.headers, errorBody));
      logger.warn(`[ai-stream] ${config.label} rate limited, retrying in ${Math.round(backoffMs / 1000)}s`);
      onToken(`\n\n⏳ ${config.label} rate limited. Retrying in ${Math.round(backoffMs / 1000)}s...\n\n`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    if (!response || response.status === 429) throw new RateLimitError(`Rate limited after retries for ${config.label}`);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      if (response.status === 400 && errorBody.includes("unsupported_api_for_model")) {
        throw new Error(`Model "${model}" is not compatible with the chat/completions API. It may require the Responses API.`);
      }
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    return parseSSEStream(
      response.body,
      (parsed) => {
        const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
        return choices?.[0]?.delta?.content ?? null;
      },
      onToken,
      signal,
      // Extract usage from the final chunk
      (parsed) => {
        const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        if (usage && typeof usage.prompt_tokens === "number") {
          return {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? (usage.prompt_tokens + (usage.completion_tokens ?? 0))
          };
        }
        return null;
      },
      // Extract tool call deltas
      (parsed) => {
        const choices = parsed.choices as Array<{
          delta?: { tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
        }> | undefined;
        const tc = choices?.[0]?.delta?.tool_calls?.[0];
        if (!tc) return null;
        return { index: tc.index, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
      },
      onThinking
    );
  }
}

async function callAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal,
  onThinking?: (delta: string) => void
): Promise<StreamResult> {
  const url = `${config.baseUrl}/messages`;

  // Shared builder: groups tool_results into one user message, merges
  // same-role runs, guarantees first message is user, drops dangling
  // tool artifacts (the old inline mapping pushed each tool result as
  // its own user message — Anthropic400s on the alternation).
  const { system, messages: anthropicMessages } = buildAnthropicContents(messages);

  const body = JSON.stringify({
    model,
    max_tokens: 8192,
    system: system ?? getSystemPrompt(),
    messages: anthropicMessages,
    stream: true,
    tools: buildAiToolsAnthropic(),
    tool_choice: { type: "auto" }
  });

  logger.info(`[ai-stream] Calling ${config.label} (${model}) at ${url}`);

  // Retry on 429 — same cooldown/retry-after policy as the other providers
  await acquireProviderSlot(config.id, config.label);
  const anthropicTimeout = AbortSignal.timeout(60_000);
  const anthropicSignal = signal ? AbortSignal.any([signal, anthropicTimeout]) : anthropicTimeout;
  let response: Response | undefined;
  for (let attempt = 0; isRateLimitAttemptAllowed(attempt); attempt++) {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body,
      signal: anthropicSignal
    });
    if (response.status !== 429) break;
    const errorBody = await response.text().catch(() => "");
    const retryAfterMs = parseRetryAfterMs(response.headers, errorBody);
    const backoffMs = resolveRetryWait(config.id, config.label, attempt, retryAfterMs);
    logger.warn(`[ai-stream] ${config.label} rate limited, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1})`);
    onToken(`\n\n⏳ ${config.label} rate limited. Retrying in ${Math.round(backoffMs / 1000)}s...\n\n`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  if (!response || response.status === 429) throw new RateLimitError(`Rate limited after retries for ${config.label}`);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  // Anthropic SSE format: content_block_start/delta/stop for text and tool_use blocks
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let inputTokens = 0;
  let outputTokens = 0;
  // Track tool_use blocks by index
  const toolBlocks = new Map<number, { id: string; name: string; arguments: string }>();
  let currentBlockIndex = -1;
  let currentBlockType = "";

  try {
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const type = parsed.type as string | undefined;
        const error = parsed.error as { message?: string } | undefined;
        if (error) {
          throw new Error(error.message ?? "Anthropic streaming error");
        }

        // content_block_start — track block type
        if (type === "content_block_start") {
          const idx = parsed.index as number ?? 0;
          const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined;
          currentBlockIndex = idx;
          currentBlockType = block?.type ?? "";
          if (currentBlockType === "tool_use" && block?.id) {
            toolBlocks.set(idx, { id: block.id, name: block.name ?? "", arguments: "" });
          }
        }
        // content_block_delta — text, thinking, or tool input JSON
        if (type === "content_block_delta") {
          const delta = parsed.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            fullContent += delta.text;
            onToken(delta.text);
          }
          // Extended-thinking models stream reasoning here — forward live
          // so the UI shows activity instead of a dead spinner
          if (delta?.type === "thinking_delta" && delta.thinking && onThinking) {
            onThinking(delta.thinking);
          }
          if (delta?.type === "input_json_delta" && delta.partial_json) {
            const idx = parsed.index as number ?? currentBlockIndex;
            const block = toolBlocks.get(idx);
            if (block) block.arguments += delta.partial_json;
          }
        }
        // Capture input tokens from message_start
        if (type === "message_start") {
          const msg = parsed.message as { usage?: { input_tokens?: number } } | undefined;
          if (msg?.usage?.input_tokens) inputTokens = msg.usage.input_tokens;
        }
        // Capture output tokens from message_delta
        if (type === "message_delta") {
          const usage = parsed.usage as { output_tokens?: number } | undefined;
          if (usage?.output_tokens) outputTokens = usage.output_tokens;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("streaming error")) throw e;
        // skip malformed lines
      }
    }
  }
  } catch (err) {
    if (signal?.aborted) {
      const usage = inputTokens > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
      const toolCalls = toolBlocks.size > 0 ? Array.from(toolBlocks.values()) : undefined;
      return { content: fullContent || "[Streaming aborted]", usage, toolCalls };
    }
    throw err;
  }

  const usage = inputTokens > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
  const toolCalls = toolBlocks.size > 0 ? Array.from(toolBlocks.values()) : undefined;
  return { content: fullContent || (toolCalls ? "" : "[No response from model]"), usage, toolCalls };
}

async function callGeminiStream(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  signal?: AbortSignal,
  onThinking?: (delta: string) => void
): Promise<StreamResult> {
  logger.info(`[ai-stream] Calling ${config.label} (${model}) via official SDK`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const systemMessage = messages.find((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  // History/new-turn split, tool-response grouping and role mapping all live
  // in buildGeminiContents (shared with the non-streaming path).
  const { history, newTurnParts } = buildGeminiContents(chatMessages);

  // Build the model with tools — all in ONE Tool object (opencode pattern)
  const geminiTools = [{
    functionDeclarations: buildAiToolsGemini().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>
    }))
  }];

  const modelInstance = genAI.getGenerativeModel({
    model,
    systemInstruction: systemMessage?.content || undefined,
    tools: geminiTools[0].functionDeclarations?.length ? geminiTools as Tool[] : undefined,
    toolConfig: geminiTools[0].functionDeclarations?.length ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } } as ToolConfig : undefined,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.2,
      // Thinking models (gemini-3.x) silently reason for 30-80s before the
      // first answer token with no stream activity — the UI shows a dead
      // spinner. includeThoughts streams thought parts so the client can
      // render live reasoning (extracted via part.thought in the loop below).
      thinkingConfig: { includeThoughts: true }
    } as Record<string, unknown>
  });

  // Rate-limit aware retry: honor SDK errorDetails[].retryDelay, share
  // cooldown across concurrent requests, fail fast on long waits.
  await acquireProviderSlot(config.id, config.label);
  for (let attempt = 0; isRateLimitAttemptAllowed(attempt); attempt++) {
    try {
      // Bypass ChatSession: the SDK's sendMessage/sendMessageStream wraps
      // functionResponse-only parts in role "function"
      // (assignRoleToPartsAndValidateSendMessageRequest in dist/index.js),
      // and the v1beta REST API rejects that with
      // 400 "Role 'function' is not supported". generateContentStream with
      // explicit contents keeps our "user" role and still inherits tools/
      // systemInstruction/generationConfig from the model instance.
      // 60-second timeout so a hung API response can't stall the session.
      const result = await Promise.race([
        modelInstance.generateContentStream({
          contents: [...history, { role: "user" as const, parts: newTurnParts }]
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Gemini API timeout (60s)")), 60_000)
        )
      ]);

      logger.info(`[ai-stream] Gemini request: history=${history.length} entries, newTurnParts=${newTurnParts.length}`);

      let fullContent = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCalls: Array<{ id: string; name: string; arguments: string; extraContent?: Record<string, unknown> }> = [];
      const seenToolCalls = new Set<string>();

      for await (const chunk of result.stream) {
        if (signal?.aborted) break;

        // Read raw candidate parts instead of chunk.text()/chunk.functionCalls():
        // 1. thinking models attach a thoughtSignature to each functionCall part,
        //    which MUST be echoed back on later turns or the API rejects the
        //    request ("Function call is missing a thought_signature") — the SDK's
        //    helpers drop it.
        // 2. SDK 0.24 getText() does NOT filter thought parts, so with
        //    includeThoughts enabled chunk.text() would leak thought text into
        //    the answer — we split parts here and emit thought text via
        //    onThinking only, answer text via onToken only.
        const rawChunk = chunk as unknown as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                thought?: boolean;
                functionCall?: { name?: string; args?: Record<string, unknown> };
                thoughtSignature?: string;
                executableCode?: { language?: string; code?: string };
                codeExecutionResult?: { output?: string };
              }>;
            };
          }>;
        };
        const parts = rawChunk.candidates?.[0]?.content?.parts ?? [];
        let answerText = "";
        for (const part of parts) {
          if (part.thought) {
            if (part.text && onThinking) onThinking(part.text);
            continue;
          }
          // Mirror SDK getText() formatting for code-execution parts
          if (part.text) {
            answerText += part.text;
          } else if (part.executableCode) {
            answerText +=
              "\n```" + (part.executableCode.language ?? "") + "\n" +
              (part.executableCode.code ?? "") + "\n```\n";
          } else if (part.codeExecutionResult?.output) {
            answerText += part.codeExecutionResult.output;
          }
          const fc = part.functionCall;
          if (fc?.name) {
            const argsStr = JSON.stringify(fc.args ?? {});
            const dedupKey = `${fc.name}:${argsStr}`;
            if (!seenToolCalls.has(dedupKey)) {
              seenToolCalls.add(dedupKey);
              toolCalls.push({
                // Unique across rounds — a bare `tool_${index}` collides
                // once round 2 reuses index 0, and providers reject
                // duplicate tool-call ids in one conversation.
                id: `tool_${randomUUID().slice(0, 12)}`,
                name: fc.name,
                arguments: argsStr,
                ...(part.thoughtSignature ? { extraContent: { thoughtSignature: part.thoughtSignature } } : {})
              });
            }
          }
        }
        if (answerText) {
          fullContent += answerText;
          onToken(answerText);
        }

        // Extract usage from final chunk
        const raw = chunk as unknown as Record<string, unknown>;
        const usageMeta = raw.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
        if (usageMeta?.promptTokenCount) {
          inputTokens = usageMeta.promptTokenCount;
          outputTokens = usageMeta.candidatesTokenCount ?? 0;
        }
      }

      const usage = inputTokens > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
      logger.info(`[ai-stream] Gemini response: content=${fullContent.length} chars, toolCalls=${toolCalls.length}, usage=${JSON.stringify(usage)}`);
      return {
        content: fullContent || (toolCalls.length > 0 ? "" : "[No response from model]"),
        usage,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        const retryAfterMs = parseRetryAfterMs(undefined, msg, err);
        const backoffMs = resolveRetryWait(config.id, config.label, attempt, retryAfterMs);
        logger.warn(`[ai-stream] Rate limited, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1})`);
        onToken(`\n\n⏳ ${config.label} rate limited. Retrying in ${Math.round(backoffMs / 1000)}s...\n\n`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new RateLimitError(`Rate limited after retries for ${config.label}`);
}

/** Callback for tool-related SSE events */
type ToolEventCallback = (event: {
  type: "tool_call" | "tool_result" | "permission_request";
  toolCallId: string;
  toolName: string;
  arguments?: string;
  result?: string;
  isError?: boolean;
  fileChange?: FileChange;
  action?: ToolAction;
  thoughtSignature?: string;
}) => void;

/** Parse code blocks from markdown text and extract filenames */
function parseCodeBlocks(text: string): Array<{ filename: string; content: string }> {
  const blocks: Array<{ filename: string; content: string }> = [];
  // Match ```filename\ncontent``` or ```language filename\ncontent```
  const regex = /```(?:[\w-]+)?\s+([^\n]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const filename = match[1].trim();
    const content = match[2];
    // Only include if it looks like a file path
    if (filename.includes(".") || filename.includes("/")) {
      blocks.push({ filename, content });
    }
  }
  return blocks;
}

/** Streaming version of callAI — invokes onToken for each chunk, supports tool execution loop.
 *  When the AI returns tool calls, it executes them and sends results back for another round.
 *  When quickMode is true, generates code as text in 1 request and parses code blocks to create files. */
async function callAIStream(
  providerLabel: string,
  uiModel: string,
  messages: ChatMessage[],
  onToken: TokenCallback,
  fileContext?: string,
  signal?: AbortSignal,
  onToolEvent?: ToolEventCallback,
  sessionId?: string,
  quickMode?: boolean,
  onUsage?: (usage: UsageData) => void,
  onThinking?: (delta: string) => void,
  forceTools?: boolean,
  mode?: "plan" | "build" | "quick",
  agentId?: string
): Promise<StreamResult> {
  const config = resolveProvider(providerLabel);
  if (!config) {
    const errMsg = `[Error] Unknown provider: ${providerLabel}. Available: ${providerConfigs.map((c) => c.label).join(", ")}`;
    onToken(errMsg);
    return { content: errMsg };
  }

  const apiKey = await getKeyForProviderAsync(config.id);
  if (!apiKey) {
    const errMsg = `[Error] No API key set for ${config.label}. Go to Settings in the sidebar to add your API key, or set the ${config.envKey} environment variable and restart the server.`;
    onToken(errMsg);
    return { content: errMsg };
  }

  const model = resolveModel(config, uiModel);

  const isQuickMode = Boolean(quickMode || mode === "quick");
  const targetAgentId = agentId || (mode === "plan" ? "plan" : (mode === "build" || isQuickMode ? "build" : activeAgentId));

  // Build messages with system prompt, workspace file tree, and optional file context
  const basePrompt = getSystemPrompt();
  const agentPrompt = getAgentSystemPrompt(targetAgentId);
  const fileTree = await getWorkspaceFileTree();
  const systemContent = buildSystemContent(basePrompt, fileTree, agentPrompt, fileContext);

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...messages
  ];

  // Quick mode: fast path — up to 4 requests with the same completion gate as
  // the full loop. It used to be a SINGLE request with no loop, which is why
  // quick mode always stopped after one command / one code dump.
  if (isQuickMode) {
    const QUICK_MAX_ROUNDS = 4;
    logger.info("[ai-stream] Quick mode: up to 4 requests with completion gate");

    let content = "";
    let usage = undefined as UsageData | undefined;
    const fileChanges: FileChange[] = [];
    const allToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let quickHadAction = false;
    let roundErrors: string[] = [];
    let continuations = 0;
    let completionNudges = 0;
    // Harness-enforced verification: set by successful writes, cleared only
    // when run_command actually executes afterwards (see build loop above).
    let pendingVerify = false;
    let verifyBounces = 0;

    for (let round = 0; round < QUICK_MAX_ROUNDS; round++) {
      let result: StreamResult;
      if (config.format === "anthropic") {
        result = await callAnthropicStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      } else if (config.format === "copilot") {
        result = await callCopilotStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      } else if (config.format === "gemini") {
        result = await callGeminiStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      } else {
        result = await callOpenAICompatibleStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      }

      trackLocalUsage(config.id, result.usage);
      if (result.usage) onUsage?.(result.usage);
      content += result.content;
      if (result.usage) {
        usage = usage
          ? {
              inputTokens: usage.inputTokens + result.usage.inputTokens,
              outputTokens: usage.outputTokens + result.usage.outputTokens,
              totalTokens: usage.totalTokens + result.usage.totalTokens
            }
          : { ...result.usage };
      }
      roundErrors = [];

      // Execute any tool calls the model returned instead of dropping them.
      // Silently discarding write_file/edit_file meant quick mode could never
      // create files whenever the model preferred tools over fenced code.
      const quickToolCalls = (result.toolCalls ?? []).filter((tc) => tc.name);
      if (quickToolCalls.length > 0) {
        logger.info(`[ai-stream] Quick mode round ${round + 1}: executing ${quickToolCalls.length} tool call(s)`);
        // Mirror the conversation the main loop builds so follow-up rounds
        // actually see what happened.
        chatMessages.push({
          role: "assistant",
          content: result.content,
          tool_calls: quickToolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        });
        const summary: string[] = [];
        for (const tc of quickToolCalls) {
          allToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
          onToolEvent?.({ type: "tool_call", toolCallId: tc.id, toolName: tc.name, arguments: tc.arguments, thoughtSignature: typeof tc.extraContent?.thoughtSignature === "string" ? tc.extraContent.thoughtSignature : undefined });
          const toolResult = await executeTool(tc.name, tc.arguments, tc.id, sessionId, onToolEvent);
          if (toolResult.fileChanges?.length) fileChanges.push(...toolResult.fileChanges);
          else if (toolResult.fileChange) fileChanges.push(toolResult.fileChange);
          onToolEvent?.({
            type: "tool_result",
            toolCallId: tc.id,
            toolName: tc.name,
            result: toolResult.result,
            isError: toolResult.isError,
            fileChange: toolResult.fileChange
          });
          if (
            tc.name === "run_command" ||
            tc.name === "write_file" ||
            tc.name === "write_files" ||
            tc.name === "edit_file"
          ) {
            quickHadAction = true;
          }
          if (tc.name === "run_command") {
            pendingVerify = false;
          } else if (
            !toolResult.isError &&
            (tc.name === "write_file" || tc.name === "write_files" || tc.name === "edit_file")
          ) {
            pendingVerify = true;
          }
          if (toolResult.isError) {
            roundErrors.push(`${tc.name}: ${toolResult.result.replace(/\s+/g, " ").slice(0, 300)}`);
          }
          chatMessages.push({
            role: "tool",
            content: toolResult.result,
            tool_call_id: tc.id,
            name: tc.name
          });
          summary.push(`${tc.name}: ${toolResult.isError ? toolResult.result : "ok"}`);
          logger.info(`[ai-stream] Quick mode: ${tc.name} -> ${toolResult.isError ? "error" : "ok"}`);
        }
        if (!content.trim()) {
          content = `Done. Executed ${quickToolCalls.length} tool call(s):\n${summary.join("\n")}`;
        }
      } else {
        // No tool calls — fall back to parsing fenced code blocks into files
        const codeBlocks = parseCodeBlocks(content);

        for (const block of codeBlocks) {
          try {
            const resolved = resolveWorkspacePath(block.filename);
            if (!resolved) {
              logger.warn(`[ai-stream] Quick mode: skipped ${block.filename} (outside workspace)`);
              continue;
            }
            // Route through executeTool so write_file permissions (ask/deny)
            // apply to quick mode the same way they do to the tool loop.
            const toolResult = await executeTool(
              "write_file",
              JSON.stringify({ path: resolved.relPath, content: block.content }),
              "quick-mode",
              sessionId,
              onToolEvent
            );
            if (toolResult.isError) {
              logger.warn(`[ai-stream] Quick mode: write rejected for ${block.filename}: ${toolResult.result}`);
              roundErrors.push(`write_file ${block.filename}: ${toolResult.result.replace(/\s+/g, " ").slice(0, 300)}`);
              continue;
            }
            if (toolResult.fileChange) fileChanges.push(toolResult.fileChange);
            quickHadAction = true;
            pendingVerify = true;
            logger.info(`[ai-stream] Quick mode: wrote file ${block.filename}`);
          } catch (err) {
            logger.error(`[ai-stream] Quick mode: failed to create ${block.filename}`, err as Record<string, unknown>);
          }
        }
        chatMessages.push({ role: "assistant", content: result.content });
      }

      // Completion gate — bail out when nothing to push on
      if (round >= QUICK_MAX_ROUNDS - 1) break;
      const saidDone = /(^|\n)\s*(?:\*\*)?DONE\s*:/i.test(result.content ?? "");
      if (roundErrors.length > 0 && continuations < 2) {
        continuations++;
        logger.info("[ai-stream] Quick mode: failed step — continuing");
        chatMessages.push({
          role: "user",
          content: `Your previous step FAILED:\n- ${roundErrors.slice(0, 3).join("\n- ")}\nThe task is not finished. Diagnose, fix, and retry with tool calls until it succeeds. Do not reply in prose.`
        });
        continue;
      }
      // Verification gate — a DONE marker does not bypass it
      if (pendingVerify && verifyBounces < 3) {
        verifyBounces++;
        logger.info("[ai-stream] Quick mode: changed files but never verified — forcing run_command");
        chatMessages.push({
          role: "user",
          content: `You changed files but have NOT executed a verification command after those changes. Call run_command NOW: read package.json scripts and run the project's typecheck/build/test command, then fix whatever it reports. Do not reply with prose and do not write DONE until a verification command has executed.`
        });
        continue;
      }
      if (quickHadAction && !saidDone && completionNudges < 2) {
        completionNudges++;
        logger.info("[ai-stream] Quick mode: no DONE marker — continuing");
        chatMessages.push({
          role: "user",
          content: `You ended your turn without confirming completion. If steps remain, continue with tools now. If everything is complete and verified, resend your final answer starting with exactly "DONE: " plus a one-line summary and the verification you ran.`
        });
        continue;
      }
      break;
    }

    return {
      content,
      usage,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      fileChanges: fileChanges.length > 0 ? fileChanges : undefined
    };
  }

  // Tool execution loop — up to MAX_TOOL_ROUNDS rounds of tool calls
  // (module-level constant, default 50, override with GAMMA_CODE_MAX_TOOL_ROUNDS)
  let allContent = "";
  let lastUsage: UsageData | undefined;
  let nudgedForTools = 0; // retry counter if model claims it has no tools (max 3)
  // Error-continuation: error summaries from the previous round, plus how many
  // times we've already pushed the model to keep going this turn (max 2).
  let lastRoundErrors: string[] = [];
  let errorContinuations = 0;
  // Completion gate: did this turn change/run anything (action tools), and how
  // many times have we bounced a premature "I'm done" stop without the DONE marker.
  let turnHadActionTools = false;
  let completionNudges = 0;
  // Verification gate (harness-enforced, NOT trusted from the model): set when
  // a write/edit succeeds this turn; cleared only when a run_command actually
  // executes after it. While set, text-only stops are bounced back — models
  // (codestral especially) claim "DONE: ... verified with npm run dev" without
  // ever running it, so the harness must see the command itself.
  let pendingVerify = false;
  let verifyBounces = 0;
  // Force tool_choice:"required" on round 0 when: user toggled force-tools,
  // OR the active agent is "build" (Codestral/Mistral prefer prose otherwise).
  // After the model calls tools once, switch back to "auto" so it can finish.
  let forceToolChoice = forceTools ?? false;
  if (!forceToolChoice && targetAgentId === "build") {
    forceToolChoice = true;
  }
  const allToolCalls: Array<{ id: string; name: string; arguments: string; extraContent?: Record<string, unknown> }> = [];
  const allFileChanges: FileChange[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    try {
      let result: StreamResult;
      if (config.format === "anthropic") {
        result = await callAnthropicStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      } else if (config.format === "copilot") {
        result = await callCopilotStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      } else if (config.format === "gemini") {
        result = await callGeminiStream(config, apiKey, model, chatMessages, onToken, signal, onThinking);
      } else {
        result = await callOpenAICompatibleStream(config, apiKey, model, chatMessages, onToken, signal, onThinking, forceToolChoice);
      }

      trackLocalUsage(config.id, result.usage);
      if (result.usage) onUsage?.(result.usage);
      allContent += result.content;
      if (result.usage) {
        if (lastUsage) {
          lastUsage.inputTokens += result.usage.inputTokens;
          lastUsage.outputTokens += result.usage.outputTokens;
          lastUsage.totalTokens += result.usage.totalTokens;
        } else {
          lastUsage = { ...result.usage };
        }
      }

      // If no tool calls, check for a "no tools" refusal and retry
      if (!result.toolCalls || result.toolCalls.length === 0) {
        // Codestral/Mistral frequently reply in prose claiming they have no
        // tools even though tools were sent. Detect the refusal pattern and
        // retry with forced tool_choice — allows up to 3 retries.
        const refusal = /(don'?t|do not|cannot|can'?t|unable to|not able to|lack)[^.!?\n]{0,30}(run|execute|call|use|have|access|directly)[^.!?\n]{0,20}(code|tool|command|capabilit|function|computer|machine|system|environment|local)|(don'?t|do not|cannot|can'?t|unable to|not able to)[^.!?\n]{0,20}(build|create|edit|write|modify|run|execute|operate|open|launch)[^.!?\n]{0,20}(on your|directly|locally|machine|app|application)|no (file )?tools|lack the tools|guide you through|help guide|as an ai|certainly guide|guide you/i;
        if (nudgedForTools < 3 && result.content && refusal.test(result.content)) {
          nudgedForTools++;
          forceToolChoice = true;
          logger.info(`[ai-stream] Model claimed no tools (attempt ${nudgedForTools}) — retrying with forced tool_choice:"required"`);
          // Remove the refusal text from accumulated content and retry
          allContent = allContent.slice(0, allContent.length - result.content.length);
          // Also remove any streamed refusal tokens the client saw
          onToken(`\r`);
          chatMessages.push({
            role: "user",
            content: `STOP. You have these tools and MUST call at least one now to complete the task: ${buildAiToolsOpenAI().map((t) => t.function.name).join(", ")}. You have full access to the project workspace — you can create, read, and update files there, and run commands. Do not respond in prose. Do not apologize. Do not say you lack tools. Call the appropriate tool immediately.`
          });
          round--; // retry this round
          continue;
        }
        // The model ended its turn. If its previous round had failing tools,
        // the task is NOT done — a premature "the command failed, want me to
        // fix it?" stop is exactly the 1-2-step behavior we want to eliminate.
        // Push it back to work (max 2 continuations per turn so a genuinely
        // impossible task can still end).
        if (lastRoundErrors.length > 0 && errorContinuations < 2) {
          errorContinuations++;
          const summary = lastRoundErrors.slice(0, 3).join("\n- ");
          lastRoundErrors = [];
          forceToolChoice = true;
          logger.info(`[ai-stream] Model stopped after failed step (continuation ${errorContinuations}) — nudging`);
          chatMessages.push({
            role: "user",
            content: `Your previous step FAILED:\n- ${summary}\nThe task is not finished. Diagnose the actual cause, fix it, and retry with tool calls (fix the file, adjust the command, then run the verification again). Do not reply in prose and do not ask what to do next — keep working until it succeeds.`
          });
          round--; // retry this round
          continue;
        }
        // Verification gate — runs BEFORE the DONE marker check, and a DONE
        // marker does not bypass it. If files were changed and no command has
        // run since, the model MUST execute a verification command now.
        if (pendingVerify && verifyBounces < 3) {
          verifyBounces++;
          forceToolChoice = true;
          logger.info(`[ai-stream] Changed files but never verified (bounce ${verifyBounces}) — forcing a verification command`);
          chatMessages.push({
            role: "user",
            content: `You changed files this turn but have NOT executed a single verification command after those changes. Claiming "verified" in prose is not acceptable — the command must actually run. Call run_command NOW: read package.json scripts and run the project's typecheck/lint/build/test command (e.g. npm run typecheck / npm run build), then fix whatever it reports. Do not reply with prose and do not write DONE until a verification command has executed.`
          });
          round--; // retry this round
          continue;
        }
        // Completion gate (the "stops after 1-2 commands" fix): an ACTION turn
        // (write/edit/run happened) may only end with a DONE: marker. Plain
        // text without it means the model wrapped up early — bounce it back to
        // either keep working or explicitly confirm completion. Max 2 bounces.
        const saidDone = /(^|\n)\s*(?:\*\*)?DONE\s*:/i.test(result.content ?? "");
        if (turnHadActionTools && !saidDone && completionNudges < 2) {
          completionNudges++;
          forceToolChoice = false; // it must be free to reply text-only DONE
          logger.info(`[ai-stream] Action turn ended without DONE marker (nudge ${completionNudges}) — continuing`);
          chatMessages.push({
            role: "user",
            content: `You ended your turn without confirming completion. Review your work so far against the original request:\n- If steps remain (files still to change, verification still to run, errors still to fix), call tools and continue now.\n- If everything is genuinely complete and verified, resend your final answer starting with exactly "DONE: " followed by a one-line summary of what changed and which verification command you ran.\nDo not repeat earlier steps that already succeeded.`
          });
          round--; // retry this round
          continue;
        }
        return { content: allContent, usage: lastUsage, toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined, fileChanges: allFileChanges.length > 0 ? allFileChanges : undefined };
      }

      // Process tool calls
      logger.info(`[ai-stream] Round ${round + 1}: AI returned ${result.toolCalls.length} tool call(s)`);
      logger.info(`[ai-stream] Tool calls: ${JSON.stringify(result.toolCalls.map((tc) => ({ id: tc.id, name: tc.name })))}`);
      forceToolChoice = false; // model complied — restore auto tool_choice

      // Deduplicate tool calls by ID and ensure unique IDs
      const seenIds = new Set<string>();
      const uniqueToolCalls = result.toolCalls.filter((tc) => {
        if (seenIds.has(tc.id)) return false;
        seenIds.add(tc.id);
        return true;
      });

      // An action tool ran this turn → the DONE gate applies to its final message
      if (
        uniqueToolCalls.some(
          (tc) =>
            tc.name === "run_command" ||
            tc.name === "write_file" ||
            tc.name === "write_files" ||
            tc.name === "edit_file"
        )
      ) {
        turnHadActionTools = true;
      }

      // Add the assistant message with tool calls to conversation
      const assistantToolCalls = uniqueToolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
        // Preserve extra_content (includes thought_signature for Gemini 3)
        ...(tc.extraContent ? { extra_content: tc.extraContent } : {})
      }));
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: result.content,
        tool_calls: assistantToolCalls
      };
      chatMessages.push(assistantMsg);

      // Execute this round's tool calls. Independent calls run concurrently —
      // grouping keeps calls that touch the same path (or shell commands)
      // ordered, so a multi-file round completes in one batch instead of
      // serially. Results are appended in the original call order.
      for (const tc of uniqueToolCalls) {
        allToolCalls.push(tc);
        onToolEvent?.({ type: "tool_call", toolCallId: tc.id, toolName: tc.name, arguments: tc.arguments, thoughtSignature: typeof tc.extraContent?.thoughtSignature === "string" ? tc.extraContent.thoughtSignature : undefined });
      }

      const serializationKey = (tc: { name: string; arguments: string }): string => {
        if (tc.name === "run_command") return "seq:run_command";
        try {
          const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
          if (typeof parsed.path === "string") return `path:${parsed.path}`;
        } catch {
          // Unparseable args — fall through to per-tool serialization
        }
        return `seq:${tc.name}`;
      };

      const chains = new Map<string, Promise<unknown>>();
      const executed = await Promise.all(
        uniqueToolCalls.map((tc) => {
          const key = serializationKey(tc);
          const previous = chains.get(key) ?? Promise.resolve();
          const run = previous.then(() =>
            executeTool(tc.name, tc.arguments, tc.id, sessionId, onToolEvent)
          );
          chains.set(
            key,
            run.then(
              () => undefined,
              () => undefined
            )
          );
          return run.then((toolResult) => {
            // Track file changes for checkpoint support
            if (toolResult.fileChanges?.length) {
              allFileChanges.push(...toolResult.fileChanges);
            } else if (toolResult.fileChange) {
              allFileChanges.push(toolResult.fileChange);
            }
            onToolEvent?.({ type: "tool_result", toolCallId: tc.id, toolName: tc.name, result: toolResult.result, isError: toolResult.isError, fileChange: toolResult.fileChange });
            return { tc, toolResult };
          });
        })
      );

      // Add tool results to conversation for the next AI round. Every result
      // except read_file (whose content must stay byte-exact for edit_file
      // copying) carries a short continuation reminder — this is the last
      // thing the model sees before deciding to stop or keep working, and it
      // is what keeps weak models chaining steps like opencode does.
      const CONTINUE_REMINDER = `\n\n[continue: take the next step now — the task is only finished when it is complete AND verified. Keep calling tools until then; end your message with a "DONE:" line only when everything is done.`;
      for (const { tc, toolResult } of executed) {
        chatMessages.push({
          role: "tool",
          content:
            tc.name === "read_file"
              ? toolResult.result
              : toolResult.result + CONTINUE_REMINDER,
          tool_call_id: tc.id,
          name: tc.name
        });
      }

      // Record this round's failures — if the model then ends its turn, the
      // no-tool-calls branch above nudges it back to work instead of stopping.
      lastRoundErrors = executed
        .filter((e) => e.toolResult.isError)
        .map((e) => `${e.tc.name}: ${e.toolResult.result.replace(/\s+/g, " ").slice(0, 300)}`);

      // Verification-gate state (in call order): any successful write/edit
      // requires a run_command AFTER it; executing run_command satisfies it
      // (failures are handled by the error gate above, which re-arms this via
      // the follow-up fix).
      for (const e of executed) {
        if (e.tc.name === "run_command") {
          pendingVerify = false;
        } else if (
          !e.toolResult.isError &&
          (e.tc.name === "write_file" || e.tc.name === "write_files" || e.tc.name === "edit_file")
        ) {
          pendingVerify = true;
        }
      }

      // Self-healing: if edit_file failed, inject a corrective nudge with the
      // actual file content so the model can copy the right old_string next round
      const failedEdits = executed.filter((e) => e.tc.name === "edit_file" && e.toolResult.isError);
      if (failedEdits.length > 0) {
        for (const fe of failedEdits) {
          try {
            const args = JSON.parse(fe.tc.arguments) as { path?: string };
            if (args.path) {
              const absPath = path.resolve(workspaceRoot, args.path);
              const actual = await readWorkspaceFile(absPath);
              const lines = actual.replace(/\r\n/g, "\n").split("\n");
              const preview = lines.slice(0, 40).map((l, i) => `${i + 1}: ${l}`).join("\n");
              chatMessages.push({
                role: "user",
                content: `The edit_file call failed because old_string didn't match. Here is the ACTUAL content of ${args.path}:\n\`\`\`\n${preview}\n\`\`\`\nCopy the EXACT text from above as your new old_string. Do not guess or paraphrase.`
              });
            }
          } catch { /* ignore — fallback is the tool error message */ }
        }
      }

      // Continue to next round — AI will see the tool results and continue
    } catch (error) {
      if (signal?.aborted) {
        return { content: allContent || "[Streaming aborted]", usage: lastUsage };
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("ai.stream_failed", { provider: config.label, round: round + 1, error: message });
      const errMsg = `[Error] ${config.label} API call failed: ${message}`;
      onToken(errMsg);
      return { content: allContent + errMsg, usage: lastUsage };
    }
  }

  // If we hit max rounds, return what we have with a clear continuation note
  logger.warn(`[ai-stream] Hit max tool rounds (${MAX_TOOL_ROUNDS})`);
  const maxRoundsNote = `\n\n[${MAX_TOOL_ROUNDS}-step limit reached for this turn — work above is partial. Reply "continue" to resume, or raise GAMMA_CODE_MAX_TOOL_ROUNDS.]`;
  onToken(maxRoundsNote);
  return { content: allContent + maxRoundsNote, usage: lastUsage, toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined, fileChanges: allFileChanges.length > 0 ? allFileChanges : undefined };
}

/* ================================================================
   Helpers (unchanged)
   ================================================================ */

type JsonResponse = ServerResponse;

const JSON_CACHE_THRESHOLD = 8 * 1024;

type PreparedBody = { body: Buffer; etag: string; compressed?: Buffer };

function prepareBody(body: Buffer, etag?: string): PreparedBody {
  return {
    body,
    etag: etag ?? `W/"${createHash("sha1").update(body).digest("base64url")}"`
  };
}

/** Write an already-serialized body with gzip + ETag revalidation.
 *  Workspace snapshots are megabytes of text — gzip cuts them ~6-10x, and a
 *  matching If-None-Match short-circuits to an empty 304 so repeated
 *  /api/workspace polls after every message cost nothing over the wire.
 *  The compressed buffer is cached on `prepared` so repeated sends of the
 *  same payload never pay for gzip twice. */
function sendPrepared(response: JsonResponse, statusCode: number, prepared: PreparedBody): void {
  const origin = (response as JsonResponse & { localsOrigin?: string }).localsOrigin ?? "http://127.0.0.1:3000";
  const request = response.req;
  void (async () => {
    try {
      const headers: Record<string, string | number> = {
        "content-type": "application/json",
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "content-type,authorization,if-none-match",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "etag": prepared.etag,
        "cache-control": "no-cache"
      };

      if (request?.headers["if-none-match"] === prepared.etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }

      const acceptsGzip = /\bgzip\b/.test(String(request?.headers["accept-encoding"] ?? ""));
      if (acceptsGzip && prepared.body.length >= JSON_CACHE_THRESHOLD) {
        if (!prepared.compressed) {
          prepared.compressed = await gzipAsync(prepared.body, { level: 6 });
        }
        headers["content-encoding"] = "gzip";
        headers["content-length"] = prepared.compressed.length;
        response.writeHead(statusCode, headers);
        response.end(prepared.compressed);
        return;
      }

      headers["content-length"] = prepared.body.length;
      response.writeHead(statusCode, headers);
      response.end(prepared.body);
    } catch (err) {
      logger.error("response.write_failed", { error: err instanceof Error ? err.message : String(err) });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: "Internal server error" }));
    }
  })();
}

function sendJson(response: JsonResponse, statusCode: number, payload: unknown): void {
  sendPrepared(response, statusCode, prepareBody(Buffer.from(JSON.stringify(payload), "utf8")));
}

async function collectFiles(directory: string, depth = 0, counter = { count: 0 }): Promise<FileEntry[]> {
  // Phase 1: walk the tree with readdir only (no stats, no reads) to collect
  // candidate paths. Directory recursion runs in parallel across siblings.
  const paths = await collectFilePaths(directory, depth, counter);
  if (paths.length === 0) return [];

  // Phase 2: read file bodies with a bounded pool so a 5k-file workspace
  // resolves in a handful of event-loop turns instead of one read at a time.
  const files = await mapConcurrent(paths, FILE_READ_CONCURRENCY, loadFileEntry);
  return files
    .filter((entry): entry is FileEntry => entry !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
}

const FILE_READ_CONCURRENCY = 32;

async function collectFilePaths(directory: string, depth: number, counter: { count: number }): Promise<string[]> {
  if (depth > MAX_WORKSPACE_DEPTH || counter.count >= MAX_WORKSPACE_FILES) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // Directory doesn't exist or is not accessible
    return [];
  }

  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    if (entry.isDirectory()) {
      directories.push(path.join(directory, entry.name));
      continue;
    }
    if (!allowedExtensions.has(path.extname(entry.name))) continue;
    if (counter.count >= MAX_WORKSPACE_FILES) break;
    counter.count++;
    files.push(path.join(directory, entry.name));
  }

  if (directories.length === 0) return files;
  const nested = await Promise.all(
    directories.map((child) => collectFilePaths(child, depth + 1, counter))
  );
  return files.concat(...nested);
}

async function loadFileEntry(absolutePath: string): Promise<FileEntry | null> {
  const extension = path.extname(absolutePath);
  const relativePath = path.relative(workspaceRoot, absolutePath);
  let content = "";
  try {
    const fileStat = await stat(absolutePath);
    const cached = fileContentCache.get(absolutePath);
    if (fileStat.size > MAX_WORKSPACE_FILE_BYTES) {
      content = `/* File skipped: size ${fileStat.size} bytes exceeds limit ${MAX_WORKSPACE_FILE_BYTES} */`;
    } else if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      // Unchanged since last scan — reuse cached content, skip the read
      content = cached.content;
    } else {
      content = await readFile(absolutePath, "utf8");
      rememberFileContent(absolutePath, content, fileStat.mtimeMs, fileStat.size);
    }
  } catch {
    content = "";
  }
  return {
    id: relativePath,
    name: path.basename(relativePath),
    path: relativePath,
    folder: path.dirname(relativePath),
    language: languageFromExtension(extension),
    content
  };
}

/** Prime the content cache with text we already have in memory so the next
 *  workspace scan doesn't re-read the file we just wrote. */
function rememberFileContent(absolutePath: string, content: string, mtimeMs?: number, size?: number): void {
  if (fileContentCache.size >= FILE_CONTENT_CACHE_MAX) fileContentCache.clear();
  const now = Date.now();
  if (mtimeMs !== undefined && size !== undefined) {
    fileContentCache.set(absolutePath, { mtimeMs, size, content, checkedAt: now });
    return;
  }
  const estimatedSize = Buffer.byteLength(content, "utf8");
  fileContentCache.set(absolutePath, { mtimeMs: now, size: estimatedSize, content, checkedAt: now });
  void stat(absolutePath)
    .then((fileStat) => {
      const entry = fileContentCache.get(absolutePath);
      if (entry && entry.content === content) {
        entry.mtimeMs = fileStat.mtimeMs;
        entry.size = fileStat.size;
        entry.checkedAt = Date.now();
      }
    })
    .catch(() => {
      fileContentCache.delete(absolutePath);
    });
}

/** Read a workspace file through the content cache. The AI loop reads the same
 *  files repeatedly (read → edit → verify), and an mtime/size check is far
 *  cheaper than hitting disk again. Throws like fs.readFile when missing. */
async function readWorkspaceFile(absolutePath: string): Promise<string> {
  const now = Date.now();
  const cached = fileContentCache.get(absolutePath);
  if (cached && now - cached.checkedAt < READ_STAT_GRACE_MS) {
    return cached.content;
  }
  const fileStat = await stat(absolutePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    cached.checkedAt = now;
    return cached.content;
  }
  const content = await readFile(absolutePath, "utf8");
  rememberFileContent(absolutePath, content, fileStat.mtimeMs, fileStat.size);
  return content;
}

function languageFromExtension(extension: string) {
  switch (extension) {
    case ".ts": case ".tsx": return "typescript";
    case ".js": case ".jsx": return "javascript";
    case ".css": return "css";
    case ".json": return "json";
    case ".md": return "markdown";
    case ".html": return "html";
    case ".yml": case ".yaml": return "yaml";
    default: return "plaintext";
  }
}

/** Incremental update to workspace file caches when a file is written or edited.
 *  Avoids invalidating the entire workspace file tree and forcing a full
 *  re-scan of thousands of files across disk. */
function updateFileInWorkspaceCache(
  absolutePath: string,
  content: string,
  fileStat?: { mtimeMs: number; size: number }
): void {
  rememberFileContent(absolutePath, content, fileStat?.mtimeMs, fileStat?.size);

  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (!isPathInside(workspaceRoot, absolutePath)) return;

  const extension = path.extname(absolutePath);
  if (!allowedExtensions.has(extension)) return;

  workspaceEpoch++;
  fileTreeCache = null;
  projectContextCache = null;
  filesVersion++;

  if (!filesCache || filesCache.root !== workspaceRoot) return;

  const entries = filesCache.value;
  const idx = entries.findIndex((e) => e.path === relativePath);
  const entrySize = fileStat?.size ?? Buffer.byteLength(content, "utf8");
  const entry: FileEntry = {
    id: relativePath,
    name: path.basename(relativePath),
    path: relativePath,
    folder: path.dirname(relativePath),
    language: languageFromExtension(extension),
    content:
      entrySize > MAX_WORKSPACE_FILE_BYTES
        ? `/* File skipped: size ${entrySize} bytes exceeds limit ${MAX_WORKSPACE_FILE_BYTES} */`
        : content
  };

  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
    entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  filesCache.epoch = workspaceEpoch;
  filesCache.expiresAt = Date.now() + FILES_TTL_MS;
}

/** Incrementally remove a file or folder from workspace file caches. */
function removeFileFromWorkspaceCache(targetPath: string): void {
  for (const key of [...fileContentCache.keys()]) {
    if (key === targetPath || key.startsWith(targetPath + path.sep)) {
      fileContentCache.delete(key);
    }
  }
  for (const dir of [...knownDirectories]) {
    if (dir === targetPath || dir.startsWith(targetPath + path.sep)) {
      knownDirectories.delete(dir);
    }
  }

  workspaceEpoch++;
  fileTreeCache = null;
  projectContextCache = null;
  filesVersion++;

  if (!filesCache || filesCache.root !== workspaceRoot) return;

  const relTarget = path.relative(workspaceRoot, targetPath);
  filesCache.value = filesCache.value.filter(
    (e) => e.path !== relTarget && !e.path.startsWith(relTarget + path.sep) && !e.path.startsWith(relTarget + "/")
  );
  filesCache.epoch = workspaceEpoch;
  filesCache.expiresAt = Date.now() + FILES_TTL_MS;
}

function toSummary(session: StoredSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    provider: session.provider,
    model: session.model,
    updatedAt: session.updatedAt,
    sharedId: session.sharedId
  };
}

function getRecentRuns() {
  return Array.from(commandRunStore.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 8)
    // The UI never renders stored run output (live runs stream over SSE), but
    // the full text rides along in every /api/workspace payload — keep a tail.
    .map((run) => ({ ...run, output: run.output.length > RECENT_RUN_OUTPUT_CHARS ? `…${run.output.slice(-RECENT_RUN_OUTPUT_CHARS)}` : run.output }));
}

function attachMessage(
  session: StoredSession,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  extra?: {
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    fileChanges?: FileChange[];
    attachments?: Array<{ id: string; name: string; mimeType: string; size: number; data: string }>;
    mode?: "plan" | "build" | "quick";
  }
) {
  session.messages.push({
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(extra?.toolCalls ? { toolCalls: extra.toolCalls } : {}),
    ...(extra?.toolCallId ? { toolCallId: extra.toolCallId } : {}),
    ...(extra?.toolName ? { toolName: extra.toolName } : {}),
    ...(extra?.isError !== undefined ? { isError: extra.isError } : {}),
    ...(extra?.fileChanges ? { fileChanges: extra.fileChanges } : {}),
    ...(extra?.attachments ? { attachments: extra.attachments } : {}),
    ...(extra?.mode ? { mode: extra.mode } : {})
  });
  session.updatedAt = new Date().toISOString();
}

/** Workspace file list with a short-lived cache. Invalidated immediately on
 *  any write we know about; the TTL only exists to pick up external edits. */
async function getWorkspaceFiles(): Promise<FileEntry[]> {
  const now = Date.now();
  if (
    filesCache &&
    filesCache.root === workspaceRoot &&
    filesCache.epoch === workspaceEpoch &&
    filesCache.expiresAt > now
  ) {
    return filesCache.value;
  }

  const value = await collectFiles(workspaceRoot);
  filesVersion++;
  filesCache = {
    root: workspaceRoot,
    epoch: workspaceEpoch,
    expiresAt: now + FILES_TTL_MS,
    value
  };
  return value;
}

async function buildWorkspaceSnapshot() {
  // Check if workspace root exists
  const workspaceExists = await stat(workspaceRoot).then(() => true).catch(() => false);
  const skillsEnabled = workspaceExists && resolvedConfig?.skills?.enabled !== false;

  // Everything independent runs concurrently: file scan, git, skills and
  // provider model lists used to be awaited one after another.
  const [files, gitInfo, skills, providers] = await Promise.all([
    workspaceExists ? getWorkspaceFiles() : Promise.resolve([] as FileEntry[]),
    workspaceExists
      ? getGitInfo()
      : Promise.resolve({ branch: undefined as string | undefined, status: "", ok: false }),
    skillsEnabled
      ? listSkills(workspaceRoot, resolvedConfig?.skills?.paths ?? [])
      : Promise.resolve([] as SkillEntry[]),
    Promise.all(providerConfigs.map(async (config) => {
      const models = await getModelsForProvider(config);
      // Custom provider: add the user's model to the list if not already there
      if (config.id === "custom" && customProvider.model && !models.includes(customProvider.model)) {
        models.unshift(customProvider.model);
      }
      return {
        id: config.id,
        label: config.label,
        status: getProviderStatus(config),
        model: config.id === "custom" ? customProvider.model : config.defaultModel,
        models,
        method: getAuthMethod(config)
      };
    }))
  ]);

  const sessions = Array.from(sessionStore.values())
    .filter((s) => s.workspace === workspaceRoot)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(toSummary);

  const agents = resolveAgents(resolvedConfig).map((agent) => ({
    id: agent.id,
    label: agent.label,
    description: agent.description
  }));

  return workspaceSnapshotSchema.parse({
    workspace: {
      id: "gamma-code",
      name: path.basename(workspaceRoot),
      root: workspaceRoot,
      branch: gitInfo.branch,
      files
    },
    sessions,
    suggestions: promptSuggestions,
    recentRuns: getRecentRuns(),
    config: resolvedConfig ?? undefined,
    configPaths: resolvedConfigPaths ?? undefined,
    skills,
    agents,
    activeAgentId,
    plugins: pluginRuntime?.plugins.map((p) => ({
      id: p.definition.id,
      label: p.definition.label,
      version: p.definition.version
    })) ?? [],
    ci: ciContext,
    providers
  });
}

/** Memoized serialization for /api/workspace. Building the payload is
 *  unavoidable, but stringifying + gzipping ~1MB of text costs 50-250ms per
 *  call. Everything except the file list (tracked by filesVersion) is hashed
 *  into a fingerprint, and the serialized bytes are reused when unchanged. */
let workspaceSnapshotMemo: { fingerprint: string; prepared: PreparedBody } | null = null;

function prepareWorkspaceSnapshot(
  payload: Awaited<ReturnType<typeof buildWorkspaceSnapshot>>
): PreparedBody {
  const fingerprint =
    String(filesVersion) +
    "|" +
    JSON.stringify(payload, (_key, value) => (_key === "files" ? undefined : value));

  if (workspaceSnapshotMemo && workspaceSnapshotMemo.fingerprint === fingerprint) {
    return workspaceSnapshotMemo.prepared;
  }

  const prepared = prepareBody(Buffer.from(JSON.stringify(payload), "utf8"));
  workspaceSnapshotMemo = { fingerprint, prepared };
  return prepared;
}

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
async function readJsonBody(request: AsyncIterable<string | Buffer>) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? textEncoder.encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Retained output per run. Appending per chunk is O(n²) in CPU+memory for
 *  chatty commands (builds, test suites), and the full text was also
 *  re-serialized into every /api/workspace payload. We keep a bounded tail;
 *  the live SSE stream is the source of truth for current runs. */
const RUN_OUTPUT_MAX_CHARS = 400_000;
const RECENT_RUN_OUTPUT_CHARS = 4_000;
/** Cap stored runs so a long-lived server can't accumulate unbounded state. */
const COMMAND_RUN_STORE_MAX = 30;

async function runCommand(command: string, sessionId?: string) {
  const startedAt = new Date().toISOString();
  const run: CommandRun = {
    id: randomUUID(),
    sessionId,
    command,
    status: "running",
    output: `$ ${command}\n`,
    exitCode: null,
    startedAt,
    finishedAt: null
  };

  commandRunStore.set(run.id, run);
  const emitter = getTerminalEmitter(run.id);

  const shell = resolveTerminalShell();
  const shellName = path.basename(shell.command).toLowerCase();
  const shellArgs =
    shellName.includes("powershell") || shellName.includes("pwsh")
      ? [...shell.args, "-NoProfile", "-NonInteractive", "-Command", command]
      : shellName === "cmd.exe"
        ? [...shell.args, "/d", "/s", "/c", command]
        : [...shell.args, "-lc", command];
  const child = spawn(shell.command, shellArgs, {
    cwd: workspaceRoot,
    env: {
      ...process.env
    }
  });

  // Store child process for potential killing
  activeChildProcesses.set(run.id, child);

  let outputLength = run.output.length;
  const appendOutput = (text: string) => {
    outputLength += text.length;
    run.output += text;
    // Trim only once we've grown to 2x the cap — amortized O(1) per chunk
    // instead of copying the whole buffer on every append.
    if (outputLength > RUN_OUTPUT_MAX_CHARS * 2) {
      run.output = run.output.slice(-RUN_OUTPUT_MAX_CHARS);
      outputLength = run.output.length;
    }
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    appendOutput(text);
    emitter.emit("data", text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    appendOutput(text);
    emitter.emit("data", text);
  });

  // Without this, a spawn failure (e.g. missing shell binary) crashes the
  // whole server with an unhandled 'error' event.
  child.on("error", (err) => {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    appendOutput(`\nFailed to start process: ${err.message}`);
    commandRunStore.set(run.id, run);
    emitter.emit("data", `\nFailed to start process: ${err.message}`);
    emitter.emit("close", { status: run.status, exitCode: null });
    activeChildProcesses.delete(run.id);
    setTimeout(() => { terminalEmitters.delete(run.id); }, 2000);
  });

  child.on("close", (code, signal) => {
    run.status = signal ? "killed" : code === 0 ? "completed" : "failed";
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (signal) {
      appendOutput(`\nProcess terminated with signal ${signal}.`);
      emitter.emit("data", `\nProcess terminated with signal ${signal}.`);
    }
    commandRunStore.set(run.id, run);
    emitter.emit("close", { status: run.status, exitCode: code });

    // Evict oldest runs once the store is full (insertion order = age order).
    if (commandRunStore.size > COMMAND_RUN_STORE_MAX) {
      const oldestIds = [...commandRunStore.keys()].slice(0, commandRunStore.size - COMMAND_RUN_STORE_MAX);
      for (const id of oldestIds) commandRunStore.delete(id);
    }

    // Clean up child process reference and emitter after a short delay
    activeChildProcesses.delete(run.id);
    setTimeout(() => { terminalEmitters.delete(run.id); }, 2000);

    if (sessionId) {
      const session = sessionStore.get(sessionId);
      if (session) {
        session.commandRuns = [run, ...session.commandRuns.filter((item) => item.id !== run.id)].slice(0, 12);
        session.status = run.status === "completed" ? "idle" : "review";
        attachMessage(
          session,
          "system",
          `Command ${run.status}: ${command}${typeof code === "number" ? ` (exit ${code})` : ""}`
        );
        sessionStore.set(session.id, { ...session });
        persistSessions();
      }
    }
  });

  return run;
}

async function getDirectoryChildren(relativeDir: string) {
  const absoluteDir = path.resolve(workspaceRoot, relativeDir);
  if (!isPathInside(workspaceRoot, absoluteDir)) return [];

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => !ignoredDirectories.has(entry.name))
      .map(async (entry) => {
        const absolutePath = path.join(absoluteDir, entry.name);
        const entryStat = await stat(absolutePath);
        return {
          name: entry.name,
          path: path.relative(workspaceRoot, absolutePath),
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isDirectory() ? null : entryStat.size
        };
      })
  );
}

/* ================================================================
   Helper: read file content for AI context
   ================================================================ */

async function readFileContext(filePath?: string): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    const absolutePath = path.resolve(workspaceRoot, filePath);
    if (!isPathInside(workspaceRoot, absolutePath)) return undefined;
    const content = await readWorkspaceFile(absolutePath);
    // Limit context to ~8000 chars to avoid token limits
    return content.length > 8000 ? content.slice(0, 8000) + "\n... (truncated)" : content;
  } catch {
    return undefined;
  }
}

/* ================================================================
   HTTP Server
   ================================================================ */

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": request.headers.origin && allowedOrigins.has(request.headers.origin) ? request.headers.origin : "http://127.0.0.1:3000",
        "access-control-allow-headers": "content-type,authorization,if-none-match",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS"
      });
      response.end();
      return;
    }

    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: "Origin not allowed" });
      return;
    }

    (response as JsonResponse & { localsOrigin?: string }).localsOrigin = origin && allowedOrigins.has(origin)
      ? origin
      : "http://127.0.0.1:3000";

    const start = Date.now();
    response.on("finish", () => {
      logger.info("http.request", {
        method: request.method,
        url: request.url ? redactSecrets(request.url) : request.url,
        status: response.statusCode,
        durationMs: Date.now() - start
      });
    });

    if (webPassword) {
      const auth = request.headers.authorization ?? "";
      const urlToken = request.url?.includes("?") ? new URL(request.url, `http://localhost:${port}`).searchParams.get("token") : null;
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : urlToken;
      if (!token || token !== webPassword) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
    }

    if (request.url === "/health") {
      const payload = healthResponseSchema.parse({
        ok: true,
        appName: APP_NAME,
        timestamp: new Date().toISOString()
      });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      sendJson(response, 200, {
        ok: true,
        appName: APP_NAME,
        message: "Gamma Code local runtime is running.",
        webUrl: "http://127.0.0.1:3000",
        endpoints: ["/health", "/api/workspace", "/api/sessions/:id", "/api/file", "/api/terminal/runs", "/api/fs?path=apps"]
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/workspace") {
      try {
        sendPrepared(response, 200, prepareWorkspaceSnapshot(await buildWorkspaceSnapshot()));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to build workspace snapshot";
        logger.error("workspace-snapshot-failed", { error: message, workspaceRoot });
        sendJson(response, 500, { error: message });
      }
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/share/")) {
      const shareId = request.url.replace("/share/", "");
      const share = getShare(shareId);
      if (!share) {
        sendJson(response, 404, { error: "Share not found" });
        return;
      }
      sendJson(response, 200, share);
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/fs")) {
      const url = new URL(request.url, `http://localhost:${port}`);
      const dir = url.searchParams.get("path") ?? ".";
      sendJson(response, 200, { path: dir, children: await getDirectoryChildren(dir) });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/skills")) {
      const url = new URL(request.url, `http://localhost:${port}`);
      const skillPath = url.searchParams.get("path");
      if (skillPath) {
        try {
          const content = await readSkill(workspaceRoot, skillPath);
          sendJson(response, 200, { path: skillPath, content });
        } catch (err) {
          sendJson(response, 404, { error: "Skill not found" });
        }
        return;
      }
      const skills = resolvedConfig?.skills?.enabled === false
        ? []
        : await listSkills(workspaceRoot, resolvedConfig?.skills?.paths ?? []);
      sendJson(response, 200, { skills });
      return;
    }

    if (request.method === "GET" && request.url === "/api/provider-usage") {
      const usage = await getAllProviderUsage();
      sendJson(response, 200, { providers: usage });
      return;
    }

    if (request.method === "GET" && request.url === "/api/ci") {
      sendJson(response, 200, { ci: ciContext });
      return;
    }

    /* ---- Workspace / project management ---- */

    if (request.method === "GET" && request.url === "/api/workspace/recent") {
      sendJson(response, 200, { projects: recentProjects });
      return;
    }

    if (request.method === "POST" && request.url === "/api/config/reload") {
      await refreshConfig();
      sendJson(response, 200, { ok: true, config: resolvedConfig, configPaths: resolvedConfigPaths });
      return;
    }

    if (request.method === "POST" && request.url === "/api/plugins/reload") {
      pluginRuntime = await loadPlugins(workspaceRoot, resolvedConfig);
      sendJson(response, 200, { ok: true, plugins: pluginRuntime.plugins.map((p) => p.definition) });
      return;
    }

    if (request.method === "POST" && request.url === "/api/agents/switch") {
      const body = await readJsonBody(request) as { agentId?: string };
      const agentId = body.agentId?.trim();
      if (!agentId) {
        sendJson(response, 400, { error: "Missing agentId" });
        return;
      }
      const agents = resolveAgents(resolvedConfig);
      if (!agents.some((agent) => agent.id === agentId)) {
        sendJson(response, 404, { error: "Unknown agentId" });
        return;
      }
      activeAgentId = agentId;
      sendJson(response, 200, { ok: true, activeAgentId });
      return;
    }

    if (request.method === "POST" && request.url === "/api/permissions/approve") {
      const body = await readJsonBody(request) as { sessionId?: string; toolCallId?: string; allow?: boolean; remember?: boolean; action?: ToolAction };
      if (!body.sessionId || !body.toolCallId) {
        sendJson(response, 400, { error: "Missing sessionId or toolCallId" });
        return;
      }
      const pending = pendingToolApprovals.get(body.toolCallId);
      if (!pending || pending.sessionId !== body.sessionId) {
        sendJson(response, 404, { error: "No pending permission for this tool call" });
        return;
      }
      const allow = body.allow === true;
      if (allow) {
        const approvals = sessionToolApprovals.get(body.sessionId) ?? new Set<ToolAction>();
        approvals.add(pending.action);
        sessionToolApprovals.set(body.sessionId, approvals);
        // Also unblock any other concurrent pending approvals for this same action in this session
        for (const [id, p] of [...pendingToolApprovals.entries()]) {
          if (p.sessionId === body.sessionId && p.action === pending.action) {
            p.resolve(true);
            pendingToolApprovals.delete(id);
          }
        }
      }
      pending.resolve(allow);
      pendingToolApprovals.delete(body.toolCallId);
      sendJson(response, 200, { ok: true, allowed: allow });
      return;
    }

    if (request.method === "POST" && request.url === "/api/share") {
      const body = await readJsonBody(request) as { sessionId?: string };
      const sessionId = body.sessionId?.trim();
      if (!sessionId) {
        sendJson(response, 400, { error: "Missing sessionId" });
        return;
      }
      const session = sessionStore.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }

      const shareId = randomUUID();
      const content = session.messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
      await createShare({
        id: shareId,
        createdAt: new Date().toISOString(),
        sessionId,
        title: session.title,
        content
      });
      session.sharedId = shareId;
      sessionStore.set(session.id, { ...session });
      persistSessions();
      sendJson(response, 201, { id: shareId, url: `/share/${shareId}` });
      return;
    }

    if (request.method === "DELETE" && request.url?.startsWith("/api/share/")) {
      const shareId = request.url.replace("/api/share/", "");
      const deleted = await deleteShare(shareId);
      if (deleted) {
        for (const session of sessionStore.values()) {
          if (session.sharedId === shareId) {
            session.sharedId = undefined;
            sessionStore.set(session.id, { ...session });
            break;
          }
        }
        persistSessions();
      }
      sendJson(response, 200, { ok: true, deleted });
      return;
    }

    if (request.method === "POST" && request.url === "/api/workspace/switch") {
      const payload = await readJsonBody(request);
      const targetPath = typeof payload.path === "string" ? (payload.path as string).trim() : "";
      if (!targetPath) {
        sendJson(response, 400, { error: "Missing 'path' field" });
        return;
      }
      const resolved = path.resolve(targetPath);
      try {
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          sendJson(response, 400, { error: "Path is not a directory" });
          return;
        }
      } catch {
        sendJson(response, 400, { error: "Path does not exist" });
        return;
      }
      workspaceRoot = resolved;
      touchProject(resolved);
      knownDirectories.clear();
      invalidateWorkspaceCaches();
      await refreshConfig();
      // Restart the file watcher so external edits in the new workspace
      // invalidate caches (the old watcher still pointed at the previous root).
      workspaceWatcher?.close();
      workspaceWatcher = null;
      startWorkspaceWatcher();
      logger.info(`[workspace] Switched to ${resolved}`);
      sendJson(response, 200, {
        root: workspaceRoot,
        name: path.basename(workspaceRoot),
      });
      return;
    }

    /* ---- Git branch management ---- */

    if (request.method === "GET" && request.url === "/api/git/branches") {
      try {
        // All three git reads run concurrently; porcelain status is shared
        // with (and usually served from) the git-info cache. symbolic-ref
        // first so a repository without commits still reports its branch.
        const currentBranchPromise = runGit(["symbolic-ref", "--short", "HEAD"]).catch(() =>
          runGit(["rev-parse", "--abbrev-ref", "HEAD"])
        );
        const [currentBranch, localRaw, remoteRaw, gitInfo] = await Promise.all([
          currentBranchPromise,
          runGit(["branch", "--format=%(refname:short)"]),
          runGit(["branch", "-r", "--format=%(refname:short)"]).catch(() => ""),
          getGitInfo()
        ]);

        const localBranches = localRaw ? localRaw.split("\n").map((b) => b.trim()).filter(Boolean) : [];

        // Remote branches (strip "origin/" prefix, deduplicate with local)
        const remoteBranches = remoteRaw
          ? remoteRaw.trim().split("\n")
              .map((b) => b.trim())
              .filter((b) => b && !b.includes("HEAD"))
              .map((b) => b.replace(/^origin\//, ""))
              .filter((b) => !localBranches.includes(b))
          : [];

        // Check for uncommitted changes
        const hasUncommittedChanges = gitInfo.status.length > 0;

        sendJson(response, 200, {
          current: currentBranch,
          local: localBranches,
          remote: remoteBranches,
          hasUncommittedChanges,
        });
      } catch (err) {
        sendJson(response, 500, { error: "Not a git repository or git not available" });
      }
      return;
    }

    if (request.method === "GET" && request.url === "/api/git/status") {
      try {
        const gitInfo = await getGitInfo();
        if (!gitInfo.ok) {
          throw new Error("Not a git repository or git not available");
        }
        const statusRaw = gitInfo.status;
        
        const modified: string[] = [];
        const staged: string[] = [];
        const untracked: string[] = [];
        // Per-path short letter (M/A/D/U/…) so the UI can show the real
        // status instead of a hardcoded "M" for every file.
        const letters: Record<string, string> = {};
        
        if (statusRaw) {
          const lines = statusRaw.split("\n").filter(Boolean);
          for (const line of lines) {
            if (line.length >= 3) {
              const statusCode = line.substring(0, 2);
              const changedPath = line.substring(3).trim();
              
              const stagedStatus = statusCode[0];
              const workTreeStatus = statusCode[1] || stagedStatus;
              
              const rawLetter = stagedStatus !== " " && stagedStatus !== "?"
                ? stagedStatus
                : workTreeStatus !== " " ? workTreeStatus : stagedStatus;
              letters[changedPath] = rawLetter === "?" ? "U" : rawLetter;
              
              if (stagedStatus === "?" || workTreeStatus === "?") {
                untracked.push(changedPath);
              } else if (stagedStatus === "A" || stagedStatus === "M" || stagedStatus === "D" || stagedStatus === "R") {
                staged.push(changedPath);
              } else if (workTreeStatus === "M" || workTreeStatus === "D") {
                modified.push(changedPath);
              } else {
                modified.push(changedPath);
              }
            }
          }
        }

        sendJson(response, 200, {
          modified,
          staged,
          untracked,
          letters,
        });
      } catch (err) {
        sendJson(response, 500, { error: "Not a git repository or git not available" });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/git/checkout") {
      try {
        const body = await readJsonBody(request) as { branch: string };
        if (!body.branch || typeof body.branch !== "string") {
          sendJson(response, 400, { error: "Missing branch name" });
          return;
        }
        const safeBranch = sanitizeGitRef(body.branch);
        if (!safeBranch) {
          sendJson(response, 400, { error: "Invalid branch name" });
          return;
        }

        // Check if it's a local branch
        const localRaw = await runGit(["branch", "--format=%(refname:short)"]);
        const localBranches = localRaw ? localRaw.split("\n").map((b) => b.trim()) : [];

        let output: string;
        if (localBranches.includes(safeBranch)) {
          output = await runGit(["checkout", safeBranch]);
        } else {
          // Try checking out remote branch as tracking branch
          output = await runGit(["checkout", "-b", safeBranch, `origin/${safeBranch}`]);
        }

        const newBranch = await gitCurrentBranch();
        invalidateWorkspaceCaches();
        sendJson(response, 200, { branch: newBranch, output });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(response, 400, { error: `Checkout failed: ${message}` });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/git/revert") {
      try {
        const body = await readJsonBody(request) as { path: string };
        if (!body.path || typeof body.path !== "string") {
          sendJson(response, 400, { error: "Missing file path" });
          return;
        }
        const safeFile = sanitizeGitRef(body.path);
        if (!safeFile) {
          sendJson(response, 400, { error: "Invalid file path" });
          return;
        }

        await runGit(["checkout", "HEAD", "--", safeFile]);
        invalidateWorkspaceCaches();
        
        sendJson(response, 200, { success: true, file: safeFile });
      } catch (err) {
        sendJson(response, 500, { error: "Failed to revert file" });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/git/branch") {
      try {
        const body = await readJsonBody(request) as { name: string; checkout?: boolean; from?: string };
        if (!body.name || typeof body.name !== "string") {
          sendJson(response, 400, { error: "Missing branch name" });
          return;
        }
        const safeName = sanitizeGitRef(body.name);
        if (!safeName) {
          sendJson(response, 400, { error: "Invalid branch name" });
          return;
        }

        const fromRef = body.from ? sanitizeGitRef(body.from) : "";
        await runGit(fromRef ? ["branch", safeName, fromRef] : ["branch", safeName]);

        if (body.checkout !== false) {
          await runGit(["checkout", safeName]);
        }

        const newBranch = await gitCurrentBranch();
        invalidateWorkspaceCaches();
        sendJson(response, 201, { branch: newBranch, created: safeName });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(response, 400, { error: `Branch creation failed: ${message}` });
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/sessions") {
      const payload = createSessionSchema.parse(await readJsonBody(request));
      const now = new Date().toISOString();
      const id = randomUUID();
      const session: StoredSession = {
        id,
        title: payload.prompt.slice(0, 72),
        status: "running",
        provider: payload.provider,
        model: payload.model,
        activeFilePath: payload.filePath,
        updatedAt: now,
        messages: [],
        commandRuns: [],
        workspace: workspaceRoot
      };

      attachMessage(session, "user", payload.prompt, {
        mode: payload.mode ?? (payload.quickMode ? "quick" : undefined)
      });
      sessionStore.set(id, session);
      persistSessions();

      // Send immediate response with user message, then stream AI in background
      const fileContext = await readFileContext(payload.filePath);
      const expandedPrompt = await expandAtReferences(payload.prompt);
      const conversationMessages: ChatMessage[] = [{ role: "user", content: expandedPrompt }];

      const emitter = getSessionEmitter(id);
      const messageId = randomUUID();

      // Create abort controller for this streaming request
      const abortController = new AbortController();
      activeAbortControllers.set(id, abortController);

      // Track tool calls and results to store them in session after completion
      const batchedToolCalls: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }> = [];
      const batchedToolResults: Array<{
        role: "tool";
        content: string;
        extra?: Parameters<typeof attachMessage>[3];
      }> = [];

      callAIStream(payload.provider, payload.model, conversationMessages, (token) => {
        emitter.emit("token", { messageId, token });
      }, fileContext, abortController.signal, (toolEvent) => {
        // Forward tool events to SSE stream
        emitter.emit(toolEvent.type, { messageId, ...toolEvent });
        if (toolEvent.type === "tool_call") {
          batchedToolCalls.push({
            id: toolEvent.toolCallId,
            name: toolEvent.toolName,
            arguments: toolEvent.arguments || "{}",
            thoughtSignature: toolEvent.thoughtSignature
          });
        } else if (toolEvent.type === "tool_result") {
          batchedToolResults.push({
            role: "tool",
            content: toolEvent.result || "",
            extra: {
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              isError: toolEvent.isError
            }
          });
        }
      }, id, payload.quickMode, (usage) => {
        const totals = session.usageTotals ?? { requestCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0 };
        totals.requestCount += 1;
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.totalTokens += usage.totalTokens;
        totals.contextTokens = usage.inputTokens + usage.outputTokens;
        session.usageTotals = totals;
        emitter.emit("usage", { messageId, usage });
      }, (delta) => {
        emitter.emit("thinking", { messageId, token: delta });
      }, payload.forceTools, payload.mode).then((result) => {
        const current = activeAbortControllers.get(id);
        if (current !== undefined && current !== abortController) return;
        clearAbortController(id, abortController);
        if (batchedToolCalls.length > 0) {
          attachMessage(session, "assistant", "", {
            toolCalls: batchedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) }))
          });
        }
        for (const tr of batchedToolResults) {
          attachMessage(session, tr.role, tr.content, tr.extra);
        }
        attachMessage(session, "assistant", result.content, {
          ...(result.fileChanges && result.fileChanges.length > 0 ? { fileChanges: result.fileChanges } : {})
        });
        session.status = "idle";
        sessionStore.set(id, { ...session });
        persistSessions();
        emitter.emit("done", { messageId, usage: result.usage });
        logger.info(`[ai-stream] Session ${id} got reply (${result.content.length} chars)${result.usage ? ` [${result.usage.inputTokens}+${result.usage.outputTokens} tokens]` : ""}`);
      }).catch((error) => {
        clearAbortController(id, abortController);
        if (abortController.signal.aborted) {
          // User pressed Stop — the abort route already set status/persisted.
          return;
        }
        if (batchedToolCalls.length > 0) {
          attachMessage(session, "assistant", "", {
            toolCalls: batchedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) }))
          });
        }
        for (const tr of batchedToolResults) {
          attachMessage(session, tr.role, tr.content, tr.extra);
        }
        const message = error instanceof Error ? error.message : String(error);
        attachMessage(session, "assistant", `[Error] AI call failed: ${message}`);
        session.status = "review";
        sessionStore.set(id, { ...session });
        persistSessions();
        emitter.emit("error", { messageId, error: message });
      });

      sendJson(response, 201, { ...session, streamMessageId: messageId });
      return;
    }

    if (request.method === "POST" && request.url === "/api/messages") {
      const payload = appendMessageSchema.parse(await readJsonBody(request));
      const session = sessionStore.get(payload.sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }

      session.provider = payload.provider;
      session.model = payload.model;
      session.activeFilePath = payload.filePath;
      session.status = "running";
      attachMessage(session, "user", payload.prompt, {
        ...(payload.attachments ? { attachments: payload.attachments } : {}),
        mode: payload.mode ?? (payload.quickMode ? "quick" : undefined)
      });
      sessionStore.set(session.id, { ...session });
      persistSessions();

      // Build conversation history for context — include tool messages for full context
      const conversationMessages: ChatMessage[] = session.messages
        .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
        .map((m) => {
          const msg: ChatMessage = { role: m.role as "user" | "assistant" | "tool", content: m.content };
          if (m.role === "user" && m.attachments && m.attachments.length > 0) {
            msg.attachments = m.attachments;
          }
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            msg.tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
              // Gemini thinking models require this signature to be echoed back
              ...(tc.thoughtSignature ? { extra_content: { thoughtSignature: tc.thoughtSignature } } : {})
            }));
          }
          if (m.role === "tool" && m.toolCallId) {
            msg.tool_call_id = m.toolCallId;
            msg.name = m.toolName;
          }
          return msg;
        });

      // Expand @file references in the latest user message
      const lastUserIdx = conversationMessages.length - 1;
      if (lastUserIdx >= 0 && conversationMessages[lastUserIdx].role === "user") {
        conversationMessages[lastUserIdx].content = await expandAtReferences(conversationMessages[lastUserIdx].content);
      }

      const fileContext = await readFileContext(payload.filePath);
      const emitter = getSessionEmitter(session.id);
      const messageId = randomUUID();

      // Create abort controller for this streaming request. If a previous
      // stream is still running for this session, stop it first — two live
      // streams writing to one session corrupts its history.
      const abortController = new AbortController();
      activeAbortControllers.get(session.id)?.abort();
      activeAbortControllers.set(session.id, abortController);

      // Track tool calls and results to store them in session after completion
      // Batch all tool_call events into ONE assistant message per round (not one per event)
      const batchedToolCalls: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }> = [];
      const batchedToolResults: Array<{
        role: "tool";
        content: string;
        extra?: Parameters<typeof attachMessage>[3];
      }> = [];

      // Streaming AI call
      callAIStream(payload.provider, payload.model, conversationMessages, (token) => {
        emitter.emit("token", { messageId, token });
      }, fileContext, abortController.signal, (toolEvent) => {
        // Forward tool events to SSE stream
        emitter.emit(toolEvent.type, { messageId, ...toolEvent });
        // Accumulate tool calls and results for session persistence
        if (toolEvent.type === "tool_call") {
          batchedToolCalls.push({
            id: toolEvent.toolCallId,
            name: toolEvent.toolName,
            arguments: toolEvent.arguments || "{}",
            thoughtSignature: toolEvent.thoughtSignature
          });
        } else if (toolEvent.type === "tool_result") {
          batchedToolResults.push({
            role: "tool",
            content: toolEvent.result || "",
            extra: {
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              isError: toolEvent.isError
            }
          });
        }
      }, payload.sessionId, payload.quickMode, (usage) => {
        const totals = session.usageTotals ?? { requestCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0 };
        totals.requestCount += 1;
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.totalTokens += usage.totalTokens;
        totals.contextTokens = usage.inputTokens + usage.outputTokens;
        session.usageTotals = totals;
        emitter.emit("usage", { messageId, usage });
      }, (delta) => {
        emitter.emit("thinking", { messageId, token: delta });
      }, payload.forceTools, payload.mode).then((result) => {
        // callAIStream resolves (not rejects) on abort. If a newer stream has
        // replaced ours, that stream owns session state now — drop this late
        // result instead of appending it after the new prompt / flipping
        // status back to idle while it runs.
        const current = activeAbortControllers.get(session.id);
        if (current !== undefined && current !== abortController) return;
        clearAbortController(session.id, abortController);
        // Store ONE assistant message with ALL tool calls (if any)
        if (batchedToolCalls.length > 0) {
          attachMessage(session, "assistant", "", {
            toolCalls: batchedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) }))
          });
        }
        // Store all tool results
        for (const tr of batchedToolResults) {
          attachMessage(session, tr.role, tr.content, tr.extra);
        }
        // Store final assistant response
        attachMessage(session, "assistant", result.content, {
          ...(result.fileChanges && result.fileChanges.length > 0 ? { fileChanges: result.fileChanges } : {})
        });
        session.status = "idle";
        sessionStore.set(session.id, { ...session });
        persistSessions();
        emitter.emit("done", { messageId, usage: result.usage });
        logger.info(`[ai-stream] Session ${session.id} got reply (${result.content.length} chars)${result.usage ? ` [${result.usage.inputTokens}+${result.usage.outputTokens} tokens]` : ""}`);
      }).catch((error) => {
        clearAbortController(session.id, abortController);
        if (abortController.signal.aborted) {
          // Stopped by the user (abort route already set status/persisted) or
          // superseded by a newer stream — don't append a bogus error message
          // or mutate session state behind the newer stream's back.
          return;
        }
        // Still store any tool calls/results that happened before the error
        if (batchedToolCalls.length > 0) {
          attachMessage(session, "assistant", "", {
            toolCalls: batchedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) }))
          });
        }
        for (const tr of batchedToolResults) {
          attachMessage(session, tr.role, tr.content, tr.extra);
        }
        const message = error instanceof Error ? error.message : String(error);
        attachMessage(session, "assistant", `[Error] AI call failed: ${message}`);
        session.status = "review";
        sessionStore.set(session.id, { ...session });
        persistSessions();
        emitter.emit("error", { messageId, error: message });
      });

      sendJson(response, 200, { ...session, streamMessageId: messageId });
      return;
    }

    /* DELETE /api/messages/:id — delete a message pair (user + all assistant/tool messages in that round) */
    if (request.method === "DELETE" && request.url?.match(/^\/api\/messages\/[^/]+$/)) {
      const messageId = request.url.split("/")[3];
      let found = false;
      let deletedCount = 0;
      for (const session of sessionStore.values()) {
        const index = session.messages.findIndex((m) => m.id === messageId);
        if (index !== -1) {
          const msg = session.messages[index];
          if (msg.role === "user") {
            // Delete from this user message up to (but not including) the next user message
            let endIndex = index + 1;
            while (endIndex < session.messages.length && session.messages[endIndex].role !== "user") {
              endIndex++;
            }
            deletedCount = endIndex - index;
            session.messages.splice(index, deletedCount);
          } else {
            // If not a user message, just delete the single message (fallback)
            session.messages.splice(index, 1);
            deletedCount = 1;
          }
          sessionStore.set(session.id, { ...session });
          persistSessions();
          found = true;
          break;
        }
      }
      sendJson(response, 200, { ok: true, deleted: found, deletedCount });
      return;
    }

    /* POST /api/sessions/:id/restore — restore a checkpoint by reverting file changes and removing the message pair.
       Body: { messageId: string } where messageId is the user message ID.
       Returns: { prompt: string, restoredFiles: string[] } */
    if (request.method === "POST" && request.url?.match(/^\/api\/sessions\/[^/]+\/restore$/)) {
      const sessionId = request.url.split("/")[3];
      const session = sessionStore.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }

      const body = await readJsonBody(request) as { messageId?: string };
      if (!body.messageId) {
        sendJson(response, 400, { error: "Missing messageId" });
        return;
      }

      const userIndex = session.messages.findIndex((m) => m.id === body.messageId);
      if (userIndex === -1 || session.messages[userIndex].role !== "user") {
        sendJson(response, 404, { error: "User message not found" });
        return;
      }

      const userMessage = session.messages[userIndex];
      const prompt = userMessage.content;

      // Find the end of this message pair (up to next user message)
      let endIndex = userIndex + 1;
      while (endIndex < session.messages.length && session.messages[endIndex].role !== "user") {
        endIndex++;
      }

      // Collect all fileChanges from messages in this round
      const roundMessages = session.messages.slice(userIndex, endIndex);
      const allFileChanges: FileChange[] = [];
      for (const msg of roundMessages) {
        if (msg.fileChanges) {
          allFileChanges.push(...msg.fileChanges);
        }
      }

      // Revert file changes in reverse order (last change first)
      const restoredFiles: string[] = [];
      for (let i = allFileChanges.length - 1; i >= 0; i--) {
        const fc = allFileChanges[i];
        const absPath = path.resolve(workspaceRoot, fc.filePath);
        if (!isPathInside(workspaceRoot, absPath)) continue;
        try {
          if (fc.isNewFile) {
            // File was newly created — delete it
            await unlink(absPath);
            removeFileFromWorkspaceCache(absPath);
            logger.info(`[restore] Deleted new file: ${fc.filePath}`);
          } else {
            // File existed before — restore previous content
            await ensureDirectoryExists(path.dirname(absPath));
            await writeFile(absPath, fc.previousContent, "utf8");
            updateFileInWorkspaceCache(absPath, fc.previousContent);
            logger.info(`[restore] Restored: ${fc.filePath}`);
          }
          restoredFiles.push(fc.filePath);
        } catch (err) {
          logger.error("restore.failed", { file: fc.filePath, error: (err as Error).message });
        }
      }

      if (restoredFiles.length > 0) invalidateWorkspaceCaches();

      // Remove the message pair from session
      session.messages.splice(userIndex, endIndex - userIndex);
      session.updatedAt = new Date().toISOString();
      sessionStore.set(session.id, { ...session });
      persistSessions();

      sendJson(response, 200, { ok: true, prompt, restoredFiles, deletedCount: endIndex - userIndex });
      return;
    }

    /* SSE stream endpoint — clients connect here to receive real-time tokens */
    if (request.method === "GET" && request.url?.match(/^\/api\/sessions\/[^/]+\/stream/)) {
      const sessionId = request.url.split("/")[3];
      const session = sessionStore.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "http://127.0.0.1:3000",
        "access-control-allow-headers": "content-type,authorization,if-none-match",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
      });

      // Send initial connected event
      response.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

      // Keep-alive comments: long agentic turns can go quiet for minutes while
      // tools run. Without periodic bytes, browsers/proxies drop the SSE
      // connection and the live token stream silently dies mid-task.
      const keepAlive = setInterval(() => {
        try {
          response.write(": keepalive\n\n");
        } catch {
          // Client already gone — cleanup happens on "close"
        }
      }, SSE_KEEPALIVE_MS);

      const emitter = getSessionEmitter(sessionId);

      const onToken = (payload: { messageId: string; token: string }) => {
        response.write(`data: ${JSON.stringify({ type: "token", messageId: payload.messageId, token: payload.token })}\n\n`);
      };
      const onDone = (payload: { messageId: string; usage?: UsageData }) => {
        response.write(`data: ${JSON.stringify({ type: "done", messageId: payload.messageId, usage: payload.usage })}\n\n`);
      };
      const onUsage = (payload: { messageId: string; usage: UsageData }) => {
        response.write(`data: ${JSON.stringify({ type: "usage", messageId: payload.messageId, usage: payload.usage })}\n\n`);
      };
      const onThinking = (payload: { messageId: string; token: string }) => {
        response.write(`data: ${JSON.stringify({ type: "thinking", messageId: payload.messageId, token: payload.token })}\n\n`);
      };
      const onError = (payload: { messageId: string; error: string }) => {
        response.write(`data: ${JSON.stringify({ type: "error", messageId: payload.messageId, error: payload.error })}\n\n`);
      };
      const onToolCall = (payload: { messageId: string; toolCallId: string; toolName: string; arguments?: string }) => {
        response.write(`data: ${JSON.stringify({ type: "tool_call", messageId: payload.messageId, toolCallId: payload.toolCallId, toolName: payload.toolName, arguments: payload.arguments })}\n\n`);
      };
      const onToolResult = (payload: { messageId: string; toolCallId: string; toolName: string; result?: string; isError?: boolean; fileChange?: FileChange }) => {
        response.write(`data: ${JSON.stringify({ type: "tool_result", messageId: payload.messageId, toolCallId: payload.toolCallId, toolName: payload.toolName, result: payload.result, isError: payload.isError, fileChange: payload.fileChange })}\n\n`);
      };
      const onPermissionRequest = (payload: { messageId: string; toolCallId: string; toolName: string; action?: ToolAction }) => {
        response.write(`data: ${JSON.stringify({ type: "permission_request", messageId: payload.messageId, toolCallId: payload.toolCallId, toolName: payload.toolName, action: payload.action })}\n\n`);
      };

      emitter.on("token", onToken);
      emitter.on("done", onDone);
      emitter.on("usage", onUsage);
      emitter.on("thinking", onThinking);
      emitter.on("error", onError);
      emitter.on("tool_call", onToolCall);
      emitter.on("tool_result", onToolResult);
      emitter.on("permission_request", onPermissionRequest);

      // Cleanup when client disconnects
      request.on("close", () => {
        clearInterval(keepAlive);
        emitter.off("token", onToken);
        emitter.off("done", onDone);
        emitter.off("usage", onUsage);
        emitter.off("thinking", onThinking);
        emitter.off("error", onError);
        emitter.off("tool_call", onToolCall);
        emitter.off("tool_result", onToolResult);
        emitter.off("permission_request", onPermissionRequest);
        // Clean up emitter if no listeners remain
        if (emitter.listenerCount("token") === 0) {
          sessionEmitters.delete(sessionId);
        }
      });

      return;
    }

    /* POST /api/sessions/:id/abort — cancel an in-flight AI streaming request */
    if (request.method === "POST" && request.url?.match(/^\/api\/sessions\/[^/]+\/abort$/)) {
      const sessionId = request.url.split("/")[3];
      const controller = activeAbortControllers.get(sessionId);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(sessionId);
        // Also emit a done event so the SSE client knows streaming ended
        const emitter = getSessionEmitter(sessionId);
        emitter.emit("done", { messageId: null, aborted: true });
        logger.info(`[ai-stream] Aborted streaming for session ${sessionId}`);
      }
      const session = sessionStore.get(sessionId);
      if (session) {
        session.status = "idle";
        sessionStore.set(sessionId, { ...session });
        persistSessions();
      }
      sendJson(response, 200, { ok: true, aborted: !!controller });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/sessions/")) {
      const sessionId = request.url.replace("/api/sessions/", "");
      const session = sessionStore.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      const mergedRuns = [
        ...session.commandRuns,
        ...getRecentRuns().filter((run) => run.sessionId === session.id && !session.commandRuns.some((item) => item.id === run.id))
      ].slice(0, 12);
      sendJson(response, 200, { ...session, commandRuns: mergedRuns });
      return;
    }

    if (request.method === "DELETE" && request.url?.startsWith("/api/sessions/")) {
      const sessionId = request.url.replace("/api/sessions/", "");
      // Abort any in-flight AI streaming
      const controller = activeAbortControllers.get(sessionId);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(sessionId);
      }
      const existed = sessionStore.delete(sessionId);
      persistSessions();
      // Also clean up any SSE emitter and pending permission state
      sessionEmitters.delete(sessionId);
      sessionToolApprovals.delete(sessionId);
      sendJson(response, 200, { ok: true, deleted: existed });
      return;
    }

    /* SSE stream for terminal output */
    if (request.method === "GET" && request.url?.match(/^\/api\/terminal\/runs\/[^/]+\/stream/)) {
      const runId = request.url.split("/")[4];
      const run = commandRunStore.get(runId);
      if (!run) {
        sendJson(response, 404, { error: "Run not found" });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "http://127.0.0.1:3000",
        "access-control-allow-headers": "content-type,authorization,if-none-match",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
      });

      // Send current output as initial payload
      response.write(`data: ${JSON.stringify({ type: "init", output: run.output, status: run.status })}\n\n`);

      // If already finished, send close immediately
      if (run.status !== "running") {
        response.write(`data: ${JSON.stringify({ type: "close", status: run.status, exitCode: run.exitCode })}\n\n`);
        response.end();
        return;
      }

      const emitter = getTerminalEmitter(runId);

      const onData = (text: string) => {
        response.write(`data: ${JSON.stringify({ type: "data", text })}\n\n`);
      };
      const onClose = (payload: { status: string; exitCode: number | null }) => {
        response.write(`data: ${JSON.stringify({ type: "close", status: payload.status, exitCode: payload.exitCode })}\n\n`);
        response.end();
      };

      emitter.on("data", onData);
      emitter.on("close", onClose);

      request.on("close", () => {
        emitter.off("data", onData);
        emitter.off("close", onClose);
      });

      return;
    }

    if (request.method === "GET" && request.url === "/api/terminal/runs") {
      sendJson(response, 200, { runs: getRecentRuns() });
      return;
    }

    if (request.method === "POST" && request.url === "/api/terminal/runs") {
      const payload = createCommandRunSchema.parse(await readJsonBody(request));
      const run = await runCommand(payload.command, payload.sessionId);
      if (payload.sessionId) {
        const session = sessionStore.get(payload.sessionId);
        if (session) {
          session.status = "running";
          session.commandRuns = [run, ...session.commandRuns.filter((item) => item.id !== run.id)].slice(0, 12);
          attachMessage(session, "system", `Running command: ${payload.command}`);
          sessionStore.set(session.id, { ...session });
          persistSessions();
        }
      }
      sendJson(response, 201, run);
      return;
    }

    /* DELETE /api/terminal/runs/:id — kill a running terminal process */
    if (request.method === "DELETE" && request.url?.match(/^\/api\/terminal\/runs\/[^/]+$/)) {
      const runId = request.url.split("/")[4];
      const run = commandRunStore.get(runId);
      if (!run) {
        sendJson(response, 404, { error: "Run not found" });
        return;
      }
      const child = activeChildProcesses.get(runId);
      if (child && run.status === "running") {
        child.kill("SIGTERM");
        // Give it 3s then SIGKILL
        setTimeout(() => {
          if (activeChildProcesses.has(runId)) {
            child.kill("SIGKILL");
          }
        }, 3000);
        sendJson(response, 200, { ok: true, killed: true });
      } else {
        sendJson(response, 200, { ok: true, killed: false, status: run.status });
      }
      return;
    }

    if (request.method === "PUT" && request.url === "/api/file") {
      const payload = (await readJsonBody(request)) as { path: string; content: string };
      const targetPath = path.resolve(workspaceRoot, payload.path);
      if (!isPathInside(workspaceRoot, targetPath)) {
        sendJson(response, 400, { error: "Invalid file path" });
        return;
      }
      await ensureDirectoryExists(path.dirname(targetPath));
      await writeFile(targetPath, payload.content, "utf8");
      updateFileInWorkspaceCache(targetPath, payload.content);
      sendJson(response, 200, { ok: true, path: payload.path });
      return;
    }

    // DELETE /api/file?path=... — remove a file, or a folder recursively.
    // Workspace-boundary enforced; the workspace root itself can never be
    // deleted, and every open-file content cache entry under the path is
    // dropped so a later restore can't resurrect stale bytes.
    if (request.method === "DELETE" && request.url?.startsWith("/api/file?")) {
      let relPath: string | null = null;
      try {
        relPath = new URL(request.url, "http://127.0.0.1").searchParams.get("path");
      } catch {
        relPath = null;
      }
      if (!relPath) {
        sendJson(response, 400, { error: "Missing path" });
        return;
      }
      const targetPath = path.resolve(workspaceRoot, relPath);
      if (!isPathInside(workspaceRoot, targetPath)) {
        sendJson(response, 400, { error: "Invalid file path" });
        return;
      }
      try {
        const st = await stat(targetPath);
        if (st.isDirectory()) {
          await rm(targetPath, { recursive: true, force: true });
        } else {
          await unlink(targetPath);
        }
        removeFileFromWorkspaceCache(targetPath);
        logger.info(`[files] Deleted ${st.isDirectory() ? "folder" : "file"}: ${relPath}`);
        sendJson(response, 200, { ok: true, path: relPath });
      } catch (err) {
        sendJson(response, 404, { error: `Delete failed: ${(err as Error).message}` });
      }
      return;
    }

    /* ================================================================
       Auth Endpoints
       ================================================================ */

    // GET /api/auth/status — connection status of all providers
    if (request.method === "GET" && request.url === "/api/auth/status") {
      const providers = providerConfigs.map((config) => ({
        id: config.id as ProviderId,
        label: config.label,
        status: getProviderStatus(config),
        method: getAuthMethod(config)
      }));
      sendJson(response, 200, { providers });
      return;
    }

    // POST /api/auth/keys — save an API key for a provider
    if (request.method === "POST" && request.url === "/api/auth/keys") {
      const payload = saveKeyInputSchema.parse(await readJsonBody(request));
      storedKeys.set(payload.provider, payload.key);
      invalidateModelCache(payload.provider);
      logger.info(`[auth] Stored API key for provider: ${payload.provider}`);
      void persistAuth();
      sendJson(response, 200, { ok: true, provider: payload.provider });
      return;
    }

    // DELETE /api/auth/keys/:provider — remove a stored key
    if (request.method === "DELETE" && request.url?.startsWith("/api/auth/keys/")) {
      const providerId = request.url.replace("/api/auth/keys/", "");
      storedKeys.delete(providerId);
      invalidateModelCache(providerId);
      logger.info(`[auth] Removed stored key for provider: ${providerId}`);
      void persistAuth();
      sendJson(response, 200, { ok: true, provider: providerId });
      return;
    }

    // POST /api/auth/github/start — initiate GitHub OAuth Device Flow
    if (request.method === "POST" && request.url === "/api/auth/github/start") {
      try {
        const result = await startGitHubDeviceFlow();
        sendJson(response, 200, {
          deviceCode: result.deviceCode,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          expiresIn: result.expiresIn,
          interval: result.interval
        });
      } catch (err) {
        sendJson(response, 500, {
          error: err instanceof Error ? err.message : "Failed to start GitHub device flow"
        });
      }
      return;
    }

    // GET /api/auth/github/poll?device_code=X — poll for GitHub OAuth completion
    if (request.method === "GET" && request.url?.startsWith("/api/auth/github/poll")) {
      const url = new URL(request.url, `http://localhost:${port}`);
      const deviceCode = url.searchParams.get("device_code");
      if (!deviceCode) {
        sendJson(response, 400, { error: "Missing device_code parameter" });
        return;
      }
      const result = await pollGitHubDeviceFlow(deviceCode);
      // Don't send the actual token to the client for security
      sendJson(response, 200, {
        status: result.status,
        error: result.error,
        interval: result.interval
      });
      return;
    }

    // GET /api/custom-provider — get custom provider config
    if (request.method === "GET" && request.url === "/api/custom-provider") {
      sendJson(response, 200, {
        baseUrl: customProvider.baseUrl,
        model: customProvider.model,
        hasApiKey: !!customProvider.apiKey
      });
      return;
    }

    // POST /api/custom-provider — save custom provider config
    if (request.method === "POST" && request.url === "/api/custom-provider") {
      const body = await readJsonBody(request) as { baseUrl?: string; apiKey?: string; model?: string };
      if (body.baseUrl !== undefined) customProvider.baseUrl = body.baseUrl;
      if (body.apiKey !== undefined) customProvider.apiKey = body.apiKey;
      if (body.model !== undefined) customProvider.model = body.model;
      invalidateModelCache("custom");
      logger.info("[custom-provider] Saved config", { baseUrl: customProvider.baseUrl ? "(set)" : "(empty)" });
      void persistCustomProvider();
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { ok: false, appName: APP_NAME, message: "Not found" });
  } catch (error) {
    // Zod validation failures and malformed JSON are client errors (400),
    // not server faults — and we must not echo raw issue lists back.
    const errName = (error as { name?: string })?.name;
    if (errName === "ZodError") {
      sendJson(response, 400, { ok: false, message: "Invalid request payload" });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { ok: false, message: "Malformed JSON body" });
      return;
    }
    if ((error as Error)?.message?.includes("exceeds")) {
      sendJson(response, 413, { ok: false, message: (error as Error).message });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      appName: APP_NAME,
      message: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

/* ================================================================
   WebSocket PTY Terminal Server
   ================================================================ */

const WS_PORT = Number(process.env.WS_PORT ?? 3031);

// Active PTY sessions keyed by WebSocket
const activePtySessions = new Map<WebSocket, nodePty.IPty>();

/** Shell for the integrated terminal.
 *  `GAMMA_CODE_SHELL` (or `SHELL`) wins when it names something that exists;
 *  otherwise PowerShell/COMSPEC on Windows and zsh elsewhere. The previous
 *  unconditional `/bin/zsh` default could not spawn at all on Windows. */
function resolveTerminalShell(): { command: string; args: string[] } {
  const configured = process.env.GAMMA_CODE_SHELL?.trim() || process.env.SHELL?.trim();
  if (configured && existsSync(configured)) return { command: configured, args: [] };

  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.WINDIR || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    if (existsSync(powershell)) return { command: powershell, args: ["-NoLogo"] };
    const comspec = process.env.COMSPEC;
    if (comspec && existsSync(comspec)) return { command: comspec, args: [] };
    return { command: "cmd.exe", args: [] };
  }

  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return { command: candidate, args: [] };
  }
  return { command: "sh", args: [] };
}

function startTerminalServer(): void {
  const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

  // Log only after the bind actually succeeds (the constructor returns
  // before the socket is listening; logging here raced with EADDRINUSE).
  wss.on("listening", () => {
    logger.info(`[terminal] WebSocket PTY server listening on ws://127.0.0.1:${WS_PORT}`);
  });

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    // Same-origin guard: any local process (or a malicious page targeting
    // localhost) could otherwise attach to the PTY and get a free shell.
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      logger.warn("[terminal] Rejected PTY connection from disallowed origin", { origin });
      ws.close(4003, "Origin not allowed");
      return;
    }
    if (webPassword) {
      const urlToken = request.url?.includes("?")
        ? new URL(request.url, `http://127.0.0.1:${WS_PORT}`).searchParams.get("token")
        : null;
      const auth = request.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : urlToken;
      if (!token || token !== webPassword) {
        logger.warn("[terminal] Rejected PTY connection: missing/invalid password");
        ws.close(4001, "Unauthorized");
        return;
      }
    }
    const shell = resolveTerminalShell();
    let ptyProcess: nodePty.IPty;
    try {
      ptyProcess = nodePty.spawn(shell.command, shell.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        env: {
          ...process.env,
          TERM: "xterm-256color"
        } as Record<string, string>
      });
    } catch (err) {
      logger.error("terminal.spawn_failed", { error: err instanceof Error ? err.message : String(err) });
      ws.send(JSON.stringify({ type: "error", data: `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}` }));
      ws.close();
      return;
    }

    activePtySessions.set(ws, ptyProcess);
    logger.info(`[terminal] PTY spawned (pid: ${ptyProcess.pid}, shell: ${shell})`);

    // PTY → WebSocket (shell output)
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info(`[terminal] PTY exited (code: ${exitCode}, signal: ${signal})`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
        ws.close();
      }
      activePtySessions.delete(ws);
    });

    // WebSocket → PTY (user input + resize)
    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as {
          type: string;
          data?: string;
          cols?: number;
          rows?: number;
        };

        if (msg.type === "input" && msg.data) {
          ptyProcess.write(msg.data);
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          ptyProcess.resize(msg.cols, msg.rows);
        }
      } catch {
        // If raw message is not JSON, treat it as direct input
        const text = typeof raw === "string" ? raw : raw.toString();
        ptyProcess.write(text);
      }
    });

    ws.on("close", () => {
      logger.info("[terminal] WebSocket closed, killing PTY");
      ptyProcess.kill();
      activePtySessions.delete(ws);
    });

    ws.on("error", (err: Error) => {
      logger.error("terminal.ws_error", { error: err.message });
      ptyProcess.kill();
      activePtySessions.delete(ws);
    });
  });

  wss.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      logger.error(
        `[terminal] Port ${WS_PORT} is already in use. Another GammaCode instance is probably running — ` +
          `run "pnpm stop" to kill it, or set WS_PORT=<other port>.`
      );
      process.exit(1);
    }
    logger.error("terminal.ws_server_error", { error: err.message });
  });
}

/* ================================================================
   Startup
   ================================================================ */

async function refreshConfig(): Promise<void> {
  try {
    const { config, paths } = await loadConfig(workspaceRoot);
    resolvedConfig = config;
    resolvedConfigPaths = paths;
    const nextDefault = getDefaultAgent(resolvedConfig);
    activeAgentId = nextDefault;
    pluginRuntime = await loadPlugins(workspaceRoot, resolvedConfig);
  } catch (err) {
    logger.error("config.load_failed", { error: err instanceof Error ? err.message : String(err) });
    resolvedConfig = null;
    resolvedConfigPaths = null;
    activeAgentId = "build";
    pluginRuntime = null;
  }
}

async function startServer(): Promise<void> {
  await refreshConfig();
  // Load persisted auth tokens from disk (GitHub OAuth, manual API keys)
  await loadPersistedAuth();

  // Load persisted sessions from disk
  await loadPersistedSessions();

  // Load recent projects list and mark the current workspace as active
  await loadPersistedProjects();
  await loadPersistedCustomProvider();
  await loadShares();
  touchProject(workspaceRoot);

  // Start WebSocket PTY terminal server
  startTerminalServer();

  // Log which providers are available
  const connectedProviders = providerConfigs.filter((c) => getKeyForProvider(c.id));
  const disconnectedProviders = providerConfigs.filter((c) => !getKeyForProvider(c.id));

  // Without this handler a port conflict crashes with a raw unhandled
  // 'error' event stack — the classic "server won't launch" symptom when a
  // previous instance is still alive.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `Port ${port} is already in use. Another GammaCode server is probably still running. ` +
          `Run "pnpm stop" to kill it, or set PORT=<other port> and retry.`
      );
      process.exit(1);
    }
    logger.error("server.unexpected_error", { error: err.message });
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info(`${APP_NAME} server listening on http://127.0.0.1:${port}`);
    if (connectedProviders.length > 0) {
      logger.info(`[ai] Connected providers: ${connectedProviders.map((c) => c.label).join(", ")}`);
    }
    if (disconnectedProviders.length > 0) {
      logger.info(`[ai] Missing API keys: ${disconnectedProviders.map((c) => `${c.label} (${c.envKey})`).join(", ")}`);
    }

    // Watch for out-of-band edits so the (now long-lived) file caches refresh
    // as soon as something changes on disk.
    startWorkspaceWatcher();
  });
}

// Crash forensics: log unhandled rejections (keep running) and unhandled
// exceptions (exit so ports free up and `pnpm dev` / tsx watch can recover).
process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", {
    reason: reason instanceof Error ? reason.message : String(reason)
  });
});
process.on("uncaughtException", (err) => {
  logger.error("process.uncaught_exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
// Last-ditch breadcrumb for exit paths that bypass the handlers above (native
// crashes, process.exit elsewhere). writeSync(2) is synchronous, so it lands
// even during 'exit'.
process.on("exit", (code) => {
  try {
    writeSync(2, `[server] process exiting with code ${code}\n`);
  } catch {
    // Nothing left to do.
  }
});

void startServer();
