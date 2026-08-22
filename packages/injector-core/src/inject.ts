/**
 * String-based injection for adapters without a streaming rewriter
 * (Lambda@Edge, sidecar). The Cloudflare adapter uses HTMLRewriter instead —
 * same intent: snippet becomes the last child of <head>. Unlike a real
 * parser, this path scans the raw string, so it explicitly skips `</head>`
 * occurrences that are inert text rather than the real end tag: inside a
 * raw-text element (script/style/title/noframes), inside a safely validated
 * head-level `noscript`, inside an
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
/**
 * Attribute-safe rendering of an ETag for the `data-etag` marker: the
 * surrounding quotes and any weak prefix are presentation noise (the Kirby
 * plugin strips them the same way), and the remainder is HTML-escaped
 * defensively — RFC 9110 limits ETags to printable ASCII without `"`, but a
 * third-party header value must not be able to break out of the attribute.
 */
function etagAttributeValue(etag: string): string {
  return etag
    .replace(/^W\//i, '')
    .replace(/^"|"$/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

export function buildScriptTag(jsonldRaw: string, etag?: string | null): string {
  const safe = jsonldRaw.replace(/</g, '\\u003c');
  // `data-source` + `data-etag` mirror the Kirby plugin's markup so every
  // integration exposes the same debugging surface: the page source alone
  // answers "which record version is in this (possibly CDN-cached) copy?".
  // Deliberately NO `data-status`: the connector only injects after a
  // successful lookup, so it would always read 200 — noise, not signal.
  const etagAttr = etag ? ` data-etag="${etagAttributeValue(etag)}"` : '';
  return `<script type="application/ld+json" data-source="Enhancely.ai"${etagAttr}>${safe}</script>`;
}

/**
 * Elements whose content the HTML parser treats as raw (or escapable raw)
 * text: a literal `</head>` inside them is inert text, not a tag. Only the
 * element's own end tag terminates the span.
 */
const RAW_TEXT_ELEMENTS = ['script', 'style', 'title', 'noframes'] as const;

/** Void metadata elements the HTML tree builder accepts while "in head". */
const HEAD_VOID_ELEMENTS = ['base', 'basefont', 'bgsound', 'link', 'meta'] as const;

/** Tokens that remain in the head when scripting-disabled `noscript` is parsed. */
const NOSCRIPT_VOID_ELEMENTS = ['basefont', 'bgsound', 'link', 'meta'] as const;
const NOSCRIPT_RAW_TEXT_ELEMENTS = ['style', 'noframes'] as const;

/** `<plaintext>` consumes the rest of the document; it has no HTML end tag. */
const PLAINTEXT_ELEMENT = 'plaintext';

/**
 * Index just past the `>` that closes the start/end tag beginning at `start`
 * (which must point at `<`), skipping `>` only while the HTML tokenizer is in
 * a quoted attribute VALUE. A quote in a tag/attribute name is ordinary
 * parse-error data and must not hide the real closing `>`.
 */
function endOfTag(html: string, start: number): number {
  type State =
    | 'tag-name'
    | 'before-attribute-name'
    | 'attribute-name'
    | 'after-attribute-name'
    | 'before-attribute-value'
    | 'attribute-value-double'
    | 'attribute-value-single'
    | 'attribute-value-unquoted'
    | 'after-attribute-value-quoted'
    | 'self-closing-start-tag';

  let state: State = 'tag-name';
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i] ?? '';
    const whitespace = /[\t\n\f\r ]/.test(char);

    switch (state) {
      case 'tag-name':
        if (whitespace) state = 'before-attribute-name';
        else if (char === '/') state = 'self-closing-start-tag';
        else if (char === '>') return i + 1;
        break;
      case 'before-attribute-name':
        if (whitespace) break;
        if (char === '/') state = 'self-closing-start-tag';
        else if (char === '>') return i + 1;
        else state = 'attribute-name';
        break;
      case 'attribute-name':
        if (whitespace) state = 'after-attribute-name';
        else if (char === '/') state = 'self-closing-start-tag';
        else if (char === '=') state = 'before-attribute-value';
        else if (char === '>') return i + 1;
        break;
      case 'after-attribute-name':
        if (whitespace) break;
        if (char === '/') state = 'self-closing-start-tag';
        else if (char === '=') state = 'before-attribute-value';
        else if (char === '>') return i + 1;
        else state = 'attribute-name';
        break;
      case 'before-attribute-value':
        if (whitespace) break;
        if (char === '"') state = 'attribute-value-double';
        else if (char === "'") state = 'attribute-value-single';
        else if (char === '>') return i + 1;
        else state = 'attribute-value-unquoted';
        break;
      case 'attribute-value-double':
        if (char === '"') state = 'after-attribute-value-quoted';
        break;
      case 'attribute-value-single':
        if (char === "'") state = 'after-attribute-value-quoted';
        break;
      case 'attribute-value-unquoted':
        if (whitespace) state = 'before-attribute-name';
        else if (char === '>') return i + 1;
        break;
      case 'after-attribute-value-quoted':
        if (whitespace) state = 'before-attribute-name';
        else if (char === '/') state = 'self-closing-start-tag';
        else if (char === '>') return i + 1;
        else {
          state = 'before-attribute-name';
          i -= 1; // reconsume the parse-error byte in the new state
        }
        break;
      case 'self-closing-start-tag':
        if (char === '>') return i + 1;
        state = 'before-attribute-name';
        i -= 1; // reconsume exactly as the HTML tokenizer does
        break;
    }
  }
  return -1;
}

/** End of a WHATWG comment, including the `--!>` parse-error closer. */
function endOfComment(html: string, start: number): number {
  // These two parse-error forms close inside their opener. No other closer
  // may overlap the four-byte `<!--` opener (`<!--!>` stays unterminated).
  if (html.startsWith('<!-->', start)) return start + 5;
  if (html.startsWith('<!--->', start)) return start + 6;

  // One forward pass is important: two independent `indexOf` calls would
  // rescan the entire remaining document for every short comment when one of
  // the two closer shapes is absent.
  for (let index = start + 4; index < html.length - 1; index += 1) {
    if (html[index] !== '-' || html[index + 1] !== '-') continue;
    if (html[index + 2] === '>') return index + 3;
    if (html[index + 2] === '!' && html[index + 3] === '>') return index + 4;
  }
  return -1;
}

/** The tokenizer recognizes the DOCTYPE keyword before validating its name boundary. */
function startsDoctype(html: string, start: number): boolean {
  return (
    html
      .slice(start, start + '<!doctype'.length)
      .replace(/[A-Z]/g, (char) => char.toLowerCase()) === '<!doctype'
  );
}

/**
 * HTML token boundary used by the structural scanners. Unlike normal start
 * tags, the tokenizer terminates a DOCTYPE at the first `>` even while it is
 * inside a quoted PUBLIC/SYSTEM identifier (the abrupt-doctype state).
 */
function endOfStructuralToken(html: string, start: number): number {
  if (startsDoctype(html, start)) {
    const end = html.indexOf('>', start + 2);
    return end < 0 ? -1 : end + 1;
  }
  return endOfTag(html, start);
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
    if (after === undefined || !/[\t\n\f\r />]/.test(after)) {
      from = close + needle.length;
      continue;
    }

    // The HTML tokenizer has escaped and double-escaped SCRIPT states. After
    // `<!-- ... <script`, the first lexical `</script>` can merely leave the
    // double-escaped state instead of closing the element. A plain `<!--`
    // without a nested script opener remains in the escaped state, where an
    // end tag still closes the element. Implementing every tokenizer state
    // would defeat this deliberately small scanner, so the exact shape that
    // can enter double-escaped mode is conservatively uninjectable.
    // Search only the current raw-text span, after finding its boundary-valid
    // closer once. This keeps both many false close prefixes in one script and
    // many separate scripts linear in the document size.
    if (tag === 'script') {
      const rawTextSpan = lower.slice(start, close);
      const escaped = rawTextSpan.indexOf('<!--');
      if (escaped >= 0) {
        let nested = rawTextSpan.indexOf('<script', escaped + 4);
        while (nested >= 0) {
          if (startsElement(rawTextSpan, nested, 'script')) return -1;
          nested = rawTextSpan.indexOf('<script', nested + 7);
        }
      }
    }

    return endOfTag(html, close);
  }

  return -1;
}

/** True when `start` begins an opening tag with exactly this tag name. */
function startsElement(lower: string, start: number, tag: string): boolean {
  const prefix = `<${tag}`;
  if (!lower.startsWith(prefix, start)) return false;
  const after = lower[start + prefix.length];
  return after !== undefined && /[\t\n\f\r />]/.test(after);
}

/** True when the complete tag span is a plain `</head>` end tag. */
function isHeadCloseTag(html: string, start: number, end: number): boolean {
  return /^<\/head[\t\n\f\r ]*>$/i.test(html.slice(start, end));
}

/**
 * Name of a plain ASCII end tag, or null for markup this deliberately small
 * scanner cannot prove is an end tag. The HTML tree builder ignores ordinary
 * stray end tags while it is "in head"; recognizing the conservative subset
 * here avoids rejecting otherwise injectable markup such as `</p>`.
 */
function plainEndTagName(lower: string, start: number, end: number): string | null {
  return /^<\/([a-z][a-z0-9:-]*)[\t\n\f\r ]*>$/.exec(lower.slice(start, end))?.[1] ?? null;
}

/**
 * Validate a head-level `<noscript>` for both HTML parser scripting modes.
 * With scripting enabled its contents are raw text. With scripting disabled,
 * however, a body token or non-whitespace text pops `noscript` and can then
 * implicitly close the document head. Accept only the metadata subset that
 * remains in-head in both modes; malformed/ambiguous content fails open.
 */
function endOfSafeHeadNoscript(html: string, lower: string, contentStart: number): number {
  const needle = '</noscript';
  let close = lower.indexOf(needle, contentStart);
  while (close >= 0) {
    const after = html[close + needle.length];
    if (after !== undefined && /[\t\n\f\r />]/.test(after)) break;
    close = lower.indexOf(needle, close + needle.length);
  }
  if (close < 0) return -1;

  const closeEnd = endOfTag(html, close);
  if (closeEnd < 0) return -1;

  let i = contentStart;
  while (i < close) {
    const lt = html.indexOf('<', i);
    const textEnd = lt < 0 || lt >= close ? close : lt;
    if (/[^\t\n\f\r ]/.test(html.slice(i, textEnd))) return -1;
    if (textEnd === close) return closeEnd;

    if (lower.startsWith('<!--', lt)) {
      const commentEnd = endOfComment(html, lt);
      if (commentEnd < 0 || commentEnd > close) return -1;
      i = commentEnd;
      continue;
    }

    const tagEnd = endOfStructuralToken(html, lt);
    if (tagEnd < 0 || tagEnd > close) return -1;

    const endTagName = plainEndTagName(lower, lt, tagEnd);
    if (endTagName !== null) {
      // In "in head noscript", every end tag except `br` and the matching
      // `noscript` is ignored. The matching closer is the boundary above.
      if (endTagName === 'br' || endTagName === 'noscript') return -1;
      i = tagEnd;
      continue;
    }

    if (startsDoctype(html, lt)) {
      i = tagEnd;
      continue;
    }

    if (NOSCRIPT_VOID_ELEMENTS.some((element) => startsElement(lower, lt, element))) {
      i = tagEnd;
      continue;
    }

    const raw = NOSCRIPT_RAW_TEXT_ELEMENTS.find((element) => startsElement(lower, lt, element));
    if (raw !== undefined) {
      const rawEnd = endOfRawTextElement(html, lower, raw, tagEnd);
      if (rawEnd < 0 || rawEnd > close) return -1;
      i = rawEnd;
      continue;
    }

    return -1;
  }

  return closeEnd;
}

/**
 * Index of the first real `</head>`, or null. A single left-to-right pass that
 * treats the markup structurally, so a literal `</head>` is ignored when it is
 * inert text: inside an HTML comment, inside a raw-text element
 * (script/style/title/noframes), a safe head-level `noscript`, OR inside
 * a quoted attribute value of any tag (e.g. `<meta content="… </head> …">`).
 * A close tag is accepted only after an actual `<head>` opener; an orphaned
 * `</head>` in body text is never an injection point. Any non-metadata token
 * that would make the HTML parser implicitly leave the head (including SVG,
 * MathML, body content, or non-whitespace text) fails open instead of using a
 * later source-level closer. `<template>` and `<plaintext>` are likewise
 * conservative vetoes rather than partial parser implementations.
 */
export function findHeadInjectionPoint(html: string): number | null {
  // HTML tag names are ASCII-case-insensitive. Unicode lower-casing can change
  // string length (`İ` → `i` + combining dot) and would make every subsequent
  // index point at the wrong byte/character in the original source.
  const lower = html.replace(/[A-Z]/g, (char) => char.toLowerCase());
  let sawHeadOpen = false;
  let sawBodyOpen = false;
  let sawHtmlOpen = false;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return null;

    // In the HTML "in head" insertion mode, non-whitespace character tokens
    // pop the head element and are reprocessed in the body. A later literal
    // </head> is then orphaned and cannot be our insertion point.
    const textBeforeTag = html.slice(i, lt);
    const structuralText =
      i === 0 && textBeforeTag.startsWith('\uFEFF') ? textBeforeTag.slice(1) : textBeforeTag;
    if (/[^\t\n\f\r ]/.test(structuralText)) return null;

    if (lower.startsWith('<!--', lt)) {
      const end = endOfComment(html, lt);
      if (end < 0) return null; // unterminated comment → no real </head> follows
      i = end;
      continue;
    }

    const tagEnd = endOfStructuralToken(html, lt);
    if (tagEnd < 0) return null; // unterminated tag
    const endTagName = plainEndTagName(lower, lt, tagEnd);

    if (isHeadCloseTag(html, lt, tagEnd)) {
      if (sawHeadOpen) return lt;
      // In the HTML "before head" insertion mode, `</head>` first creates an
      // implicit head and then closes it. A later lexical `<head>…</head>` is
      // therefore not a second real document head and cannot be our target.
      return null;
    }

    if (startsElement(lower, lt, 'head')) {
      if (sawBodyOpen || sawHeadOpen) return null;
      sawHeadOpen = true;
      i = tagEnd;
      continue;
    }

    // An explicit body opener implicitly closes an unclosed head in the HTML
    // parser. Any later source `</head>` is therefore orphaned body markup.
    if (startsElement(lower, lt, 'body')) {
      if (sawHeadOpen) return null;
      sawBodyOpen = true;
      i = tagEnd;
      continue;
    }

    // Before an explicit document head, the HTML tree builder permits only
    // comments, whitespace, a doctype and the outer <html> element. Any
    // foreign/body token (notably SVG/MathML CDATA containing a lexical
    // <head>) can put the parser in a different insertion mode, so a later
    // source-level </head> is not proof of an injectable document head.
    if (!sawHeadOpen) {
      if (startsElement(lower, lt, 'html')) {
        if (sawBodyOpen || sawHtmlOpen) return null;
        sawHtmlOpen = true;
        i = tagEnd;
        continue;
      }
      if (startsDoctype(html, lt)) {
        if (sawBodyOpen) return null;
        i = tagEnd;
        continue;
      }
      // In both "before html" and "before head", ordinary end tags are parse
      // errors that the tree builder ignores. The four special names below
      // instead create/close an implicit head and are already rejected (head)
      // or must remain conservative (body/html/br).
      if (
        endTagName !== null &&
        endTagName !== 'head' &&
        endTagName !== 'body' &&
        endTagName !== 'html' &&
        endTagName !== 'br'
      ) {
        i = tagEnd;
        continue;
      }
      return null;
    }

    // Template contents use their own parser insertion mode. A source-level
    // `</head>` inside a template is not the document head's close tag. Be
    // conservative instead of implementing the complete template stack.
    if (startsElement(lower, lt, 'template')) return null;

    // Per the HTML parsing model, plaintext has no effective closing tag. A
    // later `</head>` is text, even if the source spells `</plaintext>` first.
    if (startsElement(lower, lt, PLAINTEXT_ELEMENT)) return null;

    // `noscript` is raw text only when scripting is enabled. With scripting
    // disabled it has its own tree-builder mode, so validate the content for
    // both interpretations before skipping to its matching closer.
    if (startsElement(lower, lt, 'noscript')) {
      const closeEnd = endOfSafeHeadNoscript(html, lower, tagEnd);
      if (closeEnd < 0) return null;
      i = closeEnd;
      continue;
    }

    if (endTagName !== null) {
      // In the HTML "in head" insertion mode, body/html/br end tags take the
      // "anything else" path and implicitly close the head. A template end
      // tag has separate stack-sensitive rules; because this scanner does not
      // implement that stack, keep it as a conservative veto. Every other
      // plain stray end tag is a parse error that the tree builder ignores.
      if (
        endTagName === 'head' ||
        endTagName === 'body' ||
        endTagName === 'html' ||
        endTagName === 'br' ||
        endTagName === 'template'
      ) {
        return null;
      }
      i = tagEnd;
      continue;
    }

    // Raw-text element open (`<script`, `<style`, …)? Its end tag terminates it.
    let raw: (typeof RAW_TEXT_ELEMENTS)[number] | null = null;
    for (const t of RAW_TEXT_ELEMENTS) {
      if (startsElement(lower, lt, t)) {
        raw = t;
        break;
      }
    }

    if (raw !== null) {
      const closeEnd = endOfRawTextElement(html, lower, raw, tagEnd);
      if (closeEnd < 0) return null; // unterminated raw-text span → no real </head>
      i = closeEnd;
    } else if (
      sawHeadOpen &&
      HEAD_VOID_ELEMENTS.some((element) => startsElement(lower, lt, element))
    ) {
      i = tagEnd;
    } else if (sawHeadOpen) {
      // Any other token (foreign content such as <svg>/<math>, body elements,
      // declarations, or end-tag syntax we cannot prove safe) may make the
      // browser leave the document head. Decline rather than splice into
      // inert/body content.
      return null;
    }
  }
  return null;
}

/**
 * Insert `snippet` immediately before the first `</head>` (case-insensitive)
 * that lies outside raw-text elements, comments and attribute values, and only
 * after a real `<head>` opener. No safe point → HTML is returned unchanged
 * (fail-open, never guess).
 */
export function injectIntoHead(
  html: string,
  snippet: string,
  injectionPoint: number | null = findHeadInjectionPoint(html)
): string {
  const index = injectionPoint;
  if (index === null || index < 0 || index >= html.length) return html;
  const tagEnd = endOfTag(html, index);
  if (tagEnd < 0 || !isHeadCloseTag(html, index, tagEnd)) return html;
  return html.slice(0, index) + snippet + html.slice(index);
}
