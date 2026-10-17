/* ================================================================
   Provider rate-limit coordination

   - Parses Retry-After from headers, provider JSON bodies (Mistral
     retry_after, Google errorDetails[].retryDelay) and free text.
   - Per-provider cooldown: once any request 429s, sibling requests
     (other sessions, next tool rounds) wait out the cooldown instead
     of hammering the same endpoint and extending the ban.
   - Fails fast with a clear message when the provider asks to wait
     longer than we're willing to auto-retry, instead of burning
     quota with pointless attempts.
   ================================================================ */

import { logger } from "./logger.js";

/** Longest wait we'll sit through automatically. Beyond this, fail fast. */
export const MAX_AUTO_RETRY_WAIT_MS = 90_000;
const MAX_ATTEMPTS = 4;

export class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

interface Cooldown {
  until: number;
  reason: string;
}

const providerCooldowns = new Map<string, Cooldown>();

/** Parse "34s" / "34.5s" / "1m30s" / "2h" / plain-seconds into ms. */
function parseDurationMs(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const full = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (full && (full[1] || full[2] || full[3])) {
    const h = parseFloat(full[1] ?? "0");
    const m = parseFloat(full[2] ?? "0");
    const sec = parseFloat(full[3] ?? "0");
    return Math.round(((h * 60 + m) * 60 + sec) * 1000);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  return null;
}

/** Extract the provider-requested wait from any 429 signal we've seen.
 *  Returns milliseconds, or null if nothing parseable. */
export function parseRetryAfterMs(
  headers: Headers | undefined,
  bodyText: string | undefined,
  sdkError?: unknown
): number | null {
  // 1. Retry-After header — seconds or HTTP-date
  const header = headers?.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      const delta = date - Date.now();
      if (delta > 0) return delta;
    }
  }

  // 2. Google SDK error — errorDetails[].retryDelay like "34s"
  if (sdkError && typeof sdkError === "object") {
    const details = (sdkError as { errorDetails?: unknown }).errorDetails;
    if (Array.isArray(details)) {
      for (const d of details) {
        const delay = (d as { retryDelay?: unknown })?.retryDelay;
        if (typeof delay === "string") {
          const ms = parseDurationMs(delay);
          if (ms != null) return ms;
        }
      }
    }
  }

  if (bodyText) {
    // 3. Provider JSON — Mistral {"detail":{"retry_after":28}} or top-level
    //    retry_after (seconds); Google REST error.details[].retryDelay
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const containers: Array<Record<string, unknown> | undefined> = [
        parsed,
        parsed.detail as Record<string, unknown> | undefined,
        parsed.error as Record<string, unknown> | undefined
      ];
      for (const c of containers) {
        if (!c || typeof c !== "object") continue;
        const ra = c.retry_after ?? c.retryAfter;
        if (typeof ra === "number" && ra >= 0) return Math.round(ra * 1000);
        if (typeof ra === "string") {
          const ms = parseDurationMs(ra);
          if (ms != null) return ms;
        }
        const details = c.details;
        if (Array.isArray(details)) {
          for (const d of details) {
            const delay = (d as { retryDelay?: unknown })?.retryDelay;
            if (typeof delay === "string") {
              const ms = parseDurationMs(delay);
              if (ms != null) return ms;
            }
          }
        }
      }
    } catch {
      /* not JSON — fall through to text patterns */
    }

    // 4. Free text — "retry in 33s" / "Please retry in 33.023s" / "retry-after 28"
    const m =
      bodyText.match(/retry(?:-|\s)?after["\s:]*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|min|minutes)?/i) ??
      bodyText.match(/retry.*?in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|min|minutes)?/i);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) {
        const unit = (m[2] ?? "s").toLowerCase();
        if (unit.startsWith("ms")) return Math.round(n);
        if (unit.startsWith("min")) return Math.round(n * 60_000);
        return Math.round(n * 1000);
      }
    }
  }

  return null;
}

/** Block until this provider's cooldown expires (no-op when clear). */
export async function acquireProviderSlot(providerId: string, providerLabel: string): Promise<void> {
  const cd = providerCooldowns.get(providerId);
  if (!cd) return;
  const wait = cd.until - Date.now();
  if (wait <= 0) {
    providerCooldowns.delete(providerId);
    return;
  }
  logger.warn(`[ratelimit] ${providerLabel} cooling down ${Math.round(wait / 1000)}s (${cd.reason})`);
  await new Promise((resolve) => setTimeout(resolve, wait));
  providerCooldowns.delete(providerId);
}

/** Extend the cooldown to cover `waitMs` from now (keeps the longer one). */
export function noteRateLimit(providerId: string, waitMs: number, reason: string): void {
  const until = Date.now() + Math.max(waitMs, 0);
  const existing = providerCooldowns.get(providerId);
  if (!existing || until > existing.until) {
    providerCooldowns.set(providerId, { until, reason });
  }
}

/** Decide how long to wait for this 429. Honors the server's hint, applies
 *  backoff when absent, and throws RateLimitError for waits we won't sit
 *  through (quota exhausted — retrying sooner just digs the hole deeper). */
export function resolveRetryWait(
  providerId: string,
  providerLabel: string,
  attempt: number,
  retryAfterMs: number | null
): number {
  const waitMs = retryAfterMs ?? Math.min(2 ** attempt, 16) * 1500 + Math.random() * 1000;

  if (waitMs > MAX_AUTO_RETRY_WAIT_MS) {
    noteRateLimit(providerId, waitMs, "server-requested long wait");
    const mins = Math.round(waitMs / 60_000);
    throw new RateLimitError(
      `${providerLabel} rate limit: the provider asked to wait ~${mins} min. ` +
        `Try again later, or switch provider/model in Settings.`,
      waitMs
    );
  }

  // Small grace on top of the server hint so we don't re-trigger on the edge.
  noteRateLimit(providerId, waitMs + 1000, "post-429 cooldown");
  return waitMs;
}

export function isRateLimitAttemptAllowed(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}
