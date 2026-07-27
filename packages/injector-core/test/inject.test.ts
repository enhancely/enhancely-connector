import { describe, expect, it } from 'vitest';

import { buildScriptTag, injectIntoHead } from '../src/index.js';

const SNIPPET = '<script type="application/ld+json">{"@type":"Thing"}</script>';

describe('buildScriptTag', () => {
  it('wraps the raw JSON-LD string verbatim in a ld+json script tag', () => {
    const raw = '{"@context":"https://schema.org","name":"A \\u003c B"}';
    expect(buildScriptTag(raw)).toBe(`<script type="application/ld+json">${raw}</script>`);
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
    const html = '<head>a</head><head>b</head>';
    expect(injectIntoHead(html, SNIPPET)).toBe(`<head>a${SNIPPET}</head><head>b</head>`);
  });

  it('matches </HEAD> case-insensitively', () => {
    const html = '<HTML><HEAD></HEAD><BODY></BODY></HTML>';
    expect(injectIntoHead(html, SNIPPET)).toBe(`<HTML><HEAD>${SNIPPET}</HEAD><BODY></BODY></HTML>`);
  });

  it("matches the whitespace variant '</head >'", () => {
    const html = '<head></head >';
    expect(injectIntoHead(html, SNIPPET)).toBe(`<head>${SNIPPET}</head >`);
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

  it('skips a literal </head> inside an HTML comment', () => {
    const html = '<head><!-- </head> --></head><body></body>';
    expect(injectIntoHead(html, SNIPPET)).toBe(
      `<head><!-- </head> -->${SNIPPET}</head><body></body>`
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

  it('does not treat <scripty…> as a script opener (word boundary)', () => {
    const html = '<head><scripty></scripty></head>';
    expect(injectIntoHead(html, SNIPPET)).toBe(`<head><scripty></scripty>${SNIPPET}</head>`);
  });
});
