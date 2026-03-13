// ============================================================
//  SyncFlow — retry.js
//  Exponential backoff utility used throughout the system.
//
//  withRetry(fn, opts) — wraps any async function.
//  On failure: waits, then retries. Gives up after maxAttempts.
//
//  Default schedule (3 attempts):
//    Attempt 1 — immediate
//    Attempt 2 — wait 5 seconds
//    Attempt 3 — wait 15 seconds
//    → throw last error
//
//  Special handling:
//    429 Too Many Requests: reads Retry-After header if present and
//    waits exactly that long (capped at 5 min). Without the header,
//    waits at least 30 seconds. Never fires immediately after a 429.
// ============================================================

async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 5000,   // 5s between attempt 1→2
    multiplier  = 3,      // 5s → 15s → 45s
    label       = 'operation',
    onRetry     = null,   // optional async callback(attempt, error, delayMs)
  } = opts;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      // Bail immediately if caller flagged non-retryable (e.g. 401/403)
      if (err.noRetry) throw err;

      lastError = err;
      if (attempt === maxAttempts) break;

      const status = err?.response?.status;
      let delayMs  = baseDelayMs * Math.pow(multiplier, attempt - 1);

      // ── 429 Too Many Requests — honour Retry-After header ────
      if (status === 429) {
        const retryAfterHeader = err?.response?.headers?.['retry-after'];
        if (retryAfterHeader) {
          const parsed       = Number(retryAfterHeader);
          const retryAfterMs = !isNaN(parsed)
            ? parsed * 1000
            : new Date(retryAfterHeader).getTime() - Date.now();
          // Cap at 5 min — never stall a sync indefinitely
          delayMs = Math.min(Math.max(retryAfterMs, 1000), 5 * 60 * 1000);
          console.warn(`[RETRY] ${label} — 429 rate limited. Retry-After: ${Math.round(delayMs / 1000)}s`);
        } else {
          delayMs = Math.max(delayMs, 30000); // minimum 30s for 429 without header
          console.warn(`[RETRY] ${label} — 429 rate limited (no Retry-After). Waiting ${Math.round(delayMs / 1000)}s`);
        }
      } else {
        console.warn(`[RETRY] ${label} — attempt ${attempt}/${maxAttempts} failed (${status || 'network'}): ${err.message}. Retrying in ${Math.round(delayMs / 1000)}s...`);
      }

      if (onRetry) await onRetry(attempt, err, delayMs).catch(() => {});
      await sleep(delayMs);
    }
  }

  console.error(`[RETRY] ${label} — all ${maxAttempts} attempts failed. Last: ${lastError.message}`);
  throw lastError;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { withRetry, sleep };
