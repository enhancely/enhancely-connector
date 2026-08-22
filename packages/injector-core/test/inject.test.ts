import { describe, expect, it } from 'vitest';

import { buildScriptTag, findHeadInjectionPoint, injectIntoHead } from '../src/index.js';

const SNIPPET =
  '<script type="application/ld+json" data-source="Enhancely.ai">{"@type":"Thing"}</script>';

describe('buildScriptTag', () => {
  it('wraps the raw JSON-LD string verbatim in a ld+json script tag', () => {
    const raw = '{"@context":"https://schema.org","name":"A \\u003c B"}';
    expect(buildScriptTag(raw)).toBe(
      `<script type="application/ld+json" data-source="Enhancely.ai">${raw}</script>`
    );
  });
});

describe('injectIntoHead', () => {
  it('injects immediately before the first </head>', () => {
    const html = '<html><head><title>t</title></head><body>x</body></html>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<html><head><title>t</title>${SNIPPET}</head><body>x</body></html>`
    );
  });

  it('only touches the FIRST </head> when several appear', () => {
    const html = '<head><title>a</title></head><head><title>b</title></head>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><title>a</title>${SNIPPET}</head><head><title>b</title></head>`
    );
  });

  it('matches </HEAD> case-insensitively', () => {
    const html = '<HTML><HEAD></HEAD><BODY></BODY></HTML>';
    expect(injectIntoHead(html, SNIPPET)).toBe(`<HTML><HEAD>${SNIPPET}</HEAD><BODY></BODY></HTML>`);
  });

  it("matches the whitespace variant '</head >'", () => {
    const html = '<head></head >';
    expect(injectIntoHead(html, SNIPPET)).toBe(`<head>${SNIPPET}</head >`);
  });

  it.each([
    '<!DOCTYPE html PUBLIC "x><head><title>real</title></head>"><head><title>fake</title></head>',
    "<!DOCTYPE html SYSTEM 'x><head><title>real</title></head>'><head><title>fake</title></head>",
  ])('ends malformed quoted DOCTYPE identifiers at the tokenizer first >: %s', (html) => {
    const firstHeadClose = html.indexOf('</head>');
    expect(findHeadInjectionPoint(html)).toBe(firstHeadClose);
    expect(injectIntoHead(html, SNIPPET)).toBe(
      html.slice(0, firstHeadClose) + SNIPPET + html.slice(firstHeadClose)
    );
  });

  it.each(['<!DOCTYPEhtml><head></head>', '<!DOCTYPE/html><head></head>'])(
    'recognizes a DOCTYPE even when whitespace before its name is missing: %s',
    (html) => {
      const headClose = html.indexOf('</head>');
      expect(findHeadInjectionPoint(html)).toBe(headClose);
      expect(injectIntoHead(html, SNIPPET)).toBe(
        html.slice(0, headClose) + SNIPPET + html.slice(headClose)
      );
    }
  );

  it('does not hide post-DOCTYPE text behind a source-level identifier quote', () => {
    const html = '<!DOCTYPE html PUBLIC "x>"><head></head><body>x</body>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('returns the HTML unchanged when there is no </head> (fail-open)', () => {
    const html = '<body>no head here</body>';
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('skips a literal </head> inside an inline <script> string', () => {
    const html =
      '<html><head><script>var tpl="...</head>...";</script></head><body>x</body></html>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<html><head><script>var tpl="...</head>...";</script>${SNIPPET}</head><body>x</body></html>`
    );
  });

  it('skips </head> inside a <script> with attributes, case-insensitively', () => {
    const html = '<head><SCRIPT type="text/javascript">a("</HEAD>")</SCRIPT></head>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><SCRIPT type="text/javascript">a("</HEAD>")</SCRIPT>${SNIPPET}</head>`
    );
  });

  it('fails open when a script double-escaped state makes an apparent closer inert', () => {
    const html = '<head><script><!--<script></script></head>--></script></head><body>x</body>';

    // The first </script> only exits the HTML tokenizer's double-escaped
    // state; the following </head> is still script text, not the head closer.
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('scans many false script end-tag prefixes in linear time', () => {
    const falseClosers = '</scriptx>'.repeat(50_000);
    const html = `<head><script>${falseClosers}</script></head><body>x</body>`;
    const realHeadClose = html.indexOf('</head>');

    expect(findHeadInjectionPoint(html)).toBe(realHeadClose);
    expect(injectIntoHead(html, SNIPPET)).toBe(
      html.slice(0, realHeadClose) + SNIPPET + html.slice(realHeadClose)
    );
  });

  it('scans many separate script elements in linear time', () => {
    const scripts = '<script></script>'.repeat(40_000);
    const html = `<head>${scripts}</head><body>x</body>`;
    const realHeadClose = html.indexOf('</head>');

    expect(findHeadInjectionPoint(html)).toBe(realHeadClose);
    expect(injectIntoHead(html, SNIPPET)).toBe(
      html.slice(0, realHeadClose) + SNIPPET + html.slice(realHeadClose)
    );
  });

  it('fails open instead of injecting at an inert </head> inside template contents', () => {
    const html = '<head><template></head></template></head><body>x</body>';

    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it.each(['script', 'style', 'title'])(
    'does not treat </%sx> as the raw-text closing tag',
    (tag) => {
      const html = `<head><${tag}>literal </${tag}x> then </head></${tag}></head>`;
      expect(injectIntoHead(html, SNIPPET)).toBe(
        `<head><${tag}>literal </${tag}x> then </head></${tag}>${SNIPPET}</head>`
      );
    }
  );

  it.each(['textarea', 'iframe', 'xmp', 'noembed'])(
    'fails open when the body element <%s> implicitly closes the head',
    (tag) => {
      const html = `<head><${tag}>literal </head> text</${tag}></head><body>x</body>`;
      expect(findHeadInjectionPoint(html)).toBeNull();
      expect(injectIntoHead(html, SNIPPET)).toBe(html);
    }
  );

  it('fails open for foreign-content CDATA whose </head> is inert', () => {
    const html = '<html><head><svg><![CDATA[x > </head> y]]></svg></head><body>x</body></html>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('fails open for foreign-content CDATA before an apparent document head', () => {
    const html = '<html><svg><![CDATA[x > <head></head> y]]></svg></html>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('fails open when non-whitespace text implicitly closes the head', () => {
    const html = '<html><head>body text</head><body>x</body></html>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('treats everything after <plaintext> as text and fails open', () => {
    const html = '<head><plaintext>literal </head></plaintext></head><body>x</body>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('does not use an orphaned </head> without a real <head> opener', () => {
    const html = '<html><body>stray closer</head><p>x</p></body></html>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('does not use a </head> after <body> implicitly closed the head', () => {
    const html = '<html><head><title>x</title><body>stray closer</head></body></html>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('keeps source indices stable across Unicode with length-changing lowercase forms', () => {
    const html = '<html><!--İ--><HEAD><title>x</title></HEAD><body>x</body></html>';
    expect(findHeadInjectionPoint(html)).toBe(html.indexOf('</HEAD>'));
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<html><!--İ--><HEAD><title>x</title>${SNIPPET}</HEAD><body>x</body></html>`
    );
  });

  it('accepts one leading UTF-8 BOM as an encoding signature', () => {
    const html = '\uFEFF  <html><head><title>x</title></head><body>x</body></html>';
    expect(findHeadInjectionPoint(html)).toBe(html.indexOf('</head>'));
    expect(injectIntoHead(html, SNIPPET)).toContain(`${SNIPPET}</head>`);
  });

  it('rejects a later lexical head after a closer already created an implicit head', () => {
    const html = '</head><html><head><title>x</title></head><body>x</body></html>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('ignores an ordinary stray end tag before the real document head', () => {
    const html = '</p><html><head><title>x</title></head><body>x</body></html>';
    expect(findHeadInjectionPoint(html)).toBe(html.indexOf('</head>'));
    expect(injectIntoHead(html, SNIPPET)).toContain(`${SNIPPET}</head>`);
  });

  it('does not treat non-ASCII whitespace as a raw-text end-tag boundary', () => {
    const html = '<head><script>literal </script\u00a0foo> then </head></script></head>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><script>literal </script\u00a0foo> then </head></script>${SNIPPET}</head>`
    );
  });

  it('skips a literal </head> inside an HTML comment', () => {
    const html = '<head><!-- </head> --></head><body></body>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><!-- </head> -->${SNIPPET}</head><body></body>`
    );
  });

  it('recognizes --!> as a real comment closer before an implicit head close', () => {
    const html = '<head><!-- --!><body> --></head><p>x</p>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('does not let --!> overlap the comment opener', () => {
    const html = '<head><!--!></head>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('scans many separate comments in linear time', () => {
    const comments = '<!---->'.repeat(40_000);
    const html = `<head>${comments}</head><body>x</body>`;
    const realHeadClose = html.indexOf('</head>');

    expect(findHeadInjectionPoint(html)).toBe(realHeadClose);
    expect(injectIntoHead(html, SNIPPET)).toBe(
      html.slice(0, realHeadClose) + SNIPPET + html.slice(realHeadClose)
    );
  });

  it('validates --!> comments inside head noscript under scripting-disabled parsing', () => {
    const html = '<head><noscript><!-- --!><body> --></noscript></head><p>x</p>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('does not let a quote in an attribute name hide the tokenizer first >', () => {
    const html = "<head foo'><body>'></head><p>x</p>";
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it.each(['<head a="v"b="x></head>"></head>', '<head /b="x></head>"></head>'])(
    'reconsumes malformed attribute bytes before choosing the head closer: %s',
    (html) => {
      const realHeadClose = html.lastIndexOf('</head>');
      expect(findHeadInjectionPoint(html)).toBe(realHeadClose);
      expect(injectIntoHead(html, SNIPPET)).toBe(
        html.slice(0, realHeadClose) + SNIPPET + html.slice(realHeadClose)
      );
    }
  );

  it.each([
    '<head><!--><meta content="--> </head>"><title>x</title></head><body>x</body>',
    '<head><!---><script>const marker = "--> </head>";</script></head><body>x</body>',
  ])(
    'does not extend an abruptly closed comment into a later attribute or raw-text marker: %s',
    (html) => {
      const realHeadClose = html.lastIndexOf('</head>');
      expect(findHeadInjectionPoint(html)).toBe(realHeadClose);
      expect(injectIntoHead(html, SNIPPET)).toBe(
        html.slice(0, realHeadClose) + SNIPPET + html.slice(realHeadClose)
      );
    }
  );

  it('accepts an abruptly closed comment inside safe head noscript content', () => {
    const html =
      '<head><noscript><!--><meta content="-->"></noscript><title>x</title></head><body>x</body>';
    const realHeadClose = html.lastIndexOf('</head>');

    expect(findHeadInjectionPoint(html)).toBe(realHeadClose);
    expect(injectIntoHead(html, SNIPPET)).toBe(
      html.slice(0, realHeadClose) + SNIPPET + html.slice(realHeadClose)
    );
  });

  it('ignores <script> and <!-- openers that are themselves inside the other span', () => {
    const html = '<head><script>// <!-- not a comment\nvar x=1;</script><!-- <script> --></head>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><script>// <!-- not a comment\nvar x=1;</script><!-- <script> -->${SNIPPET}</head>`
    );
  });

  it('fails open when </head> only exists inside an unterminated script', () => {
    const html = '<head><script>var tpl="</head>";';
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('fails open when </head> only exists inside a comment', () => {
    const html = '<head><!-- </head> --><body>no real head close</body>';
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('fails open for an unknown <scripty> element that implicitly closes the head', () => {
    const html = '<head><scripty></scripty></head>';
    expect(findHeadInjectionPoint(html)).toBeNull();
    expect(injectIntoHead(html, SNIPPET)).toBe(html);
  });

  it('ignores an ordinary stray end tag while the HTML parser remains in head', () => {
    const html = '<head><link rel="canonical" href="/"></p><title>x</title></head><body>x</body>';

    expect(findHeadInjectionPoint(html)).toBe(html.indexOf('</head>'));
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><link rel="canonical" href="/"></p><title>x</title>${SNIPPET}</head><body>x</body>`
    );
  });

  it('accepts metadata-only noscript content that stays safe in both scripting modes', () => {
    const html =
      '<head><noscript><link rel="stylesheet" href="/no-js.css"></noscriptx></noscript><title>x</title></head>';
    expect(findHeadInjectionPoint(html)).toBe(html.indexOf('</head>'));
    expect(injectIntoHead(html, SNIPPET)).toContain(`${SNIPPET}</head>`);
  });

  it.each(['plain text', '<div>body token</div>'])(
    'fails open for noscript content that can close head when scripting is disabled: %s',
    (content) => {
      const html = `<head><noscript>${content}</noscript><title>x</title></head>`;
      expect(findHeadInjectionPoint(html)).toBeNull();
      expect(injectIntoHead(html, SNIPPET)).toBe(html);
    }
  );

  it.each(['body', 'html', 'br'])(
    'does not ignore </%s>, which implicitly closes an open head',
    (tag) => {
      const html = `<head><link rel="canonical" href="/"></${tag}><title>x</title></head>`;
      expect(findHeadInjectionPoint(html)).toBeNull();
      expect(injectIntoHead(html, SNIPPET)).toBe(html);
    }
  );

  it.each(['svg', 'div', 'template'])(
    'keeps <%s> as a conservative structural veto inside head',
    (tag) => {
      const html = `<head><${tag}></${tag}></head><body>x</body>`;
      expect(findHeadInjectionPoint(html)).toBeNull();
      expect(injectIntoHead(html, SNIPPET)).toBe(html);
    }
  );
});
