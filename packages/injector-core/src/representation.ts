/**
 * True when Content-Disposition makes a response a download rather than a
 * document we may rewrite. Multiple field instances are commonly comma-joined
 * by Fetch/Node; any attachment member vetoes injection. Although duplicate
 * Content-Disposition is formally invalid, abstaining is the only fail-open
 * choice because clients disagree about first/last-value handling.
 */
export function isAttachmentDisposition(value: string | null | undefined): boolean {
  return /(?:^|,)\s*attachment(?:\s*;|\s*(?:,|$))/i.test(value ?? '');
}
