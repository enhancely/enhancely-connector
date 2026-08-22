# @enhancely/adapter-lambda-edge

CloudFront **Lambda@Edge** adapters for the Enhancely JSON-LD injector.

> **Status: implemented + tested.** Three entrypoints, one core. All connector
> logic comes from `@enhancely/injector-core` — these adapters only translate
> CloudFront event shapes and wire up the edge-specific concerns: key
> resolution without environment variables, and getting hold of the HTML body
> at all. Everything they share lives in `src/shared.ts` and `src/cache-cap.ts`, so the entrypoints
> cannot drift apart.

## Which trigger?

|                                                     | **origin-request** (`src/origin-request.ts`)                                  | **origin-response** (`src/index.ts`)                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Origin hits per injected cache miss                 | **1**                                                                         | **2** (CloudFront's + our re-fetch)                      |
| Cross-response consistency gates                    | none — there is only one response                                             | X-Robots-Tag, Cache-Control, Expires, CSP must all match |
| Pages that set a cookie or are `private`/`no-store` | **injected**                                                                  | skipped                                                  |
| Fail-open primitive                                 | `return request` — CloudFront proceeds as if the function were not associated | return the response it already holds                     |
| Body over the 1 MB quota                            | hands the request back, CloudFront streams it unlimited                       | viewer-facing **502**                                    |
| Artifact                                            | `dist/lambda-origin-request.zip`                                              | `dist/lambda.zip`                                        |

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

The Enhancely lookup runs only **after** the origin response proves the URL is a
servable, injectable HTML page. Up to v0.8.0 it ran first, which forced the
adapter to guess from the request alone — and from the request alone this is
unknowable:

- **`Accept` cannot decide it.** Googlebot sends the wildcard media range
  _without_ `text/html` (Google Search Central), so requiring `text/html` would
  exclude the most important consumer of the injected JSON-LD; accepting the
  wildcard excludes nothing, since every script, image and XHR carries it too.
- **Fetch Metadata (`Sec-Fetch-Dest`) cannot either.** It is absent on
  `http://`, on pre-2023 browsers and on crawlers, and it is normally not part
  of the cache key — gating on a header outside the cache key lets the
  un-injected variant win the cache entry and be served to everyone.

Origin-first avoids spending Enhancely calls on extension-less non-pages while retaining the local extension fast path.

| path                           | origin hits                                     |
| ------------------------------ | ----------------------------------------------- |
| HTML + snippet                 | 1 (we fetch, we generate)                       |
| HTML, no snippet               | 1 (we fetch, we generate the origin's bytes)    |
| not HTML / vetoed / over quota | 2 on the FIRST request, 1 afterwards (memoized) |

Only the third line pays twice, it is reserved for representations this adapter
must not touch, and only the FIRST request for such a URL pays it: the verdict
is memoized per execution environment, so repeats skip our fetch and cost
exactly what they cost before origin-first — one CloudFront fetch, nothing else.

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

### The companion (origin-response, pairs WITH origin-request)

`src/companion.ts` is a third, slim entrypoint that restores the two things the
origin-request trigger structurally cannot do:

- **auto-registration** — it sees status + content-type, so it can enroll real,
  servable HTML (the origin-request lookup runs before any response exists and
  would register redirects and 404s). With `autoRegister` it makes ONE
  register-or-revalidate `POST /api/v1/jsonld { url }` per unknown/stale URL:
  unknown → registered (201), known → revalidated (`If-None-Match` → 412) or
  fetched (200 + raw body + ETag, cached so the NEXT miss injects). With
  `autoRegister` off it degrades to a cap-only companion (conditional GET).
- **retry cache-lifetime capping** — on a miss without a snippet the
  origin-request adapter hands the request back and never sees the response
  CloudFront caches; the companion does, and applies the same
  `retryablePassThroughResponse` cap as the standalone origin-response adapter
  (shared code in `src/cache-cap.ts`), which makes `assertedDefaultTtlSeconds`
  effective again.

The pairing is safe by AWS contract: a response GENERATED by an origin-request
function never fires the origin-response trigger, and cached responses invoke
neither function — the companion only ever sees uninjected pass-through
traffic. Generated responses additionally carry `X-Enhancely-Injected`; a
companion that ever observes it abstains loudly (it means the full
origin-response INJECTOR was mis-paired onto the behavior, which stays
forbidden).

Cap gates are stricter than register gates, deliberately: requests carrying
`Cookie`/`Authorization` and responses with `private`/`no-store` are never
rewritten; responses with `Set-Cookie` only under the operator assertion
`capSetCookieResponses` (for credential-less requests — the shared crawler
variant). Registration, by contrast, mirrors what the injector will inject —
including Set-Cookie/`private`/`no-store` pages.

One economics note on cap-only mode (`autoRegister: false`): the companion then
GETs unknown URLs, each answering 404 — on a large un-registered site that can
trip the server's per-org 404-flood limiter (429 for the whole org, which also
backs off the injector fleet). Cap-only mode is meant for catalogs that are
already populated; during catalog fill, run with `autoRegister: true`.

### Why origin-request injects pages that set cookies

`origin-response` skips any response carrying `Set-Cookie` or
`Cache-Control: private|no-store`, because a _re-fetch_ cannot faithfully
reproduce a page that stamps new state into the viewer. That reasoning is a
property of the double fetch, not of the page, so `origin-request` does not
apply it — the response handed to the viewer **is** the one the origin just
produced, `Set-Cookie` included verbatim.

On sites behind a stickiness-enabled load balancer — where _every_ response
carries a session cookie — the old rule silently meant "never inject at all".

Generated-response caching follows the response cache directives; Set-Cookie alone is not a cacheability signal. The connector therefore preserves the origin's cache semantics.

One correction while being precise: the generated response is _not_
byte-identical to the passed-through one — `ETag`, `Last-Modified` and
`Content-Length` are deliberately dropped because they describe the uninjected
body. It is identical in the only respect that governs caching.

### Order of operations: lookup first

The Enhancely lookup runs **before** the origin fetch, and a missing snippet
hands the request back so CloudFront does its own normal fetch:

```
no snippet → 0 own fetches + 1 CloudFront fetch = 1   (same as without the function)
snippet    → 1 own fetch,   0 CloudFront fetches = 1   (origin-response: 2)
```

Running both concurrently would shave the lookup latency off the snippet path,
but would spend a wasted origin fetch on every page _without_ a snippet — and
while a catalog is still filling up, that is the large majority of requests.
The lookup is a memory-cache hit in steady state anyway, and after an upstream
failure the core's `retryNotBefore` memo skips the call entirely.

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
                │       UTF-8-compatible charset + no Set-Cookie +
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
which would break virtual hosts on the origin.

> **`assertedDefaultTtlSeconds` and the retry cache-control rewriting need an
> origin-response seat.** The `origin-request` entrypoint hands the request
> back when there is no snippet, so CloudFront fetches and caches the origin's
> own response — that entrypoint never sees it and cannot shorten its
> lifetime. On an origin-request deployment, associate the **companion** on
> origin-response of the same behavior (see "The companion" above): it applies
> exactly this capping, making the assertion effective again. Without the
> companion, an uninjected page on that trigger is cached for the behavior's
> normal TTL.

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

| `connector-config.json` key | Default                        | Notes                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                    | — (falls back to SSM)          | `sk-…` / `sk-org-…`. Present → SSM is never contacted.                                                                                                                                                                                                                          |
| `enhancelyBase`             | `https://app.enhancely.ai`     | Enhancely API base URL.                                                                                                                                                                                                                                                         |
| `timeoutMs`                 | `800`                          | Enhancely API call timeout (enforced by the core).                                                                                                                                                                                                                              |
| `cacheTtlMs`                | `300000` (5 min)               | JSON-LD cache TTL.                                                                                                                                                                                                                                                              |
| `autoRegister`              | `false`                        | Register unknown pages (GET-path adapters: POST after a 404; the companion: one register-or-revalidate POST, no prior 404 needed).                                                                                                                                              |
| `originTimeoutMs`           | `2000`                         | Origin re-fetch timeout (higher than the API timeout on purpose).                                                                                                                                                                                                               |
| `ssmParameterName`          | `/enhancely/connector/api-key` | Only used when `apiKey` is absent.                                                                                                                                                                                                                                              |
| `ssmRegion`                 | `us-east-1`                    | Region of the SSM parameter.                                                                                                                                                                                                                                                    |
| `ssmTimeoutMs`              | `2000`                         | Bound on the SSM `GetParameter` call (fail-open on expiry).                                                                                                                                                                                                                     |
| `excludePaths`              | `[]`                           | Paths skipped before config/API work; CloudFront-style `*`/`?`.                                                                                                                                                                                                                 |
| `assertedDefaultTtlSeconds` | `0` (off)                      | Asserted minimum DefaultTTL used to cap lifetime-less retries.                                                                                                                                                                                                                  |
| `capSetCookieResponses`     | `false`                        | Companion only: also cap `Set-Cookie` responses (credential-less requests only). **Never** enable on an origin that mints session cookies for anonymous requests — replayed `Set-Cookie` via downstream caches is the session-fixation pattern. TF: `cap_set_cookie_responses`. |

### Key source trade-offs

| Option        | Pros                                               | Cons                                                                                                    |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Baked file    | Zero runtime latency, no extra IAM                 | Key embedded in every published function version; rotation = redeploy + republish + CloudFront update.  |
| SSM parameter | Rotation without redeploy; key never in the bundle | One SSM call per execution environment (cold-start latency); needs `ssm:GetParameter` on the exec role. |

Either way the key stays server-side — it must never appear in anything sent
to the browser (non-negotiable rule #1 of this repo).

## Limits (Lambda@Edge realities)

- **1 MB generated response — headers AND body together** — for
  origin-response triggers; exceeding it makes CloudFront answer the viewer
  with a **502**, not the original page. The adapter accounts for the quota
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
- **Per-request responses pass through**: `Set-Cookie` on the response, or
  `Cache-Control: private`/`no-store`, marks a representation that a
  re-fetch cannot faithfully reproduce — no injection there.
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

### 3. Create + publish (Lambda@Edge triggers need a PUBLISHED VERSION, never `$LATEST`)

```bash
aws lambda create-function --region us-east-1 \
  --function-name enhancely-injector \
  --runtime nodejs20.x \
  --handler index.handler \
  --role arn:aws:iam::<ACCOUNT>:role/enhancely-lambda-edge \
  --timeout 10 --memory-size 256 \
  --zip-file fileb://dist/lambda-origin-request.zip   # origin-response: dist/lambda.zip

aws lambda publish-version --region us-east-1 \
  --function-name enhancely-injector
# note the returned Version → ARN like …:function:enhancely-injector:1
```

Redeploys: `aws lambda update-function-code … --zip-file fileb://dist/lambda-origin-request.zip   # origin-response: dist/lambda.zip`
followed by a fresh `publish-version` and step 4 with the new version ARN.

### 4. Attach to the CloudFront behavior (origin-response)

```bash
aws cloudfront get-distribution-config --id <DIST_ID> > dist-config.json
# In DistributionConfig.DefaultCacheBehavior (or the relevant CacheBehavior).
# EventType must match the artifact you deployed:
#   lambda-origin-request.zip → "origin-request"   (recommended)
#   lambda.zip                → "origin-response"
#   "LambdaFunctionAssociations": {
#     "Quantity": 1,
#     "Items": [{
#       "LambdaFunctionARN": "arn:aws:lambda:us-east-1:<ACCOUNT>:function:enhancely-injector:<VERSION>",
#       "EventType": "origin-request",
#       "IncludeBody": false
#     }]
#   }
#
# Do NOT associate both triggers with the same behavior using these artifacts:
# origin-request already generates the final response, and the origin-response
# adapter would then re-fetch it a second time.
aws cloudfront update-distribution --id <DIST_ID> \
  --if-match <ETag-from-get> \
  --distribution-config file://dist-config.updated.json
```

Recommended alongside: an origin request policy that forwards the viewer
`Host` header, and a cache policy with a non-trivial TTL for HTML (so the
injected page is actually cached and the re-fetch stays a cache-miss cost).

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
timeouts, redirects, Set-Cookie / private / no-store gates, credential-safe
retry policies, Enhancely 404/rate-limit/network errors, and the missing-key
pass-through/cooldown.
