/**
 * String-based injection for adapters without a streaming rewriter
 * (Lambda@Edge, sidecar). The Cloudflare adapter uses HTMLRewriter instead —
 * same intent: snippet becomes the last child of <head>. Unlike a real
 * parser, this path scans the raw string, so it explicitly skips `</head>`
 * occurrences that are inert text rather than the real end tag: inside a
 * raw-text element (script/style/title/textarea/noscript), inside an
 * `<!-- … -->` comment, or inside a quoted attribute value (e.g.
 * `<meta content="… </head> …">`). Injecting at any of those would corrupt
 * valid markup.
 */

/**
 * Wrap the raw JSON-LD string in its script tag.
 *
 * The Enhancely API already returns the body script-safe (every `<` sent as
 * the JSON unicode escape `<`), so in the happy path there is nothing to
 * escape. We nonetheless re-escape any literal `<` defensively — the connector
 * must not rely SOLELY on an upstream (a third-party, possibly staging,
 * endpoint) having done it: a response containing `</script><script>…` would
 * otherwise become arbitrary JavaScript in the customer's origin. The escape
 * is idempotent (no literal `<` in the happy path → no-op) and byte-preserving
 * for valid content, and mirrors the server's own `escapeJsonForScriptEmbedding`.
 */
export function buildScriptTag(jsonldRaw: string): string {
  const safe = jsonldRaw.replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${safe}</script>`;
}

/**
 * Elements whose content the HTML parser treats as raw (or escapable raw)
 * text: a literal `</head>` inside them is inert text, not a tag. Only the
 * element's own end tag terminates the span.
 */
const RAW_TEXT_ELEMENTS = ['script', 'style', 'title', 'textarea', 'noscript'] as const;

const HEAD_CLOSE = /^<\/head\s*>/i;

/**
 * Index just past the `>` that closes the start/end tag beginning at `start`
 * (which must point at `<`), skipping `>` inside quoted attribute values.
 * Returns -1 for an unterminated tag.
 */
function endOfTag(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Index just past a raw-text element's real end tag, or -1. Matching the tag
 * name as a mere prefix is not enough: HTML only recognizes it when the next
 * character is whitespace, `/`, or `>`.
 */
function endOfRawTextElement(
  html: string,
  lower: string,
  tag: (typeof RAW_TEXT_ELEMENTS)[number],
  start: number
): number {
  const needle = `</${tag}`;
  let from = start;

  while (from < html.length) {
    const close = lower.indexOf(needle, from);
    if (close < 0) return -1;

    const after = html[close + needle.length];
    if (after !== undefined && /[\t\n\f\r />]/.test(after)) {
      return endOfTag(html, close);
    }

    from = close + needle.length;
  }

  return -1;
}

/**
 * Index of the first real `</head>`, or -1. A single left-to-right pass that
 * treats the markup structurally, so a literal `</head>` is ignored when it is
 * inert text: inside an HTML comment, inside a raw-text element
 * (script/style/title/textarea/noscript), OR inside a quoted attribute value of
 * any tag (e.g. `<meta content="… </head> …">`). Injecting at any of those
 * would corrupt valid markup.
 */
function findHeadCloseIndex(html: string): number {
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return -1;

    if (lower.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return -1; // unterminated comment → no real </head> follows
      i = end + 3;
      continue;
    }

    if (HEAD_CLOSE.test(html.slice(lt, lt + 32))) return lt;

    // Raw-text element open (`<script`, `<style`, …)? Its end tag terminates it.
    let raw: (typeof RAW_TEXT_ELEMENTS)[number] | null = null;
    for (const t of RAW_TEXT_ELEMENTS) {
      if (lower.startsWith(`<${t}`, lt)) {
        const after = html[lt + 1 + t.length];
        if (after === undefined || /[\s/>]/.test(after)) {
          raw = t;
          break;
        }
      }
    }

    const tagEnd = endOfTag(html, lt);
    if (tagEnd < 0) return -1; // unterminated tag
    if (raw !== null) {
      const closeEnd = endOfRawTextElement(html, lower, raw, tagEnd);
      if (closeEnd < 0) return -1; // unterminated raw-text span → no real </head>
      i = closeEnd;
    } else {
      i = tagEnd;
    }
  }
  return -1;
}

/**
 * Insert `snippet` immediately before the first `</head>` (case-insensitive)
 * that lies outside <script> elements and HTML comments. No such `</head>`
 * (including when it only appears inside an unterminated script/comment) →
 * HTML is returned unchanged (fail-open, never guess).
 */
export function injectIntoHead(html: string, snippet: string): string {
  const index = findHeadCloseIndex(html);
  if (index < 0) return html;
  return html.slice(0, index) + snippet + html.slice(index);
}
