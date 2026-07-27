output "qualified_arn" {
  value       = aws_lambda_function.injector.qualified_arn
  description = "Versioned function ARN — attach as origin-response lambda_function_association."
}

output "function_name" {
  value       = aws_lambda_function.injector.function_name
  description = "Lambda function name."
}

output "ssm_parameter_name" {
  value       = var.ssm_parameter_name
  description = "SSM parameter expected to hold the API key (us-east-1)."
}

output "role_arn" {
  value       = aws_iam_role.edge.arn
  description = "IAM role ARN of the edge function."
}
