/**
 * String-based injection for adapters without a streaming rewriter
 * (Lambda@Edge, sidecar). The Cloudflare adapter uses HTMLRewriter instead —
 * same intent: snippet becomes the last child of <head>. Unlike a real
 * parser, this path scans the raw string, so it explicitly skips `</head>`
 * occurrences inside <script>…</script> elements and <!-- … --> comments:
 * a literal "</head>" in an inline script string or a comment is just text
 * and must not attract the snippet (injecting there would break the page's
 * JavaScript and swallow the JSON-LD).
 */

/** Wrap the raw (pre-escaped) JSON-LD string in its script tag. */
export function buildScriptTag(jsonldRaw: string): string {
  return `<script type="application/ld+json">${jsonldRaw}</script>`;
}

/**
 * Elements whose content the HTML parser treats as raw (or escapable raw)
 * text: a literal `</head>` inside them is inert text, not a tag. Only the
 * element's own end tag terminates the span.
 */
const RAW_TEXT_ELEMENTS = ['script', 'style', 'title', 'textarea', 'noscript'] as const;

/**
 * Tokens that matter while scanning for the real `</head>`: comment
 * open/close, raw-text element open/close, head close. Inside a comment only
 * `-->` matters; inside a raw-text element only its own `</tag` matters.
 */
const SCAN_TOKEN = new RegExp(
  ['<!--', '-->', ...RAW_TEXT_ELEMENTS.flatMap((t) => [`<${t}\\b`, `</${t}\\s*>`]), '</head\\s*>']
    .join('|')
    .replace(/[/]/g, '\\/'),
  'gi'
);

/** Index of the first `</head>` outside raw-text/comment spans, or -1. */
function findHeadCloseIndex(html: string): number {
  let inRawText: string | null = null; // tag name whose end tag we await
  let inComment = false;
  for (const match of html.matchAll(SCAN_TOKEN)) {
    const token = match[0].toLowerCase();
    if (inComment) {
      if (token === '-->') inComment = false;
    } else if (inRawText !== null) {
      if (token.startsWith(`</${inRawText}`)) inRawText = null;
    } else if (token === '<!--') {
      inComment = true;
    } else if (token.startsWith('</head')) {
      return match.index ?? -1;
    } else if (!token.startsWith('</')) {
      const open = RAW_TEXT_ELEMENTS.find((t) => token === `<${t}`);
      if (open !== undefined) inRawText = open;
    }
    // Stray end tags / `-->` outside their span are inert — ignored.
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
