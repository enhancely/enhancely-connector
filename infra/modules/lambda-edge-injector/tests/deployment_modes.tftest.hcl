mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      name = "us-east-1"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-edge-role"
      id  = "mock-edge-role"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn           = "arn:aws:lambda:us-east-1:123456789012:function:mock"
      qualified_arn = "arn:aws:lambda:us-east-1:123456789012:function:mock:1"
      version       = "1"
    }
  }
}

run "default_origin_request_pair" {
  command = plan

  assert {
    condition     = output.deployment_mode == "origin-request"
    error_message = "origin-request must remain the default deployment mode."
  }

  assert {
    condition     = length(aws_lambda_function.companion) == 1
    error_message = "Default mode must create exactly one companion."
  }

  assert {
    condition = (
      aws_lambda_function.injector.handler == "index.handler" &&
      aws_lambda_function.companion[0].handler == "companion.handler" &&
      aws_lambda_function.injector.filename == data.archive_file.origin_request_pair.output_path &&
      aws_lambda_function.companion[0].filename == data.archive_file.origin_request_pair.output_path &&
      strcontains(data.archive_file.origin_request_pair.output_path, "123456789012")
    )
    error_message = "The default pair must use one shared, account-scoped artifact."
  }

  assert {
    condition = (
      length(output.lambda_function_associations) == 2 &&
      contains(keys(output.lambda_function_associations), "origin-request") &&
      contains(keys(output.lambda_function_associations), "origin-response") &&
      !output.lambda_function_associations["origin-request"].include_body &&
      !output.lambda_function_associations["origin-response"].include_body
    )
    error_message = "Default association output must pair origin-request with its origin-response companion."
  }

  assert {
    condition = (
      output.qualified_arn == null &&
      output.origin_response_qualified_arn == null &&
      output.origin_request_qualified_arn != null &&
      output.companion_qualified_arn != null
    )
    error_message = "Legacy origin-response outputs must stay null in default mode."
  }

  assert {
    condition = (
      jsondecode(one([
        for source in data.archive_file.origin_request_pair.source :
        source.content if source.filename == "connector-config.json"
      ])).timeoutMs == 800 &&
      jsondecode(one([
        for source in data.archive_file.origin_request_pair.source :
        source.content if source.filename == "connector-config.json"
      ])).originTimeoutMs == 2000
    )
    error_message = "The baked defaults must keep separate 800 ms Enhancely and 2000 ms origin budgets."
  }
}

run "standalone_origin_response_compatibility" {
  command = plan

  variables {
    deployment_mode = "origin-response"
  }

  assert {
    condition     = length(aws_lambda_function.companion) == 0
    error_message = "Compatibility mode must not create a companion."
  }

  assert {
    condition = (
      aws_lambda_function.injector.handler == "index.handler" &&
      aws_lambda_function.injector.filename == data.archive_file.origin_response.output_path
    )
    error_message = "Compatibility mode must deploy the standalone origin-response artifact."
  }

  assert {
    condition = (
      length(output.lambda_function_associations) == 1 &&
      contains(keys(output.lambda_function_associations), "origin-response") &&
      !contains(keys(output.lambda_function_associations), "origin-request")
    )
    error_message = "Compatibility association output must contain only origin-response."
  }

  assert {
    condition = (
      output.qualified_arn != null &&
      output.qualified_arn == output.origin_response_qualified_arn &&
      output.origin_request_qualified_arn == null &&
      output.companion_qualified_arn == null
    )
    error_message = "qualified_arn must retain its legacy origin-response meaning."
  }

  assert {
    condition = (
      jsondecode(one([
        for source in data.archive_file.origin_response.source :
        source.content if source.filename == "connector-config.json"
      ])).timeoutMs == 2000 &&
      jsondecode(one([
        for source in data.archive_file.origin_response.source :
        source.content if source.filename == "connector-config.json"
      ])).originTimeoutMs == 2000
    )
    error_message = "Compatibility mode must retain its historical 2000 ms Enhancely timeout when timeout_ms is omitted."
  }
}

run "standalone_origin_response_explicit_timeout_override" {
  command = plan

  variables {
    deployment_mode = "origin-response"
    timeout_ms      = 800
  }

  assert {
    condition = jsondecode(one([
      for source in data.archive_file.origin_response.source :
      source.content if source.filename == "connector-config.json"
    ])).timeoutMs == 800
    error_message = "An explicit timeout_ms must override the compatibility mode's historical default."
  }
}

run "reject_unknown_deployment_mode" {
  command = plan

  variables {
    deployment_mode = "both-injectors"
  }

  expect_failures = [
    var.deployment_mode,
  ]
}

run "reject_name_that_cannot_fit_companion_suffix" {
  command = plan

  variables {
    name = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [
    aws_lambda_function.companion,
  ]
}

run "allow_long_legacy_name_in_compatibility_mode" {
  command = plan

  variables {
    deployment_mode = "origin-response"
    name            = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition     = aws_lambda_function.injector.function_name == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    error_message = "Compatibility mode must retain legacy names up to 59 characters."
  }
}

run "allow_timeout_budget_boundary" {
  command = plan

  variables {
    timeout_ms        = 4000
    origin_timeout_ms = 2000
  }

  assert {
    condition = (
      aws_lambda_function.injector.timeout == 10 &&
      aws_lambda_function.companion[0].timeout == 10 &&
      jsondecode(one([
        for source in data.archive_file.origin_request_pair.source :
        source.content if source.filename == "connector-config.json"
      ])).timeoutMs == 4000 &&
      jsondecode(one([
        for source in data.archive_file.origin_request_pair.source :
        source.content if source.filename == "connector-config.json"
      ])).originTimeoutMs == 2000
    )
    error_message = "The exact 6000 ms origin-plus-Enhancely boundary must remain valid under the fixed 10-second Lambda timeout."
  }
}

run "reject_combined_timeout_budget_overrun" {
  command = plan

  variables {
    timeout_ms        = 4000
    origin_timeout_ms = 2001
  }

  expect_failures = [
    aws_lambda_function.injector,
  ]
}

run "reject_enhancely_timeout_above_total_budget" {
  command = plan

  variables {
    timeout_ms        = 6001
    origin_timeout_ms = 1
  }

  expect_failures = [
    var.timeout_ms,
  ]
}

run "reject_origin_timeout_above_total_budget" {
  command = plan

  variables {
    timeout_ms        = 1
    origin_timeout_ms = 6001
  }

  expect_failures = [
    var.origin_timeout_ms,
  ]
}
