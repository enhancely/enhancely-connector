output "lambda_function_associations" {
  value = {
    "origin-request" = {
      lambda_arn   = aws_lambda_function.injector.qualified_arn
      include_body = false
    }
    "origin-response" = {
      lambda_arn   = aws_lambda_function.companion.qualified_arn
      include_body = false
    }
  }
  description = "Pairing-safe CloudFront association map containing the origin-request injector and its cache-cap-only origin-response companion. Install both on the same cache behavior."
}

output "injector_function_name" {
  value       = aws_lambda_function.injector.function_name
  description = "Origin-request injector Lambda function name."
}

output "companion_function_name" {
  value       = aws_lambda_function.companion.function_name
  description = "Origin-response companion Lambda function name."
}

output "ssm_parameter_name" {
  value       = var.ssm_parameter_name
  description = "SSM parameter expected to hold the API key (us-east-1)."
}

output "role_arn" {
  value       = aws_iam_role.edge.arn
  description = "Shared IAM role ARN of the Lambda@Edge pair."
}
