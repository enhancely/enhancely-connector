import { describe, expect, it } from 'vitest';
import { isAttachmentDisposition } from '../src/representation.js';

describe('isAttachmentDisposition', () => {
  it.each([
    'attachment',
    'attachment; filename="page.html"',
    'inline, attachment; filename="page.html"',
    'INLINE, ATTACHMENT',
  ])('blocks every attachment member: %s', (value) => {
    expect(isAttachmentDisposition(value)).toBe(true);
  });

  it.each([null, undefined, '', 'inline', 'inline; filename="page.html"'])(
    'allows non-attachment dispositions: %s',
    (value) => {
      expect(isAttachmentDisposition(value)).toBe(false);
    }
  );
});
