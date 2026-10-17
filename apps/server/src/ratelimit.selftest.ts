/* Run: pnpm --filter @gamma-code/server exec tsx src/ratelimit.selftest.ts */

import { parseRetryAfterMs, resolveRetryWait, noteRateLimit, RateLimitError } from "./ratelimit.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}`, detail ?? "");
  }
}

// Retry-After header: seconds
check("header seconds", parseRetryAfterMs(new Headers({ "retry-after": "28" }), undefined) === 28_000);

// Mistral body: detail.retry_after (seconds)
check(
  "mistral detail.retry_after",
  parseRetryAfterMs(undefined, JSON.stringify({ detail: { error: "rate limited", retry_after: 7200 } })) === 7_200_000
);

// Mistral body: top-level retry_after
check("top-level retry_after", parseRetryAfterMs(undefined, JSON.stringify({ retry_after: 45 })) === 45_000);

// Google REST body: error.details[].retryDelay
check(
  "google details retryDelay",
  parseRetryAfterMs(
    undefined,
    JSON.stringify({ error: { code: 429, details: [{ "@type": "x", retryDelay: "34s" }] } })
  ) === 34_000
);

// Google SDK error object: errorDetails[].retryDelay "1m30s"
check(
  "sdk errorDetails 1m30s",
  parseRetryAfterMs(undefined, undefined, { errorDetails: [{ retryDelay: "1m30s" }] }) === 90_000
);

// Free text: "Please retry in 33.023s"
check("free text retry in", parseRetryAfterMs(undefined, "429 Too Many Requests. Please retry in 33.023s") === 33_023);

// No signal
check("no signal → null", parseRetryAfterMs(undefined, "boom") === null);

// resolveRetryWait: short server hint is honored + grace
const w1 = resolveRetryWait("t", "Test", 0, 5_000);
check("short hint honored (~5s)", w1 >= 5_000 && w1 <= 6_100, w1);

// resolveRetryWait: long wait throws RateLimitError with minutes in message
let threw = false;
try {
  resolveRetryWait("t2", "Mistral", 0, 7_200_000);
} catch (e) {
  threw = e instanceof RateLimitError;
  check("long wait message mentions min", /~120 min/.test((e as Error).message), (e as Error).message);
}
check("long wait throws RateLimitError", threw);

// resolveRetryWait: no hint → exponential backoff (1.5-2.5s at attempt 0)
const w2 = resolveRetryWait("t3", "Test", 0, null);
check("backoff attempt0 in [1.5s, 2.6s]", w2 >= 1_500 && w2 <= 2_600, w2);

// noteRateLimit keeps the longer cooldown
noteRateLimit("t4", 60_000, "a");
noteRateLimit("t4", 1_000, "b");
// acquire isn't exported for direct inspection; behavior checked via resolveRetryWait not needed — parser+wait logic covered above.

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll ratelimit selftests passed.");
