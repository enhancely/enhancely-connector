/**
 * Config resolution for the Lambda@Edge adapter.
 *
 * Lambda@Edge supports NO user-configurable environment variables, so the
 * usual `ENHANCELY_API_KEY=sk-…` pattern is impossible. Two key sources are
 * supported, tried in this order:
 *
 *   1. **Baked config file** — `connector-config.json`, generated at deploy
 *      time (gitignored; see `connector-config.example.json`) and zipped next
 *      to the bundled `index.js`. Zero runtime latency, no extra IAM, but the
 *      key is embedded in every published function version and rotation
 *      requires a redeploy.
 *   2. **SSM Parameter Store** — when the baked file has no `apiKey` (or does
 *      not exist), the key is fetched via `GetParameter` (WithDecryption) from
 *      `ssmParameterName` (default `/enhancely/connector/api-key`) in
 *      `ssmRegion` (default `us-east-1`, where Lambda@Edge is authored).
 *      Rotation without redeploy, key never in the bundle — at the cost of one
 *      SSM call per execution environment and IAM permissions. The call is
 *      BOUNDED (`AbortSignal.timeout`, default 2000 ms, at most 2 attempts):
 *      an unbounded SSM hang would ride the first invocation into the Lambda
 *      function timeout, which CloudFront turns into a viewer-facing 502 —
 *      the exact failure the fail-open invariant forbids. A timed-out SSM
 *      resolves to "no key" → pass-through for a 30-second cooldown, then the
 *      next invocation retries.
 *
 * Concurrent invocations of one execution environment share a single in-flight
 * resolution (and thus a single SSM call). A SUCCESSFUL result is memoized for
 * the environment's lifetime; a FAILURE (missing parameter, SSM timeout /
 * AccessDenied / throttling) is retried after a short cooldown rather than
 * cached forever — otherwise a key set out-of-band AFTER the first invocation,
 * or a transient SSM blip, would strand a warm instance in pass-through until
 * it is recycled. Each failure is logged loudly.
 *
 * Why `fs` instead of `await import('./connector-config.json')`: the deployed
 * bundle is CJS while this source (and vitest) run as ESM — a native dynamic
 * JSON import would need import attributes (`with { type: 'json' }`) that
 * cannot be expressed portably across both module systems and esbuild's
 * external handling. The observable contract is identical: drop the file next
 * to the bundled `index.js` in the zip (the `package` script does this
 * automatically when the file exists).
 *
 * The SSM SDK import stays DYNAMIC (`await import('@aws-sdk/client-ssm')`):
 * execution environments running on a baked key never load the SDK at all,
 * and the bundle marks `@aws-sdk/*` external (the Lambda Node runtime ships
 * AWS SDK v3), so no SDK bytes are shipped either way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TIMEOUT_MS, defineConfig } from '@enhancely/injector-core';
import type { InjectorConfig } from '@enhancely/injector-core';

export const DEFAULT_SSM_PARAMETER_NAME = '/enhancely/connector/api-key';
export const DEFAULT_SSM_REGION = 'us-east-1';
export const CONFIG_FILE_NAME = 'connector-config.json';

/**
 * Default timeout for the direct origin fetch. Deliberately higher than the
 * core Enhancely-call timeout (800 ms): page generation may legitimately take
 * longer than a lookup, while a hung origin must still fail open quickly.
 */
export const DEFAULT_ORIGIN_TIMEOUT_MS = 2000;

/**
 * Default timeout for the SSM `GetParameter` call. Every network call this
 * adapter makes must be bounded (repo rule 3): a hung SSM otherwise runs into
 * the Lambda function timeout, and a timed-out Lambda@Edge function is a
 * viewer-facing 502 — NOT fail-open.
 */
const DEFAULT_SSM_TIMEOUT_MS = 2000;

/**
 * Terraform deploys every entrypoint with a fixed 10-second Lambda timeout.
 * AbortSignal deadlines must expire early enough that Node/AWS can settle the
 * aborted socket and the handler can still return the original response. Keep
 * two seconds entirely outside network deadlines for cold start, the dynamic
 * SSM SDK import, abort settlement and response serialization.
 */
const LAMBDA_HARD_TIMEOUT_MS = 10_000;
const FAIL_OPEN_SETTLEMENT_RESERVE_MS = 2_000;
export const MAX_SEQUENTIAL_NETWORK_TIMEOUT_MS =
  LAMBDA_HARD_TIMEOUT_MS - FAIL_OPEN_SETTLEMENT_RESERVE_MS;

/**
 * Default lifetime of the origin-request "this URL is not a page" memo.
 * 30 minutes: long, because the verdict is stable, and being wrong is bounded
 * (see `nonPageMemoTtlMs` in BakedConnectorConfig).
 */
const DEFAULT_NON_PAGE_MEMO_TTL_MS = 1_800_000;

/**
 * Shape of the deploy-time generated `connector-config.json` (all optional).
 *
 * NOTE for hand-rolled deployments: `excludePaths`, `includeHosts` and
 * `assertedDefaultTtlSeconds` are honored ONLY via this baked file. A
 * deployment that supplies the key purely through SSM without shipping a
 * `connector-config.json` silently runs without those controls. The Terraform
 * module always bakes the file, so the supported path is unaffected.
 */
export interface BakedConnectorConfig {
  /** Enhancely API key. When present, SSM is never contacted. */
  apiKey?: string;
  /** Override for the Enhancely API base URL. */
  enhancelyBase?: string;
  /** Timeout for Enhancely API calls (core default: 800 ms). */
  timeoutMs?: number;
  /** JSON-LD cache TTL (core default: 300 000 ms). */
  cacheTtlMs?: number;
  /** Enable self-registration through the one-step register-or-revalidate POST. */
  autoRegister?: boolean;
  /** Timeout for the direct origin fetch (default: 2000 ms). */
  originTimeoutMs?: number;
  /** SSM parameter holding the API key (used only when `apiKey` is absent). */
  ssmParameterName?: string;
  /** Region of the SSM parameter (default: us-east-1). */
  ssmRegion?: string;
  /** Timeout for the SSM GetParameter call (default: 2000 ms). */
  ssmTimeoutMs?: number;
  /**
   * Operator assertion, in seconds: every cache behavior this function is
   * associated with has a DefaultTTL of AT LEAST this many seconds for the
   * HTML it serves. When set (> 0), an uninjected pass-through response
   * WITHOUT an explicit origin lifetime receives the bounded retry
   * Cache-Control capped at `min(retryTtl, this value)` — such a response is
   * already shared-cached for at least the asserted lifetime, so the write
   * can only SHORTEN effective cacheability, never extend it. That unpins
   * lookup timeouts and 404s after seconds instead of the full DefaultTTL
   * (often a day). The number form is what makes the invariant arithmetic
   * instead of trust: even a conservative understatement (e.g. 60) is safe
   * and effective. Absent/0 = off (v0.5.3 behavior). Never set it higher
   * than the SMALLEST DefaultTTL among the associated behaviors; leave off
   * when any of them has DefaultTTL 0. Credentialed requests
   * (Authorization/Cookie) are never touched either way.
   */
  assertedDefaultTtlSeconds?: number;
  /**
   * Operator assertion (all Lambda entrypoints, default false): on this origin,
   * `Set-Cookie` on responses to credential-less requests is load-balancer
   * plumbing (e.g. ALB stickiness stamped on every response), not session
   * material. When true, the retry cache-lifetime cap ALSO applies to such
   * responses — without it, an origin that stamps a cookie on everything can
   * never have an uninjected copy unpinned. Requests carrying
   * Cookie/Authorization stay untouched regardless, and `private`/`no-store`
   * responses are never capped. Do NOT set this on an origin that mints session
   * cookies (JSESSIONID & co.) for anonymous requests: the written s-maxage
   * would license downstream shared caches to replay that Set-Cookie across
   * users (session-fixation pattern).
   */
  capSetCookieResponses?: boolean;
  /**
   * How long the origin-request entrypoint remembers that an answer cannot be
   * injected or safely generated from its first fetch (for example an
   * unsupported 2xx representation or over-quota body). Small redirects,
   * errors and veto bodies are returned from that fetch and need no memo.
   * Default 1 800 000 ms = 30 minutes.
   *
   * Deliberately independent of `cacheTtlMs`, and much longer: that TTL
   * governs a JSON-LD record, which changes when someone edits content, while
   * this one governs a representation-level hard veto, which is normally much
   * more stable.
   *
   * A stale veto is bounded by this TTL and scoped to one execution
   * environment. The companion may shorten CloudFront's cache lifetime so the
   * origin-request trigger gets another opportunity, but it never bypasses
   * this memo and never calls Enhancely itself.
   */
  nonPageMemoTtlMs?: number;
  /**
   * Request paths the connector must not touch AT ALL (login/account areas,
   * robots.txt-disallowed or noindex-by-policy sections): no Enhancely
   * lookup, no auto-registration, no cache-TTL rewriting, no origin fetch
   * — the response passes through byte-identical with its normal caching.
   * CloudFront path-pattern wildcards (`*`), case-sensitive, matched against
   * the full request path. Checked before config/SSM resolution.
   */
  excludePaths?: string[];
  /**
   * Exact public page hostnames on which connector work is enabled. Missing
   * or empty preserves the historical all-host behavior. The list is checked
   * synchronously before SSM, the connector's origin fetch, Enhancely, or a
   * companion cache cap. Entries are hostname-only (no wildcard, scheme,
   * path, credentials, or port); an explicitly supplied malformed hand-written
   * policy deliberately matches nothing rather than widening to every host.
   */
  includeHosts?: string[];
}

/* ------------------------------------------------------------------------ */
/* Module state (one per Lambda execution environment)                        */
/* ------------------------------------------------------------------------ */

// A SUCCESSFUL resolution is memoized for the whole execution environment.
// A FAILURE (missing parameter, SSM timeout/AccessDenied/throttling) is NOT
// cached permanently — that would strand a warm instance forever if the key is
// set out-of-band after the first invocation, or during a transient SSM blip.
// Instead a failure applies a short cooldown, after which the next invocation
// retries. Concurrent invocations still share one in-flight resolution.
let resolvedConfig: InjectorConfig | null = null;
let negativeUntil = 0;
let inflight: Promise<InjectorConfig | null> | null = null;
const NEGATIVE_TTL_MS = 30_000;
// The baked FILE read is memoized separately from key resolution: exclusion
// checks must work synchronously before (and without) any SSM call.
let bakedCache: BakedConnectorConfig | null | undefined;

/** Test seams — `undefined` means "use the real file read". */
let bakedOverride: BakedConnectorConfig | null | undefined;
let configOverrides: Partial<InjectorConfig> | null = null;

/* ------------------------------------------------------------------------ */
/* Parsing helpers                                                            */
/* ------------------------------------------------------------------------ */

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** AbortSignal.timeout accepts whole milliseconds; reject unsafe coercions. */
function positiveWholeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Pick only well-typed fields; junk in the file must never crash the edge. */
function parseBaked(raw: unknown): BakedConnectorConfig {
  const baked: BakedConnectorConfig = {};
  if (typeof raw !== 'object' || raw === null) return baked;
  const source = raw as Record<string, unknown>;

  const apiKey = nonEmptyString(source['apiKey']);
  if (apiKey !== undefined) baked.apiKey = apiKey;
  const enhancelyBase = nonEmptyString(source['enhancelyBase']);
  if (enhancelyBase !== undefined) baked.enhancelyBase = enhancelyBase;
  const timeoutMs = positiveWholeNumber(source['timeoutMs']);
  const cacheTtlMs = positiveNumber(source['cacheTtlMs']);
  if (cacheTtlMs !== undefined) baked.cacheTtlMs = cacheTtlMs;
  if (typeof source['autoRegister'] === 'boolean') baked.autoRegister = source['autoRegister'];
  const originTimeoutMs = positiveWholeNumber(source['originTimeoutMs']);
  const ssmParameterName = nonEmptyString(source['ssmParameterName']);
  if (ssmParameterName !== undefined) baked.ssmParameterName = ssmParameterName;
  const ssmRegion = nonEmptyString(source['ssmRegion']);
  if (ssmRegion !== undefined) baked.ssmRegion = ssmRegion;
  const ssmTimeoutMs = positiveWholeNumber(source['ssmTimeoutMs']);

  // These calls are sequential on the first cold invocation: resolve the key
  // from SSM, fetch the origin, then ask Enhancely. A hand-written baked file
  // must not be able to spend Lambda's entire 10-second lifetime inside its
  // AbortSignal deadlines, because hard Lambda termination becomes a viewer
  // 502 instead of fail-open. Invalid/over-budget overrides are ignored as one
  // set, restoring the known-safe 800 + 2000 + 2000 ms defaults.
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const effectiveOriginTimeoutMs = originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
  const effectiveSsmTimeoutMs = ssmTimeoutMs ?? DEFAULT_SSM_TIMEOUT_MS;
  if (
    effectiveTimeoutMs + effectiveOriginTimeoutMs + effectiveSsmTimeoutMs <=
    MAX_SEQUENTIAL_NETWORK_TIMEOUT_MS
  ) {
    if (timeoutMs !== undefined) baked.timeoutMs = timeoutMs;
    if (originTimeoutMs !== undefined) baked.originTimeoutMs = originTimeoutMs;
    if (ssmTimeoutMs !== undefined) baked.ssmTimeoutMs = ssmTimeoutMs;
  } else {
    console.error(
      `[enhancely-lambda-edge] connector-config timeouts total ` +
        `${effectiveTimeoutMs + effectiveOriginTimeoutMs + effectiveSsmTimeoutMs} ms, exceeding ` +
        `the ${MAX_SEQUENTIAL_NETWORK_TIMEOUT_MS} ms safe network budget under Lambda's ` +
        `10-second limit — ignoring timeout overrides and using safe defaults`
    );
  }
  const assertedDefaultTtlSeconds = positiveNumber(source['assertedDefaultTtlSeconds']);
  // Whole seconds only, minimum 1: a fractional assertion below 1 would
  // floor to s-maxage=0 downstream (safe but surprising) — treat it as off.
  if (assertedDefaultTtlSeconds !== undefined && assertedDefaultTtlSeconds >= 1) {
    baked.assertedDefaultTtlSeconds = Math.floor(assertedDefaultTtlSeconds);
  }
  const nonPageMemoTtlMs = positiveNumber(source['nonPageMemoTtlMs']);
  if (nonPageMemoTtlMs !== undefined) baked.nonPageMemoTtlMs = nonPageMemoTtlMs;
  if (typeof source['capSetCookieResponses'] === 'boolean') {
    baked.capSetCookieResponses = source['capSetCookieResponses'];
  }
  if (Array.isArray(source['excludePaths'])) {
    const patterns = source['excludePaths'].filter(
      (entry): entry is string => typeof entry === 'string' && entry !== ''
    );
    if (patterns.length > 0) baked.excludePaths = patterns;
  }
  if (Object.hasOwn(source, 'includeHosts')) {
    if (Array.isArray(source['includeHosts'])) {
      // Preserve an invalid item as an empty sentinel. Filtering junk out
      // could turn an explicitly configured non-empty policy into [] and
      // accidentally re-enable the connector on every host.
      baked.includeHosts = source['includeHosts'].map((entry) =>
        typeof entry === 'string' ? entry : ''
      );
    } else {
      baked.includeHosts = [''];
    }
  }

  return baked;
}

/**
 * Locate and read the baked config file. Candidates, in order:
 * - `LAMBDA_TASK_ROOT` (reserved runtime env var; `/var/task` = zip root),
 * - the bundle's own directory (`__dirname` exists in the CJS bundle only),
 * - the working directory (local development / tests).
 * A missing file is normal (SSM mode); an unparsable file is loud but still
 * falls back to SSM rather than taking the function down.
 */
function readBakedConfig(): BakedConnectorConfig | null {
  const dirs: string[] = [];
  const taskRoot = nonEmptyString(process.env['LAMBDA_TASK_ROOT']);
  if (taskRoot !== undefined) dirs.push(taskRoot);
  // `typeof` keeps this safe under ESM (vitest), where __dirname is undeclared.
  if (typeof __dirname === 'string') dirs.push(__dirname);
  dirs.push(process.cwd());

  for (const dir of dirs) {
    const file = join(dir, CONFIG_FILE_NAME);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // not present here — try the next candidate
    }
    try {
      return parseBaked(JSON.parse(text));
    } catch (error) {
      console.error(
        `[enhancely-lambda-edge] ${file} is not valid JSON (${String(error)}) — ignoring it and trying SSM`
      );
      return null;
    }
  }
  return null;
}

async function fetchApiKeyFromSsm(
  parameterName: string,
  region: string,
  timeoutMs: number
): Promise<string | null> {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  // maxAttempts: 2 — the SDK default of 3 attempts multiplies a slow/browning
  // SSM; one retry is plenty for a best-effort key fetch that fails open.
  const client = new SSMClient({ region, maxAttempts: 2 });
  // The abort signal bounds the WHOLE send (all attempts included): a hung
  // SSM must settle this promise so resolveOnce memoizes null (pass-through)
  // instead of riding the invocation into a Lambda timeout → viewer 502.
  const result = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    { abortSignal: AbortSignal.timeout(timeoutMs) }
  );
  return nonEmptyString(result.Parameter?.Value) ?? null;
}

/** Baked config, read at most once per execution environment (test seam wins). */
function bakedConfig(): BakedConnectorConfig | null {
  if (bakedOverride !== undefined) return bakedOverride;
  if (bakedCache === undefined) bakedCache = readBakedConfig();
  return bakedCache;
}

async function resolveOnce(): Promise<InjectorConfig | null> {
  try {
    const baked = bakedConfig();

    let apiKey = baked?.apiKey;
    if (apiKey === undefined) {
      apiKey =
        (await fetchApiKeyFromSsm(
          baked?.ssmParameterName ?? DEFAULT_SSM_PARAMETER_NAME,
          baked?.ssmRegion ?? DEFAULT_SSM_REGION,
          baked?.ssmTimeoutMs ?? DEFAULT_SSM_TIMEOUT_MS
        )) ?? undefined;
    }

    if (apiKey === undefined) {
      console.error(
        '[enhancely-lambda-edge] NO API KEY: neither a baked connector-config.json apiKey nor a ' +
          'non-empty SSM parameter was found — responses pass through UNINJECTED for 30 seconds, ' +
          'then config resolution is retried'
      );
      return null;
    }

    // Guard against an unconfigured/placeholder key. Every Enhancely key is
    // `sk-…` (project) or `sk-org-…`; anything else (e.g. the SSM SecureString
    // placeholder `REPLACE_ME` before the real value is set) means the deployment
    // is not configured yet. Return null so the handler passes through without
    // performing its direct origin fetch until the key is installed.
    if (!apiKey.startsWith('sk-')) {
      console.error(
        `[enhancely-lambda-edge] API KEY not configured (value does not look like an Enhancely ` +
          `key) — passing every response through UNINJECTED. Set the real key in SSM.`
      );
      return null;
    }

    return defineConfig({
      apiKey,
      ...(baked?.enhancelyBase !== undefined && { enhancelyBase: baked.enhancelyBase }),
      ...(baked?.timeoutMs !== undefined && { timeoutMs: baked.timeoutMs }),
      ...(baked?.cacheTtlMs !== undefined && { cacheTtlMs: baked.cacheTtlMs }),
      ...(baked?.autoRegister !== undefined && { autoRegister: baked.autoRegister }),
      ...configOverrides,
    });
  } catch (error) {
    // SSM unreachable / denied / timed out / SDK missing — fail open for the
    // 30-second negative-result cooldown, then let the next invocation retry.
    console.error(
      '[enhancely-lambda-edge] config resolution FAILED — every response passes through ' +
        'UNINJECTED for 30 seconds, then config resolution is retried:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return null;
  }
}

/**
 * Resolve the injector config for this execution environment (memoized —
 * concurrent invocations share one in-flight resolution). `null` means "no
 * key resolvable": the handler must pass every response through untouched.
 * Never rejects.
 */
export function resolveAdapterConfig(): Promise<InjectorConfig | null> {
  if (resolvedConfig !== null) return Promise.resolve(resolvedConfig);
  if (Date.now() < negativeUntil) return Promise.resolve(null);
  if (inflight !== null) return inflight;
  inflight = resolveOnce().then((result) => {
    inflight = null;
    if (result !== null) {
      resolvedConfig = result;
    } else {
      // Missing key / SSM error → retry after the cooldown, not never.
      negativeUntil = Date.now() + NEGATIVE_TTL_MS;
    }
    return result;
  });
  return inflight;
}

/**
 * Remaining cooldown after a failed config resolution. The handler uses this
 * to avoid letting CloudFront cache an uninjected pass-through response longer
 * than the next SSM/key retry. Null means no retry is currently scheduled.
 */
export function getConfigRetryInMs(): number | null {
  if (resolvedConfig !== null || negativeUntil <= Date.now()) return null;
  return negativeUntil - Date.now();
}

/**
 * Timeout for the direct origin fetch (`originTimeoutMs` from the baked config,
 * default 2000 ms). The validated baked value is available synchronously.
 */
export function getOriginTimeoutMs(): number {
  return bakedConfig()?.originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
}

/**
 * The operator's asserted minimum DefaultTTL in seconds (baked config
 * `assertedDefaultTtlSeconds`), or 0 when the assertion was not made. When
 * positive, uninjected pass-through responses WITHOUT an explicit origin
 * lifetime may receive the bounded retry Cache-Control capped at this value;
 * without the assertion the adapter cannot know the DefaultTTL and must not
 * add cacheability. The validated baked value is available synchronously so
 * the companion can avoid config/SSM work when no cap is possible.
 */
export function getAssertedDefaultTtlSeconds(): number {
  return bakedConfig()?.assertedDefaultTtlSeconds ?? 0;
}

/**
 * Operator assertion `capSetCookieResponses` (baked config; used pair-wide),
 * default false. Available synchronously for the companion's pre-config gate.
 */
export function getCapSetCookieResponses(): boolean {
  return bakedConfig()?.capSetCookieResponses ?? false;
}

/** Lifetime of the origin-request non-page memo (baked `nonPageMemoTtlMs`). */
export function getNonPageMemoTtlMs(): number {
  return bakedConfig()?.nonPageMemoTtlMs ?? DEFAULT_NON_PAGE_MEMO_TTL_MS;
}

/**
 * Operator exclude patterns (baked config `excludePaths`). Read directly from
 * the memoized baked file so the handler can skip excluded requests BEFORE
 * any config/SSM resolution — an excluded path must not even pay the first
 * key fetch.
 */
export function getExcludePaths(): readonly string[] {
  return bakedConfig()?.excludePaths ?? [];
}

/**
 * Exact public page-host selector (baked `includeHosts`). Like exclude paths,
 * this is available synchronously before API-key/SSM resolution. Empty means
 * unrestricted.
 */
export function getIncludeHosts(): readonly string[] {
  return bakedConfig()?.includeHosts ?? [];
}

/* ------------------------------------------------------------------------ */
/* Test seams (no-ops in production — nothing calls them)                     */
/* ------------------------------------------------------------------------ */

/** Clear the success/cooldown/in-flight memo state. */
function __resetMemoForTests(): void {
  resolvedConfig = null;
  negativeUntil = 0;
  inflight = null;
}

/** TEST-ONLY: bypass the connector-config.json file read (`null` = no file). */
export function __setBakedConfigForTests(baked: BakedConnectorConfig | null): void {
  // Exercise the same validation as the real JSON-file path so tests cannot
  // accidentally bypass the production timeout budget with a typed object.
  bakedOverride = baked === null ? null : parseBaked(baked);
  __resetMemoForTests();
}

/** TEST-ONLY: extra fields merged into the resolved config (e.g. `fetchImpl`). */
export function __setConfigOverridesForTests(overrides: Partial<InjectorConfig> | null): void {
  configOverrides = overrides;
  __resetMemoForTests();
}

/** TEST-ONLY: restore pristine module state. */
export function __resetAdapterConfigForTests(): void {
  bakedOverride = undefined;
  configOverrides = null;
  __resetMemoForTests();
  bakedCache = undefined;
}
