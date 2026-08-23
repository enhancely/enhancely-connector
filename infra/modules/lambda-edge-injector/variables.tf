variable "name" {
  type        = string
  default     = "enhancely-injector"
  description = "Primary Lambda function name (also used for the IAM role: <name>-edge). In origin-request mode the companion uses <name>-companion."

  validation {
    condition     = length(var.name) >= 1 && length(var.name) <= 59 && can(regex("^[A-Za-z0-9_-]+$", var.name))
    error_message = "name must be 1-59 characters using only letters, digits, hyphens, or underscores (59 leaves room for the shared -edge IAM-role suffix). Origin-request mode additionally limits it to 54 characters for the -companion function."
  }
}

variable "deployment_mode" {
  type        = string
  default     = "origin-request"
  description = "Deployment architecture. origin-request (default) creates the origin-first injector plus its origin-response companion; generated normal paths use one origin fetch, while hard handbacks can use two. origin-response creates only the legacy standalone injector: CloudFront performs its first fetch, but injection still requires a second direct fetch from a reachable custom origin. S3 REST origins including S3 OAC pass through. Private VPC origins are not injectable, and sign-protected custom origins are unsupported."

  validation {
    condition     = contains(["origin-request", "origin-response"], var.deployment_mode)
    error_message = "deployment_mode must be either \"origin-request\" (recommended default pair) or \"origin-response\" (standalone compatibility mode)."
  }
}

variable "enhancely_base" {
  type        = string
  default     = "https://app.enhancely.ai"
  description = "Enhancely API base URL. Override only for an explicitly configured non-production environment."

  validation {
    condition     = startswith(var.enhancely_base, "https://")
    error_message = "enhancely_base must be https — the API key would otherwise travel in cleartext."
  }
}

variable "ssm_parameter_name" {
  type        = string
  default     = "/enhancely/connector/api-key"
  description = "SSM SecureString (us-east-1) holding the Enhancely API key (project sk-… or org-wide sk-org-…). Set the real value out-of-band."

  validation {
    condition     = trimspace(var.ssm_parameter_name) != ""
    error_message = "ssm_parameter_name must not be empty."
  }
}

variable "create_ssm_parameter" {
  type        = bool
  default     = false
  description = "Whether Terraform creates a REPLACE_ME placeholder for the API-key parameter. Default false (recommended): the operator creates+sets the SecureString out-of-band so the decrypted key never gets read into Terraform state on refresh. Set true only for throwaway environments."
}

variable "auto_register" {
  type        = bool
  default     = false
  description = "Self-registration mode: on a stale/missing JSON-LD cache entry, use one register-or-revalidate POST that reads known pages or registers unknown proven HTML pages. Fresh positive/negative cache entries make no API request."
}

variable "include_hosts" {
  type        = list(string)
  default     = []
  description = "Exact public page hostnames on which connector work is enabled. Empty preserves the all-host behavior. No wildcards, schemes, paths, credentials, or ports. Matching is case-insensitive after IDNA/Punycode canonicalization; a final DNS dot remains distinct. Checked before SSM, the connector origin fetch, Enhancely, or companion cache rewriting. IMPORTANT: when aliases share a distribution/behavior, Viewer Host must also be in the CloudFront cache key; an origin-request policy alone does not isolate cached objects by alias."

  validation {
    condition = (
      length(distinct([for host in var.include_hosts : lower(host)])) == length(var.include_hosts) &&
      alltrue([
        for host in var.include_hosts :
        host == trimspace(host) &&
        length(host) <= (endswith(host, ".") ? 254 : 253) &&
        can(regex("^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.?$", host))
      ])
    )
    error_message = "include_hosts entries must be unique exact DNS hostnames (Unicode names in Punycode), without whitespace, wildcard, scheme, path, credentials, or port."
  }
}

variable "host_in_cache_key_asserted" {
  type        = bool
  default     = false
  description = "Operator assertion required when include_hosts is non-empty: the associated CloudFront cache behavior includes viewer Host in its cache key (or every listed host uses a separate distribution). This module cannot inspect the external behavior and does not configure its cache policy."
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
  description = "origin-request only: how long the function remembers that an origin answer can neither be injected nor safely generated (for example a truncated/over-quota body or an unsupported successful representation), so repeats hand back before performing the connector's classification fetch. Redirects, 404s, and small status-200 veto bodies are reproduced from their first fetch and do not enter this memo. Default 30 minutes. Deliberately independent of cache_ttl_ms: that governs a JSON-LD record; this governs a hard response-reproduction veto. The verdict expires and is local to one execution environment, so a changed route is reclassified while every other environment remains unaffected."

  validation {
    condition     = var.non_page_memo_ttl_ms > 0 && floor(var.non_page_memo_ttl_ms) == var.non_page_memo_ttl_ms
    error_message = "non_page_memo_ttl_ms must be a positive whole number of milliseconds."
  }
}

variable "cap_set_cookie_responses" {
  type        = bool
  default     = false
  description = "Pair-wide operator assertion, also used by standalone origin-response: on this origin, Set-Cookie on responses to credential-less requests is load-balancer plumbing (e.g. ALB stickiness stamped on every response), not session material. When true, the retry cache-lifetime cap also applies to such responses; requests carrying Cookie/Authorization stay untouched regardless, and private/no-store responses are never capped. DO NOT enable on an origin that mints session cookies (JSESSIONID & co.) for anonymous requests - the written s-maxage would license downstream shared caches to replay that Set-Cookie across users (session-fixation pattern). Default false."
}

variable "timeout_ms" {
  type        = number
  default     = null
  nullable    = true
  description = "Optional per-call timeout for Enhancely API requests (AbortSignal). When omitted, origin-request uses 800 ms and origin-response retains its historical 2000 ms timeout. An explicit value applies to either mode. When set, it must be at most 6000 ms and, together with origin_timeout_ms, at most 6000 ms; the fixed 10-second Lambda budget reserves 2000 ms for first-invocation SSM config and 2000 ms for cold-start/abort-settlement/fail-open response work."

  validation {
    condition     = var.timeout_ms == null ? true : var.timeout_ms > 0 && var.timeout_ms <= 6000 && floor(var.timeout_ms) == var.timeout_ms
    error_message = "timeout_ms, when set, must be a positive whole number no greater than 6000 ms. The effective timeout_ms + origin_timeout_ms is additionally limited to 6000 ms by the Lambda fail-open budget."
  }
}

variable "origin_timeout_ms" {
  type        = number
  default     = 2000
  description = "Timeout for the connector's own origin fetch. Used by the default origin-request injector and the standalone origin-response re-fetch; separate from the Enhancely API budget. Must be at most 6000 ms and, together with the effective mode-dependent timeout_ms, at most 6000 ms so timeout handling can settle before Lambda's fixed 10-second termination."

  validation {
    condition     = var.origin_timeout_ms > 0 && var.origin_timeout_ms <= 6000 && floor(var.origin_timeout_ms) == var.origin_timeout_ms
    error_message = "origin_timeout_ms must be a positive whole number no greater than 6000 ms. timeout_ms + origin_timeout_ms is additionally limited to 6000 ms by the Lambda fail-open budget."
  }
}

variable "cache_ttl_ms" {
  type        = number
  default     = 300000
  description = "Freshness TTL of the in-memory JSON-LD cache (ETag revalidation applies after expiry)."

  validation {
    condition     = var.cache_ttl_ms > 0 && floor(var.cache_ttl_ms) == var.cache_ttl_ms
    error_message = "cache_ttl_ms must be a positive whole number of milliseconds."
  }
}

variable "memory_size" {
  type        = number
  default     = 256
  description = "Lambda memory size (MB)."

  validation {
    condition     = var.memory_size >= 128 && var.memory_size <= 10240 && floor(var.memory_size) == var.memory_size
    error_message = "memory_size must be a whole number between 128 and 10240 MB."
  }
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags applied to all created resources."
}
