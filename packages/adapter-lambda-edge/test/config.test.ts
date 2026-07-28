import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_FILE_NAME,
  DEFAULT_SSM_PARAMETER_NAME,
  DEFAULT_SSM_REGION,
  __resetAdapterConfigForTests,
  __setBakedConfigForTests,
  getConfigRetryInMs,
  getOriginTimeoutMs,
  resolveAdapterConfig,
} from '../src/config.js';

interface MockSendOptions {
  abortSignal?: AbortSignal;
}

/**
 * Mock @aws-sdk/client-ssm. config.ts imports it DYNAMICALLY, which vitest's
 * module registry intercepts all the same.
 */
const ssm = vi.hoisted(() => ({
  send: vi.fn<(command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>>(),
  clientConfigs: [] as Array<{ region?: string; maxAttempts?: number }>,
}));

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {
    constructor(config: { region?: string; maxAttempts?: number }) {
      ssm.clientConfigs.push(config);
    }
    send(command: unknown, options?: MockSendOptions): Promise<unknown> {
      return ssm.send(command, options);
    }
  }
  class GetParameterCommand {
    constructor(readonly input: { Name: string; WithDecryption: boolean }) {}
  }
  return { SSMClient, GetParameterCommand };
});

beforeEach(() => {
  ssm.send.mockReset();
  ssm.clientConfigs.length = 0;
  __resetAdapterConfigForTests();
});

afterEach(() => {
  __resetAdapterConfigForTests();
  vi.restoreAllMocks();
  vi.useRealTimers(); // no-op unless a test opted into fake timers
});

describe('resolveAdapterConfig — baked config', () => {
  it('uses the baked apiKey and never contacts SSM', async () => {
    __setBakedConfigForTests({
      apiKey: 'sk-baked',
      enhancelyBase: 'https://api.example.test',
      timeoutMs: 500,
      cacheTtlMs: 60_000,
      originTimeoutMs: 3_000,
    });

    const config = await resolveAdapterConfig();

    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe('sk-baked');
    expect(config?.enhancelyBase).toBe('https://api.example.test');
    expect(config?.timeoutMs).toBe(500);
    expect(config?.cacheTtlMs).toBe(60_000);
    expect(getOriginTimeoutMs()).toBe(3_000);
    expect(ssm.send).not.toHaveBeenCalled();
  });

  it('baked apiKey takes precedence over SSM even when ssmParameterName is set', async () => {
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-from-ssm' } });
    __setBakedConfigForTests({ apiKey: 'sk-baked', ssmParameterName: '/custom/param' });

    const config = await resolveAdapterConfig();

    expect(config?.apiKey).toBe('sk-baked');
    expect(ssm.send).not.toHaveBeenCalled();
  });
});

describe('resolveAdapterConfig — SSM', () => {
  it('falls back to SSM with defaults when there is no baked apiKey', async () => {
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-from-ssm' } });
    __setBakedConfigForTests(null); // no connector-config.json at all

    const config = await resolveAdapterConfig();

    expect(config?.apiKey).toBe('sk-from-ssm');
    expect(ssm.send).toHaveBeenCalledTimes(1);
    const command = ssm.send.mock.calls[0]?.[0] as {
      input: { Name: string; WithDecryption: boolean };
    };
    expect(command.input).toEqual({ Name: DEFAULT_SSM_PARAMETER_NAME, WithDecryption: true });
    expect(ssm.clientConfigs).toEqual([{ region: DEFAULT_SSM_REGION, maxAttempts: 2 }]);
    // Every SSM call is BOUNDED — an unbounded hang would ride the invocation
    // into the Lambda timeout (viewer-facing 502 instead of fail-open).
    expect(ssm.send.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('honors baked ssmParameterName and ssmRegion', async () => {
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-from-ssm' } });
    __setBakedConfigForTests({ ssmParameterName: '/acme/key', ssmRegion: 'eu-west-1' });

    const config = await resolveAdapterConfig();

    expect(config?.apiKey).toBe('sk-from-ssm');
    const command = ssm.send.mock.calls[0]?.[0] as { input: { Name: string } };
    expect(command.input.Name).toBe('/acme/key');
    expect(ssm.clientConfigs[0]?.region).toBe('eu-west-1');
  });

  it('a hung GetParameter is aborted after ssmTimeoutMs → cooldown null (pass-through)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A send that NEVER settles on its own — only the abort signal ends it.
    ssm.send.mockImplementation(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'TimeoutError'))
          );
        })
    );
    __setBakedConfigForTests({ ssmTimeoutMs: 50 });

    expect(await resolveAdapterConfig()).toBeNull();
    expect(await resolveAdapterConfig()).toBeNull(); // cooldown, no immediate second hang
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('memoizes: concurrent invocations share ONE GetParameter call', async () => {
    let release!: (value: unknown) => void;
    ssm.send.mockReturnValue(new Promise((resolve) => (release = resolve)));
    __setBakedConfigForTests(null);

    // Simulate concurrent invocations of one execution environment.
    const first = resolveAdapterConfig();
    const second = resolveAdapterConfig();
    const third = resolveAdapterConfig();
    release({ Parameter: { Value: 'sk-shared' } });

    const configs = await Promise.all([first, second, third]);
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(configs[0]?.apiKey).toBe('sk-shared');
    // Same memoized resolution → same object.
    expect(configs[1]).toBe(configs[0]);
    expect(configs[2]).toBe(configs[0]);
  });

  it('memoizes across sequential invocations too', async () => {
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-from-ssm' } });
    __setBakedConfigForTests(null);

    await resolveAdapterConfig();
    await resolveAdapterConfig();

    expect(ssm.send).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAdapterConfig — no key resolvable', () => {
  it('returns null and logs ONE loud error when SSM fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ssm.send.mockRejectedValue(new Error('AccessDeniedException'));
    __setBakedConfigForTests(null);

    expect(await resolveAdapterConfig()).toBeNull();
    expect(await resolveAdapterConfig()).toBeNull(); // cooldown — no immediate retry or re-log

    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain('30 seconds');
  });

  it('returns null when the SSM parameter exists but is empty', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ssm.send.mockResolvedValue({ Parameter: { Value: '' } });
    __setBakedConfigForTests({});

    expect(await resolveAdapterConfig()).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAdapterConfig — negative-result cooldown (failure not cached forever)', () => {
  it('within the cooldown a failure is NOT retried, but after 30s the next call re-invokes SSM', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // First resolution throws (SSM error) → null; later the key is available.
    ssm.send
      .mockRejectedValueOnce(new Error('AccessDeniedException'))
      .mockResolvedValue({ Parameter: { Value: 'sk-later' } });
    __setBakedConfigForTests(null); // no baked key → SSM is the only source

    // First resolution fails → null, exactly one SSM call.
    expect(await resolveAdapterConfig()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(getConfigRetryInMs()).toBe(30_000);

    // Second immediate call: inside the cooldown → still null, NO new SSM call.
    expect(await resolveAdapterConfig()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(1);

    // Advance past NEGATIVE_TTL_MS (30_000 ms): the next call RE-invokes SSM,
    // and the key is now available → a real config.
    vi.advanceTimersByTime(30_001);
    const config = await resolveAdapterConfig();
    expect(config?.apiKey).toBe('sk-later');
    expect(getConfigRetryInMs()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(2);

    // The now-successful config is memoized: no further SSM reads.
    expect((await resolveAdapterConfig())?.apiKey).toBe('sk-later');
    expect(ssm.send).toHaveBeenCalledTimes(2);
    // Only the single failure was logged (not the cooldown short-circuit).
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('holds the cooldown right up to the 30s boundary, then retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ssm.send.mockResolvedValue({ Parameter: { Value: '' } }); // parameter empty → null key
    __setBakedConfigForTests(null);

    expect(await resolveAdapterConfig()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(1);

    // One ms before the cooldown expires: still no retry.
    vi.advanceTimersByTime(29_999);
    expect(await resolveAdapterConfig()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(1);

    // Crossing the boundary: SSM is retried (still null — parameter still empty).
    vi.advanceTimersByTime(2);
    expect(await resolveAdapterConfig()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(2);
  });

  it('a SUCCESSFUL resolution is cached — no cooldown, no second SSM read', async () => {
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-ok' } });
    __setBakedConfigForTests(null);

    const first = await resolveAdapterConfig();
    const second = await resolveAdapterConfig();

    expect(first?.apiKey).toBe('sk-ok');
    expect(second).toBe(first); // same memoized object
    expect(ssm.send).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAdapterConfig — placeholder / non-sk- key guard', () => {
  it('a baked apiKey that is not an sk- key (SSM placeholder REPLACE_ME) → null (pass-through)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    __setBakedConfigForTests({ apiKey: 'REPLACE_ME' });

    expect(await resolveAdapterConfig()).toBeNull();
    // The guard fires BEFORE any SSM contact (the key was baked).
    expect(ssm.send).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });

  it('an SSM value that is not an sk- key (REPLACE_ME) → null (pass-through)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ssm.send.mockResolvedValue({ Parameter: { Value: 'REPLACE_ME' } });
    __setBakedConfigForTests(null); // no baked key → SSM supplies the placeholder

    expect(await resolveAdapterConfig()).toBeNull();
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('an sk-org- key passes the guard', async () => {
    __setBakedConfigForTests({ apiKey: 'sk-org-real' });
    const config = await resolveAdapterConfig();
    expect(config?.apiKey).toBe('sk-org-real');
  });
});

/**
 * The REAL file-read path (no `__setBakedConfigForTests` seam): a
 * connector-config.json written to disk and located via LAMBDA_TASK_ROOT —
 * exactly how customer deployments resolve the baked key.
 */
describe('resolveAdapterConfig — real connector-config.json file read', () => {
  let dir: string;
  const savedTaskRoot = process.env['LAMBDA_TASK_ROOT'];

  const writeConfigFile = (content: string): void => {
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), content);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enhancely-baked-'));
    // First candidate directory in readBakedConfig — deterministic hit.
    process.env['LAMBDA_TASK_ROOT'] = dir;
  });

  afterEach(() => {
    if (savedTaskRoot === undefined) delete process.env['LAMBDA_TASK_ROOT'];
    else process.env['LAMBDA_TASK_ROOT'] = savedTaskRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a valid file from LAMBDA_TASK_ROOT and never contacts SSM', async () => {
    writeConfigFile(
      JSON.stringify({
        apiKey: 'sk-from-file',
        enhancelyBase: 'https://api.example.test',
        originTimeoutMs: 4321,
      })
    );

    const config = await resolveAdapterConfig();

    expect(config?.apiKey).toBe('sk-from-file');
    expect(config?.enhancelyBase).toBe('https://api.example.test');
    expect(getOriginTimeoutMs()).toBe(4321);
    expect(ssm.send).not.toHaveBeenCalled();
  });

  it('unparsable file → loud error, still falls back to SSM (never crashes the edge)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-from-ssm' } });
    writeConfigFile('{ this is not JSON');

    const config = await resolveAdapterConfig();

    expect(config?.apiKey).toBe('sk-from-ssm');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('wrong-typed junk fields are dropped; well-typed fields survive', async () => {
    ssm.send.mockResolvedValue({ Parameter: { Value: 'sk-from-ssm' } });
    writeConfigFile(
      JSON.stringify({
        apiKey: 123, // junk → dropped → SSM fallback
        timeoutMs: '500', // junk → dropped
        cacheTtlMs: -5, // junk → dropped
        ssmParameterName: '/from-file/key', // well-typed → used
        originTimeoutMs: 1234, // well-typed → used
      })
    );

    const config = await resolveAdapterConfig();

    expect(config?.apiKey).toBe('sk-from-ssm');
    const command = ssm.send.mock.calls[0]?.[0] as { input: { Name: string } };
    expect(command.input.Name).toBe('/from-file/key');
    expect(getOriginTimeoutMs()).toBe(1234);
  });
});
