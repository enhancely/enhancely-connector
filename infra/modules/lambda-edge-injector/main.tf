# =============================================================================
# Enhancely JSON-LD Injector — reusable Lambda@Edge module
#
# Creates the Lambda@Edge function (origin-response), its IAM role and an
# optional SSM SecureString placeholder for the API key. The caller attaches
# the output `qualified_arn` to their CloudFront distribution(s):
#
#   lambda_function_association = {
#     origin-response = {
#       lambda_arn   = module.enhancely_injector.qualified_arn
#       include_body = false
#     }
#   }
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
# The bundled dist/index.js ships with the module at the pinned git ref —
# upgrading the connector = bumping `ref`. No cache infrastructure is needed:
# CloudFront caches the injected page, the function keeps a per-execution-
# environment memory cache, and ETag revalidation keeps refreshes cheap.
# =============================================================================

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "archive_file" "bundle" {
  type        = "zip"
  output_path = "${path.module}/dist/lambda-${var.name}.zip"

  source {
    filename = "index.js"
    content  = file("${path.module}/dist/index.js")
  }

  # Deploy-specific config WITHOUT the API key — the key is read from SSM at
  # runtime, so no secret lands in the globally replicated function artifact.
  source {
    filename = "connector-config.json"
    content = jsonencode({
      enhancelyBase    = var.enhancely_base
      ssmParameterName = var.ssm_parameter_name
      ssmRegion        = "us-east-1"
      timeoutMs        = var.timeout_ms
      cacheTtlMs       = var.cache_ttl_ms
      autoRegister     = var.auto_register
    })
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
          : "arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_parameter_name}"
        )
      }
    ]
  })
}

resource "aws_lambda_function" "injector" {
  function_name    = var.name
  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.edge.arn
  memory_size      = var.memory_size
  timeout          = 10
  publish          = true # Lambda@Edge associations require a published version
  tags             = var.tags

  lifecycle {
    precondition {
      condition     = data.aws_region.current.name == "us-east-1"
      error_message = "Lambda@Edge functions must be created in us-east-1 — pass an us-east-1 aliased provider to this module (providers = { aws = aws.us_east_1 })."
    }
  }
}
