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
 * file only translates CloudFront event shapes (repo rule 7).
 */
import type {
  CloudFrontHeaders,
  CloudFrontResponseHandler,
  CloudFrontResultResponse,
} from 'aws-lambda';
import {
  getJsonLdLookup,
  injectIntoHead,
  matchesExcludedPath,
  MemoryCache,
} from '@enhancely/injector-core';
import {
  getAssertedDefaultTtlSeconds,
  getCapSetCookieResponses,
  getConfigRetryInMs,
  getExcludePaths,
  getOriginTimeoutMs,
  resolveAdapterConfig,
} from './config.js';
import { fetchOriginHtml } from './origin-fetch.js';
import { retryablePassThroughResponse } from './cache-cap.js';
import {
  blocksIndexing,
  buildOriginUrl,
  buildPageUrl,
  cacheControlValue,
  charsetOf,
  combinedHeaderValue,
  containsOnlyAscii,
  customHeaderValue,
  declaresUtf8MetaInPrescan,
  forwardedHeaders,
  GENERATED_HTML_CONTENT_TYPE,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  hasUtf8Bom,
  headerValue,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  PAGE_HOST_HEADER,
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
    .map((directive) => directive.trim().replace(/\s+/g, ' ').toLowerCase())
    .join(',');
}

/** Compare Cache-Control semantically enough to ignore order/casing/spacing. */
function normalizedCacheControl(policy: string | null): string | null {
  if (policy === null) return null;
  return policy
    .split(',')
    .map((directive) => directive.trim().toLowerCase())
    .sort()
    .join(',');
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

    // Cheap gate on what CloudFront already knows — no network work unless
    // this looks like an injectable HTML page.
    if (
      !shouldAttempt(
        {
          method: request.method,
          status: response.status,
          contentType: headerValue(response.headers, 'content-type'),
          contentEncoding: headerValue(response.headers, 'content-encoding'),
          cacheControl: cacheControlValue(response.headers),
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

    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return response;

    // Host header CloudFront sent to the origin (the viewer Host when the
    // origin request policy forwards it — recommended, see README). This is
    // what the origin re-fetch must present so vhosts resolve.
    const originHost =
      headerValue(request.headers, 'host') ?? request.origin?.custom?.domainName ?? '';
    if (originHost === '') return response;

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

    // Public page host for the Enhancely lookup. Origins that must NOT
    // receive the viewer Host (S3 website endpoints reject foreign hosts, so
    // their distributions cannot forward it) declare the public hostname as a
    // static origin custom header instead: X-Enhancely-Page-Host.
    const pageHost = customHeaderValue(request, PAGE_HOST_HEADER) ?? originHost;
    const pageUrl = buildPageUrl(pageHost, request.uri, request.querystring);

    // Ask Enhancely FIRST — this needs no page body (cache + ETag + API call
    // only). Only when there is actually something to inject do we pay the
    // origin re-fetch below. Pages with no JSON-LD yet (unregistered, 404,
    // rate-limited, upstream error) therefore never double the origin load. A not-yet-configured key (no snippet) likewise costs zero extra origin hits.
    const lookup = await getJsonLdLookup(pageUrl, cache, config);
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
      forwardedHeaders(request.headers)
    );
    // Over the conservative fetch cap — a body that large can never be
    // returned, not even under the most favorable header set.
    if (origin.truncated) return response;
    if (
      !shouldAttempt({
        method: 'GET',
        status: String(origin.status),
        contentType: origin.contentType,
        // Non-null despite Accept-Encoding: identity → origin ignored us; the
        // bytes are not injectable HTML.
        contentEncoding: origin.contentEncoding,
        cacheControl: origin.cacheControl,
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
    const firstCacheControl = cacheControlValue(response.headers);
    if (normalizedCacheControl(firstCacheControl) !== normalizedCacheControl(origin.cacheControl)) {
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

    const originalHtml = origin.body.toString('utf8');
    // Charset gate, part 2: a page may omit the charset parameter yet carry
    // non-UTF-8 bytes (e.g. `<meta charset="iso-8859-1">` in the markup). A
    // lossy utf8 decode replaces those bytes with U+FFFD, and CloudFront would
    // CACHE the mojibake. Prove the decode was lossless before doing anything
    // with it; otherwise pass through byte-identical.
    if (!Buffer.from(originalHtml, 'utf8').equals(origin.body)) return response;
    const originCharset = charsetOf(origin.contentType ?? '');
    const asciiBody = containsOnlyAscii(origin.body);
    // `ascii`/`us-ascii` are legacy web-encoding labels. Relabeling non-ASCII
    // bytes as UTF-8 can change visible origin text even when those bytes form
    // valid UTF-8, so only genuinely ASCII source bytes are safe.
    if ((originCharset === 'ascii' || originCharset === 'us-ascii') && !asciiBody) {
      return response;
    }
    // With no header charset, valid UTF-8 bytes are not proof of UTF-8 intent:
    // browsers perform a context-sensitive HTML encoding prescan and might
    // interpret the same bytes as windows-1252. Safe to relabel are ASCII
    // bytes, an unambiguous UTF-8 BOM, or a meta tag in the prescan window
    // that itself declares UTF-8 (then the browser decodes it as UTF-8 too,
    // and the lossless-decode proof above already showed the bytes ARE valid
    // UTF-8). Everything else stays ambiguous and passes through. In the
    // field this matters for origins that send a bare `text/html` for German
    // pages carrying umlauts plus `<meta charset="utf-8">`: before this
    // prescan every such page silently failed open.
    if (
      originCharset === null &&
      !asciiBody &&
      !hasUtf8Bom(origin.body) &&
      !declaresUtf8MetaInPrescan(origin.body)
    ) {
      return response;
    }
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
