import type { InjectorConfig } from './types.js';

/**
 * Maximum number of live API-key scopes retained for one fetch implementation.
 * Custom fetch implementations are weakly held, while the normal global fetch
 * instance has one bounded map for the lifetime of the execution environment.
 */
const MAX_SCOPES_PER_FETCH_IMPL = 128;

const missingGlobalFetchOwner = {};
let rateLimitDeadlines = new WeakMap<object, Map<string, number>>();

/** Test-only reset for suites that deliberately reuse a fetch implementation. */
export function __resetRateLimitCircuitForTests(): void {
  rateLimitDeadlines = new WeakMap<object, Map<string, number>>();
}

function fetchOwner(config: InjectorConfig): object {
  return config.fetchImpl ?? globalThis.fetch ?? missingGlobalFetchOwner;
}

function scopeKey(config: InjectorConfig): string {
  // JSON encoding keeps arbitrary base/key strings unambiguous. The key never
  // leaves this execution environment and is never logged.
  return JSON.stringify([config.enhancelyBase, config.apiKey]);
}

function pruneExpired(scopes: Map<string, number>, now: number): void {
  for (const [key, deadline] of scopes) {
    if (deadline <= now) scopes.delete(key);
  }
}

/** Active org/API-key rate-limit deadline, or null when the circuit is closed. */
export function getRateLimitDeadline(config: InjectorConfig, now?: number): number | null {
  const owner = fetchOwner(config);
  const scopes = rateLimitDeadlines.get(owner);
  if (scopes === undefined) return null;

  const currentTime = now ?? Date.now();
  pruneExpired(scopes, currentTime);
  if (scopes.size === 0) {
    rateLimitDeadlines.delete(owner);
    return null;
  }

  const key = scopeKey(config);
  const deadline = scopes.get(key);
  if (deadline === undefined) return null;

  // Refresh insertion order so capacity eviction behaves like a small LRU.
  scopes.delete(key);
  scopes.set(key, deadline);
  return deadline;
}

/**
 * Open or extend the circuit for one Enhancely base/API-key scope. Callers pass
 * the already path-capped deadline so GET and register POST share the exact
 * retry instant selected by the orchestrator.
 */
export function recordRateLimitDeadline(config: InjectorConfig, deadline: number): void {
  const now = Date.now();
  if (deadline <= now) return;

  const owner = fetchOwner(config);
  let scopes = rateLimitDeadlines.get(owner);
  if (scopes === undefined) {
    scopes = new Map();
    rateLimitDeadlines.set(owner, scopes);
  } else {
    pruneExpired(scopes, now);
  }

  const key = scopeKey(config);
  const current = scopes.get(key) ?? 0;
  scopes.delete(key);
  scopes.set(key, Math.max(current, deadline));

  while (scopes.size > MAX_SCOPES_PER_FETCH_IMPL) {
    const oldest = scopes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    scopes.delete(oldest);
  }
}
