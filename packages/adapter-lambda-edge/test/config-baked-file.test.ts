/**
 * The REAL baked-file read path (`bakedCache`), which production executes but
 * every other test bypasses via the `__setBakedConfigForTests` override seam:
 * a `connector-config.json` on disk under LAMBDA_TASK_ROOT must feed
 * getExcludePaths/getAssertedDefaultTtlSeconds, be read at most once per
 * environment, and be forgotten after the reset seam runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAdapterConfigForTests,
  getAssertedDefaultTtlSeconds,
  getExcludePaths,
  resolveAdapterConfig,
} from '../src/config.js';

let dir: string;
const previousTaskRoot = process.env['LAMBDA_TASK_ROOT'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connector-baked-'));
  process.env['LAMBDA_TASK_ROOT'] = dir;
  __resetAdapterConfigForTests();
});

afterEach(() => {
  if (previousTaskRoot === undefined) {
    delete process.env['LAMBDA_TASK_ROOT'];
  } else {
    process.env['LAMBDA_TASK_ROOT'] = previousTaskRoot;
  }
  rmSync(dir, { recursive: true, force: true });
  __resetAdapterConfigForTests();
});

describe('baked file read path (no test seam)', () => {
  it('serves excludePaths synchronously from the file, before any resolution', () => {
    writeFileSync(
      join(dir, 'connector-config.json'),
      JSON.stringify({ excludePaths: ['/account/*', '/login'], assertedDefaultTtlSeconds: 3600 })
    );
    expect(getExcludePaths()).toEqual(['/account/*', '/login']);
  });

  it('feeds assertedDefaultTtlSeconds through resolution, including with a baked key', async () => {
    writeFileSync(
      join(dir, 'connector-config.json'),
      JSON.stringify({ apiKey: 'sk-baked-test', assertedDefaultTtlSeconds: 3600 })
    );
    const config = await resolveAdapterConfig();
    expect(config?.apiKey).toBe('sk-baked-test');
    expect(getAssertedDefaultTtlSeconds()).toBe(3600);
  });

  it('memoizes the file read and forgets it on reset', () => {
    const file = join(dir, 'connector-config.json');
    writeFileSync(file, JSON.stringify({ excludePaths: ['/a'] }));
    expect(getExcludePaths()).toEqual(['/a']);

    // A rewrite without reset is invisible (one read per environment) …
    writeFileSync(file, JSON.stringify({ excludePaths: ['/b'] }));
    expect(getExcludePaths()).toEqual(['/a']);

    // … and visible again after the reset seam clears the memo.
    __resetAdapterConfigForTests();
    expect(getExcludePaths()).toEqual(['/b']);
  });

  it('ignores junk values in the file without throwing', () => {
    writeFileSync(
      join(dir, 'connector-config.json'),
      JSON.stringify({ excludePaths: [1, '', '/ok'], assertedDefaultTtlSeconds: -5 })
    );
    expect(getExcludePaths()).toEqual(['/ok']);
    expect(getAssertedDefaultTtlSeconds()).toBe(0);
  });
});
