/**
 * Split an HTTP field value on one delimiter while preserving delimiters
 * inside RFC quoted strings. Backslash quoted-pairs keep the next byte inside
 * the current string. Slices remain untrimmed for the caller's field grammar.
 */
function splitHttpQuotedValue(
  value: string,
  delimiter: string
): { parts: string[]; balanced: boolean } {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return { parts, balanced: !quoted };
}

/** HTTP optional whitespace is exactly SP / HTAB, never Unicode whitespace. */
export function trimHttpOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, '');
}

/**
 * True when a comma occurs inside an HTTP quoted-string. Fetch-only runtimes
 * fold duplicate field instances before exposing them; in that environment a
 * quoted comma may be either legitimate data or the folded boundary between
 * two individually malformed instances, so strict gates must abstain.
 */
export function hasCommaInsideHttpQuotes(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (!quoted) {
      if (char === '"') quoted = true;
      continue;
    }
    // In a folded Fetch value the inserted boundary comma can itself follow a
    // terminal backslash from the preceding malformed field instance. It is
    // still ambiguous even though a single-field parser sees a quoted-pair.
    if (char === ',') return true;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') quoted = false;
  }
  return false;
}

export function splitOutsideHttpQuotes(value: string, delimiter: string): string[] {
  return splitHttpQuotedValue(value, delimiter).parts;
}

/**
 * Strict counterpart for response gates. An unterminated quoted-string makes
 * a field value ambiguous, so callers that decide whether bytes may be
 * rewritten must fail closed instead of treating the rest as harmless data.
 */
export function splitOutsideHttpQuotesStrict(value: string, delimiter: string): string[] | null {
  const parsed = splitHttpQuotedValue(value, delimiter);
  return parsed.balanced ? parsed.parts : null;
}
