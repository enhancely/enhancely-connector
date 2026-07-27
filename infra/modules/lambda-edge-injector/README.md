# lambda-edge-injector — Terraform module

Deploys the Enhancely JSON-LD injector as a CloudFront **Lambda@Edge**
(origin-response) function. This is the standard integration path for
customers running CloudFront: pin the module at a release tag, attach the
output ARN to your distribution, put the API key into SSM — done.

No cache infrastructure is required: CloudFront caches the injected page,
the function keeps a per-execution-environment memory cache, and ETag
revalidation keeps refreshes cheap. Fail-open end to end — the function can
never break page delivery.

## Usage

```hcl
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1" # Lambda@Edge requirement
}

module "enhancely_injector" {
  source    = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=v0.2.0"
  providers = { aws = aws.us_east_1 }

  name           = "acme-enhancely-injector"
  enhancely_base = "https://app.enhancely.ai"
  auto_register  = true # pages self-register from real traffic
  tags           = { managed-by = "terraform" }
}
```

Attach to your distribution (works with plain resources or
terraform-aws-modules/cloudfront):

```hcl
lambda_function_association = {
  origin-response = {
    lambda_arn   = module.enhancely_injector.qualified_arn
    include_body = false
  }
}
```

After the first apply, set the real API key (never in repo/state):

```bash
aws ssm put-parameter --region us-east-1 \
  --name /enhancely/connector/api-key \
  --type SecureString --overwrite --value 'sk-…'
```

Use an **organization key** (`sk-org-…`) to cover every domain of your
Enhancely organization with one parameter — records are routed to the right
project per domain server-side. Swapping the key needs no redeploy.

## Upgrading

Bump `?ref=` to the new release tag. The bundled `dist/index.js` ships with
the module at each tag; Terraform picks up the change via `source_code_hash`,
publishes a new function version and rolls the CloudFront association.

## Requirements & notes

- Pass an **us-east-1** provider (enforced by a precondition).
- The distribution's origin request policy should forward the viewer `Host`
  header (e.g. `Managed-AllViewer`). Origins that must not receive it (S3
  website endpoints) instead declare the public hostname as a static origin
  custom header `X-Enhancely-Page-Host`.
- Responses larger than ~1 MB (headers + body, Lambda@Edge quota) pass
  through uninjected; same for non-HTML, non-200, Set-Cookie and
  Cache-Control private/no-store responses.
