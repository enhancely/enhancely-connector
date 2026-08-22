/** Lower-cased `charset` parameter of a Content-Type value, or null. */
export function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
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

/**
 * Positive-only subset of the WHATWG HTML encoding prescan. Only an actual
 * UTF-8 declaration in the first 1024 bytes answers true; ambiguous markup
 * deliberately remains false so adapters pass the original bytes through.
 */
export function declaresUtf8MetaInPrescan(body: Uint8Array): boolean {
  let window = latin1Window(body);
  window = window.replace(/<!--[\s\S]*?-->/g, ' ');
  const openComment = window.indexOf('<!--');
  if (openComment !== -1) window = window.slice(0, openComment);

  const metaRe = /<meta\b([^>]*)>/gi;
  const attrRe = /([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/g;
  let tag: RegExpExecArray | null;
  while ((tag = metaRe.exec(window)) !== null) {
    const attrs = new Map<string, string>();
    attrRe.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(tag[1] ?? '')) !== null) {
      const name = attr[1]?.toLowerCase() ?? '';
      if (!attrs.has(name)) attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const direct = attrs.get('charset');
    const declared =
      direct !== undefined
        ? direct.trim().toLowerCase()
        : attrs.get('http-equiv')?.trim().toLowerCase() === 'content-type'
          ? charsetOf(attrs.get('content') ?? '')
          : null;
    if (declared === 'utf-8' || declared === 'utf8') return true;
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
