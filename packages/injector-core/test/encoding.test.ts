import { describe, expect, it } from 'vitest';

import {
  charsetOf,
  containsOnlyAscii,
  declaresUtf8MetaInPrescan,
  hasUtf8Bom,
  isUtf8SafeHtmlBytes,
  isValidUtf8,
} from '../src/index.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('HTML encoding safety', () => {
  it('parses charset parameters case-insensitively', () => {
    expect(charsetOf('text/html; Charset="UTF-8"')).toBe('utf-8');
    expect(charsetOf('text/html')).toBeNull();
  });

  it('recognizes ASCII, BOM, and UTF-8 meta evidence', () => {
    expect(containsOnlyAscii(encode('<head></head>'))).toBe(true);
    expect(containsOnlyAscii(encode('ü'))).toBe(false);
    expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe(true);
    expect(declaresUtf8MetaInPrescan(encode('<meta charset="utf-8">'))).toBe(true);
    expect(declaresUtf8MetaInPrescan(encode('<!-- <meta charset="utf-8"> -->'))).toBe(false);
  });

  it('strictly rejects malformed UTF-8', () => {
    expect(isValidUtf8(new Uint8Array([0xc3, 0x28]))).toBe(false);
    expect(isUtf8SafeHtmlBytes(new Uint8Array([0xc3, 0x28]), 'text/html; charset=utf-8')).toBe(
      false
    );
  });

  it('requires positive evidence when no charset is declared', () => {
    expect(isUtf8SafeHtmlBytes(encode('<html><head></head></html>'), 'text/html')).toBe(true);
    expect(isUtf8SafeHtmlBytes(encode('<meta charset="utf-8"><p>ü</p>'), 'text/html')).toBe(true);
    expect(isUtf8SafeHtmlBytes(encode('<p>ü</p>'), 'text/html')).toBe(false);
  });

  it('honors strict ASCII labels and rejects legacy charsets', () => {
    expect(isUtf8SafeHtmlBytes(encode('<p>plain</p>'), 'text/html; charset=us-ascii')).toBe(true);
    expect(isUtf8SafeHtmlBytes(encode('<p>ü</p>'), 'text/html; charset=us-ascii')).toBe(false);
    expect(isUtf8SafeHtmlBytes(encode('<p>plain</p>'), 'text/html; charset=windows-1252')).toBe(
      false
    );
  });
});
