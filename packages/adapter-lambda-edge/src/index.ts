/**
 * CloudFront Lambda@Edge origin-response adapter for the Enhancely injector.
 *
 * THE central CloudFront constraint: origin-response triggers CANNOT read the
 * origin response body — CloudFront only hands the function status + headers.
 * So for eligible responses (GET, status 200, text/html, no Set-Cookie, no
 * private/no-store Cache-Control — Content-Encoding on THIS response is fine,
 * see below) the handler first asks Enhancely for a snippet (needs no body);
 * only when there is one does it RE-FETCH the page from the custom origin (same
 * URI + querystring, incoming Host header so vhosts resolve, ALL request
 * headers CloudFront sent to the origin forwarded — except Host, Accept-Encoding
 * and hop-by-hop — so the origin serves the same representation, with
 * `Accept-Encoding: identity` for raw injectable bytes), injects the snippet
 * before </head> and replaces the body. The first gate IGNORES the CloudFront
 * response's Content-Encoding (real viewers get gzip/br, but we re-fetch
 * identity); the identity re-fetch is re-gated on encoding. Representation
 * headers are handled conservatively: Content-Type becomes explicit UTF-8;
 * Cache-Control/Expires and non-blocking X-Robots-Tag metadata must be stable
 * across both responses; noindex/none on either response vetoes injection;
 * and CSP structure must remain stable except for body-bound nonces/hashes
 * (the accepted re-fetch value matches its body). CloudFront then caches the
 * injected page, so the extra origin roundtrip is paid once per CloudFront
 * cache miss — origin-response does not fire on hits. A retryable no-snippet
 * result receives a short shared-cache TTL aligned with the core/config retry
 * and loses its origin validators, unless the request carries Authorization
 * or Cookie. That prevents a long default TTL (or later 304) from pinning a
 * transiently uninjected public representation.
 *
 * Fail-open invariant: the whole handler is wrapped in try/catch and ALWAYS
 * returns the original response on any failure — config unresolvable, origin
 * re-fetch error/timeout/non-200, body over the generated-response quota
 * (1 MB INCLUDING headers; see MAX_ORIGIN_BODY_BYTES and
 * serializedHeaderBytes), unstable cache/security metadata, ambiguous
 * charset/encoding, lossy UTF-8 decode, core errors.
 *
 * All connector logic (Enhancely API client, cache + ETag revalidation,
 * injection, fail-open orchestration) lives in @enhancely/injector-core; this
 * file only translates CloudFront event shapes (repo rule 8).
 */
import type {
  CloudFrontHeaders,
  CloudFrontResponseHandler,
  CloudFrontResultResponse,
} from 'aws-lambda';
import {
  __resetRateLimitCircuitForTests,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  injectIntoHead,
  isHostIncluded,
  matchesExcludedPath,
  MemoryCache,
  splitOutsideHttpQuotesStrict,
  trimHttpOws,
} from '@enhancely/injector-core';
import type { HttpFieldValue } from '@enhancely/injector-core';
import {
  getAssertedDefaultTtlSeconds,
  getCapSetCookieResponses,
  getConfigRetryInMs,
  getExcludePaths,
  getIncludeHosts,
  getOriginTimeoutMs,
  resolveAdapterConfig,
} from './config.js';
import { fetchOriginHtml } from './origin-fetch.js';
import { retryablePassThroughResponse } from './cache-cap.js';
import {
  blocksIndexing,
  buildOriginUrl,
  combinedHeaderValue,
  forwardedHeaders,
  GENERATED_HTML_CONTENT_TYPE,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  headerValue,
  headerValues,
  INJECTED_MARKER_HEADER,
  isUtf8SafeHtmlBytes,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  originCustomHeaders,
  resolvePageRequestTarget,
  serializedHeaderBytes,
  shouldAttempt,
} from './shared.js';

// Re-exported so the published surface (and the existing test imports) stay
// exactly where they were before the helpers moved into shared.ts.
export {
  buildOriginUrl,
  buildPageUrl,
  charsetOf,
  forwardedHeaders,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  PAGE_HOST_HEADER,
  serializedHeaderBytes,
  shouldAttempt,
} from './shared.js';
export type { AttemptInput } from './shared.js';

export {
  resolveAdapterConfig,
  DEFAULT_ORIGIN_TIMEOUT_MS,
  DEFAULT_SSM_PARAMETER_NAME,
  DEFAULT_SSM_REGION,
  DEFAULT_SSM_TIMEOUT_MS,
  CONFIG_FILE_NAME,
  getConfigRetryInMs,
} from './config.js';
export type { BakedConnectorConfig } from './config.js';
export { fetchOriginHtml } from './origin-fetch.js';
export {
  cacheDirectiveSeconds,
  retrySharedTtlSeconds,
  retryablePassThroughResponse,
} from './cache-cap.js';
export type { CapOptions } from './cache-cap.js';
export type { OriginFetchResult } from './origin-fetch.js';

/** Ignore casing and harmless comma/whitespace differences for stability checks. */
function normalizedRobotsTag(xRobotsTag: string | null): string | null {
  if (xRobotsTag === null) return null;
  return xRobotsTag
    .split(',')
    .map((directive) => {
      const trimmed = trimHttpOws(directive);
      // Bare directive names are case-insensitive. Arguments of scoped,
      // dated, or proprietary directives remain byte/case stable.
      return /^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
    })
    .join(',');
}

/** Compare Cache-Control without splitting commas inside quoted extensions. */
function normalizedCacheControl(policy: HttpFieldValue): string | null | undefined {
  if (policy === null || policy === undefined) return null;
  const instances = typeof policy === 'string' ? [policy] : policy;
  const directives: string[] = [];
  const names = new Set<string>();
  for (const instance of instances) {
    const parsed = splitOutsideHttpQuotesStrict(instance, ',');
    if (parsed === null) return undefined;
    for (const directive of parsed) {
      const trimmed = trimHttpOws(directive);
      if (trimmed === '') continue;
      const equalsAt = trimmed.indexOf('=');
      const name = (equalsAt < 0 ? trimmed : trimmed.slice(0, equalsAt)).toLowerCase();
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || names.has(name)) {
        return undefined;
      }
      names.add(name);
      // Directive names are case-insensitive; extension values are not.
      directives.push(equalsAt < 0 ? name : `${name}${trimmed.slice(equalsAt)}`);
    }
  }
  return directives.sort().join(',');
}

/**
 * Compare CSP structure while allowing per-response nonces and body hashes to
 * rotate. Every other directive/source must remain stable or injection fails
 * open rather than weakening the policy seen on the first response.
 */
function normalizedCspStructure(policy: string): string {
  return policy
    .split(';')
    .map((rawDirective) => {
      const [rawName, ...rawSources] = rawDirective.trim().split(/\s+/);
      if (rawName === undefined || rawName === '') return '';
      const sources = rawSources.map((source) => {
        if (/^'nonce-[^']+'$/i.test(source)) return "'nonce-*'";
        const hash = /^'(sha256|sha384|sha512)-[^']+'$/i.exec(source);
        return hash?.[1] === undefined ? source : `'${hash[1].toLowerCase()}-*'`;
      });
      return [rawName.toLowerCase(), ...sources].join(' ');
    })
    .filter((directive) => directive !== '')
    .join(';');
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Per-execution-environment JSON-LD cache. Execution environments survive
 * many invocations (and are replicated per edge location), so hit rates are
 * decent; CloudFront's own cache in front does the heavy lifting.
 */
let cache = new MemoryCache();

/** TEST-ONLY: fresh cache between tests. */
export function __resetHandlerStateForTests(): void {
  cache = new MemoryCache();
  __resetRateLimitCircuitForTests();
}

export const handler: CloudFrontResponseHandler = async (event) => {
  const record = event.Records[0];
  if (!record) {
    // A CloudFront origin-response event always carries exactly one record;
    // this guard exists only to satisfy noUncheckedIndexedAccess.
    throw new Error('unreachable: CloudFront origin-response event without records');
  }
  const { request, response } = record.cf;

  try {
    // Operator-excluded paths (login/account areas, robots.txt-disallowed
    // sections) pay NOTHING: no config/SSM resolution, no lookup, no
    // auto-registration, no cache rewriting — byte-identical pass-through
    // with the origin's normal caching. Checked first because it is the
    // cheapest gate and the only purely policy-driven one.
    if (matchesExcludedPath(getExcludePaths(), request.uri)) {
      return response;
    }

    // Pair-wide invariant: never add a second snippet to content another
    // Enhancely integration (or an upstream connector) already marked.
    if (response.headers[INJECTED_MARKER_HEADER] !== undefined) return response;

    // Cheap gate on what CloudFront already knows — no network work unless
    // this looks like an injectable HTML page.
    if (
      !shouldAttempt(
        {
          method: request.method,
          status: response.status,
          contentType: headerValues(response.headers, 'content-type'),
          contentEncoding: headerValue(response.headers, 'content-encoding'),
          cacheControl: headerValues(response.headers, 'cache-control'),
          contentDisposition: headerValues(response.headers, 'content-disposition'),
          hasSetCookie: response.headers['set-cookie'] !== undefined,
        },
        // Ignore the first response's content-encoding — we re-fetch identity.
        true
      )
    ) {
      return response;
    }

    // A page the origin itself marks noindex is not schema-markup territory:
    // pass it through untouched (normal caching, no lookup, no registration).
    // `none` is the documented equivalent of `noindex, nofollow`. A
    // bot-scoped directive (`somebot: noindex`) also skips — deliberately
    // conservative (the only cost is a skipped injection). This gate is a
    // DELIBERATE default-behavior change vs v0.5.3 (which injected such
    // pages); the fail direction is under-injection, never a modified
    // response. Only the header form is visible here — origin-response
    // triggers never see the body, so a `<meta name="robots">` cannot be
    // honored at this layer; use excludePaths for those sections instead.
    const xRobotsTag = combinedHeaderValue(response.headers, 'x-robots-tag');
    if (blocksIndexing(xRobotsTag)) {
      return response;
    }

    const target = resolvePageRequestTarget(request);
    if (target === null || !isHostIncluded(target.pageHost, getIncludeHosts())) return response;
    const { originHost, pageUrl } = target;

    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return response;

    // No resolvable API key → body pass-through (logged once per failed
    // resolution), with a bounded cache retry only for an otherwise eligible
    // custom-origin response.
    const config = await resolveAdapterConfig();
    if (config === null) {
      const retryInMs = getConfigRetryInMs();
      return retryInMs === null
        ? response
        : retryablePassThroughResponse(response, request.headers, retryInMs, {
            assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
            capSetCookieResponses: getCapSetCookieResponses(),
          });
    }

    // Ask Enhancely FIRST — this needs no page body (cache + ETag + API call
    // only). With autoRegister, the register-or-revalidate POST discovers and
    // reads in one round-trip; lookup-only mode remains a conditional GET.
    // Only when there is actually something to inject do we pay the
    // origin re-fetch below. Pages with no JSON-LD yet (unregistered, 404,
    // rate-limited, upstream error) therefore never double the origin load. A
    // not-yet-configured key (no snippet) likewise costs zero extra origin hits.
    const lookup = config.autoRegister
      ? await getJsonLdRegisterLookup(pageUrl, cache, config)
      : await getJsonLdLookup(pageUrl, cache, config);
    if (lookup.snippet === null) {
      return lookup.revalidateInMs === null
        ? response
        : retryablePassThroughResponse(response, request.headers, lookup.revalidateInMs, {
            assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
            capSetCookieResponses: getCapSetCookieResponses(),
          });
    }

    // Re-fetch the page: origin-response events do not expose the body.
    const origin = await fetchOriginHtml(
      originUrl,
      originHost,
      getOriginTimeoutMs(),
      MAX_ORIGIN_BODY_BYTES,
      MAX_RESPONSE_HEADER_BYTES,
      {
        ...forwardedHeaders(request.headers),
        // CloudFront stores static origin headers outside request.headers and
        // gives them precedence over same-named viewer headers. Replay the
        // representation CloudFront originally fetched, not a weaker variant.
        ...originCustomHeaders(request),
      }
    );
    // Over the conservative fetch cap — a body that large can never be
    // returned, not even under the most favorable header set.
    if (origin.truncated) return response;
    if (
      !shouldAttempt({
        method: 'GET',
        status: String(origin.status),
        contentType: origin.allHeaders['content-type'] ?? null,
        // Non-null despite Accept-Encoding: identity → origin ignored us; the
        // bytes are not injectable HTML.
        contentEncoding: origin.contentEncoding,
        cacheControl: origin.allHeaders['cache-control'] ?? null,
        contentDisposition: origin.allHeaders['content-disposition'] ?? null,
        hasSetCookie: origin.hasSetCookie,
      })
    ) {
      return response;
    }

    // The generated body comes from the identity re-fetch, so its indexing
    // policy is authoritative too. A noindex/none that appears only there
    // must still veto injection; otherwise we would decorate that body and
    // return it without the re-fetch's X-Robots-Tag.
    if (blocksIndexing(origin.xRobotsTag)) {
      return response;
    }
    // Non-blocking directives are policy metadata as well. If they differ
    // between the first answer and the body source, neither response is a
    // safe substitute for the other, so preserve the first one untouched.
    if (normalizedRobotsTag(xRobotsTag) !== normalizedRobotsTag(origin.xRobotsTag)) {
      return response;
    }

    // Cache semantics must be stable across the first response and the
    // representation we re-fetch. Choosing either side of a mismatch can make
    // the viewer response more cacheable than the other one intended, so the
    // only fail-open choice is to leave the first response untouched.
    const firstNormalizedCacheControl = normalizedCacheControl(
      headerValues(response.headers, 'cache-control')
    );
    const originNormalizedCacheControl = normalizedCacheControl(
      origin.allHeaders['cache-control'] ?? null
    );
    if (
      firstNormalizedCacheControl === undefined ||
      originNormalizedCacheControl === undefined ||
      firstNormalizedCacheControl !== originNormalizedCacheControl
    ) {
      return response;
    }
    if (headerValue(response.headers, 'expires') !== origin.expires) {
      return response;
    }

    // Dropping or structurally weakening a CSP that protected the first
    // response would be a security downgrade. Per-response nonces/hashes may
    // rotate; every other directive/source must remain stable. The re-fetch's
    // accepted value is copied below because it matches that body.
    const firstCsp = combinedHeaderValue(response.headers, 'content-security-policy');
    const firstCspReportOnly = combinedHeaderValue(
      response.headers,
      'content-security-policy-report-only'
    );
    if (
      (firstCsp !== null && origin.contentSecurityPolicy === null) ||
      (firstCsp !== null &&
        origin.contentSecurityPolicy !== null &&
        normalizedCspStructure(firstCsp) !==
          normalizedCspStructure(origin.contentSecurityPolicy)) ||
      (firstCspReportOnly !== null && origin.contentSecurityPolicyReportOnly === null) ||
      (firstCspReportOnly !== null &&
        origin.contentSecurityPolicyReportOnly !== null &&
        normalizedCspStructure(firstCspReportOnly) !==
          normalizedCspStructure(origin.contentSecurityPolicyReportOnly))
    ) {
      return response;
    }

    if (!isUtf8SafeHtmlBytes(origin.body, origin.contentType ?? '')) return response;
    const originalHtml = origin.body.toString('utf8');
    // We already hold the snippet — inject it directly. injectIntoHead returns
    // the HTML unchanged when there is no </head>, preserving fail-open.
    const injected = injectIntoHead(originalHtml, lookup.snippet);

    // Nothing injected (no </head>) → return the untouched response; CloudFront
    // serves the origin's own (byte-identical) body without us generating one.
    if (injected === originalHtml) return response;

    const headers: CloudFrontHeaders = { ...response.headers };
    // The origin's Content-Length describes the ORIGINAL body and is wrong for
    // the replaced one. Per the Lambda@Edge body-replacement rules CloudFront
    // computes Content-Length from the returned body itself; deleting the
    // stale header (rather than recomputing it here) is the documented, safe
    // way to let that happen — a mismatched explicit value risks truncated or
    // hung responses.
    delete headers['content-length'];
    // The generated body is the identity (uncompressed) re-fetch, but the
    // original response we cloned these headers from may have been gzip/br
    // (CloudFront forwards Accept-Encoding when Compress is on). Drop the stale
    // Content-Encoding so the viewer does not try to gunzip plain HTML;
    // CloudFront re-compresses the generated response for the viewer.
    delete headers['content-encoding'];
    // ETag / Last-Modified are validators for the ORIGINAL body; keeping them
    // would let two different bodies circulate under one strong validator
    // (a client holding the uninjected page revalidates → 304 → never sees
    // the injected version). Drop them so caches treat the body as new.
    delete headers['etag'];
    delete headers['last-modified'];
    // Integrity digests describe the ORIGINAL bytes too — a Content-MD5 /
    // Digest / Content-Digest / Repr-Digest computed over the uninjected body
    // would make any verifying client reject the replaced one as corrupted.
    delete headers['content-md5'];
    delete headers['digest'];
    delete headers['content-digest'];
    delete headers['repr-digest'];

    // The generated text is UTF-8 regardless of whether the re-fetch declared
    // UTF-8, ASCII, or no charset. Canonicalize the Content-Type so Unicode in
    // the injected JSON-LD can never be decoded under a stale ASCII label.
    headers['content-type'] = [{ key: 'Content-Type', value: GENERATED_HTML_CONTENT_TYPE }];

    // The equality gate above proved the cache policy stable across both
    // responses. Re-emit the re-fetch's canonical value with its body.
    if (origin.cacheControl === null) {
      delete headers['cache-control'];
    } else {
      headers['cache-control'] = [{ key: 'Cache-Control', value: origin.cacheControl }];
    }
    if (origin.expires === null) {
      delete headers['expires'];
    } else {
      headers['expires'] = [{ key: 'Expires', value: origin.expires }];
    }

    // The generated body is the re-fetch's, so the CSP that matches it (an
    // origin minting a per-response nonce would put a DIFFERENT nonce in each
    // response) is the re-fetch's — not the first response's. Copy it over so
    // header and body agree; otherwise the page's own inline scripts would be
    // CSP-blocked (a page-breaking, fail-CLOSED outcome). The asymmetry gate
    // above already returned the original response if a first-response CSP
    // disappeared; deleting first is now safe and prevents duplicate values.
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    if (origin.contentSecurityPolicy !== null) {
      headers['content-security-policy'] = [
        { key: 'Content-Security-Policy', value: origin.contentSecurityPolicy },
      ];
    }
    if (origin.contentSecurityPolicyReportOnly !== null) {
      headers['content-security-policy-report-only'] = [
        {
          key: 'Content-Security-Policy-Report-Only',
          value: origin.contentSecurityPolicyReportOnly,
        },
      ];
    }

    // CloudFront independently caps an origin response's headers at 32 KB.
    // A larger per-response CSP from the re-fetch can push a previously valid
    // first-response header set over that limit; returning it would produce a
    // viewer-facing 502 after Lambda has completed, so fail open here.
    const responseHeaderBytes = serializedHeaderBytes(
      headers,
      response.status,
      response.statusDescription
    );
    if (responseHeaderBytes > MAX_RESPONSE_HEADER_BYTES) return response;

    // The injected page must also fit the 1 MB generated-response quota, which
    // counts headers AND body together. Budget the body against the ACTUAL
    // serialized header size plus a safety margin. An over-quota generated
    // response is a viewer-facing 502, not fail-open — so when in doubt, pass
    // through.
    const bodyBudgetBytes =
      MAX_GENERATED_RESPONSE_BYTES - responseHeaderBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
    if (Buffer.byteLength(injected, 'utf8') > bodyBudgetBytes) return response;

    const result: CloudFrontResultResponse = {
      ...response,
      headers,
      body: injected,
      bodyEncoding: 'text',
    };
    return result;
  } catch (error) {
    // Fail-open: whatever went wrong, the viewer gets the original page.
    console.error(
      '[enhancely-lambda-edge] fail-open:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return response;
  }
};
