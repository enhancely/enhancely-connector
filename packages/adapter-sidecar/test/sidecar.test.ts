/**
 * Integration test for the sidecar proxy: real node:http origin + a stub
 * Enhancely API, with the sidecar imported (and started) in-process.
 *
 * Regression focus (byte fidelity, fail-open):
 * - declared non-UTF-8 charset → streamed through BYTE-IDENTICAL, no injection
 * - charset-less HTML whose bytes are not valid UTF-8 (mislabeled legacy page)
 *   → buffered, but served byte-identical when nothing was injected
 * - normal UTF-8 page → JSON-LD snippet injected before </head>
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';

const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Thing"}';
// Mirrors buildScriptTag output for the mock (ETag "v1"): the tag carries the
// Kirby-parity attribution attributes since v0.8.0.
const SNIPPET = `<script type="application/ld+json" data-source="Enhancely.ai" data-etag="v1">${RAW_JSONLD}</script>`;

// 'Café' / 'Résumé' encoded as iso-8859-1: the high bytes are invalid UTF-8.
const LATIN1_HTML = Buffer.from(
  '<html><head><title>Café</title></head><body>Résumé</body></html>',
  'latin1'
);
const UTF8_HTML = '<html><head><title>ok</title></head><body>utf-8 page</body></html>';

let origin: http.Server;
let enhancelyStub: http.Server;
let sidecar: http.Server;
let enhancelyHits = 0;

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return address.port;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function get(
  port: number,
  path: string
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  headersDistinct: NodeJS.Dict<string[]>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            headersDistinct: res.headersDistinct,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  origin = http.createServer((req, res) => {
    if (req.url === '/latin1-labeled') {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(LATIN1_HTML);
    } else if (req.url === '/latin1-unlabeled') {
      // Mislabeled legacy page: no charset declared, bytes are iso-8859-1.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(LATIN1_HTML);
    } else if (req.url === '/utf8') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(UTF8_HTML);
    } else if (req.url === '/conflicting-content-type') {
      res.writeHead(200, [
        'Content-Type',
        'text/html; charset=utf-8',
        'Content-Type',
        'application/json',
      ]);
      res.end(UTF8_HTML);
    } else if (req.url === '/conflicting-disposition') {
      res.writeHead(200, [
        'Content-Type',
        'text/html; charset=utf-8',
        'Content-Disposition',
        'inline',
        'Content-Disposition',
        'attachment; filename="page.html"',
      ]);
      res.end(UTF8_HTML);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await listen(origin);

  enhancelyStub = http.createServer((req, res) => {
    enhancelyHits += 1;
    // GET /api/v1/jsonld/{encodeURIComponent(rawPageUrl)}
    const segment = decodeURIComponent(req.url ?? '');
    if (segment.includes('/utf8')) {
      res.writeHead(200, { 'content-type': 'application/ld+json', etag: '"v1"' });
      res.end(RAW_JSONLD);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    }
  });
  await listen(enhancelyStub);

  // Env must be in place BEFORE the sidecar module is imported: it reads its
  // configuration at module load and starts listening immediately.
  process.env['UPSTREAM_ORIGIN'] = `http://127.0.0.1:${portOf(origin)}`;
  process.env['ENHANCELY_API_KEY'] = 'sk-test-key';
  process.env['ENHANCELY_BASE'] = `http://127.0.0.1:${portOf(enhancelyStub)}`;
  process.env['PORT'] = '0';

  const mod = await import('../src/index.js');
  sidecar = mod.server;
  if (!sidecar.listening) await once(sidecar, 'listening');
});

after(() => {
  for (const server of [sidecar, origin, enhancelyStub]) {
    server.close();
    server.closeAllConnections();
  }
});

void test('declared iso-8859-1 page streams through byte-identical, uninjected', async () => {
  const res = await get(portOf(sidecar), '/latin1-labeled');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=iso-8859-1');
  // Regression (finding: sidecar byte-corrupted non-UTF-8 HTML): the exact
  // upstream bytes must come back — no U+FFFD mojibake, no injection.
  assert.equal(Buffer.compare(res.body, LATIN1_HTML), 0);
});

void test('charset-less page with non-UTF-8 bytes is served byte-identical when nothing is injected', async () => {
  const res = await get(portOf(sidecar), '/latin1-unlabeled');
  assert.equal(res.status, 200);
  // Enhancely answers 404 for this page → no injection → the buffered path
  // must fall back to the ORIGINAL bytes, not the lossy utf-8 re-encode.
  assert.equal(Buffer.compare(res.body, LATIN1_HTML), 0);
  assert.equal(Number(res.headers['content-length']), LATIN1_HTML.byteLength);
});

void test('utf-8 page gets the JSON-LD snippet injected before </head>', async () => {
  const res = await get(portOf(sidecar), '/utf8');
  assert.equal(res.status, 200);
  const html = res.body.toString('utf8');
  assert.equal(html, UTF8_HTML.replace('</head>', `${SNIPPET}</head>`));
  assert.equal(Number(res.headers['content-length']), res.body.byteLength);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
});

void test('conflicting Content-Type instances veto injection and survive pass-through', async () => {
  const hitsBefore = enhancelyHits;
  const res = await get(portOf(sidecar), '/conflicting-content-type');
  assert.equal(Buffer.compare(res.body, Buffer.from(UTF8_HTML)), 0);
  assert.deepEqual(res.headersDistinct['content-type'], [
    'text/html; charset=utf-8',
    'application/json',
  ]);
  assert.equal(enhancelyHits, hitsBefore);
});

void test('every Content-Disposition instance reaches the gate and pass-through', async () => {
  const hitsBefore = enhancelyHits;
  const res = await get(portOf(sidecar), '/conflicting-disposition');
  assert.equal(Buffer.compare(res.body, Buffer.from(UTF8_HTML)), 0);
  assert.deepEqual(res.headersDistinct['content-disposition'], [
    'inline',
    'attachment; filename="page.html"',
  ]);
  assert.equal(enhancelyHits, hitsBefore);
});
