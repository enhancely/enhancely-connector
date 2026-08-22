/**
 * True when X-Robots-Tag contains a complete `noindex` or `none` directive.
 * Multiple header values may be joined with commas before calling. Bot-scoped
 * directives are deliberately conservative: skipping injection is safer than
 * decorating a representation hidden from any crawler.
 */
export function blocksIndexing(xRobotsTag: string | null | undefined): boolean {
  return (
    xRobotsTag !== null &&
    xRobotsTag !== undefined &&
    /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i.test(xRobotsTag)
  );
}
