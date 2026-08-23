#!/usr/bin/env node
/**
 * Conformance suite: drive the Lambda@Edge pairing against a live CloudFront
 * distribution and assert what it does — not what the unit tests believe.
 *
 * WHY A SECOND SUITE. The unit tests run the handler against a local origin,
 * which proves the logic. They cannot prove what CloudFront does with the
 * result: whether a generated response keeps two separate Set-Cookie headers,
 * whether an over-quota body fails open instead of returning 502, whether a
 * 300 KB page still gets compressed. Those are properties of the platform, and
 * the only honest way to know them is to ask the platform.
 *
 * A compatible fixture deployment has two halves, because no single origin
 * can provide both:
 *   - `/fixtures/*` — S3 objects with deliberate shapes (realistic and
 *     over-quota page sizes, no </head>, pre-existing JSON-LD, latin-1 bytes
 *     without a charset) served through the REAL injector + companion pairing.
 *   - `/probe/two-cookies` — a bucket cannot stamp Set-Cookie, so the platform
 *     half of that question is asked of an edge function that generates such
 *     a response directly. The adapter half (does our code emit every value?)
 *     is covered by the multi-value unit test.
 *
 * Run before every release, and after any change to response construction.
 *
 * Usage:
 *   node scripts/edge-conformance.mjs https://host --auth user:pass
 */

const MARKER = 'x-enhancely-injected';
const SNIPPET = 'data-source="Enhancely.ai"';

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith('http'));
if (!baseArg) {
  console.error('Usage: node scripts/edge-conformance.mjs https://host [--auth user:pass]');
  process.exit(2);
}
const base = baseArg.replace(/\/$/, '');
const authIndex = args.indexOf('--auth');
const auth = authIndex >= 0 ? args[authIndex + 1] : process.env.CONFORMANCE_AUTH;

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${detail}`);
  }
}

async function get(path, extraHeaders = {}) {
  const headers = { 'user-agent': 'enhancely-conformance/1', ...extraHeaders };
  if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  // This suite requires all query strings in the CloudFront cache key. A fresh
  // value should keep each assertion on a cache MISS, so we measure the edge
  // functions rather than an artefact cached by an earlier assertion. Randomise
  // the parameter NAME too, so one hard-coded allowlist cannot accidentally
  // make cacheable fixtures look correctly configured. X-Cache below detects a
  // violated miss assumption; the operator must still verify the cache/origin
  // request policies because an uncacheable response also reports a miss.
  const nonce = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const bust = `${path.includes('?') ? '&' : '?'}enhancely_conformance_${nonce}=1`;
  const response = await fetch(`${base}${path}${bust}`, { headers, redirect: 'manual' });
  const cloudFrontCache = response.headers.get('x-cache') ?? '';
  if (cloudFrontCache.toLowerCase().includes('hit from cloudfront')) {
    throw new Error(
      `Conformance request was served from cache (${cloudFrontCache}). Ensure this suite's ` +
        'random query parameter reaches the cache key before using its results.'
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    // getSetCookie() is the only API that preserves multiple Set-Cookie headers.
    cookies: response.headers.getSetCookie?.() ?? [],
    bytes,
    // Lossy on purpose for substring checks; byte assertions use `bytes`, because
    // decoding a latin-1 body as UTF-8 would manufacture the very U+FFFD we test for.
    body: bytes.toString('utf8'),
  };
}

/**
 * Pages this suite expects to see INJECTED must exist in the catalog first.
 * On a fresh fixture the adapter's first visit registers the URL and serves it
 * un-injected — correct behaviour, but indistinguishable from a regression if
 * asserted blind. So warm the injectable fixtures and wait for the flip, with
 * a bound: if it never comes, that IS the finding and the assertions below
 * report it rather than this loop hanging.
 */
async function warmUp(paths, budgetMs = 420_000) {
  process.stdout.write('Warming the catalog');
  const started = Date.now();
  const pending = new Set(paths);
  while (pending.size > 0 && Date.now() - started < budgetMs) {
    for (const path of [...pending]) {
      const r = await get(path);
      if (r.body.includes(SNIPPET)) pending.delete(path);
    }
    if (pending.size === 0) break;
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    pending.size === 0
      ? ` injected after ${seconds}s\n`
      : ` gave up after ${seconds}s; still un-injected: ${[...pending].join(', ')}\n`
  );
}

async function main() {
  console.log(`\nConformance run against ${base}\n`);
  await warmUp(['/', '/fixtures/big.html', '/fixtures/existing-jsonld.html']);

  // ── Set-Cookie: the property the origin-request adapter exists for ──────
  console.log('Set-Cookie on a GENERATED response (platform half)');
  {
    const r = await get('/probe/two-cookies');
    report(
      'CloudFront preserves BOTH Set-Cookie headers separately',
      r.cookies.length === 2,
      `cookies=${JSON.stringify(r.cookies)}`
    );
    report(
      'both cookie values arrive unmodified',
      r.cookies.some((c) => c.startsWith('session_primary=probe1-')) &&
        r.cookies.some((c) => c.startsWith('session_cors=probe2-')),
      JSON.stringify(r.cookies)
    );
  }

  // ── Size boundaries: the one fail-CLOSED limit on this trigger ──────────
  console.log('\nSize boundaries');
  {
    const r = await get('/fixtures/big.html');
    report(
      'realistic ~300 KB page is injected',
      r.status === 200 && r.body.includes(SNIPPET),
      `status=${r.status} bytes=${r.body.length}`
    );
    report(
      'a page that large is still compressed by CloudFront',
      (r.headers.get('content-encoding') ?? '') !== '',
      `content-encoding=${r.headers.get('content-encoding')}`
    );
  }
  {
    const r = await get('/fixtures/huge.html');
    report(
      'over-quota page fails OPEN (200, not 502) and is served un-injected',
      r.status === 200 && !r.body.includes(SNIPPET),
      `status=${r.status} injected=${r.body.includes(SNIPPET)} bytes=${r.body.length}`
    );
  }

  // ── Gates that must never inject ────────────────────────────────────────
  console.log('\nGates');
  {
    const r = await get('/fixtures/nohead.html');
    report(
      'no </head> to inject before: origin bytes served unchanged',
      r.status === 200 && !r.body.includes(SNIPPET) && r.body.includes('no head element'),
      `status=${r.status}`
    );
  }
  {
    const r = await get('/fixtures/latin1.html');
    report(
      'latin-1 without a charset is never injected',
      !r.body.includes(SNIPPET),
      'snippet found — the body was relabelled as UTF-8'
    );
    report(
      'latin-1 bytes survive byte-exact (0xE9 intact, never re-encoded)',
      r.bytes.includes(0xe9) && !r.bytes.includes(Buffer.from('\uFFFD', 'utf8')),
      `bytes=${r.bytes.length} hasE9=${r.bytes.includes(0xe9)}`
    );
  }
  {
    const r = await get('/private/page.html');
    report('excluded path is never injected', !r.body.includes(SNIPPET), `status=${r.status}`);
  }

  // ── Injection quality ───────────────────────────────────────────────────
  console.log('\nInjection quality');
  {
    const r = await get('/fixtures/existing-jsonld.html');
    const count = (r.body.match(/application\/ld\+json/g) ?? []).length;
    report(
      "the origin's own JSON-LD is kept and ours is added (2 blocks)",
      count === 2 && r.body.includes('"Organization"'),
      `ld+json blocks=${count}`
    );
  }
  {
    const r = await get('/');
    const at = r.body.indexOf(SNIPPET);
    const headClose = r.body.indexOf('</head>');
    report(
      'snippet sits inside <head>',
      at > 0 && headClose > at,
      `snippet=${at} head=${headClose}`
    );
    report(
      'validators are stripped from an injected response',
      r.headers.get('etag') === null && r.headers.get('last-modified') === null,
      `etag=${r.headers.get('etag')} last-modified=${r.headers.get('last-modified')}`
    );
    report('injected response is marked', r.headers.get(MARKER) === '1', 'marker missing');
    report(
      'generated HTML is explicitly UTF-8',
      (r.headers.get('content-type') ?? '').includes('utf-8'),
      `ct=${r.headers.get('content-type')}`
    );
  }

  // ── Nothing may ever 5xx ────────────────────────────────────────────────
  console.log('\nNo viewer-facing 5xx anywhere');
  {
    const paths = [
      '/',
      '/fixtures/big.html',
      '/fixtures/huge.html',
      '/fixtures/nohead.html',
      '/fixtures/latin1.html',
      '/fixtures/existing-jsonld.html',
      '/private/page.html',
      '/probe/two-cookies',
      '/does-not-exist.html',
      '/does-not-exist',
      '/style.css',
    ];
    const results = await Promise.all(paths.map((p) => get(p).then((r) => [p, r.status])));
    const bad = results.filter(([, status]) => status >= 500);
    report(
      `all ${paths.length} paths answered without a 5xx`,
      bad.length === 0,
      JSON.stringify(bad)
    );
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
