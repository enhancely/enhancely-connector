# @enhancely/adapter-lambda-edge

CloudFront Lambda@Edge adapter for the Enhancely JSON-LD injector.

The adapter has exactly one supported deployment architecture:

1. `src/origin-request.ts` is the injector.
2. `src/companion.ts` is its cache-cap-only `origin-response` companion.
3. Both functions are associated with the same CloudFront cache behavior.

Version 0.10.0 removes the unused standalone origin-response injector and its
double-origin-fetch architecture. The companion is not an injector: it never
reads a body, calls Enhancely, registers a URL, or fetches the origin.

All connector logic comes from `@enhancely/injector-core`. Edge-specific shared
logic lives in `src/shared.ts` and `src/cache-cap.ts`.

The complete platform-neutral architecture, Mermaid diagrams, request matrix,
and cache timing reference are in
[`../../docs/architecture/current-runtime-architecture.md`](../../docs/architecture/current-runtime-architecture.md).

## Runtime architecture

```text
viewer
  │
  ▼
CloudFront cache
  │ cache miss
  ▼
origin-request injector
  ├─ local request/host/path gates
  ├─ one direct custom-origin fetch
  ├─ exact 200 text/html + charset/header/head/body-budget gates
  ├─ JSON-LD cache, then at most one Enhancely request if stale/missing
  └─ generate injected or safely reproducible original response
       │
       └─ hard handback only ──> CloudFront origin
                                  │
                                  ▼
                         origin-response companion
                         (safe cache cap only)
```

An origin-request-generated response does not invoke the origin-response
trigger. Therefore normal injected and safely reproducible pass-through paths
use one origin response and never run the companion. A CloudFront cache hit
invokes neither Lambda.

The origin-request injector deliberately fetches the origin before contacting
Enhancely. Only an exact `200 text/html` response that passes charset,
`X-Robots-Tag`, `Cache-Control: no-transform`, `Content-Disposition`, structural
`</head>`, header-quota, and body-budget checks can cause an Enhancely lookup.
Extension-less redirects, errors, non-HTML responses, and documents without a
safe head therefore cost zero Enhancely calls.

## Request counts

Counts below are per CloudFront viewer request.

| Case                                                                                                                    |                   Direct/CloudFront origin responses |                      Enhancely requests |                               Companion |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------: | --------------------------------------: | --------------------------------------: |
| CloudFront cache hit                                                                                                    |                                                    0 |                                       0 |                                       0 |
| Eligible HTML, fresh JSON-LD cache                                                                                      |                                                    1 |                                       0 |                                       0 |
| Eligible HTML, stale/missing JSON-LD cache                                                                              |                                                    1 |                               at most 1 |                                       0 |
| Exact 200 HTML without usable `</head>`                                                                                 |                                                    1 |                                       0 |                                       0 |
| Reproducible redirect, `4xx`/`5xx`, empty `204`, small non-HTML, noindex, unsafe charset, `no-transform`, or attachment |                                                    1 |                                       0 |                                       0 |
| Small reproducible veto/body                                                                                            |                                                    1 |                                       0 |                                       0 |
| Snippet exceeds generated-response budget but original fits                                                             |                                                    1 |                               at most 1 |                                       0 |
| Hard handback: response cannot safely be generated                                                                      | 2 on first classification, normally 1 while memoized | 0 or at most 1 before the quota verdict | 1 cache-cap invocation, 0 network calls |

Hard handbacks are deliberately rare. Their verdict is remembered for
`nonPageMemoTtlMs` (30 minutes by default) per full public URL and execution
environment, so repeats skip the known-unusable classification fetch and let
CloudFront fetch the origin normally. They include unsupported response statuses
such as `201`–`203`, body-bearing `204`, `205`–`299`, and `304`, as well as
responses that cannot fit safely in a generated CloudFront result.

## CloudFront prerequisites

- Use a directly reachable **Custom Origin**. The Lambda fetches it itself.
  S3 REST/OAC, VPC-only, signature-protected, or otherwise private origins are
  not suitable.
- Expose every query string that changes the origin representation through the
  cache or origin request policy. Otherwise the direct fetch cannot reproduce
  the requested representation.
- Associate the injector and companion with the **same behavior**. Use the
  Terraform module's `lambda_function_associations` output to prevent drift.
- Keep Lambda off asset/media behaviors entirely. An in-function extension or
  path gate prevents downstream work, but it cannot avoid an invocation after
  CloudFront has selected an associated behavior.
- Lambda@Edge functions and versions must be created in `us-east-1` and have a
  fixed 10-second timeout.

### Host selection and cache isolation

`includeHosts` (Terraform: `include_hosts`) accepts exact DNS hostnames only:
no wildcard, scheme, port, credentials, or path. It is checked before SSM,
origin fetch, Enhancely, registration, and companion cache rewriting. Empty
means all hosts; a malformed non-empty hand-written list matches nothing.

If host policy differs between aliases sharing a behavior, viewer `Host` must
be in the CloudFront **cache policy**, or each host must use a separate
distribution. An origin request policy alone does not partition cache hits.
The Terraform module therefore requires
`host_in_cache_key_asserted = true` whenever `include_hosts` is non-empty; only
set it after verifying the external cache policy.

A static `X-Enhancely-Page-Host` custom-origin header can represent one fixed
public host. It cannot distinguish aliases. Duplicate or explicitly empty
`Host`/override fields veto connector work.

### Path exclusions

`excludePaths` (Terraform: `exclude_paths`) uses CloudFront-style `*` and `?`
wildcards and runs before config/API work. Matching decodes RFC 3986 unreserved
octets once, maps literal backslashes to `/`, then collapses duplicate slashes
and dot-segments. Reserved, non-ASCII, malformed, and double-encoded octets
stay literal.

Use the repository helper to find candidate asset behaviors:

```bash
pnpm asset-paths https://www.example.com/ https://www.example.com/page
```

The tool uses the adapter's own non-HTML extension list. Review every suggested
path because CloudFront behavior patterns apply to all aliases of a
distribution.

## Configuration

Lambda@Edge has no user-defined environment variables. Configuration is read
in this order:

1. `connector-config.json`, baked next to `index.js` at deployment time.
2. SSM Parameter Store when no baked `apiKey` exists.

Start from
[`connector-config.example.json`](connector-config.example.json). Never commit
the populated file. SSM is called with `WithDecryption: true`, bounded by
`ssmTimeoutMs`, shared by concurrent cold invocations, and memoized for the
execution environment. A missing/unavailable config enters a 30-second
fail-open cooldown before retry.

| Key                         |                        Default | Meaning                                                                                     |
| --------------------------- | -----------------------------: | ------------------------------------------------------------------------------------------- |
| `apiKey`                    |                   SSM fallback | Server-side `sk-…` / `sk-org-…`; never returned or logged.                                  |
| `enhancelyBase`             |     `https://app.enhancely.ai` | Enhancely API base.                                                                         |
| `timeoutMs`                 |                         800 ms | Timeout for each Enhancely call.                                                            |
| `originTimeoutMs`           |                       2,000 ms | Direct custom-origin fetch timeout.                                                         |
| `ssmTimeoutMs`              |                       2,000 ms | SSM config timeout.                                                                         |
| `cacheTtlMs`                |                     300,000 ms | JSON-LD freshness before ETag revalidation.                                                 |
| `autoRegister`              |                        `false` | `false`: read-only GET. `true`: one direct register-or-revalidate POST; never GET→404→POST. |
| `ssmParameterName`          | `/enhancely/connector/api-key` | Encrypted parameter name.                                                                   |
| `ssmRegion`                 |                    `us-east-1` | Parameter region.                                                                           |
| `excludePaths`              |                           `[]` | Early path policy.                                                                          |
| `includeHosts`              |                           `[]` | Early exact-host policy.                                                                    |
| `assertedDefaultTtlSeconds` |                            `0` | Optional proven lower bound for behavior DefaultTTL.                                        |
| `nonPageMemoTtlMs`          |                   1,800,000 ms | Hard-handback classification memo.                                                          |
| `capSetCookieResponses`     |                        `false` | Permit retry caps on credential-less `Set-Cookie` responses only after operator proof.      |

The three timeout fields form one atomic safety set for a hand-written baked
config. They are accepted only when
`timeoutMs + originTimeoutMs + ssmTimeoutMs <= 8000`; otherwise the adapter uses
the safe `800 + 2000 + 2000` ms defaults. The Terraform module separately
enforces `timeout_ms + origin_timeout_ms <= 6000`, reserving 2 seconds for SSM
and 2 seconds for fail-open settlement under Lambda's 10-second limit.

## Cache and retry behavior

The connector's JSON-LD cache is independent from CloudFront's HTML cache.

| State                                 | Local duration / action                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| Fresh positive/negative JSON-LD       | `cacheTtlMs`, default 5 minutes                                  |
| Stale positive                        | conditional ETag revalidation; retained on transient failure     |
| Ordinary API error/timeout            | 10-second URL-local retry memo                                   |
| GET `429`                             | `Retry-After`, else `RateLimit-Reset`, bounded to 60 seconds     |
| Register POST `429`                   | URL-local hint up to 24 hours; shared circuit at most 60 seconds |
| Register POST `403`                   | URL-local hint up to 24 hours; never opens the shared circuit    |
| Shared API-key circuit                | only HTTP `429`, at most 60 seconds                              |
| Hard handback/non-page classification | `nonPageMemoTtlMs`, default 30 minutes                           |
| Proven origin setup/request failure   | 10-second endpoint or exact-request circuit                      |
| Missing config/SSM failure            | 30-second retry cooldown                                         |

The in-process JSON-LD cache is bounded to 5,000 entries and a conservative
16 MiB retained-string estimate. Concurrent lookups are single-flighted and
local writes are serialized. The companion owns no JSON-LD cache.

For a safely cacheable uninjected retry response, the injector or companion can
shorten the existing cache lifetime:

```text
retryTtl = max(1, ceil(revalidateInMs / 1000))
writtenTtl = min(retryTtl, proven existing cache lifetime)
```

The proven lifetime comes from `no-cache`, `s-maxage`, `max-age`, `Expires`, or
the optional `assertedDefaultTtlSeconds`. With no explicit lifetime and the
assertion at `0`, the response is unchanged. Requests with `Authorization` or
`Cookie`, responses with `private`/`no-store`, ambiguous cache fields, and
`Set-Cookie` responses without `capSetCookieResponses` are never rewritten.
The companion applies these invariant gates before config resolution, so a
response that cannot be capped also causes no SSM request.
A CloudFront cache-policy `MinimumTTL` can still override the desired retry
window; use `0` when precise retry timing matters.

## Injection and fail-open gates

Injection requires all of the following:

- method `GET`, no Range request;
- exact status `200`;
- exactly one unambiguous `Content-Type: text/html` field;
- UTF-8-compatible or absent charset with lossless UTF-8 decoding;
- no `X-Robots-Tag: noindex|none`;
- no `Cache-Control: no-transform`;
- absent or explicitly `inline` `Content-Disposition`;
- parser-safe real `</head>`;
- body, headers, and prospective snippet within Lambda quotas.

Every other case is fail-open: serve the original response unchanged or hand
the request back to CloudFront. Generated responses enforce Lambda@Edge's
32 KiB header limit and 1 MiB combined header/body limit with an extra 1 KiB
safety margin. Injected responses are explicitly UTF-8 and remove validators,
digests, and lengths that described the uninjected body.

`X-Enhancely-Injected` is a never-touch-injected-content invariant. The
companion abstains if it sees the marker; pairing safety itself comes from the
CloudFront associations, because generated origin-request responses do not
invoke origin-response.

## Build and package

```bash
pnpm --filter @enhancely/adapter-lambda-edge build
pnpm --filter @enhancely/adapter-lambda-edge test
pnpm --filter @enhancely/adapter-lambda-edge package
```

The package command produces two deployable zips. The origin-request build uses
a handler-only production entrypoint, so unit-test
reset seams from the implementation module cannot enter the Lambda artifact.

| Artifact                         | CloudFront event  | Handler         |
| -------------------------------- | ----------------- | --------------- |
| `dist/lambda-origin-request.zip` | `origin-request`  | `index.handler` |
| `dist/lambda-companion.zip`      | `origin-response` | `index.handler` |

The release publishes the matching self-contained JavaScript and ZIP assets,
plus `SHA256SUMS`. Both functions must receive the same baked configuration.
Prefer the Terraform module, which creates immutable versions, IAM/SSM access,
and the pairing-safe association map.

## Live conformance

Unit tests cannot prove CloudFront's treatment of generated bodies, compression,
duplicate `Set-Cookie`, or Lambda quotas. Run the opt-in suite only against an
operator-owned fixture distribution:

```bash
pnpm conformance https://connector-fixtures.example
```

The suite adds randomized query parameters and aborts if it observes a cache
hit, so it tests the deployed functions rather than a prior cached page. The
distribution must still be configured to forward/cache the queries required by
the fixture.
