# @enhancely/adapter-lambda-edge

CloudFront **Lambda@Edge** adapter for the Enhancely JSON-LD injector.

> **Status: implemented + tested.** Origin-response trigger with the
> **origin re-fetch pattern** (see below). All connector logic comes from
> `@enhancely/injector-core` — this adapter only translates CloudFront event
> shapes and wires up the two edge-specific concerns: key resolution without
> environment variables, and getting hold of the HTML body at all.

## Architecture: origin-response + re-fetch — and why

```
viewer ──> CloudFront ──(cache miss)──> origin
                │                          │
                │<───── origin response ───┘   status + headers ONLY
                │
                ├─ origin-response trigger: this handler
                │    1. gate: GET + status "200" + text/html +
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
                │    5. replace the response body (within the 1 MB
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
origin re-fetch. For public requests without `Authorization` or `Cookie`, the
adapter marks that response `max-age=0`, caps CloudFront `s-maxage` at the next
meaningful retry (404 cache TTL, `Retry-After`/error backoff, or config
cooldown), and removes `ETag`, `Last-Modified`, and `Expires`. It never exceeds
a shorter origin `max-age`, `s-maxage`, or `Expires`. CloudFront therefore runs
the origin-response Lambda again when the lookup/config should recover and
cannot retain the old uninjected body via a 304. Credentialed requests remain
byte-for-byte pass-through so the adapter never grants shared-cache permission.

**Fail-open invariant:** the whole handler is wrapped in try/catch and always
returns the original response — config unresolvable, re-fetch error/timeout/
non-200/redirect, body over the generated-response quota, unexpected charset
or Content-Encoding, lossy UTF-8 decode, core or API errors. The customer's
page is never at risk; worst case is one uninjected view.

The re-fetch deliberately uses `node:http`/`node:https`, not `fetch`:
undici's `fetch` treats `Host` as a forbidden header and silently drops it,
which would break virtual hosts on the origin.

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

| `connector-config.json` key | Default                        | Notes                                                             |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `apiKey`                    | — (falls back to SSM)          | `sk-…` / `sk-org-…`. Present → SSM is never contacted.            |
| `enhancelyBase`             | `https://app.enhancely.ai`     | Enhancely API base URL.                                           |
| `timeoutMs`                 | `800`                          | Enhancely API call timeout (enforced by the core).                |
| `cacheTtlMs`                | `300000` (5 min)               | JSON-LD cache TTL.                                                |
| `autoRegister`              | `false`                        | POST unknown pages after 404 and use the pending cache policy.    |
| `originTimeoutMs`           | `2000`                         | Origin re-fetch timeout (higher than the API timeout on purpose). |
| `ssmParameterName`          | `/enhancely/connector/api-key` | Only used when `apiKey` is absent.                                |
| `ssmRegion`                 | `us-east-1`                    | Region of the SSM parameter.                                      |
| `ssmTimeoutMs`              | `2000`                         | Bound on the SSM `GetParameter` call (fail-open on expiry).       |

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
  unambiguous UTF-8 BOM; safely emulating the browser's context-sensitive HTML
  meta prescan is out of scope, so non-ASCII meta/no-meta pages pass through.
  Generated HTML is always advertised explicitly as
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
- Best results when the origin request policy **forwards the viewer `Host`
  header** — it is used both for the re-fetch vhost and for the page URL sent
  to Enhancely. Without it, the origin domain is used instead.

## Build & package

```bash
pnpm --filter @enhancely/injector-core build          # once, or `pnpm -r build`
pnpm --filter @enhancely/adapter-lambda-edge build    # typecheck + esbuild bundle → dist/index.js
pnpm --filter @enhancely/adapter-lambda-edge package  # → dist/lambda.zip (includes connector-config.json when present)
```

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
  --zip-file fileb://dist/lambda.zip

aws lambda publish-version --region us-east-1 \
  --function-name enhancely-injector
# note the returned Version → ARN like …:function:enhancely-injector:1
```

Redeploys: `aws lambda update-function-code … --zip-file fileb://dist/lambda.zip`
followed by a fresh `publish-version` and step 4 with the new version ARN.

### 4. Attach to the CloudFront behavior (origin-response)

```bash
aws cloudfront get-distribution-config --id <DIST_ID> > dist-config.json
# In DistributionConfig.DefaultCacheBehavior (or the relevant CacheBehavior):
#   "LambdaFunctionAssociations": {
#     "Quantity": 1,
#     "Items": [{
#       "LambdaFunctionARN": "arn:aws:lambda:us-east-1:<ACCOUNT>:function:enhancely-injector:<VERSION>",
#       "EventType": "origin-response",
#       "IncludeBody": false
#     }]
#   }
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
