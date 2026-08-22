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

  it('does not treat Unicode whitespace as HTTP optional whitespace', () => {
    expect(charsetOf('text/html; charset=\u00a0utf-8')).toBe('\u00a0utf-8');
    expect(charsetOf('text/html; \u00a0charset=utf-8')).toBeNull();
    expect(charsetOf('text/html; charset="utf-8"\u00a0')).toBeNull();
  });

  it('ignores charset decoys inside quoted Content-Type parameters', () => {
    expect(charsetOf('text/html; profile="a; charset=utf-8"; charset=windows-1252')).toBe(
      'windows-1252'
    );
    expect(charsetOf('text/html; profile="a; charset=windows-1252"; charset="UTF-8"')).toBe(
      'utf-8'
    );
    expect(charsetOf('text/html; profile="a; charset=utf-8"')).toBeNull();
    expect(charsetOf('text/html; profile="a\\"; charset=utf-8"; charset=us-ascii')).toBe(
      'us-ascii'
    );
  });

  it('recognizes ASCII, BOM, and UTF-8 meta evidence', () => {
    expect(containsOnlyAscii(encode('<head></head>'))).toBe(true);
    expect(containsOnlyAscii(encode('ü'))).toBe(false);
    expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe(true);
    expect(declaresUtf8MetaInPrescan(encode('<meta charset="utf-8">'))).toBe(true);
    expect(declaresUtf8MetaInPrescan(encode('<!-- <meta charset="utf-8"> -->'))).toBe(false);
  });

  it.each(['<!-->', '<!--->'])(
    'recognizes the abruptly closed comment %s before later comment-end decoys',
    (comment) => {
      expect(
        declaresUtf8MetaInPrescan(
          encode(`${comment}<meta charset=utf-8><link title="later --> marker">`)
        )
      ).toBe(true);
      expect(
        declaresUtf8MetaInPrescan(
          encode(
            `${comment}<meta charset=windows-1252><link title="later --> marker"><meta charset=utf-8>`
          )
        )
      ).toBe(false);
    }
  );

  it('skips quoted tag attributes but follows the browser byte-prescan through raw text', () => {
    expect(declaresUtf8MetaInPrescan(encode('<link title="<meta charset=utf-8>">'))).toBe(false);
    expect(declaresUtf8MetaInPrescan(encode("<div title='<meta charset=utf-8>'>"))).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<link title="<meta charset=utf-8>"><meta title=">" charset="utf-8">')
      )
    ).toBe(true);
    expect(declaresUtf8MetaInPrescan(encode('<script>"<meta charset=utf-8>"</script>'))).toBe(true);
  });

  it('does not resynchronize malformed attributes into a fake UTF-8 declaration', () => {
    expect(declaresUtf8MetaInPrescan(encode('<meta =charset=utf-8>'))).toBe(false);
    expect(declaresUtf8MetaInPrescan(encode('<meta ==charset=utf-8>'))).toBe(false);
    expect(declaresUtf8MetaInPrescan(encode('<meta charset=utf-8"x">'))).toBe(false);
    expect(declaresUtf8MetaInPrescan(encode('<meta charset=utf-8/ >'))).toBe(false);
    expect(declaresUtf8MetaInPrescan(encode('<meta x\' ><!-- <meta charset="utf-8"> -->\'>'))).toBe(
      false
    );
    expect(
      declaresUtf8MetaInPrescan(
        encode("<div x' ><link title='foo > <meta charset=\"utf-8\"> bar'>")
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(encode("<?x' ><link title='foo > <meta charset=\"utf-8\"> bar'>"))
    ).toBe(false);
  });

  it('uses the distinct WHATWG meta-content syntax without HTTP backslash escapes', () => {
    expect(
      declaresUtf8MetaInPrescan(
        encode('<meta http-equiv=content-type content="text/html; charset=utf-8">')
      )
    ).toBe(true);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<meta http-equiv=content-type content=\'text/html; charset="utf\\-8"\'>')
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<meta http-equiv=" content-type " content="text/html; charset=utf-8">')
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode(
          '<meta http-equiv=content-type content=\'text/html; profile="a; charset=windows-1252"; charset=utf-8\'>'
        )
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<meta http-equiv=content-type content="text/html; charset=\'utf-8\'">')
      )
    ).toBe(true);
    expect(
      declaresUtf8MetaInPrescan(encode('<meta http-equiv=content-type content="foocharset=utf-8">'))
    ).toBe(true);
  });

  it('never lets a later UTF-8 meta override an earlier encoding candidate', () => {
    expect(
      declaresUtf8MetaInPrescan(encode('<meta charset=windows-1252><meta charset=utf-8>'))
    ).toBe(false);
    expect(declaresUtf8MetaInPrescan(encode('<meta charset=bogus><meta charset=utf-8>'))).toBe(
      false
    );
    expect(
      declaresUtf8MetaInPrescan(
        encode(
          "<meta http-equiv=content-type content='text/html; charset=iso-8859-1'><meta charset=utf-8>"
        )
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<script><meta charset=windows-1252></script><meta charset=utf-8>')
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<title><meta charset=windows-1252></title><meta charset=utf-8>')
      )
    ).toBe(false);
    expect(
      declaresUtf8MetaInPrescan(
        encode('<style><meta charset=windows-1252></style><meta charset=utf-8>')
      )
    ).toBe(false);
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

  it('does not let a quoted charset decoy override the real legacy encoding', () => {
    expect(
      isUtf8SafeHtmlBytes(
        encode('<p>ü</p>'),
        'text/html; profile="a; charset=utf-8"; charset=windows-1252'
      )
    ).toBe(false);
  });
});
