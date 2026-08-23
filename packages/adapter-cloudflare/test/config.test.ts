import { describe, expect, it } from 'vitest';
import { parsePositiveInt } from '../src/index.js';

describe('parsePositiveInt', () => {
  it.each([
    ['800', 800],
    ['000800', 800],
    ['1', 1],
  ])('accepts exact positive decimal integer %j', (value, expected) => {
    expect(parsePositiveInt(value)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '0',
    '-1',
    '1.9',
    '800ms',
    '1e3',
    ' 800',
    '800 ',
    '2147483648',
    '4294967296',
    '9007199254740992',
  ])('rejects malformed or unsafe value %j', (value) => {
    expect(parsePositiveInt(value)).toBeUndefined();
  });

  it('accepts the largest timer-safe millisecond value', () => {
    expect(parsePositiveInt('2147483647')).toBe(2_147_483_647);
  });
});
