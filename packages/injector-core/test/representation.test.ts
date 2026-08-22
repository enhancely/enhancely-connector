import { describe, expect, it } from 'vitest';
import {
  hasNoTransformDirective,
  isAttachmentDisposition,
  isHtmlMediaType,
} from '../src/representation.js';

describe('isHtmlMediaType', () => {
  it.each([
    ['text/html', true],
    ['text/html; charset=utf-8', true],
    [' TEXT/HTML ; charset=UTF-8', true],
    ['text/html; profile="one,two"', true],
    ['text/html, application/json', false],
    ['text/html, text/html', false],
    ['text/html; profile="unterminated', false],
    [['text/html; profile="unterminated', 'application/json"'], false],
    [['text/html', 'text/html'], false],
    ['\u00a0text/html', false],
    ['\vtext/html', false],
    ['text/htmlx', false],
    ['application/xhtml+xml', false],
    [null, false],
    [undefined, false],
  ])('%s → %s', (value, expected) => {
    expect(isHtmlMediaType(value)).toBe(expected);
  });
});

describe('hasNoTransformDirective', () => {
  it.each(['no-transform', 'public, no-transform', 'NO-TRANSFORM', 'no-transform=value'])(
    'matches the complete directive in %s',
    (value) => expect(hasNoTransformDirective(value)).toBe(true)
  );

  it.each([
    'public no-transform',
    'public;no-transform',
    'public\tno-transform',
    'public\nno-transform',
    'public, ext="unterminated',
  ])('conservatively vetoes malformed policy %s', (value) => {
    expect(hasNoTransformDirective(value)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    'x-no-transform',
    'foo=no-transform',
    'foo = no-transform',
    'foo= no-transform',
    'no-transformable',
  ])('does not substring-match %s', (value) => expect(hasNoTransformDirective(value)).toBe(false));

  it.each([
    'public, ext="alpha, no-transform, omega", max-age=60',
    'public, ext="alpha no-transform omega", max-age=60',
    'public, ext="alpha\\", no-transform, omega", max-age=60',
  ])('ignores no-transform text inside a quoted directive value: %s', (value) => {
    expect(hasNoTransformDirective(value)).toBe(false);
  });

  it('scans a maximum-size whitespace-only extension in linear time', () => {
    // This adversarial field used to rescan the remaining suffix at every
    // delimiter. Keeping it near the Lambda header budget makes the ordinary
    // test timeout a deterministic regression guard without timing asserts.
    expect(hasNoTransformDirective(`public,${' '.repeat(32 * 1024)}`)).toBe(false);
  });

  it('does not let separate malformed field instances heal each other', () => {
    expect(hasNoTransformDirective(['public, ext="unterminated', 'no-transform"'])).toBe(true);
  });
});

describe('isAttachmentDisposition', () => {
  it.each([
    'attachment',
    'attachment; filename="page.html"',
    'inline, attachment; filename="page.html"',
    'INLINE, ATTACHMENT',
    'x-download; filename="page.html"',
    'form-data; name="page"',
  ])('blocks every download-capable disposition member: %s', (value) => {
    expect(isAttachmentDisposition(value)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    'inline',
    'inline; filename="page.html"',
    'filename=page.html',
    'inline@invalid',
    '"attachment"',
    '\u00a0inline',
  ])('allows non-attachment dispositions: %s', (value) => {
    expect(isAttachmentDisposition(value)).toBe(false);
  });

  it.each([
    'inline; filename="report, attachment; draft.html"',
    'inline; filename="report, attachment, draft.html"',
    'inline; filename="report\\", attachment, draft.html"',
  ])('ignores attachment text inside a quoted parameter: %s', (value) => {
    expect(isAttachmentDisposition(value)).toBe(false);
  });

  it('still catches a real comma-joined attachment after a quoted filename', () => {
    expect(isAttachmentDisposition('inline; filename="report, draft.html", attachment')).toBe(true);
  });

  it.each(['inline; filename="unterminated', 'inline; filename="escaped\\'])(
    'conservatively vetoes an unbalanced quoted-string: %s',
    (value) => expect(isAttachmentDisposition(value)).toBe(true)
  );

  it('does not let separate malformed field instances hide attachment', () => {
    expect(isAttachmentDisposition(['inline; filename="unterminated', 'attachment"'])).toBe(true);
  });
});
