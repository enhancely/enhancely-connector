# =============================================================================
# Enhancely JSON-LD Injector — reusable Lambda@Edge module
#
# Creates the Lambda@Edge functions, their shared IAM role and an optional SSM
# SecureString placeholder for the API key.
#
# Creates exactly one supported pair:
#   - origin-request injector: fetches the origin once, then generates the page
#   - origin-response companion: cache-cap only, never calls Enhancely or injects
#
# Consume `lambda_function_associations` to install both handlers on the same
# cache behavior. The module intentionally has no standalone origin-response
# injector or deployment-mode switch.
#
# IMPORTANT: pass an us-east-1 provider — Lambda@Edge functions must be
# created there (execution happens at the edge POPs, not in us-east-1):
#
#   module "enhancely_injector" {
#     source    = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=vX.Y.Z"
#     providers = { aws = aws.us_east_1 }
#     ...
#   }
#
# The bundled JavaScript entrypoints ship with the module at the pinned git ref —
# upgrading the connector = bumping `ref`. No cache infrastructure is needed:
# CloudFront caches the injected page, the function keeps a per-execution-
# environment memory cache, and ETag revalidation keeps refreshes cheap.
# =============================================================================

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  companion_function_name = "${var.name}-companion"

  # Lambda@Edge functions in this module deliberately use a fixed 10-second
  # hard timeout. A first invocation can spend up to 2 seconds resolving the
  # API key from SSM before the sequential origin + Enhancely calls begin.
  # Keep another 2 seconds outside all AbortSignal budgets for cold start,
  # dynamic SDK loading, timer/abort settlement and serializing the original
  # fail-open response. Therefore the two operator-controlled call budgets may
  # consume at most 6 seconds together.
  lambda_timeout_seconds                 = 10
  ssm_config_timeout_budget_ms           = 2000
  fail_open_settlement_reserve_ms        = 2000
  configurable_network_timeout_budget_ms = local.lambda_timeout_seconds * 1000 - local.ssm_config_timeout_budget_ms - local.fail_open_settlement_reserve_ms

  # Deploy-specific config WITHOUT the API key — the key is read from SSM at
  # runtime, so no secret lands in either globally replicated artifact.
  connector_config = jsonencode({
    enhancelyBase             = var.enhancely_base
    ssmParameterName          = var.ssm_parameter_name
    ssmRegion                 = "us-east-1"
    timeoutMs                 = var.timeout_ms
    originTimeoutMs           = var.origin_timeout_ms
    cacheTtlMs                = var.cache_ttl_ms
    autoRegister              = var.auto_register
    assertedDefaultTtlSeconds = var.asserted_default_ttl_seconds
    nonPageMemoTtlMs          = var.non_page_memo_ttl_ms
    capSetCookieResponses     = var.cap_set_cookie_responses
    excludePaths              = var.exclude_paths
    includeHosts              = var.include_hosts
  })

  # Accept either conventional SSM spelling (`name` or `/name`) when building
  # the ARN for an externally managed parameter.
  ssm_parameter_path = startswith(var.ssm_parameter_name, "/") ? var.ssm_parameter_name : "/${var.ssm_parameter_name}"
}

# One zip, two handlers. Sharing the exact artifact/config makes
# it impossible for the origin-request injector and its companion to drift.
data "archive_file" "origin_request_pair" {
  type        = "zip"
  output_path = "${path.module}/dist/lambda-${data.aws_caller_identity.current.account_id}-${var.name}-origin-request-pair.zip"

  source {
    filename = "index.js"
    content  = file("${path.module}/dist/origin-request.js")
  }

  source {
    filename = "companion.js"
    content  = file("${path.module}/dist/companion.js")
  }

  source {
    filename = "connector-config.json"
    content  = local.connector_config
  }
}

# Optional placeholder SecureString (default OFF — create_ssm_parameter = false).
# SECURITY NOTE: when Terraform owns this parameter, `terraform refresh` reads
# its DECRYPTED value back into the state file on every run — ignore_changes
# does not prevent the read. So once the real key is set out-of-band, it would
# live in state as plaintext (encrypted at rest in the backend, but readable by
# anyone with state access). The recommended setup therefore leaves this off and
# has the operator create+set the SecureString entirely out-of-band:
#   aws ssm put-parameter --region us-east-1 --name <ssm_parameter_name> \
#     --type SecureString --value 'sk-…'
# Enable this only for a convenience placeholder in throwaway environments.
resource "aws_ssm_parameter" "api_key" {
  count = var.create_ssm_parameter ? 1 : 0

  name  = var.ssm_parameter_name
  type  = "SecureString"
  value = "REPLACE_ME"
  tags  = var.tags

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_iam_role" "edge" {
  name = "${var.name}-edge"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "edge" {
  name = "enhancely-injector"
  role = aws_iam_role.edge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Lambda@Edge writes logs to the region of the executing POP.
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = (
          var.create_ssm_parameter
          ? aws_ssm_parameter.api_key[0].arn
          : "arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_parameter_path}"
        )
      }
    ]
  })
}

resource "aws_lambda_function" "injector" {
  function_name    = var.name
  filename         = data.archive_file.origin_request_pair.output_path
  source_code_hash = data.archive_file.origin_request_pair.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  role             = aws_iam_role.edge.arn
  memory_size      = var.memory_size
  timeout          = local.lambda_timeout_seconds
  publish          = true # Lambda@Edge associations require a published version
  tags             = var.tags

  # Publish only after the read policy exists, so a first invocation can never
  # hit AccessDenied on GetParameter before IAM has propagated.
  depends_on = [aws_iam_role_policy.edge]

  lifecycle {
    precondition {
      condition     = data.aws_region.current.name == "us-east-1"
      error_message = "Lambda@Edge functions must be created in us-east-1 — pass an us-east-1 aliased provider to this module (providers = { aws = aws.us_east_1 })."
    }

    precondition {
      condition     = var.timeout_ms + var.origin_timeout_ms <= local.configurable_network_timeout_budget_ms
      error_message = "timeout_ms + origin_timeout_ms must be at most 6000 ms. The fixed 10-second Lambda timeout reserves 2000 ms for first-invocation SSM config and 2000 ms for cold-start, abort settlement, and returning the fail-open response."
    }

    precondition {
      condition     = length(var.include_hosts) == 0 || var.host_in_cache_key_asserted
      error_message = "A non-empty include_hosts policy requires host_in_cache_key_asserted = true after verifying that viewer Host is in the associated CloudFront cache key (or that the hosts use separate distributions). An origin request policy alone is insufficient."
    }
  }
}

# The companion is inseparable from the origin-request injector. It shares the
# same zip and baked config, but exposes only the non-injecting companion
# handler. A generated origin-request response never fires origin-response, so
# this function sees only uninjected traffic handed back to CloudFront.
resource "aws_lambda_function" "companion" {
  function_name    = local.companion_function_name
  filename         = data.archive_file.origin_request_pair.output_path
  source_code_hash = data.archive_file.origin_request_pair.output_base64sha256
  handler          = "companion.handler"
  runtime          = "nodejs22.x"
  role             = aws_iam_role.edge.arn
  memory_size      = var.memory_size
  timeout          = local.lambda_timeout_seconds
  publish          = true
  tags             = var.tags

  depends_on = [aws_iam_role_policy.edge]

  lifecycle {
    precondition {
      condition     = data.aws_region.current.name == "us-east-1"
      error_message = "Lambda@Edge functions must be created in us-east-1 — pass an us-east-1 aliased provider to this module (providers = { aws = aws.us_east_1 })."
    }
  }
}
