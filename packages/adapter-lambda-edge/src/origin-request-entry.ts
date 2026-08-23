/**
 * Production Lambda entrypoint.
 *
 * Keep the deployment surface to `handler` only. The implementation module
 * deliberately exports a few reset seams for unit tests; bundling this thin
 * wrapper lets esbuild remove those test-only exports and their code.
 */
export { handler } from './origin-request.js';
