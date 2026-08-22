/**
 * True when X-Robots-Tag contains a complete `noindex` or `none` directive.
 * Multiple header values may be joined with commas before calling. Bot-scoped
 * directives are deliberately conservative: skipping injection is safer than
 * decorating a representation hidden from any crawler.
 */
const VALUE_BEARING_ROBOTS_DIRECTIVES = new Set([
  'max-image-preview',
  'max-snippet',
  'max-video-preview',
  'unavailable_after',
]);

export function blocksIndexing(xRobotsTag: string | null | undefined): boolean {
  if (xRobotsTag === null || xRobotsTag === undefined) return false;

  // These directives take a colon-delimited VALUE. In particular,
  // `max-image-preview: none` forbids image previews but does not prevent page
  // indexing. A global regex for the token "none" cannot distinguish that
  // value from the standalone `none` directive (noindex + nofollow).
  return xRobotsTag.split(',').some((rawClause) => {
    const clause = rawClause.trim();
    if (clause === '') return false;

    // `noindex` is not a value of any supported parameterized rule, so every
    // complete occurrence wins, including bot-scoped and malformed
    // whitespace/semicolon-joined forms.
    if (/(?:^|[\s:;])noindex(?=$|[\s:;])/i.test(clause)) return true;

    // Inspect every complete `none`. It is non-blocking only when it is the
    // immediate colon value of a known value-bearing directive. This keeps
    // `max-image-preview: none` legal while preserving an earlier standalone
    // `none` in malformed values such as `none; max-image-preview: none`.
    const nonePattern = /(?:^|[\s:;])(none)(?=$|[\s;])/gi;
    for (const match of clause.matchAll(nonePattern)) {
      const noneAt = (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0);
      let cursor = noneAt - 1;
      while (cursor >= 0 && /[\t\n\f\r ]/.test(clause[cursor] ?? '')) cursor -= 1;
      if (clause[cursor] !== ':') return true;

      cursor -= 1;
      while (cursor >= 0 && /[\t\n\f\r ]/.test(clause[cursor] ?? '')) cursor -= 1;
      const keyEnd = cursor + 1;
      while (cursor >= 0 && /[A-Za-z0-9_-]/.test(clause[cursor] ?? '')) cursor -= 1;
      const key = clause.slice(cursor + 1, keyEnd).toLowerCase();
      if (!VALUE_BEARING_ROBOTS_DIRECTIVES.has(key)) return true;
    }

    return false;
  });
}
