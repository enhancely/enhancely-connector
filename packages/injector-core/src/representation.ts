import { splitOutsideHttpQuotesStrict, trimHttpOws } from './header-value.js';

export type HttpFieldValue = string | readonly string[] | null | undefined;

function fieldInstances(value: HttpFieldValue): readonly string[] {
  if (value === null || value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

/**
 * True only for the exact `text/html` media type after stripping parameters.
 * Prefix checks would wrongly accept values such as `text/htmlx`.
 */
export function isHtmlMediaType(value: HttpFieldValue): boolean {
  const instances = fieldInstances(value);
  if (instances.length !== 1) return false;
  const fieldValues = splitOutsideHttpQuotesStrict(instances[0] ?? '', ',');
  if (fieldValues === null || fieldValues.length !== 1) return false;
  const parameters = splitOutsideHttpQuotesStrict(fieldValues[0] ?? '', ';');
  return parameters !== null && trimHttpOws(parameters[0] ?? '').toLowerCase() === 'text/html';
}

const HTTP_TOKEN_AT_START = /^[\t ]*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)/;
const COMPLETE_HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function leadingHttpToken(value: string): string | null {
  return HTTP_TOKEN_AT_START.exec(value)?.[1]?.toLowerCase() ?? null;
}

/** True when Cache-Control contains a complete `no-transform` directive. */
function instanceHasNoTransformDirective(value: string): boolean {
  // Ambiguous malformed fields must veto rewriting. In particular, treating
  // an unterminated quoted-string as a benign extension could hide a real
  // directive in bytes that a downstream cache parses differently.
  if (splitOutsideHttpQuotesStrict(value, ',') === null) return true;

  // Besides the normal comma separator, recognize ASCII whitespace and `;`
  // as conservative recovery boundaries. Real intermediaries do this for
  // malformed Cache-Control values. Quoted values remain opaque, and a token
  // on the right-hand side of `=` is never promoted to a directive.
  let quoted = false;
  let escaped = false;
  let start = 0;
  const inspect = (end: number): boolean => {
    let tokenStart = start;
    // Never scan beyond the slice being inspected. Without this bound, every
    // whitespace delimiter in a long malformed value rescans the entire
    // suffix, turning this response gate quadratic.
    while (tokenStart < end && /^[\t\n\f\r ]$/.test(value[tokenStart] ?? '')) tokenStart += 1;
    if (tokenStart >= end) return false;

    let previous = tokenStart - 1;
    while (previous >= 0 && /^[\t\n\f\r ]$/.test(value[previous] ?? '')) previous -= 1;
    if (value[previous] === '=') return false;
    return leadingHttpToken(value.slice(tokenStart, end)) === 'no-transform';
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',' || char === ';' || /^[\t\n\f\r ]$/.test(char)) {
      if (inspect(index)) return true;
      start = index + 1;
    }
  }
  return inspect(value.length);
}

export function hasNoTransformDirective(value: HttpFieldValue): boolean {
  return fieldInstances(value).some(instanceHasNoTransformDirective);
}

/**
 * True when Content-Disposition can make a response a download rather than a
 * document we may rewrite. RFC 6266 says unknown disposition types should be
 * handled like `attachment`, so exact `inline` is the only token that permits
 * rewriting. Every field instance is quote-validated independently before its
 * list members are inspected; any non-inline member vetoes injection. Empty or
 * token-less invalid values are ignored like an absent header.
 */
export function isAttachmentDisposition(value: HttpFieldValue): boolean {
  return fieldInstances(value).some((instance) => {
    const members = splitOutsideHttpQuotesStrict(instance, ',');
    if (members === null) return true;
    return members.some((member) => {
      const parameters = splitOutsideHttpQuotesStrict(member, ';');
      if (parameters === null) return true;
      const disposition = trimHttpOws(parameters[0] ?? '');
      return COMPLETE_HTTP_TOKEN.test(disposition) && disposition.toLowerCase() !== 'inline';
    });
  });
}
