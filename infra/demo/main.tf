# ============================================================================
# DISPOSABLE demo stack — proves the Lambda@Edge adapter end-to-end.
#
#   demo.staging.enhancely.ai
#     → CloudFront (this stack, non-prod account, us-east-1)
#       → Lambda@Edge origin-response (adapter-lambda-edge, baked staging key)
#       → S3 static website origin (http-only custom origin)
#
# The Enhancely side is the STAGING backend (app.staging.enhancely.ai) with
# project "Connector Demo". Tear the whole thing down with `tofu destroy`
# once the demo is reviewed. Local state on purpose — this stack is scratch.
# ============================================================================

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = "us-east-1" # ACM for CloudFront + Lambda@Edge must live here
  profile = "non-prod"
}

locals {
  demo_host   = "demo.staging.enhancely.ai"
  zone_id     = "Z07822643K3ULSM7M5JDT" # staging.enhancely.ai (non-prod account)
  lambda_zip  = "${path.module}/../../packages/adapter-lambda-edge/dist/lambda.zip"
  bucket_name = "enhancely-connector-demo-site"
}

# ---------------------------------------------------------------- S3 website
resource "aws_s3_bucket" "site" {
  bucket        = local.bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  index_document {
    suffix = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  depends_on = [aws_s3_bucket_public_access_block.site]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicRead"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
    }]
  })
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.site.id
  key          = "index.html"
  source       = "${path.module}/site/index.html"
  etag         = filemd5("${path.module}/site/index.html")
  content_type = "text/html; charset=utf-8"
}

# ------------------------------------------------------------------ ACM cert
resource "aws_acm_certificate" "demo" {
  domain_name       = local.demo_host
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.demo.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  zone_id = local.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "demo" {
  certificate_arn         = aws_acm_certificate.demo.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --------------------------------------------------------------- Lambda@Edge
resource "aws_iam_role" "edge" {
  name = "enhancely-connector-demo-edge"
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
}

resource "aws_iam_role_policy" "edge_logs" {
  name = "edge-logs"
  role = aws_iam_role.edge.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:*:*:*"
    }]
  })
}

resource "aws_lambda_function" "injector" {
  function_name    = "enhancely-connector-demo-injector"
  filename         = local.lambda_zip
  source_code_hash = filebase64sha256(local.lambda_zip)
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.edge.arn
  memory_size      = 256
  timeout          = 10 # origin-facing triggers allow up to 30s; 10s is plenty
  publish          = true # Lambda@Edge associations need a published version
}

# ---------------------------------------------------------------- CloudFront
resource "aws_cloudfront_distribution" "demo" {
  enabled         = true
  comment         = "DISPOSABLE: enhancely-connector Lambda@Edge demo"
  aliases         = [local.demo_host]
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    origin_id   = "s3-website"
    domain_name = aws_s3_bucket_website_configuration.site.website_endpoint

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # S3 website endpoints are HTTP-only
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    # S3 website origins must not receive the viewer Host header, so the
    # public hostname travels as a static custom header instead (adapter
    # feature: x-enhancely-page-host).
    custom_header {
      name  = "X-Enhancely-Page-Host"
      value = local.demo_host
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-website"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    # CachingDisabled (managed policy): every request reaches the origin and
    # therefore the origin-response trigger — deterministic for testing. The
    # core's own cache still short-circuits the Enhancely API call.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    lambda_function_association {
      event_type   = "origin-response"
      lambda_arn   = aws_lambda_function.injector.qualified_arn
      include_body = false
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.demo.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# -------------------------------------------------------------------- DNS
resource "aws_route53_record" "demo_a" {
  zone_id = local.zone_id
  name    = local.demo_host
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.demo.domain_name
    zone_id                = aws_cloudfront_distribution.demo.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "demo_aaaa" {
  zone_id = local.zone_id
  name    = local.demo_host
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.demo.domain_name
    zone_id                = aws_cloudfront_distribution.demo.hosted_zone_id
    evaluate_target_health = false
  }
}

# ------------------------------------------------------------------ Outputs
output "demo_url" {
  value = "https://${local.demo_host}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.demo.id
}

output "lambda_version_arn" {
  value = aws_lambda_function.injector.qualified_arn
}
