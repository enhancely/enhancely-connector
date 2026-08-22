output "qualified_arn" {
  value       = local.origin_request_mode ? null : aws_lambda_function.injector.qualified_arn
  description = "DEPRECATED compatibility output: standalone origin-response version ARN. Intentionally null in the default origin-request mode so legacy wiring can never silently attach the wrong handler. Use lambda_function_associations for new integrations."
}

output "origin_request_qualified_arn" {
  value       = local.origin_request_mode ? aws_lambda_function.injector.qualified_arn : null
  description = "Versioned origin-request injector ARN in the default mode; null in standalone origin-response mode."
}

output "companion_qualified_arn" {
  value       = local.origin_request_mode ? aws_lambda_function.companion[0].qualified_arn : null
  description = "Versioned origin-response companion ARN in the default mode; null in standalone origin-response mode."
}

output "origin_response_qualified_arn" {
  value       = local.origin_request_mode ? null : aws_lambda_function.injector.qualified_arn
  description = "Versioned standalone origin-response injector ARN in compatibility mode; null in the default mode."
}

output "lambda_function_associations" {
  value = local.origin_request_mode ? {
    "origin-request" = {
      lambda_arn   = aws_lambda_function.injector.qualified_arn
      include_body = false
    }
    "origin-response" = {
      lambda_arn   = aws_lambda_function.companion[0].qualified_arn
      include_body = false
    }
    } : {
    "origin-response" = {
      lambda_arn   = aws_lambda_function.injector.qualified_arn
      include_body = false
    }
  }
  description = "Pairing-safe CloudFront association map. Default mode contains origin-request injector + origin-response companion; compatibility mode contains only the standalone origin-response injector."
}

output "function_name" {
  value       = aws_lambda_function.injector.function_name
  description = "Lambda function name."
}

output "companion_function_name" {
  value       = local.origin_request_mode ? aws_lambda_function.companion[0].function_name : null
  description = "Companion Lambda function name in origin-request mode; null in origin-response mode."
}

output "deployment_mode" {
  value       = var.deployment_mode
  description = "Effective deployment architecture."
}

output "ssm_parameter_name" {
  value       = var.ssm_parameter_name
  description = "SSM parameter expected to hold the API key (us-east-1)."
}

output "role_arn" {
  value       = aws_iam_role.edge.arn
  description = "IAM role ARN of the edge function."
}
