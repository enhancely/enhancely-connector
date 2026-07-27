# @enhancely/adapter-sidecar

Node.js reverse-proxy **sidecar** that injects Enhancely JSON-LD into your
origin's HTML responses. Put it between your TLS terminator (nginx, Apache,
ALB, …) and your origin server — no code changes in your application.

> **Status: functional skeleton, not production-hardened.**
> Works: HTTP/1.1 proxying, HTML detection (2xx + `text/html` only),
> bounded body buffering, injection via `@enhancely/injector-core`
> (in-memory cache + ETag revalidation, fail-open), streaming passthrough
> for everything else.
> Missing: **no TLS termination, no gzip decode** (compressed upstream
> responses pass through uninjected), **no metrics**, no HTTP/2, no charset
> transcoding (HTML declaring a non-UTF-8 charset passes through
> byte-identical and uninjected).

```text
visitor → nginx/Apache (TLS) → enhancely sidecar :8080 → your origin
                                    │
                                    └→ Enhancely API (Bearer sk-…, 800 ms timeout, fail-open)
```

## Environment variables

| Variable            | Required | Default                    | Description                                                                                                                                                          |
| ------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_ORIGIN`   | yes      | —                          | Base URL of your origin, e.g. `http://origin:3000`. Missing → the sidecar refuses to start.                                                                          |
| `ENHANCELY_API_KEY` | yes\*    | —                          | `sk-…` / `sk-org-…` key. \*Missing → loud startup error, sidecar runs as a plain pass-through proxy (fail-open, no injection). Never expose this key to the browser. |
| `ENHANCELY_BASE`    | no       | `https://app.enhancely.ai` | Enhancely API base URL override (e.g. for staging).                                                                                                                  |
| `PORT`              | no       | `8080`                     | Listen port.                                                                                                                                                         |

## Run it

Local (after `pnpm install && pnpm -r build` at the repo root):

```bash
UPSTREAM_ORIGIN=http://localhost:3000 \
ENHANCELY_API_KEY=sk-... \
PORT=8080 \
pnpm --filter @enhancely/adapter-sidecar start
```

Docker (no prebuilt image is published yet — run the built output with the
official Node image):

```bash
# from the repo root, after: pnpm install && pnpm -r build
docker run --rm -p 8080:8080 \
  -e UPSTREAM_ORIGIN=http://host.docker.internal:3000 \
  -e ENHANCELY_API_KEY=sk-... \
  -v "$PWD":/app -w /app \
  node:22-alpine \
  node packages/adapter-sidecar/dist/index.js
```

## Behavior

- **Injected**: `GET` requests whose upstream response is 2xx,
  `Content-Type: text/html` (declaring no charset or a UTF-8-compatible one),
  **not** content-encoded, and ≤ 2 MB. The body is buffered, `</head>`
  injection is done by `injector-core`, and `Content-Length` is recalculated.
  When nothing is injected, the original upstream bytes are served verbatim.
- **Passed through untouched (streaming)**: everything else — non-HTML,
  non-2xx, non-GET, non-UTF-8 declared charsets (no transcoding support),
  `Content-Encoding` present (TODO gzip support: disable compression between
  origin and sidecar; compress at the edge instead), oversized bodies, any
  Enhancely API failure/timeout (fail-open), and everything when
  `ENHANCELY_API_KEY` is missing.

## Fronting proxy examples

The sidecar does not terminate TLS — front it with:

- nginx: [`../../examples/nginx/enhancely-injector.conf`](../../examples/nginx/enhancely-injector.conf)
- Apache: [`../../examples/apache/enhancely-injector.conf`](../../examples/apache/enhancely-injector.conf)

Prefer a single static binary with no Node runtime? A Go build of this
sidecar is planned: see [`../adapter-sidecar-go`](../adapter-sidecar-go).
