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
 *      resolves to the memoized "no key" → pass-through instead.
 *
 * The result is memoized as a module-level PROMISE: all concurrent invocations
 * of one execution environment share a single resolution (and thus a single
 * SSM call). A "no key" outcome is also memoized — it is logged loudly ONCE
 * and every response passes through uninjected; Lambda recycles execution
 * environments regularly, so the next cold start retries.
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
import { defineConfig } from '@enhancely/injector-core';
import type { InjectorConfig } from '@enhancely/injector-core';

export const DEFAULT_SSM_PARAMETER_NAME = '/enhancely/connector/api-key';
export const DEFAULT_SSM_REGION = 'us-east-1';
export const CONFIG_FILE_NAME = 'connector-config.json';

/**
 * Default timeout for the origin re-fetch. Deliberately higher than the core's
 * Enhancely-call timeout (800 ms): the origin already answered once (the
 * response we are decorating), so a slow-but-working origin should not make
 * injection impossible — while a hung origin must still fail open quickly.
 */
export const DEFAULT_ORIGIN_TIMEOUT_MS = 2000;

/**
 * Default timeout for the SSM `GetParameter` call. Every network call this
 * adapter makes must be bounded (repo rule 3): a hung SSM otherwise runs into
 * the Lambda function timeout, and a timed-out origin-response function is a
 * viewer-facing 502 — NOT fail-open.
 */
export const DEFAULT_SSM_TIMEOUT_MS = 2000;

/** Shape of the deploy-time generated `connector-config.json` (all optional). */
export interface BakedConnectorConfig {
  /** Enhancely API key. When present, SSM is never contacted. */
  apiKey?: string;
  /** Override for the Enhancely API base URL. */
  enhancelyBase?: string;
  /** Timeout for Enhancely API calls (core default: 800 ms). */
  timeoutMs?: number;
  /** JSON-LD cache TTL (core default: 300 000 ms). */
  cacheTtlMs?: number;
  /** Enable self-registration: POST unknown pages to Enhancely on 404. */
  autoRegister?: boolean;
  /** Timeout for the origin re-fetch (default: 2000 ms). */
  originTimeoutMs?: number;
  /** SSM parameter holding the API key (used only when `apiKey` is absent). */
  ssmParameterName?: string;
  /** Region of the SSM parameter (default: us-east-1). */
  ssmRegion?: string;
  /** Timeout for the SSM GetParameter call (default: 2000 ms). */
  ssmTimeoutMs?: number;
}

/* ------------------------------------------------------------------------ */
/* Module state (one per Lambda execution environment)                        */
/* ------------------------------------------------------------------------ */

let memo: Promise<InjectorConfig | null> | null = null;
let resolvedOriginTimeoutMs = DEFAULT_ORIGIN_TIMEOUT_MS;

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

/** Pick only well-typed fields; junk in the file must never crash the edge. */
function parseBaked(raw: unknown): BakedConnectorConfig {
  const baked: BakedConnectorConfig = {};
  if (typeof raw !== 'object' || raw === null) return baked;
  const source = raw as Record<string, unknown>;

  const apiKey = nonEmptyString(source['apiKey']);
  if (apiKey !== undefined) baked.apiKey = apiKey;
  const enhancelyBase = nonEmptyString(source['enhancelyBase']);
  if (enhancelyBase !== undefined) baked.enhancelyBase = enhancelyBase;
  const timeoutMs = positiveNumber(source['timeoutMs']);
  if (timeoutMs !== undefined) baked.timeoutMs = timeoutMs;
  const cacheTtlMs = positiveNumber(source['cacheTtlMs']);
  if (cacheTtlMs !== undefined) baked.cacheTtlMs = cacheTtlMs;
  if (typeof source['autoRegister'] === 'boolean') baked.autoRegister = source['autoRegister'];
  const originTimeoutMs = positiveNumber(source['originTimeoutMs']);
  if (originTimeoutMs !== undefined) baked.originTimeoutMs = originTimeoutMs;
  const ssmParameterName = nonEmptyString(source['ssmParameterName']);
  if (ssmParameterName !== undefined) baked.ssmParameterName = ssmParameterName;
  const ssmRegion = nonEmptyString(source['ssmRegion']);
  if (ssmRegion !== undefined) baked.ssmRegion = ssmRegion;
  const ssmTimeoutMs = positiveNumber(source['ssmTimeoutMs']);
  if (ssmTimeoutMs !== undefined) baked.ssmTimeoutMs = ssmTimeoutMs;

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

async function resolveOnce(): Promise<InjectorConfig | null> {
  try {
    const baked = bakedOverride !== undefined ? bakedOverride : readBakedConfig();
    resolvedOriginTimeoutMs = baked?.originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;

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
          'non-empty SSM parameter was found — every response passes through UNINJECTED until ' +
          'this execution environment is recycled'
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
    // SSM unreachable / denied / timed out / SDK missing — fail open, retry
    // on the next execution environment (cold start).
    console.error(
      '[enhancely-lambda-edge] config resolution FAILED — every response passes through ' +
        'UNINJECTED until this execution environment is recycled:',
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
  memo ??= resolveOnce();
  return memo;
}

/**
 * Timeout for the origin re-fetch (`originTimeoutMs` from the baked config,
 * default 2000 ms). Only meaningful after `resolveAdapterConfig()` settled —
 * exactly the order the handler uses.
 */
export function getOriginTimeoutMs(): number {
  return resolvedOriginTimeoutMs;
}

/* ------------------------------------------------------------------------ */
/* Test seams (no-ops in production — nothing calls them)                     */
/* ------------------------------------------------------------------------ */

/** TEST-ONLY: bypass the connector-config.json file read (`null` = no file). */
export function __setBakedConfigForTests(baked: BakedConnectorConfig | null): void {
  bakedOverride = baked;
  memo = null;
}

/** TEST-ONLY: extra fields merged into the resolved config (e.g. `fetchImpl`). */
export function __setConfigOverridesForTests(overrides: Partial<InjectorConfig> | null): void {
  configOverrides = overrides;
  memo = null;
}

/** TEST-ONLY: restore pristine module state. */
export function __resetAdapterConfigForTests(): void {
  bakedOverride = undefined;
  configOverrides = null;
  memo = null;
  resolvedOriginTimeoutMs = DEFAULT_ORIGIN_TIMEOUT_MS;
}
