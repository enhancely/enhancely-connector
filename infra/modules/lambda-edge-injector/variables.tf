variable "name" {
  type        = string
  default     = "enhancely-injector"
  description = "Function name (also used for the IAM role: <name>-edge)."
}

variable "enhancely_base" {
  type        = string
  default     = "https://app.enhancely.ai"
  description = "Enhancely API base URL. Use https://app.staging.enhancely.ai for pilots against staging."

  validation {
    condition     = startswith(var.enhancely_base, "https://")
    error_message = "enhancely_base must be https — the API key would otherwise travel in cleartext."
  }
}

variable "ssm_parameter_name" {
  type        = string
  default     = "/enhancely/connector/api-key"
  description = "SSM SecureString (us-east-1) holding the Enhancely API key (project sk-… or org-wide sk-org-…). Set the real value out-of-band."
}

variable "create_ssm_parameter" {
  type        = bool
  default     = false
  description = "Whether Terraform creates a REPLACE_ME placeholder for the API-key parameter. Default false (recommended): the operator creates+sets the SecureString out-of-band so the decrypted key never gets read into Terraform state on refresh. Set true only for throwaway environments."
}

variable "auto_register" {
  type        = bool
  default     = false
  description = "Self-registration: POST unknown pages to Enhancely on first visit (once per URL per cache TTL) so the catalog fills itself from real traffic."
}

variable "exclude_paths" {
  type        = list(string)
  default     = []
  description = "Request paths the connector must not touch at all (login/account areas, robots.txt-disallowed sections): no lookup, no auto-registration, no cache rewriting, no added latency. CloudFront path-pattern wildcards (*), case-sensitive, matched against the full request path."
}

variable "asserted_default_ttl_seconds" {
  type        = number
  default     = 0
  description = "Operator assertion in seconds: every cache behavior this function is associated with has a DefaultTTL of AT LEAST this value for its HTML. When > 0, uninjected pass-through responses WITHOUT an explicit origin cache lifetime get the bounded retry Cache-Control capped at min(retry, this) instead of inheriting the DefaultTTL (often a day) - the min() keeps the write strictly shorter than what was asserted. Use the SMALLEST DefaultTTL among associated behaviors; a conservative understatement (e.g. 60) is safe. 0 (default) = off; keep off when any behavior has DefaultTTL 0. Credentialed requests stay untouched."

  validation {
    condition     = var.asserted_default_ttl_seconds >= 0
    error_message = "asserted_default_ttl_seconds must be >= 0."
  }
}

variable "timeout_ms" {
  type        = number
  default     = 2000
  description = "Per-call timeout for Enhancely API requests (AbortSignal)."
}

variable "cache_ttl_ms" {
  type        = number
  default     = 300000
  description = "Freshness TTL of the in-memory JSON-LD cache (ETag revalidation applies after expiry)."
}

variable "memory_size" {
  type        = number
  default     = 256
  description = "Lambda memory size (MB)."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags applied to all created resources."
}
