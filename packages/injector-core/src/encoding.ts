import { splitOutsideHttpQuotes, trimHttpOws } from './header-value.js';

/** Lower-cased `charset` parameter of a Content-Type value, or null. */
export function charsetOf(contentType: string): string | null {
  const parameters = splitOutsideHttpQuotes(contentType, ';');
  for (let index = 1; index < parameters.length; index += 1) {
    const parameter = parameters[index] ?? '';
    const equalsAt = parameter.indexOf('=');
    if (equalsAt < 0 || trimHttpOws(parameter.slice(0, equalsAt)).toLowerCase() !== 'charset') {
      continue;
    }

    const raw = trimHttpOws(parameter.slice(equalsAt + 1));
    if (!raw.startsWith('"')) return raw.toLowerCase();

    let value = '';
    let escaped = false;
    for (let cursor = 1; cursor < raw.length; cursor += 1) {
      const char = raw[cursor];
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        return trimHttpOws(raw.slice(cursor + 1)) === '' ? value.toLowerCase() : null;
      } else {
        value += char;
      }
    }
    return null;
  }
  return null;
}

/** True when every byte is valid US-ASCII. */
export function containsOnlyAscii(body: Uint8Array): boolean {
  return body.every((byte) => byte <= 0x7f);
}

/** A byte-order mark is unambiguous UTF-8 evidence without parsing HTML. */
export function hasUtf8Bom(body: Uint8Array): boolean {
  return body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
}

function latin1Window(body: Uint8Array): string {
  let value = '';
  const length = Math.min(body.byteLength, 1024);
  for (let i = 0; i < length; i++) value += String.fromCharCode(body[i] ?? 0);
  return value;
}

function htmlTagAt(
  value: string,
  start: number
): { name: string; isEnd: boolean; attributesStart: number } | null {
  let nameStart = start + 1;
  const isEnd = value[nameStart] === '/';
  if (isEnd) nameStart += 1;
  const match = /^[A-Za-z][^\t\n\f\r />]*/.exec(value.slice(nameStart));
  const originalName = match?.[0];
  if (originalName === undefined) return null;
  return {
    name: originalName.toLowerCase(),
    isEnd,
    attributesStart: nameStart + originalName.length,
  };
}

const ASCII_WHITESPACE = /[\t\n\f\r ]/;

function asciiLowerChar(char: string): string {
  const code = char.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : char;
}

/**
 * The HTML encoding prescan's deliberately small "get an attribute" state
 * machine. It is not the HTTP parameter grammar: quotes in an unquoted value
 * are data, a leading `=` belongs to the attribute name, and backslashes never
 * escape a quote. Returning the first duplicate mirrors the browser prescan.
 */
function prescanAttributes(
  value: string,
  start: number
): { attributes: Map<string, string>; end: number } | null {
  const attributes = new Map<string, string>();
  let position = start;

  while (true) {
    while (
      position < value.length &&
      (ASCII_WHITESPACE.test(value[position] ?? '') || value[position] === '/')
    ) {
      position += 1;
    }
    if (position >= value.length) return null;
    if (value[position] === '>') return { attributes, end: position + 1 };

    let name = '';
    let hasEquals = false;
    while (position < value.length) {
      const char = value[position] ?? '';
      if (char === '=' && name !== '') {
        hasEquals = true;
        position += 1;
        break;
      }
      if (ASCII_WHITESPACE.test(char)) {
        while (position < value.length && ASCII_WHITESPACE.test(value[position] ?? '')) {
          position += 1;
        }
        if (value[position] === '=') {
          hasEquals = true;
          position += 1;
        }
        break;
      }
      if (char === '/' || char === '>') break;
      name += asciiLowerChar(char);
      position += 1;
    }

    if (!hasEquals) {
      if (name !== '' && !attributes.has(name)) attributes.set(name, '');
      if (value[position] === '>') return { attributes, end: position + 1 };
      continue;
    }

    while (position < value.length && ASCII_WHITESPACE.test(value[position] ?? '')) {
      position += 1;
    }

    if (position >= value.length) return null;

    let attributeValue = '';
    const quote = value[position];
    if (quote === '"' || quote === "'") {
      position += 1;
      while (position < value.length && value[position] !== quote) {
        attributeValue += asciiLowerChar(value[position] ?? '');
        position += 1;
      }
      if (value[position] !== quote) return null;
      position += 1;
    } else {
      while (
        position < value.length &&
        !ASCII_WHITESPACE.test(value[position] ?? '') &&
        value[position] !== '>'
      ) {
        attributeValue += asciiLowerChar(value[position] ?? '');
        position += 1;
      }
    }

    if (name !== '' && !attributes.has(name)) attributes.set(name, attributeValue);
    if (value[position] === '>') return { attributes, end: position + 1 };
  }
}

/** WHATWG's meta-content syntax: single quotes work; backslash escapes do not. */
function charsetFromMetaContent(content: string): string | null {
  const lower = content.toLowerCase();
  let position = 0;
  while (position < content.length) {
    const match = lower.indexOf('charset', position);
    if (match < 0) return null;
    position = match + 'charset'.length;
    while (position < content.length && ASCII_WHITESPACE.test(content[position] ?? '')) {
      position += 1;
    }
    if (content[position] !== '=') continue;
    position += 1;
    while (position < content.length && ASCII_WHITESPACE.test(content[position] ?? '')) {
      position += 1;
    }
    if (position >= content.length) return null;

    const quote = content[position];
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, position + 1);
      return end < 0 ? null : content.slice(position + 1, end);
    }

    const start = position;
    while (
      position < content.length &&
      !ASCII_WHITESPACE.test(content[position] ?? '') &&
      content[position] !== ';'
    ) {
      position += 1;
    }
    return content.slice(start, position);
  }
  return null;
}

function isUtf8EncodingLabel(value: string | null): boolean {
  const normalized = (value ?? '').replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
  return normalized === 'utf-8' || normalized === 'utf8';
}

/**
 * Positive-only subset of the WHATWG HTML byte prescan. Only a UTF-8 encoding
 * candidate recognized by that prescan in the first 1024 bytes answers true;
 * ambiguous markup remains false so adapters pass the original bytes through.
 * This deliberately follows the byte prescan rather than DOM tokenization:
 * meta-looking bytes in script/style text can influence browser encoding too.
 */
export function declaresUtf8MetaInPrescan(body: Uint8Array): boolean {
  const window = latin1Window(body);
  let cursor = 0;
  while (cursor < window.length) {
    const start = window.indexOf('<', cursor);
    if (start < 0) return false;

    if (window.startsWith('<!--', start)) {
      // The tokenizer also closes the parse-error forms `<!-->` and `<!--->`:
      // their overlapping `-->` begins inside the four-byte opener.
      const commentEnd = window.indexOf('-->', start + 2);
      if (commentEnd < 0) return false;
      cursor = commentEnd + 3;
      continue;
    }

    const tag = htmlTagAt(window, start);
    if (tag === null) {
      // WHATWG's special declaration/end/instruction cases skip to the first
      // `>` regardless of quotes. Any other `<` advances one byte only.
      if (
        window.startsWith('<!', start) ||
        window.startsWith('</', start) ||
        window.startsWith('<?', start)
      ) {
        const end = window.indexOf('>', start + 2);
        if (end < 0) return false;
        cursor = end + 1;
      } else {
        cursor = start + 1;
      }
      continue;
    }

    // Every ASCII start/end tag uses the same attribute states to find its
    // real boundary. Quotes in attribute names and unquoted values are data;
    // only an explicitly quoted value may contain `>`.
    const parsed = prescanAttributes(window, tag.attributesStart);
    if (parsed === null) return false;
    if (tag.isEnd) {
      cursor = parsed.end;
      continue;
    }

    if (tag.name === 'meta') {
      const attrs = parsed.attributes;
      const direct = attrs.get('charset');
      const declared =
        direct !== undefined
          ? direct
          : attrs.get('http-equiv') === 'content-type'
            ? charsetFromMetaContent(attrs.get('content') ?? '')
            : null;
      // The browser commits to the first recognized encoding declaration. We
      // conservatively stop at every syntactic candidate: UTF-8 proves safety;
      // legacy or unknown labels fail closed instead of letting a later UTF-8
      // declaration override the earlier byte-decoding decision.
      if (declared !== null) return isUtf8EncodingLabel(declared);
      cursor = parsed.end;
      continue;
    }

    cursor = parsed.end;
  }
  return false;
}

/** True when the byte sequence decodes as UTF-8 without replacement. */
export function isValidUtf8(body: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prove that decoding and re-emitting an HTML body as UTF-8 is safe.
 *
 * A declared UTF-8 body only needs strict byte validation. ASCII labels also
 * require ASCII bytes. With no charset, positive UTF-8 evidence is required:
 * ASCII-only bytes, a BOM, or a UTF-8 meta declaration in the browser's
 * 1024-byte prescan window. Legacy/ambiguous pages fail open byte-identically
 * and, importantly, can be rejected before an Enhancely request.
 */
export function isUtf8SafeHtmlBytes(body: Uint8Array, contentType: string): boolean {
  const charset = charsetOf(contentType);
  if (charset === 'utf-8' || charset === 'utf8') return isValidUtf8(body);
  if (charset === 'ascii' || charset === 'us-ascii') return containsOnlyAscii(body);
  if (charset !== null) return false;
  return (
    isValidUtf8(body) &&
    (containsOnlyAscii(body) || hasUtf8Bom(body) || declaresUtf8MetaInPrescan(body))
  );
}
