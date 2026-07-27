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
                │    1. gate: GET + status "200" + text/html + no
                │       Content-Encoding + UTF-8-compatible charset +
                │       no Set-Cookie + no private/no-store Cache-Control
                │    2. resolve config (baked file or SSM, memoized)
                │    3. RE-FETCH the page from the custom origin
                │       (same URI+query, incoming Host header, forwarded
                │        Cookie/Authorization/Accept-Language,
                │        Accept-Encoding: identity)
                │    4. handleHtml() from injector-core:
                │       cache → ETag revalidation → Enhancely API → inject
                │    5. replace the response body (within the 1 MB
                │       generated-response quota) — or fail open
                │
                └──> CloudFront caches the INJECTED page ──> viewer
```

**Why re-fetch?** Lambda@Edge **cannot read the origin response body** in
origin-response triggers — CloudFront only exposes status and headers. The
only way to inject into the HTML is to fetch the page again, straight from
the origin (`request.origin.custom` carries domain, port, protocol and origin
path; the incoming `Host` header is forwarded so name-based vhosts resolve).
The re-fetch also forwards the origin request's `Cookie`, `Authorization` and
`Accept-Language` headers, so the origin answers with the **same
representation** it already served (logged-in vs anonymous, negotiated
language). Responses that stamp NEW per-request state — `Set-Cookie`, or
`Cache-Control: private`/`no-store` — cannot be re-fetched faithfully and
pass through untouched.

**What that costs:** one extra origin roundtrip per CloudFront **cache miss**
(origin-response does not fire on cache hits, and CloudFront caches the
injected result). Give HTML behaviors a sensible TTL and the re-fetch cost
amortizes away. The JSON-LD lookup itself is additionally cached per
execution environment (core `MemoryCache` + ETag revalidation).

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
   fetched with `GetParameter` (`WithDecryption: true`) and memoized in module
   scope, so all concurrent invocations of one execution environment share a
   single SSM call. The call is **bounded** (`AbortSignal.timeout`, default
   2 s, at most 2 attempts) — a hung SSM resolves to "no key" (pass-through)
   instead of riding the invocation into a Lambda timeout, which CloudFront
   would surface as a viewer-facing 502. The SDK is imported dynamically and
   only when needed (and never bundled — the Lambda Node runtime ships AWS
   SDK v3).

If neither yields a key, the function logs **one** loud error and passes every
response through uninjected until the execution environment is recycled.

| `connector-config.json` key | Default                        | Notes                                                             |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `apiKey`                    | — (falls back to SSM)          | `sk-…` / `sk-org-…`. Present → SSM is never contacted.            |
| `enhancelyBase`             | `https://app.enhancely.ai`     | Enhancely API base URL.                                           |
| `timeoutMs`                 | `800`                          | Enhancely API call timeout (enforced by the core).                |
| `cacheTtlMs`                | `300000` (5 min)               | JSON-LD cache TTL.                                                |
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
  with a **502**, not the original page. The adapter therefore reserves a
  16 KB header allowance and caps the body at `1 MB − 16 KB` (1,032,192
  bytes): fetched HTML above that cap — or injected HTML pushed above it —
  passes through untouched.
- **No environment variables** (hence the two key sources above).
- **No streaming**: the page is buffered, injected, returned in one piece.
- **Compressed origin answers pass through**: the re-fetch asks for
  `Accept-Encoding: identity`; if the origin sends `Content-Encoding` anyway
  (or the original response carries one), we fail open rather than corrupt.
- **Non-UTF-8 charsets pass through** (`iso-8859-1`, `windows-1252`, …) —
  same gate as the sidecar adapter; transcoding is not supported. Pages with
  **no** charset parameter are additionally verified byte-for-byte: if the
  UTF-8 decode of the fetched bytes is lossy (e.g. a latin1 page declaring
  its charset only in `<meta>`), the response passes through instead of
  caching mojibake.
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
the Host-header-carrying re-fetch and the Cookie/Authorization/
Accept-Language forwarding), mocks the Enhancely API through the core's
`fetchImpl` seam, and mocks `@aws-sdk/client-ssm` to verify key resolution
order, memoization (one `GetParameter` for concurrent cold-start
invocations), the bounded-SSM-timeout fallback, and the real
`connector-config.json` file read (valid, unparsable, junk-typed). Fail-open
coverage includes the exact generated-size boundary (body at the cap, one
byte over, injection pushing it over), origin connection errors and
re-fetch timeouts, redirects, charset/encoding/lossy-decode gates,
Set-Cookie / private / no-store gates, Enhancely 404s and network errors,
and the missing-key pass-through.
