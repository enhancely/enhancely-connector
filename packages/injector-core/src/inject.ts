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
 * Tokens that matter while scanning for the real `</head>`: comment
 * open/close, script open/close, head close. Per the HTML spec only
 * `</script` terminates script content and only `-->` terminates a comment;
 * inside those spans every other token is inert text.
 */
const SCAN_TOKEN = /<!--|-->|<script\b|<\/script\s*>|<\/head\s*>/gi;

/** Index of the first `</head>` outside script/comment spans, or -1. */
function findHeadCloseIndex(html: string): number {
  let inScript = false;
  let inComment = false;
  for (const match of html.matchAll(SCAN_TOKEN)) {
    const token = match[0].toLowerCase();
    if (inComment) {
      if (token === '-->') inComment = false;
    } else if (inScript) {
      if (token.startsWith('</script')) inScript = false;
    } else if (token === '<!--') {
      inComment = true;
    } else if (token === '<script') {
      inScript = true;
    } else if (token.startsWith('</head')) {
      return match.index ?? -1;
    }
    // A stray `-->` / `</script>` outside its span is inert — ignored.
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
