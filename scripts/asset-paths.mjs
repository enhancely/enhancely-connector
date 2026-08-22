#!/usr/bin/env node
/**
 * Find the CloudFront path patterns that keep the injector off asset traffic.
 *
 * WHY THIS EXISTS
 * A Lambda@Edge association lives on a cache behavior, and CloudFront picks
 * the behavior by PATH PATTERN alone — never by response Content-Type, which
 * does not exist yet when the behavior is chosen. So the only way to stop the
 * function being invoked for stylesheets, fonts and images is to give those
 * paths their own cache behavior without the association.
 *
 * That is worth doing. On a typical page load the HTML is one request and the
 * assets are dozens, and every one of them currently invokes the function just
 * to be rejected by its extension filter. Three things follow:
 *   - invocations are billed for work that is thrown away,
 *   - every asset request pays a few milliseconds of function time,
 *   - and — the part that actually matters — a Lambda@Edge throttle or crash
 *     on an asset request is a viewer-facing 5xx. Assets that never reach the
 *     function cannot be broken by it.
 *
 * WHAT THIS SCRIPT DOES
 * Fetches one or more pages, collects every asset they reference, and reports
 * the path patterns that would cover them — ranked, with the share of asset
 * requests each one removes, so you can spend CloudFront's 25-behaviors-per-
 * distribution budget where it pays.
 *
 * Usage:
 *   node scripts/asset-paths.mjs https://www.example.com/ [more urls…]
 *   ASSET_PATHS_AUTH='user:pass' node scripts/asset-paths.mjs https://staging…
 *
 * Nothing here touches the connector at runtime; it is an analysis aid.
 */

/**
 * Extensions that are ALWAYS a page on some stack, so a pattern must never
 * capture them. `*.js*` would swallow `.jsp`, `*.as*` would swallow `.aspx` —
 * both are server-rendered HTML, and excluding them from the injector would
 * silently stop injecting real pages. This is why the suggestions below use
 * exact extensions instead of the shorter wildcard groupings.
 */
const PAGE_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'jsp',
  'jspx',
  'asp',
  'aspx',
  'php',
  'phtml',
  'cfm',
  'do',
  'action',
  'shtml',
]);

/** CloudFront's own quota: behaviors per distribution, default. */
const CLOUDFRONT_BEHAVIOR_QUOTA = 25;

/**
 * The extensions the injector itself treats as never-HTML, read from the
 * adapter source at runtime rather than copied here. One source of truth: a
 * pattern this script suggests must be one the function would have rejected
 * anyway, or routing it away would change behaviour rather than just save an
 * invocation. It also keeps junk out of the report — a stray `url(…)` match
 * like `window.location` is not a file type the connector knows.
 */
async function knownNonHtmlExtensions() {
  const source = new URL('../packages/adapter-lambda-edge/src/shared.ts', import.meta.url);
  const text = await readFile(source, 'utf8');
  const match = /export const NON_HTML_EXTENSION =\s*\/\\\.\(\?:([^)]+)\)\$\/i;/.exec(text);
  if (!match) {
    throw new Error(
      'could not read NON_HTML_EXTENSION from the adapter source; refusing unsafe suggestions'
    );
  }
  const set = new Set();
  for (const alternative of match[1].split('|')) {
    // Expand the small regex forms the list uses: jpe?g, woff2?, tiff?, docx?
    const optional = /^([a-z0-9]+)([a-z0-9])\?$/.exec(alternative);
    if (optional) {
      set.add(optional[1]);
      set.add(optional[1] + optional[2]);
      continue;
    }
    const inner = /^([a-z]+)([a-z])\?([a-z]+)$/.exec(alternative);
    if (inner) {
      set.add(inner[1] + inner[3]);
      set.add(inner[1] + inner[2] + inner[3]);
      continue;
    }
    if (/^[a-z0-9]+$/.test(alternative)) set.add(alternative);
  }
  return set;
}

import { readFile } from 'node:fs/promises';

const HTML_ATTR = /(?:src|href|data-src|poster)\s*=\s*["']([^"']+)["']/gi;
const SRCSET = /srcset\s*=\s*["']([^"']+)["']/gi;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

function collectReferences(html) {
  const out = [];
  for (const [, value] of html.matchAll(HTML_ATTR)) out.push(value);
  for (const [, value] of html.matchAll(SRCSET)) {
    for (const candidate of value.split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) out.push(url);
    }
  }
  for (const [, value] of html.matchAll(CSS_URL)) out.push(value);
  return out;
}

function extensionOf(pathname) {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

/** Longest-first prefixes of a path, e.g. /a/b/c.js → /a/b/*, /a/* */
function prefixesOf(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const out = [];
  for (let depth = Math.min(segments.length - 1, 3); depth >= 1; depth--) {
    out.push(`/${segments.slice(0, depth).join('/')}/*`);
  }
  return out;
}

async function fetchPage(url, auth) {
  const headers = { 'user-agent': 'enhancely-asset-paths/1' };
  if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html')) {
    throw new Error(`${url} → ${type || 'no content-type'} (not an HTML page)`);
  }
  return { html: await response.text(), finalUrl: response.url || url };
}

function pad(value, width) {
  return String(value).padEnd(width);
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('usage: node scripts/asset-paths.mjs <page-url> [more urls…]');
    console.error("       ASSET_PATHS_AUTH='user:pass' for basic-auth staging sites");
    process.exit(2);
  }
  const auth = process.env.ASSET_PATHS_AUTH;
  const known = await knownNonHtmlExtensions();

  /** @type {{host: string, pathname: string, ext: string|null}[]} */
  const assets = [];
  let pages = 0;
  const externalHosts = new Set();

  for (const url of urls) {
    let page;
    try {
      page = await fetchPage(url, auth);
    } catch (error) {
      console.error(`  ! ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    pages += 1;
    const base = new URL(page.finalUrl);
    for (const reference of collectReferences(page.html)) {
      if (/^(data|javascript|mailto|tel):/i.test(reference)) continue;
      let resolved;
      try {
        resolved = new URL(reference, base);
      } catch {
        continue;
      }
      const ext = extensionOf(resolved.pathname);
      // Only files with an extension are safely pattern-matchable, and only
      // non-page extensions may be routed away from the injector.
      if (ext === null || PAGE_EXTENSIONS.has(ext)) continue;
      // Only suggest what the injector already rejects by extension.
      if (!known.has(ext)) continue;
      if (resolved.hostname !== base.hostname && !sharesRegistrableSuffix(resolved, base)) {
        externalHosts.add(resolved.hostname);
        continue;
      }
      assets.push({ host: resolved.hostname, pathname: resolved.pathname, ext });
    }
  }

  if (pages === 0) {
    console.error('No page could be analysed.');
    process.exit(1);
  }
  if (assets.length === 0) {
    console.log('No same-site assets with a usable extension were found.');
    return;
  }

  console.log(`\nAnalysed ${pages} page(s); ${assets.length} same-site asset reference(s).\n`);

  // ── Strategy A: path prefixes ───────────────────────────────────────────
  const byPrefix = new Map();
  for (const asset of assets) {
    for (const prefix of prefixesOf(asset.pathname)) {
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
  }
  const prefixes = [...byPrefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  console.log('PATH PREFIXES — usually the cheapest option: few patterns, wide coverage');
  console.log(`  ${pad('pattern', 44)}${pad('assets', 8)}share`);
  for (const [pattern, count] of prefixes) {
    const share = Math.round((count / assets.length) * 100);
    console.log(`  ${pad(pattern, 44)}${pad(count, 8)}${share}%`);
  }

  // ── Strategy B: exact extensions ────────────────────────────────────────
  const byExt = new Map();
  for (const asset of assets) byExt.set(asset.ext, (byExt.get(asset.ext) ?? 0) + 1);
  const extensions = [...byExt.entries()].sort((a, b) => b[1] - a[1]);

  console.log('\nEXTENSIONS — safe but pattern-hungry (one behavior each)');
  console.log(`  ${pad('pattern', 44)}${pad('assets', 8)}cumulative`);
  let running = 0;
  for (const [ext, count] of extensions) {
    running += count;
    const cumulative = Math.round((running / assets.length) * 100);
    console.log(`  ${pad(`*.${ext}`, 44)}${pad(count, 8)}${cumulative}%`);
  }

  // ── Recommendation ──────────────────────────────────────────────────────
  // Both strategies are set-cover problems over the same assets, so compare
  // them on the only budget that is actually scarce: the number of cache
  // behaviors. Greedy is optimal enough here — the sets are tiny and the
  // input is a sample, not an inventory.
  const TARGET = 0.9;
  const prefixPlan = greedyCover(assets, (asset) => prefixesOf(asset.pathname), TARGET);
  const extPlan = greedyCover(assets, (asset) => [`*.${asset.ext}`], TARGET);
  const winner = prefixPlan.patterns.length <= extPlan.patterns.length ? prefixPlan : extPlan;
  const other = winner === prefixPlan ? extPlan : prefixPlan;

  console.log('\nRECOMMENDATION');
  console.log(
    `  ${winner.patterns.length} behavior(s) cover ${Math.round(winner.covered * 100)}% ` +
      'of asset requests:'
  );
  console.log(`    ${winner.patterns.join('\n    ')}`);
  console.log(
    `  (the other strategy would need ${other.patterns.length} for ` +
      `${Math.round(other.covered * 100)}%.)`
  );
  console.log(
    `\n  Budget: CloudFront allows ${CLOUDFRONT_BEHAVIOR_QUOTA} cache behaviors per ` +
      'distribution (raisable on request), and the default behavior is one of them.'
  );
  console.log(
    '  Never shorten a pattern with a trailing wildcard on the extension: "*.js*" also\n' +
      '  matches .jsp and "*.as*" matches .aspx — both are server-rendered HTML, so the\n' +
      '  injector would silently stop seeing real pages.'
  );
  if (externalHosts.size > 0) {
    console.log(
      `\n  Ignored ${externalHosts.size} external host(s) — they do not go through this ` +
        `distribution: ${[...externalHosts].slice(0, 5).join(', ')}`
    );
  }
  console.log(
    '\n  Cache behaviors match on PATH only, never on host: a pattern applies to every\n' +
      '  alias served by the distribution. Verify no real page lives under a chosen\n' +
      '  prefix before you route it away from the injector.\n'
  );
}

/**
 * Smallest set of patterns that covers `target` of the assets, greedily: take
 * the pattern that covers the most as-yet-uncovered assets, repeat. Stops when
 * the target is reached or no pattern adds anything.
 */
function greedyCover(assets, patternsOf, target) {
  const remaining = new Set(assets.map((_, index) => index));
  const chosen = [];
  const total = assets.length;
  while (remaining.size > 0 && (total - remaining.size) / total < target) {
    const tally = new Map();
    for (const index of remaining) {
      for (const pattern of patternsOf(assets[index])) {
        tally.set(pattern, (tally.get(pattern) ?? 0) + 1);
      }
    }
    let best = null;
    let bestCount = 0;
    for (const [pattern, count] of tally) {
      if (count > bestCount) {
        best = pattern;
        bestCount = count;
      }
    }
    if (best === null || bestCount === 0) break;
    chosen.push(best);
    for (const index of [...remaining]) {
      if (patternsOf(assets[index]).includes(best)) remaining.delete(index);
    }
  }
  return { patterns: chosen, covered: (total - remaining.size) / total };
}

/** Treat www.example.com and assets.example.com as the same site. */
function sharesRegistrableSuffix(a, b) {
  const tail = (host) => host.split('.').slice(-2).join('.');
  return tail(a.hostname) === tail(b.hostname);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
