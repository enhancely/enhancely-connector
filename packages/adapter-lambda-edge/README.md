# @enhancely/adapter-lambda-edge

CloudFront **Lambda@Edge** adapters for the Enhancely JSON-LD injector.

Die aktuelle, kundenunabhängige Laufzeitarchitektur mit Mermaid-Diagrammen,
Request-Zahlen und sämtlichen Cache-/Retry-Zeiten steht in
[`../../docs/architecture/current-runtime-architecture.md`](../../docs/architecture/current-runtime-architecture.md).

> **Status: implemented + tested.** Three entrypoints, one core. All connector
> logic comes from `@enhancely/injector-core` — these adapters only translate
> CloudFront event shapes and wire up the edge-specific concerns: key
> resolution without environment variables, and getting hold of the HTML body
> at all. Everything they share lives in `src/shared.ts` and `src/cache-cap.ts`, so the entrypoints
> cannot drift apart.

## Which trigger?

|                                                     | **origin-request** (`src/origin-request.ts`)                               | **origin-response** (`src/index.ts`)                     |
| --------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Origin hits per injected cache miss                 | **1**                                                                      | **2** (CloudFront's + our re-fetch)                      |
| Cross-response consistency gates                    | none — there is only one response                                          | X-Robots-Tag, Cache-Control, Expires, CSP must all match |
| Pages that set a cookie or are `private`/`no-store` | **injected**                                                               | skipped                                                  |
| Fail-open primitive                                 | generate the safe original or return the request for CloudFront to fetch   | return the response it already holds                     |
| Body over the 1 MB quota                            | hands the request back; CloudFront streams it without that generated limit | returns the already-held response unchanged before quota |
| Artifact                                            | `dist/lambda-origin-request.zip`                                           | `dist/lambda.zip`                                        |

**`origin-request` is the recommended trigger.** It exists because the
origin-response trigger cannot read the origin body: that adapter has to fetch
the page a second time and then prove the two responses describe the same
object. On an origin-request trigger the function may instead _generate_ the
response, so CloudFront never contacts the origin at all — one fetch, nothing
to reconcile.

The one structural cost: the decision to fetch has to be made from the
**request**, before any `Content-Type` exists. A cheap extension pre-filter
skips obvious asset traffic; anything it lets through is still checked against
the real response, and a wrong guess costs one discarded fetch, never a wrong
body.

### Order of operations: origin first (v0.9.0)

The Enhancely lookup runs only **after** the origin response proves the URL is
an exact-200, servable, injectable HTML page: correct media type and charset,
indexable, transformable, inline rather than an attachment, structurally
injectable, and within the generated-response quota preflights. Up to v0.8.0 it
ran first, which forced the adapter to guess from the request alone — and from
the request alone this is unknowable:

- **`Accept` cannot decide it.** Googlebot sends the wildcard media range
  _without_ `text/html` (Google Search Central), so requiring `text/html` would
  exclude the most important consumer of the injected JSON-LD; accepting the
  wildcard excludes nothing, since every script, image and XHR carries it too.
- **Fetch Metadata (`Sec-Fetch-Dest`) cannot either.** It is absent on
  `http://`, on pre-2023 browsers and on crawlers, and it is normally not part
  of the cache key — gating on a header outside the cache key lets the
  un-injected variant win the cache entry and be served to everyone.

Asking Enhancely first would add an unnecessary API call and its latency to
every extension-less non-page. With the origin fetched first, that class costs
**zero** Enhancely calls.

| path                                                             | origin hits                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| HTML + snippet                                                   | 1 (we fetch, we generate)                              |
| HTML, no snippet or no usable `</head>`                          | 1 (we fetch, we generate the origin's bytes)           |
| non-2xx (404, redirect …)                                        | 1 — returned byte-for-byte from the fetch already made |
| small status-200 veto (JSON/noindex/`no-transform`/attachment/…) | 1 — returned from the fetch already made               |
| over quota / non-reproducible other 2xx                          | 2 on the FIRST request, 1 afterwards (memoized)        |

A reproducible answer never pays twice — non-2xx and small status-200 vetoes
are returned exactly from the fetch already made, without an Enhancely call.
CloudFront applies the operator's configured custom error response to a
Lambda@Edge-generated error status. Range, 206/304, unsupported
successful statuses, and quota failures stay on the conservative handback
path; an empty 204 is safely generated from the existing fetch. Only the last
line pays twice, and only the FIRST request for such a URL: the verdict is
memoized per execution environment. The two triggers deliberately do not
coordinate through a private request header: CloudFront would forward it to
the customer's origin/WAF, where it could change the representation. The
cache-cap-only companion repeats the cheap extension/Range/status/content-type/
indexing/transform/disposition gates but never contacts Enhancely. A post-lookup snippet
that does not fit the Lambda quota falls back to the already-fetched original
HTML whenever that original still fits, so that case remains one origin request
and one Enhancely request. In the rare case where neither the injected body nor
that original can be generated, the request is handed back; the companion may
safely shorten its cache lifetime but cannot add another Enhancely request.

Origin-fetch failures use two short, execution-environment-local circuits.
DNS, TCP-connect and TLS failures observed before the transport is ready park
the endpoint + virtual host for 10 seconds. A timeout, reset or malformed
response after connect is memoized only for that exact origin request, so one
bad path cannot suppress injection on healthy pages while repeats still avoid
a known-doomed extra fetch. Every circuit remains fail-open: CloudFront performs
its normal origin request.

#### Conformance: what the unit tests cannot prove

`pnpm conformance` drives a live CloudFront distribution and asserts what the
**platform** does with what the adapter produces — properties no unit test can
reach: whether a generated response keeps two separate `Set-Cookie` headers,
whether an over-quota body fails open instead of returning 502, whether a
300 KB page is still compressed, whether latin-1 bytes survive byte-exact.

Pass the URL of a compatible, operator-owned fixture distribution explicitly:
`pnpm conformance https://connector-fixtures.example`. The suite tests what is
deployed, not what is committed, and this repository intentionally contains no
live deployment configuration or credentials.

Two findings it produced on its first run, both worth knowing:

- **CloudFront strips `Set-Cookie` when a cache behavior does not forward
  cookies** (_"removes `Set-Cookie` headers from responses before returning
  responses to your viewers"_). On such a distribution the header is gone
  whether the response was injected or passed through — the injector cannot
  lose a cookie the platform already removes. Where cookies ARE forwarded,
  CloudFront also **caches** `Set-Cookie` with the object and replays it on
  every hit; AWS's own mitigation is an origin sending
  `Cache-Control: no-cache="Set-Cookie"`. That is the risk `capSetCookieResponses`
  asks the operator to reason about.
- **An unvalidated domain caps at 5 records.** Registration then answers
  `403 domain-validation-required`, the connector correctly treats it as a
  durable negative and backs off — and nothing new is ever injected. The
  functions log nothing in normal operation, so the only symptom is silence.
  Validate the domain before concluding the connector is broken.

#### Keeping the function off asset paths

The single biggest saving is not in the function at all. A Lambda@Edge
association lives on a **cache behavior**, and CloudFront picks the behavior by
**path pattern** — never by response Content-Type, which does not exist yet at
that point. So the only way to stop the function being invoked for stylesheets,
fonts and images is to give those paths their own behavior _without_ the
association.

It is worth doing, and not mainly for money: on a typical page load the HTML is
one request and the assets are dozens. Every one of them invokes the function
just to be rejected by the extension filter — and a Lambda@Edge throttle or
crash on an asset request is a **viewer-facing 5xx**. Assets that never reach
the function cannot be broken by it.

To find the right patterns for a given site:

```bash
pnpm asset-paths https://www.example.com/ https://www.example.com/some/page
# basic-auth staging:
ASSET_PATHS_AUTH='user:pass' pnpm asset-paths https://staging.example.com/
```

It reads every asset the pages reference (including `srcset` and CSS `url()`),
keeps only extensions this adapter already rejects — the list is read from
`shared.ts`, so the tool cannot drift from the code — and reports the
smallest set of behaviors that covers them, comparing a path-prefix strategy
against an extension strategy. Two traps it guards against: CloudFront allows
only 25 behaviors per distribution, and shortening `*.js` to `*.js*` also
matches `.jsp` (as `*.as*` matches `.aspx`) — both server-rendered HTML, which
would silently stop the injector seeing real pages.

Behaviors match on **path only, never on host**, so a pattern applies to every
alias the distribution serves; check that no real page lives under a prefix
before routing it away.

**Cheaper still: keep the function off those paths entirely.** A Lambda@Edge
association lives on a _cache behavior_, and CloudFront picks the behavior by
path pattern — so an ordered behavior for `*.css`, `*.js`, `/api/*` … _without_
the association means the function is never invoked for them at all: no
invocation billed, no latency, no code involved. That is strictly better than
any in-function filter for anything you can express as a path pattern (up to
the 25-behaviors-per-distribution quota). What it cannot express is the class
that motivated origin-first in the first place — extension-less URLs that turn
out to be redirects or 404s — because no component in the chain knows that
before the origin answers. Two things follow that the old order could not deliver:
`auto_register` is precise (the adapter knows it is HTML), and the retry cache
cap applies to the un-injected response because that response is now ours.

### The cache-cap-only companion (origin-response, pairs WITH origin-request)

`src/companion.ts` is a slim cache-lifetime safety net for responses the
origin-request injector has to hand back. It never calls Enhancely: an
origin-response event exposes no body and therefore cannot prove a real
`<head>`, valid UTF-8 bytes, or available generated-response quota. The
origin-request injector remains the only API caller in the recommended pair.

- **retry cache-lifetime capping** — for a response origin-request could not
  safely generate, the companion applies the same
  `retryablePassThroughResponse` cap as the standalone origin-response adapter
  (shared code in `src/cache-cap.ts`), which makes `assertedDefaultTtlSeconds`
  effective again. Method, excluded-path, known-extension, Range, exact-200
  HTML, charset, indexing, `no-transform`, and attachment gates run first, so
  permanent non-pages keep their native cache policy.

The pairing is safe by AWS contract: a response GENERATED by an origin-request
function never fires the origin-response trigger, and cached responses invoke
neither function — the companion only ever sees uninjected pass-through
traffic. Every injected generated response additionally carries
`X-Enhancely-Injected`. A companion that ever observes it abstains loudly. In a
correct deployment a generated response cannot reach this trigger, so the
marker indicates an origin echo or changed AWS event semantics; it is a
never-touch-injected-body invariant, not a pairing detector. Pairing safety
comes from the Terraform association map and review.

Cap gates are deliberately strict: requests carrying
`Cookie`/`Authorization` and responses with `private`/`no-store` are never
rewritten; responses with `Set-Cookie` only under the operator assertion
`capSetCookieResponses` (for credential-less requests — the shared crawler
variant). The same assertion is used when the origin-request injector generates
an uninjected retryable fallback, so this is a pairing-wide assertion rather
than a companion-only switch. `autoRegister` affects body-aware injectors only;
it has no effect in the companion.

### Why origin-request injects pages that set cookies

`origin-response` skips any response carrying `Set-Cookie` or
`Cache-Control: private|no-store`, because a _re-fetch_ cannot faithfully
reproduce a page that stamps new state into the viewer. That reasoning is a
property of the double fetch, not of the page, so `origin-request` does not
apply it — the response handed to the viewer **is** the one the origin just
produced, `Set-Cookie` included verbatim.

On sites behind a stickiness-enabled load balancer — where _every_ response
carries a session cookie — the old rule silently meant "never inject at all".

`Set-Cookie` alone is not a cache veto for a generated response. CloudFront's
cache policy and the response cache directives determine cacheability.
Injecting into a page that sets a cookie therefore does not make CloudFront
cache anything it would not have cached anyway; the shared-cookie risk is a
property of the distribution's cache policy, not of this injection.

One correction while being precise: the generated response is _not_
byte-identical to the passed-through one — `ETag`, `Last-Modified` and
`Content-Length` are deliberately dropped because they describe the uninjected
body. It is identical in the only respect that governs caching.

---

## Architecture: origin-response + re-fetch — and why

```
viewer ──> CloudFront ──(cache miss)──> origin
                │                          │
                │<───── origin response ───┘   status + headers ONLY
                │
                ├─ origin-response trigger: this handler
                │    1. policy/response gate: excludePaths, noindex/none,
                │       GET + status "200" + text/html +
                │       UTF-8-compatible charset + transformable + inline +
                │       no Set-Cookie +
                │       no private/no-store Cache-Control (the first
                │       response may be gzip/br; it is not the body used)
                │    2. resolve config (baked file or SSM, memoized)
                │    3. resolve JSON-LD (cache/ETag/Enhancely API)
                │    4. RE-FETCH the page from the custom origin
                │       (same URI+query, incoming Host header, ALL other
                │        origin-request headers forwarded — except
                │        Accept-Encoding and hop-by-hop headers —
                │        Accept-Encoding: identity)
                │    5. re-gate the body source, including X-Robots-Tag
                │    6. replace the response body (within the 1 MB
                │       generated-response quota), synchronize its
                │       representation headers — or fail open
                │
                └──> CloudFront caches the INJECTED page ──> viewer
```

**Why re-fetch?** Lambda@Edge **cannot read the origin response body** in
origin-response triggers — CloudFront only exposes status and headers. The
only way to inject into the HTML is to fetch the page again, straight from
the origin (`request.origin.custom` carries domain, port, protocol and origin
path; the incoming `Host` header is forwarded so name-based vhosts resolve).
The re-fetch also forwards **all** of the origin request's headers — exactly
the set CloudFront sent to the origin, already filtered by the origin request
policy — so the origin answers with the **same representation** it already
served, whatever it varies on (`User-Agent` device detection, `Accept`
negotiation, `Cookie`, `Authorization`, `Accept-Language`, CloudFront
geo/device headers, …). Only three things are excluded: `Host` (set
explicitly, as above), `Accept-Encoding` (forced to `identity` — injection
needs raw bytes) and the hop-by-hop headers (`Connection`, `Keep-Alive`,
`Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`,
`Transfer-Encoding`, `Upgrade`). Responses that stamp NEW per-request state —
`Set-Cookie`, or `Cache-Control: private`/`no-store` — cannot be re-fetched
faithfully and pass through untouched.

**What that costs:** one extra origin roundtrip per CloudFront **cache miss**
(origin-response does not fire on cache hits, and CloudFront caches the
injected result). Give HTML behaviors a sensible TTL and the re-fetch cost
amortizes away. The JSON-LD lookup itself is additionally cached per
execution environment (core `MemoryCache` + ETag revalidation).

When no snippet is available yet, the page still passes through without an
origin re-fetch. For public requests without `Authorization` or `Cookie`, and
only when the origin declares an explicit cache lifetime (`max-age`,
`s-maxage`, `Expires`, or `no-cache`), the adapter marks that response
`max-age=0`, caps CloudFront `s-maxage` at the next meaningful retry (404 cache
TTL, `Retry-After`/error backoff, or config cooldown), and removes `ETag`,
`Last-Modified`, and `Expires`. It never exceeds the origin lifetime. When the
freshness syntax is duplicate, malformed, quote-ambiguous, or not a strict
modern HTTP date, it is treated as already stale instead of being guessed.
When the
origin declares no lifetime, the response remains byte-for-byte untouched by
default: the adapter cannot see the distribution's DefaultTTL and must not
accidentally turn a DefaultTTL=0 response into a shared-cacheable one. The
optional `assertedDefaultTtlSeconds` lets the operator assert a minimum
DefaultTTL across every associated behavior; only then is a lifetime-less
response capped at `min(retry, asserted)`. Credentialed requests always remain
byte-for-byte pass-through.

`excludePaths` is evaluated before config resolution, lookup, registration, or
cache rewriting. The raw path is canonicalized once before matching: RFC 3986
unreserved escapes are decoded, literal backslashes become `/`, and duplicate
slashes/dot-segments collapse. Reserved, non-ASCII, malformed, and
double-encoded octets remain literal. An `X-Robots-Tag: noindex` or `none` on
either the first response or the identity re-fetch vetoes injection. Other
robots metadata must be stable across both responses.

**Fail-open invariant:** the whole handler is wrapped in try/catch and always
returns the original response — config unresolvable, re-fetch error/timeout/
non-200/redirect, body over the generated-response quota, unexpected charset
or Content-Encoding, lossy UTF-8 decode, core or API errors. The customer's
page is never at risk; worst case is one uninjected view.

The re-fetch deliberately uses `node:http`/`node:https`, not `fetch`:
undici's `fetch` treats `Host` as a forbidden header and silently drops it,
which would break virtual hosts on the origin. Its response-header parser is
explicitly raised from Node's 16 KiB default to CloudFront's 32 KiB limit.

> **Hard handbacks still need the companion's origin-response seat.** Normal
> no-snippet and no-`</head>` pages are generated by `origin-request`, which can
> cap them itself. Over-quota and other non-reproducible responses must be
> fetched by CloudFront; the companion sees the actual response headers,
> applies its cheap gates, and performs only safe TTL capping.

## Configuration (no environment variables at the edge!)

Lambda@Edge supports **no user-configurable environment variables**. Two key
sources are implemented, tried in this order:

1. **Baked config file** — `connector-config.json`, generated at deploy time
   and zipped next to the bundled `index.js` (the `package` script picks it up
   automatically from the package root). Gitignored; start from
   [`connector-config.example.json`](connector-config.example.json).
2. **SSM Parameter Store** — used when no baked `apiKey` exists. The key is
   fetched with `GetParameter` (`WithDecryption: true`). Concurrent invocations
   of one execution environment share a single in-flight call, and a successful
   result is memoized for that environment. The call is **bounded**
   (`AbortSignal.timeout`, default 2 s, at most 2 attempts) — a hung SSM resolves
   to "no key" (pass-through) instead of riding the invocation into a Lambda
   timeout, which CloudFront would surface as a viewer-facing 502. The SDK is
   imported dynamically and only when needed (and never bundled — the Lambda
   Node runtime ships AWS SDK v3).

If neither source yields a key, the function logs a loud error and passes
responses through uninjected for a **30-second cooldown**. The next invocation
after the cooldown retries resolution, so a key created later or a transient
SSM failure does not strand a warm execution environment.

| `connector-config.json` key | Default                        | Notes                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiKey`                    | — (falls back to SSM)          | `sk-…` / `sk-org-…`. Present → SSM is never contacted.                                                                                                                                                                                                                                                                                                                                     |
| `enhancelyBase`             | `https://app.enhancely.ai`     | Enhancely API base URL.                                                                                                                                                                                                                                                                                                                                                                    |
| `timeoutMs`                 | `800`                          | Enhancely API call timeout (enforced by the core).                                                                                                                                                                                                                                                                                                                                         |
| `cacheTtlMs`                | `300000` (5 min)               | JSON-LD cache TTL.                                                                                                                                                                                                                                                                                                                                                                         |
| `autoRegister`              | `false`                        | `false`: one conditional GET without registration. `true`: exactly one register-or-revalidate POST for lookup or registration. Only the explicit low-level compatibility API can still use GET→404→POST.                                                                                                                                                                                   |
| `originTimeoutMs`           | `2000`                         | Origin fetch/re-fetch timeout (higher than the API timeout on purpose).                                                                                                                                                                                                                                                                                                                    |
| `ssmParameterName`          | `/enhancely/connector/api-key` | Only used when `apiKey` is absent.                                                                                                                                                                                                                                                                                                                                                         |
| `ssmRegion`                 | `us-east-1`                    | Region of the SSM parameter.                                                                                                                                                                                                                                                                                                                                                               |
| `ssmTimeoutMs`              | `2000`                         | Bound on the SSM `GetParameter` call (fail-open on expiry).                                                                                                                                                                                                                                                                                                                                |
| `excludePaths`              | `[]`                           | Paths skipped before config/API work; CloudFront-style `*`/`?`.                                                                                                                                                                                                                                                                                                                            |
| `assertedDefaultTtlSeconds` | `0` (off)                      | Asserted minimum DefaultTTL used to cap lifetime-less retries.                                                                                                                                                                                                                                                                                                                             |
| `nonPageMemoTtlMs`          | `1800000` (30 min)             | How long origin-request remembers a hard veto, so repeats skip its classification fetch. Independent of the JSON-LD cache TTL.                                                                                                                                                                                                                                                             |
| `capSetCookieResponses`     | `false`                        | Pair-wide assertion for the origin-request injector's generated fallback and companion, also honored by standalone origin-response: cap `Set-Cookie` responses on credential-less requests. **Never** enable on an origin that mints session cookies for anonymous requests — replayed `Set-Cookie` via downstream caches is the session-fixation pattern. TF: `cap_set_cookie_responses`. |

All three baked timeout fields form one atomic safety set. The manual Lambda
commands below deliberately use a 10-second function timeout; baked overrides
are accepted only when `timeoutMs + originTimeoutMs + ssmTimeoutMs <= 8000`.
If that total is larger, all three overrides are ignored together and the safe
`800 + 2000 + 2000` ms defaults are used, preserving at least two seconds for
cold start, abort/socket settlement, and returning the fail-open response. The
Terraform module is stricter at plan time:
`timeout_ms + origin_timeout_ms <= 6000`, with its fixed 2000 ms SSM reserve.

### Key source trade-offs

| Option        | Pros                                               | Cons                                                                                                    |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Baked file    | Zero runtime latency, no extra IAM                 | Key embedded in every published function version; rotation = redeploy + republish + CloudFront update.  |
| SSM parameter | Rotation without redeploy; key never in the bundle | One SSM call per execution environment (cold-start latency); needs `ssm:GetParameter` on the exec role. |

Either way the key stays server-side — it must never appear in anything sent
to the browser (non-negotiable rule #1 of this repo).

## Limits (Lambda@Edge realities)

- **1 MB generated response — headers AND body together** — for Lambda@Edge
  replacements generated by either injector trigger; exceeding it would make
  CloudFront answer the viewer with a **502**, not the original page. Both
  adapters account for the quota and fail open before returning an oversized
  replacement. The standalone origin-response adapter does so
  in two stages:
  1. The origin **download** is capped at a conservative `1 MB − 33 KB`
     (1,014,784 bytes = 1 MB minus CloudFront's 32,768-byte header maximum
     minus a 1 KB safety margin). This bound must exist _before_ the final
     response headers are known (the fetch streams first), and a body above
     it could never be returned even under maximal headers — bigger pages
     pass through untouched (fail-open).
  2. Before returning an injected body, the **actual** serialized size of the
     response headers being returned is measured (`serializedHeaderBytes`:
     UTF-8 bytes of name + value + 4 bytes per header, plus the actual
     status/status-description framing with a 64-byte minimum allowance).
     The headers must independently fit CloudFront's 32 KB header cap, and the
     body must fit `1 MB − actual header bytes − 1 KB safety margin`. A fixed
     allowance would not be a guarantee. Either overage passes through
     untouched.
- **No environment variables** (hence the two key sources above).
- **No streaming**: the page is buffered, injected, returned in one piece.
- **Compressed first responses are supported**: real viewers commonly cause
  the original origin response to be gzip/br. The handler re-fetches with
  `Accept-Encoding: identity` and drops the stale `Content-Encoding` when it
  generates the replacement. If the _re-fetch_ is nevertheless compressed, it
  passes through untouched.
- **Non-UTF-8 charsets pass through** (`iso-8859-1`, `windows-1252`, …) —
  same gate as the sidecar adapter; transcoding is not supported. Pages with
  an ASCII header label must contain ASCII bytes only. Pages with **no** charset
  parameter may contain non-ASCII only when the lossless UTF-8 bytes carry an
  unambiguous UTF-8 BOM or declare UTF-8 in a supported `<meta charset>` /
  `http-equiv` form inside the browser's 1024-byte prescan window. Other
  ambiguous charset-less pages pass through. Generated HTML is always advertised explicitly as
  `text/html; charset=utf-8`, so Unicode JSON-LD cannot be mislabeled.
- **Standalone origin-response only — per-request responses pass through**:
  `Set-Cookie` on the response, or `Cache-Control: private`/`no-store`, marks a
  representation that a re-fetch cannot faithfully reproduce. The recommended
  origin-request injector uses its single fetched representation and therefore
  does inject these pages.
- **Every Lambda entrypoint honors transformation/disposition policy**:
  `Cache-Control: no-transform` and `Content-Disposition: attachment` veto
  lookup, registration, injection, and retry-cache rewriting. A small response
  already fetched by origin-request is returned safely without an Enhancely
  call; otherwise the original CloudFront path remains untouched.
- **Custom origins only**: S3 REST origins are not re-fetchable this way —
  attach this function to behaviors backed by a custom (HTTP) origin.
- `Content-Length` is **deleted** from the modified response — it described
  the original body; CloudFront computes the correct value from the returned
  body itself. `ETag` and `Last-Modified` are deleted too: they are
  validators for the **uninjected** body, and keeping them would let clients
  revalidate an old copy into a 304 and never receive the injected version.
  The integrity digests `Content-MD5`, `Digest`, `Content-Digest` and
  `Repr-Digest` are deleted for the same reason — they were computed over
  the original bytes and would make verifying clients reject the injected
  body as corrupted.
- `Cache-Control` and `Expires` must be stable across the first response and
  re-fetch; a mismatch passes through rather than making the viewer response
  more cacheable. Enforcing and report-only CSP structure must likewise remain
  stable, except that per-response nonces and body hashes may rotate. The
  accepted re-fetch CSP is copied so those values match the generated body;
  disappearance or any other policy change passes through.
- `X-Robots-Tag: noindex`/`none` on either response vetoes injection.
  Non-blocking robots metadata must be stable across both responses; a mismatch
  passes through rather than dropping or changing crawler policy.
- Best results when the origin request policy **forwards the viewer `Host`
  header** — it is used both for the re-fetch vhost and for the page URL sent
  to Enhancely. Without it, the origin domain is used instead.

## Build & package

```bash
pnpm --filter @enhancely/injector-core build          # once, or `pnpm -r build`
pnpm --filter @enhancely/adapter-lambda-edge build    # typecheck + three esbuild bundles
pnpm --filter @enhancely/adapter-lambda-edge package  # → three zips (config included when present)
```

`build` produces the bundles, `package` the zips:

| Artifact                         | Trigger                                      | Lambda handler  |
| -------------------------------- | -------------------------------------------- | --------------- |
| `dist/lambda-origin-request.zip` | `origin-request`                             | `index.handler` |
| `dist/lambda-companion.zip`      | `origin-response` (paired w/ origin-request) | `index.handler` |
| `dist/lambda.zip`                | `origin-response` (standalone injector)      | `index.handler` |

All zips contain their bundle **as `index.js`**, so the Lambda `handler`
setting is `index.handler` in every case — only the zip and the CloudFront
event type differ. (`dist/origin-request.js` / `dist/companion.js` are the
unzipped bundles for vendoring; pipelines that can only carry ONE artifact can
vendor both files into a single zip and point the two functions at
`index.handler` / `companion.handler` instead.)

The bundle is CJS, `--platform=node --target=node20`, with `@aws-sdk/*`
external (provided by the Lambda runtime). For the baked-key option, write
`packages/adapter-lambda-edge/connector-config.json` (gitignored) before
`package`.

## Deploy (us-east-1 — mandatory for Lambda@Edge)

### 1. Key in SSM (skip when baking the key)

```bash
aws ssm put-parameter --region us-east-1 \
  --name /enhancely/connector/api-key \
  --type SecureString \
  --value 'sk-…'
```

### 2. IAM role (trust BOTH lambda and edgelambda)

```bash
aws iam create-role --role-name enhancely-lambda-edge \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] },
      "Action": "sts:AssumeRole"
    }]
  }'
aws iam attach-role-policy --role-name enhancely-lambda-edge \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
# SSM key source only:
aws iam put-role-policy --role-name enhancely-lambda-edge --policy-name ssm-read \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:us-east-1:*:parameter/enhancely/connector/api-key"
    }]
  }'
```

(SecureString with a customer-managed KMS key additionally needs
`kms:Decrypt` on that key.)

### 3. Create + publish the recommended pair

Lambda@Edge associations require published versions, never `$LATEST`. The
manual equivalent of the Terraform module's default is **two functions** with
the same config: the origin-request injector and the non-injecting companion.
Each standalone release zip contains its entrypoint as `index.js`, so both use
`index.handler`:

```bash
aws lambda create-function --region us-east-1 \
  --function-name enhancely-injector \
  --runtime nodejs22.x \
  --handler index.handler \
  --role arn:aws:iam::<ACCOUNT>:role/enhancely-lambda-edge \
  --timeout 10 --memory-size 256 \
  --zip-file fileb://dist/lambda-origin-request.zip

aws lambda create-function --region us-east-1 \
  --function-name enhancely-injector-companion \
  --runtime nodejs22.x \
  --handler index.handler \
  --role arn:aws:iam::<ACCOUNT>:role/enhancely-lambda-edge \
  --timeout 10 --memory-size 256 \
  --zip-file fileb://dist/lambda-companion.zip

aws lambda publish-version --region us-east-1 \
  --function-name enhancely-injector
aws lambda publish-version --region us-east-1 \
  --function-name enhancely-injector-companion
# Note both returned version ARNs for step 4.
```

For explicit standalone compatibility mode, create only one function from
`dist/lambda.zip` and associate it with `origin-response`. That artifact is the
full re-fetching injector and must never be paired with the origin-request
injector. The companion zip is the only supported origin-response partner.

On redeploy, update and publish **both** default-pair functions, then replace
both version ARNs in step 4.

### 4. Attach both functions to the same CloudFront behavior

```bash
aws cloudfront get-distribution-config --id <DIST_ID> > dist-config.json
# In DistributionConfig.DefaultCacheBehavior (or the relevant CacheBehavior):
#   "LambdaFunctionAssociations": {
#     "Quantity": 2,
#     "Items": [
#       {
#         "LambdaFunctionARN": "arn:aws:lambda:us-east-1:<ACCOUNT>:function:enhancely-injector:<VERSION>",
#         "EventType": "origin-request",
#         "IncludeBody": false
#       },
#       {
#         "LambdaFunctionARN": "arn:aws:lambda:us-east-1:<ACCOUNT>:function:enhancely-injector-companion:<VERSION>",
#         "EventType": "origin-response",
#         "IncludeBody": false
#       }
#     ]
#   }
aws cloudfront update-distribution --id <DIST_ID> \
  --if-match <ETag-from-get> \
  --distribution-config file://dist-config.updated.json
```

Recommended alongside: an origin request policy that forwards the viewer
`Host` header, and a cache policy with a non-trivial TTL for HTML (so the
injected page is actually cached and origin work stays a cache-miss cost).

Verify:

```bash
curl -s https://www.your-site.com/some-page | grep -o 'application/ld+json'
aws logs tail /aws/lambda/us-east-1.enhancely-injector --region <edge-region>
```

(Lambda@Edge logs land in the region of the edge location that served the
request, under the `us-east-1.<function>` log-group prefix.)

## Testing locally

```bash
pnpm --filter @enhancely/adapter-lambda-edge test        # vitest
pnpm --filter @enhancely/adapter-lambda-edge typecheck
```

The suite runs the handler against a real local `node:http` origin (verifying
the Host-header-carrying re-fetch and the full request-header forwarding —
including `User-Agent` and CloudFront device headers, with `Accept-Encoding`
pinned to `identity` and hop-by-hop headers dropped), mocks the Enhancely API
through the core's `fetchImpl` seam, and mocks `@aws-sdk/client-ssm` to
verify key resolution order, memoization (one `GetParameter` for concurrent
cold-start invocations), the bounded-SSM-timeout fallback, and the real
`connector-config.json` file read (valid, unparsable, junk-typed). Fail-open
coverage includes the exact generated-size boundaries (origin-fetch cap,
independent 32 KB header cap, header-aware body budget, injection pushing one
byte over), CSP/cache-metadata stability, Unicode JSON-LD on genuinely ASCII
source HTML, ambiguous charset gates, origin connection errors and re-fetch
timeouts, redirects, `no-transform` / attachment / Set-Cookie / private /
no-store gates, credential-safe
retry policies, Enhancely 404/rate-limit/network errors, and the missing-key
pass-through/cooldown.
