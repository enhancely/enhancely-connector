/**
 * CloudFront Lambda@Edge origin-response adapter — HONEST STUB.
 *
 * Current behavior: returns the origin response completely unchanged.
 * Deploying this today is safe (pure pass-through) but does nothing yet.
 *
 * See README.md for the Lambda@Edge constraints that shape this adapter
 * (us-east-1 only, no environment variables, 1 MB response body limit).
 */
import type { CloudFrontResponseHandler } from 'aws-lambda';

/*
 * TODO(implementation) — intended flow, mirroring the sidecar adapter:
 *
 * 1. Resolve config once per execution context (module scope), NOT per event:
 *    Lambda@Edge has NO environment variables, so the API key comes from
 *    either a bundled config file baked in at deploy time or from SSM
 *    Parameter Store / Secrets Manager fetched lazily and cached in module
 *    scope. Both options are documented in README.md.
 * 2. Gate: only act on origin-response events whose response has
 *    - a 2xx status, and
 *    - Content-Type starting with `text/html`, and
 *    - no Content-Encoding (compressed origin bodies pass through; keep
 *      origin compression off between origin and CloudFront, let CloudFront
 *      compress towards the viewer), and
 *    - a body that fits Lambda@Edge's origin-response body limit (~1 MB) —
 *      larger responses are not exposed to the function and pass through.
 * 3. Buffer the body (base64-decode when `response.body.encoding === 'base64'`).
 * 4. Reconstruct the page URL from the origin request (Host header + URI) and
 *    call `handleHtml` from @enhancely/injector-core with a module-scoped
 *    MemoryCache — the core does fetch + ETag revalidation + injection and is
 *    fail-open by contract (any failure returns the HTML unchanged).
 * 5. Write the (possibly modified) body back, update Content-Length, return.
 *    Any thrown error in steps 1–5 must be caught and the ORIGINAL response
 *    returned (fail-open).
 */

export const handler: CloudFrontResponseHandler = (event) => {
  const record = event.Records[0];
  if (!record) {
    // A CloudFront origin-response event always carries exactly one record;
    // this guard exists only to satisfy noUncheckedIndexedAccess.
    throw new Error('unreachable: CloudFront event without records');
  }
  // STUB: pass the origin response through untouched (see TODO above).
  return Promise.resolve(record.cf.response);
};
