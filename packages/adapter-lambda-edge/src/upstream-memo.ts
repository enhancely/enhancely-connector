/**
 * Global "upstream is unwell" memo, in addition to the core's per-URL
 * `retryNotBefore`.
 *
 * WHY BOTH. The core's backoff lives on the cache entry, so it is keyed by
 * URL. That is right for a 404 or a per-record problem, but an API outage is
 * not per-record — it affects every URL at once. Without a wider memo, every distinct URL would pay the full timeout once per execution environment.
 *
 * So the FIRST upstream call that runs into the timeout parks every other call
 * in this execution environment for a short window. Pages then serve at full
 * speed without JSON-LD, which is the right trade: the snippet is optional,
 * the page is not.
 *
 * Detection is by elapsed time, because the core collapses every failure into
 * "no snippet" and a 404 is indistinguishable from a timeout by return value.
 * A call that consumed essentially the whole budget did not get an answer.
 *
 * This module intentionally holds state (unlike `shared.ts`): the memo IS the
 * feature. Module state is per bundle and per execution environment — the
 * origin-request injector and the companion are separate Lambda functions, so
 * each fleet keeps its own memo, which is exactly the granularity an outage
 * detector needs.
 */

let upstreamDownUntil = 0;

/** Window to park upstream calls after a timeout. Short: recovery must be quick. */
export const UPSTREAM_DOWN_MS = 10_000;

/** A call that used up (almost) the whole budget did not get an answer. */
export const TIMEOUT_DETECTION_RATIO = 0.9;

/** True while calls should be parked (the memo window is open). */
export function isUpstreamDown(): boolean {
  return Date.now() < upstreamDownUntil;
}

/** Remaining park window in ms (0 when the upstream is considered healthy). */
export function upstreamDownRemainingMs(): number {
  return Math.max(0, upstreamDownUntil - Date.now());
}

/** Feed the detector with an observed call duration against its budget. */
export function noteUpstreamCallDuration(elapsedMs: number, timeoutMs: number): void {
  if (elapsedMs >= timeoutMs * TIMEOUT_DETECTION_RATIO) {
    upstreamDownUntil = Date.now() + UPSTREAM_DOWN_MS;
  }
}

/** TEST-ONLY. */
export function __resetUpstreamMemoForTests(): void {
  upstreamDownUntil = 0;
}
