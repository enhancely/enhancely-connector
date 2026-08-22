variable "name" {
  type        = string
  default     = "enhancely-injector"
  description = "Function name (also used for the IAM role: <name>-edge)."
}

variable "enhancely_base" {
  type        = string
  default     = "https://app.enhancely.ai"
  description = "Enhancely API base URL. Use an explicitly selected non-default environment when required."

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
  description = "Request paths the connector must not touch at all (login/account areas, robots.txt-disallowed sections): no lookup, no auto-registration, no cache rewriting, no added latency. CloudFront path-pattern wildcards (*), case-sensitive, matched against the full canonicalized path. RFC 3986 unreserved escapes are decoded once, literal backslashes become slashes, and duplicate slashes/dot-segments collapse; write patterns in canonical literal form."
}

variable "asserted_default_ttl_seconds" {
  type        = number
  default     = 0
  description = "Operator assertion in seconds: every cache behavior this function is associated with has a DefaultTTL of AT LEAST this value for its HTML. When > 0, uninjected pass-through responses WITHOUT an explicit origin cache lifetime get the bounded retry Cache-Control capped at min(retry, this) instead of inheriting the DefaultTTL (often a day) - the min() keeps the write strictly shorter than what was asserted. Use the SMALLEST DefaultTTL among associated behaviors; a conservative understatement (e.g. 60) is safe. 0 (default) = off; keep off when any behavior has DefaultTTL 0. Credentialed requests stay untouched."

  validation {
    condition     = var.asserted_default_ttl_seconds >= 0 && floor(var.asserted_default_ttl_seconds) == var.asserted_default_ttl_seconds
    error_message = "asserted_default_ttl_seconds must be a whole number of seconds (0 = off)."
  }
}

variable "non_page_memo_ttl_ms" {
  type        = number
  default     = 1800000
  description = "origin-request only: how long the function remembers that a URL is NOT an injectable page (redirect, 404, JSON, binary, over-quota), so repeats skip the origin fetch that trigger needs in order to classify a URL. Default 30 minutes. Deliberately independent of cache_ttl_ms: that governs a JSON-LD record, which changes when content is edited; this governs 'not a page at all', which is stable. Costs nothing in correctness - a URL that later becomes a page is still registered via the hand-back, and every execution environment that has not memoized it still injects."
}

variable "cap_set_cookie_responses" {
  type        = bool
  default     = false
  description = "Operator assertion for the COMPANION entrypoint only: on this origin, Set-Cookie on responses to credential-less requests is load-balancer plumbing (e.g. ALB stickiness stamped on every response), not session material. When true, the retry cache-lifetime cap also applies to such responses; requests carrying Cookie/Authorization stay untouched regardless, and private/no-store responses are never capped. DO NOT enable on an origin that mints session cookies (JSESSIONID & co.) for anonymous requests - the written s-maxage would license downstream shared caches to replay that Set-Cookie across users (session-fixation pattern). Default false."
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
