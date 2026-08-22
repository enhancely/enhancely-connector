# lambda-edge-injector — Terraform module

Die aktuelle, kundenunabhängige Laufzeitarchitektur mit Mermaid-Diagrammen,
Request-Zahlen und sämtlichen Cache-/Retry-Zeiten steht in
[`../../../docs/architecture/current-runtime-architecture.md`](../../../docs/architecture/current-runtime-architecture.md).

Deploys the Enhancely JSON-LD connector as Lambda@Edge functions in
`us-east-1`. The default architecture performs one origin request for a normal
generatable HTML cache miss and asks Enhancely only after the origin response
has proved that it is an injectable page. A hard handback can require a second
normal CloudFront fetch.

## Deployment modes

| `deployment_mode`          | Functions                                           | CloudFront associations                   | Use when                                                                                       |
| -------------------------- | --------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `origin-request` (default) | origin-request injector + origin-response companion | both functions on the same cache behavior | Normal CloudFront origins; one origin hit per injectable miss                                  |
| `origin-response`          | standalone origin-response injector                 | origin-response only                      | Existing directly reachable Custom Origins that intentionally retain the legacy two-fetch flow |

The default injector fetches the origin first. Only an exact `200` UTF-8-safe
`text/html` response that is indexable, permits transformation, is not served
as an attachment, and passes the remaining policy/quota gates can trigger an
Enhancely lookup. It then generates either the injected page or the origin's
unmodified HTML, so both paths normally cost one origin request.

The cache-cap-only companion never calls Enhancely, injects, reads the body, or
fetches the origin. It is the origin-response safety net for traffic the
injector must hand back to CloudFront, notably over-quota or otherwise
unreproducible pages. It can safely shorten eligible handback cache lifetimes
so the injector eventually retries. The two functions use the same zip and
baked config so their gates cannot drift.

The compatibility mode retains the original re-fetch architecture. An injected
cache miss costs two origin requests: CloudFront's fetch plus the connector's
identity re-fetch. When `timeout_ms` is omitted, this mode also retains the
historical 2000 ms Enhancely timeout; the default origin-request pair uses 800
ms. Setting `timeout_ms` explicitly overrides the mode-dependent default.

Both injectors can directly fetch only `request.origin.custom`. S3 REST
Origins, including S3 OAC (`request.origin.s3`), pass through in both modes.
Private VPC Origins cannot be injected. A sign-protected Custom Origin is
unsupported: the Lambda fetch is unsigned, so do not associate the default
origin-request mode there. In compatibility mode, CloudFront-managed failover,
Origin Shield and connection retry rules apply to the first fetch only; the
second identity body fetch still runs directly from Lambda. Neither current
mode promises CloudFront-managed semantics for every fetch.

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
  exclude_paths = ["/account/*", "/checkout/*"]
  tags          = { managed-by = "terraform" }
}
```

`deployment_mode = "origin-request"` is the default and may be omitted.

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

Both default-mode associations must be installed on the **same cache
behavior**. Never associate the standalone origin-response injector next to the
origin-request injector. The companion is the only supported origin-response
partner.

### Standalone compatibility mode

```hcl
module "enhancely_injector" {
  source          = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=vX.Y.Z"
  providers       = { aws = aws.us_east_1 }
  deployment_mode = "origin-response"
}
```

The association output then contains only `origin-response`.

## Existing-module migration

Older module versions exposed `qualified_arn` and documented attaching it to
`origin-response`. That output keeps exactly that meaning:

- in `deployment_mode = "origin-response"`, `qualified_arn` is the standalone
  origin-response ARN;
- in the new default mode, `qualified_arn` is intentionally `null` and can
  never silently point an old origin-response association at the
  origin-request handler.

To upgrade without changing architecture, add
`deployment_mode = "origin-response"` in the same configuration change as the
module-ref bump and review the plan before applying. To migrate to the default
pair, replace the old association with
`lambda_function_associations` in the same reviewed change. Lambda@Edge uses
published, immutable versions; old replicated versions can linger after an
association moves, so allow for AWS replication/deletion delays during staged
rollouts.

## API key

Create the SecureString out of band. The module does not manage it by default,
because Terraform would otherwise read its decrypted value into state during
refresh:

```bash
aws ssm put-parameter --region us-east-1 \
  --name /enhancely/connector/api-key \
  --type SecureString --value 'sk-…'
```

Until the parameter exists, both modes fail open and serve uninjected pages.
Use an organization key (`sk-org-…`) to cover all domains in one Enhancely
organization. Setting `create_ssm_parameter = true` creates only a
`REPLACE_ME` convenience placeholder and is intended for throwaway setups.

## Important inputs

| Input                          | Default          | Meaning                                                                                                                                                                                                   |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment_mode`              | `origin-request` | Recommended pair or standalone compatibility mode                                                                                                                                                         |
| `timeout_ms`                   | mode-dependent   | Optional Enhancely API timeout: `800` in origin-request, historical `2000` in origin-response; max `6000`, and its sum with `origin_timeout_ms` must be ≤ `6000`                                          |
| `origin_timeout_ms`            | `2000`           | Origin fetch/re-fetch timeout; max `6000`, and its sum with `timeout_ms` must be ≤ `6000`                                                                                                                 |
| `cache_ttl_ms`                 | `300000`         | JSON-LD memory-cache freshness; stale entries retain their ETag                                                                                                                                           |
| `auto_register`                | `false`          | `false`: conditional GET only. `true`: one register-or-revalidate POST that reads known pages or registers unknown real HTML pages                                                                        |
| `exclude_paths`                | `[]`             | Canonicalized request paths skipped before config or network work                                                                                                                                         |
| `non_page_memo_ttl_ms`         | `1800000`        | Origin-request memo only for hard handbacks that can neither be injected nor safely generated; redirects, 404s and small veto responses are not stored                                                    |
| `asserted_default_ttl_seconds` | `0`              | Optional retry-cache cap assertion; keep `0` if any associated behavior has DefaultTTL `0`                                                                                                                |
| `cap_set_cookie_responses`     | `false`          | Pair-wide assertion used by origin-request fallback and companion (and by standalone origin-response) to cap anonymous `Set-Cookie` pass-throughs; unsafe for origins that mint anonymous session cookies |

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
the effective `timeout_ms + origin_timeout_ms > 6000`. The origin-request
defaults consume 2800 ms of that combined allowance; the historical
origin-response defaults consume 4000 ms. Hand-written `connector-config.json`
deployments get the same runtime protection: `timeoutMs + originTimeoutMs +
ssmTimeoutMs` may not exceed 8000 ms; an unsafe set is ignored together and the
known-safe 800/2000/2000 ms runtime defaults are used.

`exclude_paths` uses CloudFront-style `*` and `?` globs. Matching decodes RFC
3986 unreserved escapes once, treats literal backslashes as slashes, and
collapses duplicate slashes and dot segments. Reserved, non-ASCII, malformed,
and double-encoded octets remain literal.

`asserted_default_ttl_seconds` is an operator assertion that every associated
behavior has at least that DefaultTTL. Use the smallest value across those
behaviors. A conservative understatement is safe; an overstatement is not.

Do not enable `cap_set_cookie_responses` on an origin that creates session
cookies for anonymous requests. Writing a shared-cache lifetime in that case
could replay one visitor's `Set-Cookie` to another visitor.

## Outputs

- `lambda_function_associations` — recommended, pairing-safe map for the
  selected mode.
- `origin_request_qualified_arn` and `companion_qualified_arn` — non-null only
  in the default mode.
- `origin_response_qualified_arn` — non-null only in compatibility mode.
- `qualified_arn` — deprecated alias for the standalone origin-response ARN;
  deliberately null in the default mode.

## Requirements and trade-offs

- Pass an `us-east-1` provider; the module enforces this at plan/apply time.
- The distribution's origin request policy should forward the viewer `Host`
  header. Origins that cannot receive it, such as S3 website endpoints, can use
  the static origin custom header `X-Enhancely-Page-Host` for the public host.
- The default origin-request function performs its own network fetch. The
  compatibility mode lets CloudFront perform the first fetch, but its second
  identity re-fetch is still direct. S3 REST including S3 OAC is pass-through;
  private VPC Origins are not injectable; sign-protected Custom Origins are
  unsupported. Origin Group/Shield/retry semantics are not end-to-end.
- Lambda@Edge generated-response quotas still apply. Responses the default
  injector cannot safely generate are handed back to CloudFront and remembered
  briefly so repeats avoid the extra classification fetch.
- No separate cache infrastructure is required. CloudFront caches page
  responses; each execution environment keeps the JSON-LD cache and uses ETag
  revalidation.
- Generated zip paths include the target AWS account ID and function name, so
  parallel module instances for different provider aliases/accounts cannot
  overwrite one another in the shared module source directory.

## Upgrading

Bump the pinned `?ref=`. Every release keeps the module's three bundled
entrypoints (`index.js`, `origin-request.js`, and `companion.js`) synchronized
with the corresponding adapter build and packages deploy-specific config into
the generated zip at plan time.
