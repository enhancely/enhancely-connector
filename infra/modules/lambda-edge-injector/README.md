# lambda-edge-injector — Terraform module

Die aktuelle, kundenunabhängige Laufzeitarchitektur mit Mermaid-Diagrammen,
Request-Zahlen und sämtlichen Cache-/Retry-Zeiten steht in
[`../../../docs/architecture/current-runtime-architecture.md`](../../../docs/architecture/current-runtime-architecture.md).

Deploys the Enhancely JSON-LD connector as Lambda@Edge functions in
`us-east-1`. The default architecture performs one origin request for a normal
generatable HTML cache miss and asks Enhancely only after the origin response
has proved that it is an injectable page. A hard handback can require a second
normal CloudFront fetch.

## Architecture

The module creates exactly two Lambda@Edge functions that must be associated
with the same cache behavior:

- an `origin-request` injector;
- an `origin-response` cache-cap-only companion.

There is no deployment-mode switch and no standalone origin-response injector.

The injector fetches the origin first. Only an exact `200` UTF-8-safe
`text/html` response that is indexable, permits transformation, has no valid
non-`inline` content disposition, and passes the remaining policy/quota gates can trigger an
Enhancely lookup. It then generates either the injected page or the origin's
unmodified HTML, so both paths normally cost one origin request.

The cache-cap-only companion never calls Enhancely, injects, reads the body, or
fetches the origin. It is the origin-response safety net for traffic the
injector must hand back to CloudFront, notably over-quota or otherwise
unreproducible pages. It can safely shorten eligible handback cache lifetimes
so the injector eventually retries. The two functions use the same zip and
baked config so their gates cannot drift.

The injector can directly fetch only `request.origin.custom`. S3 REST Origins,
including S3 OAC (`request.origin.s3`), pass through. Private VPC Origins cannot
be injected. A sign-protected Custom Origin is unsupported because the Lambda
fetch is unsigned. CloudFront-managed Origin Group, Origin Shield and retry
semantics do not apply to the injector's direct fetch.

## Usage

```hcl
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1" # Lambda@Edge requirement
}

module "enhancely_injector" {
  source    = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=vX.Y.Z"
  providers = { aws = aws.us_east_1 }

  name          = "acme-enhancely-injector"
  auto_register = true
  include_hosts = ["www.example.com"]
  host_in_cache_key_asserted = true # after checking the behavior's cache policy
  exclude_paths = ["/account/*", "/checkout/*"]
  tags          = { managed-by = "terraform" }
}
```

For `terraform-aws-modules/cloudfront`, pass the pairing-safe output directly
to each intended cache behavior:

```hcl
lambda_function_association = module.enhancely_injector.lambda_function_associations
```

For a plain `aws_cloudfront_distribution`, render the same map as nested
blocks:

```hcl
dynamic "lambda_function_association" {
  for_each = module.enhancely_injector.lambda_function_associations

  content {
    event_type   = lambda_function_association.key
    lambda_arn   = lambda_function_association.value.lambda_arn
    include_body = lambda_function_association.value.include_body
  }
}
```

Both associations must be installed on the **same cache behavior**. The
companion is the only supported origin-response function and never injects.

## API key

Create the SecureString out of band. The module does not manage it by default,
because Terraform would otherwise read its decrypted value into state during
refresh:

```bash
aws ssm put-parameter --region us-east-1 \
  --name /enhancely/connector/api-key \
  --type SecureString --value 'sk-…'
```

Until the parameter exists, the pair fails open and serves uninjected pages.
Use an organization key (`sk-org-…`) to cover all domains in one Enhancely
organization. Setting `create_ssm_parameter = true` creates only a
`REPLACE_ME` convenience placeholder and is intended for throwaway setups.

## Important inputs

| Input                          | Default   | Meaning                                                                                                                                                                    |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout_ms`                   | `800`     | Enhancely API timeout; max `6000`, and its sum with `origin_timeout_ms` must be ≤ `6000`                                                                                   |
| `origin_timeout_ms`            | `2000`    | Direct origin-fetch timeout; max `6000`, and its sum with `timeout_ms` must be ≤ `6000`                                                                                    |
| `cache_ttl_ms`                 | `300000`  | JSON-LD memory-cache freshness; stale entries retain their ETag                                                                                                            |
| `auto_register`                | `false`   | `false`: conditional GET only. `true`: one register-or-revalidate POST that reads known pages or registers unknown real HTML pages                                         |
| `include_hosts`                | `[]`      | Exact public page hostnames enabled before SSM, connector-origin, Enhancely, or companion work. No wildcards/schemes/paths/ports. Empty = all hosts.                       |
| `host_in_cache_key_asserted`   | `false`   | Required operator assertion for non-empty `include_hosts`: Viewer Host is in the associated cache key, or hosts use separate distributions. Does not configure CloudFront. |
| `exclude_paths`                | `[]`      | Canonicalized request paths skipped before config or network work                                                                                                          |
| `non_page_memo_ttl_ms`         | `1800000` | Origin-request memo for hard handbacks that can neither be injected nor safely generated; redirects, 404s and small veto responses are not stored                          |
| `asserted_default_ttl_seconds` | `0`       | Optional retry-cache cap assertion; keep `0` if any associated behavior has DefaultTTL `0`                                                                                 |
| `cap_set_cookie_responses`     | `false`   | Pair-wide assertion used by the injector fallback and companion to cap anonymous `Set-Cookie` pass-throughs; unsafe for origins that mint anonymous session cookies        |

### Ten-second fail-open budget

Both Lambda@Edge functions use a fixed 10-second Lambda timeout. A hard Lambda
termination makes CloudFront return an error to the viewer; it cannot execute
the connector's normal fail-open path. The module therefore budgets the worst
first invocation conservatively:

- up to 2000 ms for resolving the API key from SSM;
- at most 6000 ms combined for the sequential origin and Enhancely calls;
- at least 2000 ms left for cold start, dynamic SDK loading, abort/socket
  settlement, and serializing the original fail-open response.

Terraform rejects either timeout above 6000 ms and rejects configurations where
`timeout_ms + origin_timeout_ms > 6000`. The defaults consume 2800 ms of that
combined allowance. Hand-written `connector-config.json`
deployments get the same runtime protection: `timeoutMs + originTimeoutMs +
ssmTimeoutMs` may not exceed 8000 ms; an unsafe set is ignored together and the
known-safe 800/2000/2000 ms runtime defaults are used.

`exclude_paths` uses CloudFront-style `*` and `?` globs. Matching decodes RFC
3986 unreserved escapes once, treats literal backslashes as slashes, and
collapses duplicate slashes and dot segments. Reserved, non-ASCII, malformed,
and double-encoded octets remain literal.

`include_hosts` is an injector selector, not an access-control rule: excluded
hosts continue through CloudFront normally and byte-identically. Matching is
exact and case-insensitive after IDNA/Punycode canonicalization; a final DNS
dot stays distinct. An explicitly supplied malformed hand-written baked policy
matches nothing. It prevents SSM/origin/Enhancely/cache-cap work, not the
Lambda@Edge invocation already selected by the cache behavior; use narrower
behaviors or separate distributions to avoid that invocation cost. Because
origin-facing Lambda triggers do not run on cache hits, a
host-dependent policy is safe across multiple aliases only when the viewer
`Host` is part of the behavior's **cache policy** or the aliases use separate
distributions. An origin request policy alone does not partition cached
objects. See AWS's [default cache-key definition](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-the-cache-key.html)
and [header caching rules](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/header-caching.html).
The module refuses a non-empty `include_hosts` list until the operator sets
`host_in_cache_key_asserted = true` after verifying that external configuration.

`asserted_default_ttl_seconds` is an operator assertion that every associated
behavior has at least that DefaultTTL. Use the smallest value across those
behaviors. A conservative understatement is safe; an overstatement is not.

Do not enable `cap_set_cookie_responses` on an origin that creates session
cookies for anonymous requests. Writing a shared-cache lifetime in that case
could replay one visitor's `Set-Cookie` to another visitor.

## Outputs

- `lambda_function_associations` — pairing-safe map for the required
  origin-request injector and origin-response companion.
- `injector_function_name` and `companion_function_name` — deployed Lambda
  names.
- `ssm_parameter_name` and `role_arn` — operational resource identifiers.

## Requirements and trade-offs

- AWS provider `>= 5.77, < 7.0`. Provider 6 currently emits a deprecation warning for
  the region attribute retained for 5.77 compatibility; validation and tests
  support both major versions.
- Pass an `us-east-1` provider; the module enforces this at plan/apply time.
- The distribution's origin request policy should forward the viewer `Host`
  header. Origins that cannot receive it, such as S3 website endpoints, can use
  the static origin custom header `X-Enhancely-Page-Host` for the public host.
  Host fields must resolve to one non-empty value; an empty static override
  vetoes connector work rather than falling back to the origin hostname.
- When `include_hosts` distinguishes aliases on one custom-origin behavior,
  viewer `Host` must be in the **cache policy** (which also forwards it). The
  static page-host header is fixed per origin and cannot distinguish several
  viewer aliases.
- For representation-faithful direct origin fetches on query-dependent pages,
  the cache policy or origin request policy must expose **all query strings**
  to the origin-facing Lambda event, as required by AWS's
  [Lambda@Edge query-string restriction](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html#edge-function-restrictions-query-string).
- The origin-request function performs its own network fetch. S3 REST including
  S3 OAC is pass-through; private VPC Origins are not injectable;
  sign-protected Custom Origins are unsupported. Origin Group/Shield/retry
  semantics are not end-to-end.
- Lambda@Edge generated-response quotas still apply. Responses the injector
  cannot safely generate are handed back to CloudFront and remembered
  briefly so repeats avoid the extra classification fetch.
- No separate cache infrastructure is required. CloudFront caches page
  responses; each execution environment keeps the JSON-LD cache and uses ETag
  revalidation.
- Generated zip paths include the target AWS account ID and function name, so
  parallel module instances for different provider aliases/accounts cannot
  overwrite one another in the shared module source directory.

## Upgrading

Bump the pinned `?ref=`. Every release keeps the module's two bundled
entrypoints (`origin-request.js` and `companion.js`) synchronized with the
corresponding adapter build and packages deploy-specific config into the
generated zip at plan time.
