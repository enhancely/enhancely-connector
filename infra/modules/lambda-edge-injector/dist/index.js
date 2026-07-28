"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CONFIG_FILE_NAME: () => CONFIG_FILE_NAME,
  DEFAULT_ORIGIN_TIMEOUT_MS: () => DEFAULT_ORIGIN_TIMEOUT_MS,
  DEFAULT_SSM_PARAMETER_NAME: () => DEFAULT_SSM_PARAMETER_NAME,
  DEFAULT_SSM_REGION: () => DEFAULT_SSM_REGION,
  DEFAULT_SSM_TIMEOUT_MS: () => DEFAULT_SSM_TIMEOUT_MS,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES: () => GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  MAX_GENERATED_RESPONSE_BYTES: () => MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES: () => MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES: () => MAX_RESPONSE_HEADER_BYTES,
  PAGE_HOST_HEADER: () => PAGE_HOST_HEADER,
  __resetHandlerStateForTests: () => __resetHandlerStateForTests,
  buildOriginUrl: () => buildOriginUrl,
  buildPageUrl: () => buildPageUrl,
  charsetOf: () => charsetOf,
  fetchOriginHtml: () => fetchOriginHtml,
  forwardedHeaders: () => forwardedHeaders,
  handler: () => handler,
  resolveAdapterConfig: () => resolveAdapterConfig,
  serializedHeaderBytes: () => serializedHeaderBytes,
  shouldAttempt: () => shouldAttempt
});
module.exports = __toCommonJS(index_exports);

// ../injector-core/dist/config.js
var DEFAULT_ENHANCELY_BASE = "https://app.enhancely.ai";
var DEFAULT_TIMEOUT_MS = 800;
var DEFAULT_CACHE_TTL_MS = 3e5;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function assertSafeBase(base) {
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new TypeError(`enhancelyBase is not a valid URL: ${base}`);
  }
  if (parsed.protocol === "https:")
    return;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))
    return;
  throw new TypeError(`enhancelyBase must use https (got ${parsed.protocol}//) \u2014 the API key would travel in cleartext`);
}
function defineConfig(input) {
  const base = (input.enhancelyBase ?? DEFAULT_ENHANCELY_BASE).replace(/\/$/, "");
  assertSafeBase(base);
  return {
    enhancelyBase: base,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    injectPosition: "before-head-close",
    autoRegister: input.autoRegister ?? false,
    ...input.fetchImpl !== void 0 && { fetchImpl: input.fetchImpl }
  };
}

// ../injector-core/dist/normalize.js
function normalizeLite(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    parsed.search = "";
    parsed.hash = "";
    const clean = parsed.toString();
    return clean.endsWith("/") ? clean.slice(0, -1) : clean;
  } catch {
    return url;
  }
}

// ../injector-core/dist/cache.js
var MemoryCache = class {
  maxEntries;
  entries = /* @__PURE__ */ new Map();
  constructor(maxEntries = 5e3) {
    this.maxEntries = maxEntries;
  }
  get(key) {
    return Promise.resolve(this.entries.get(key));
  }
  set(key, entry) {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== void 0)
        this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
    return Promise.resolve();
  }
};
function isFresh(entry, ttlMs, now = Date.now()) {
  return entry.storedAt + ttlMs > now;
}

// ../injector-core/dist/client.js
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value.trim() === "")
    return null;
  if (/^\d+$/.test(value.trim()))
    return Number.parseInt(value, 10);
  const date = Date.parse(value);
  if (Number.isNaN(date))
    return null;
  return Math.max(0, Math.ceil((date - now) / 1e3));
}
async function fetchJsonLd(config, pageUrl, etag) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const endpoint = `${config.enhancelyBase}/api/v1/jsonld/${encodeURIComponent(pageUrl)}`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/ld+json"
  };
  if (etag)
    headers["If-None-Match"] = etag;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.name : "fetch-failed" };
  }
  if (response.status === 304)
    return { status: "not-modified" };
  if (response.status === 404)
    return { status: "not-found" };
  if (response.status === 429) {
    return {
      status: "rate-limited",
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"))
    };
  }
  if (!response.ok)
    return { status: "error", reason: `http-${response.status}` };
  try {
    const jsonldRaw = await response.text();
    if (jsonldRaw.trim() === "")
      return { status: "error", reason: "empty-body" };
    return { status: "ok", jsonldRaw, etag: response.headers.get("etag") };
  } catch {
    return { status: "error", reason: "body-read-failed" };
  }
}
async function registerJsonLd(config, pageUrl) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${config.enhancelyBase}/api/v1/jsonld`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: pageUrl }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
    return response.status === 201 || response.status === 200 || response.status === 202;
  } catch {
    return false;
  }
}

// ../injector-core/dist/inject.js
function buildScriptTag(jsonldRaw) {
  const safe = jsonldRaw.replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${safe}</script>`;
}
var RAW_TEXT_ELEMENTS = ["script", "style", "title", "textarea", "noscript"];
var HEAD_CLOSE = /^<\/head\s*>/i;
function endOfTag(html, start) {
  let quote = "";
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote !== "") {
      if (c === quote)
        quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return -1;
}
function findHeadCloseIndex(html) {
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0)
      return -1;
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0)
        return -1;
      i = end + 3;
      continue;
    }
    if (HEAD_CLOSE.test(html.slice(lt, lt + 32)))
      return lt;
    let raw = null;
    for (const t of RAW_TEXT_ELEMENTS) {
      if (lower.startsWith(`<${t}`, lt)) {
        const after = html[lt + 1 + t.length];
        if (after === void 0 || /[\s/>]/.test(after)) {
          raw = t;
          break;
        }
      }
    }
    const tagEnd = endOfTag(html, lt);
    if (tagEnd < 0)
      return -1;
    if (raw !== null) {
      const close = lower.indexOf(`</${raw}`, tagEnd);
      if (close < 0)
        return -1;
      const gt = html.indexOf(">", close);
      i = gt < 0 ? html.length : gt + 1;
    } else {
      i = tagEnd;
    }
  }
  return -1;
}
function injectIntoHead(html, snippet) {
  const index = findHeadCloseIndex(html);
  if (index < 0)
    return html;
  return html.slice(0, index) + snippet + html.slice(index);
}

// ../injector-core/dist/index.js
function snippetFromEntry(entry) {
  return entry.jsonldRaw !== null ? buildScriptTag(entry.jsonldRaw) : null;
}
var DEFAULT_RETRY_BACKOFF_MS = 1e4;
var MAX_RETRY_BACKOFF_MS = 6e4;
async function getJsonLdSnippet(url, cache2, config) {
  try {
    const key = normalizeLite(url);
    const cached = await cache2.get(key);
    if (cached && isFresh(cached, config.cacheTtlMs)) {
      return snippetFromEntry(cached);
    }
    if (cached?.retryNotBefore !== void 0 && Date.now() < cached.retryNotBefore) {
      return snippetFromEntry(cached);
    }
    const result = await fetchJsonLd(config, key, cached?.etag);
    switch (result.status) {
      case "ok": {
        await cache2.set(key, {
          jsonldRaw: result.jsonldRaw,
          etag: result.etag,
          storedAt: Date.now()
        });
        return buildScriptTag(result.jsonldRaw);
      }
      case "not-modified": {
        if (!cached)
          return null;
        await cache2.set(key, {
          jsonldRaw: cached.jsonldRaw,
          etag: cached.etag,
          storedAt: Date.now()
        });
        return snippetFromEntry(cached);
      }
      case "not-found": {
        if (config.autoRegister) {
          await registerJsonLd(config, key);
        }
        await cache2.set(key, { jsonldRaw: null, etag: null, storedAt: Date.now() });
        return null;
      }
      case "rate-limited":
      case "error": {
        const backoffMs = result.status === "rate-limited" && result.retryAfterSeconds !== null ? Math.min(Math.max(result.retryAfterSeconds, 1) * 1e3, MAX_RETRY_BACKOFF_MS) : DEFAULT_RETRY_BACKOFF_MS;
        const memo = {
          jsonldRaw: cached?.jsonldRaw ?? null,
          etag: cached?.etag ?? null,
          // No previous entry → storedAt 0 keeps the memo permanently stale,
          // so it only suppresses retries until retryNotBefore, nothing more.
          storedAt: cached?.storedAt ?? 0,
          retryNotBefore: Date.now() + backoffMs
        };
        try {
          const current = await cache2.get(key);
          const unchanged = (current?.storedAt ?? null) === (cached?.storedAt ?? null) && (current?.etag ?? null) === (cached?.etag ?? null);
          if (unchanged) {
            await cache2.set(key, memo);
          }
        } catch {
        }
        return cached ? snippetFromEntry(cached) : null;
      }
    }
  } catch {
    return null;
  }
}

// src/config.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var DEFAULT_SSM_PARAMETER_NAME = "/enhancely/connector/api-key";
var DEFAULT_SSM_REGION = "us-east-1";
var CONFIG_FILE_NAME = "connector-config.json";
var DEFAULT_ORIGIN_TIMEOUT_MS = 2e3;
var DEFAULT_SSM_TIMEOUT_MS = 2e3;
var resolvedConfig = null;
var negativeUntil = 0;
var inflight = null;
var NEGATIVE_TTL_MS = 3e4;
var resolvedOriginTimeoutMs = DEFAULT_ORIGIN_TIMEOUT_MS;
var bakedOverride;
var configOverrides = null;
function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function parseBaked(raw) {
  const baked = {};
  if (typeof raw !== "object" || raw === null) return baked;
  const source = raw;
  const apiKey = nonEmptyString(source["apiKey"]);
  if (apiKey !== void 0) baked.apiKey = apiKey;
  const enhancelyBase = nonEmptyString(source["enhancelyBase"]);
  if (enhancelyBase !== void 0) baked.enhancelyBase = enhancelyBase;
  const timeoutMs = positiveNumber(source["timeoutMs"]);
  if (timeoutMs !== void 0) baked.timeoutMs = timeoutMs;
  const cacheTtlMs = positiveNumber(source["cacheTtlMs"]);
  if (cacheTtlMs !== void 0) baked.cacheTtlMs = cacheTtlMs;
  if (typeof source["autoRegister"] === "boolean") baked.autoRegister = source["autoRegister"];
  const originTimeoutMs = positiveNumber(source["originTimeoutMs"]);
  if (originTimeoutMs !== void 0) baked.originTimeoutMs = originTimeoutMs;
  const ssmParameterName = nonEmptyString(source["ssmParameterName"]);
  if (ssmParameterName !== void 0) baked.ssmParameterName = ssmParameterName;
  const ssmRegion = nonEmptyString(source["ssmRegion"]);
  if (ssmRegion !== void 0) baked.ssmRegion = ssmRegion;
  const ssmTimeoutMs = positiveNumber(source["ssmTimeoutMs"]);
  if (ssmTimeoutMs !== void 0) baked.ssmTimeoutMs = ssmTimeoutMs;
  return baked;
}
function readBakedConfig() {
  const dirs = [];
  const taskRoot = nonEmptyString(process.env["LAMBDA_TASK_ROOT"]);
  if (taskRoot !== void 0) dirs.push(taskRoot);
  if (typeof __dirname === "string") dirs.push(__dirname);
  dirs.push(process.cwd());
  for (const dir of dirs) {
    const file = (0, import_node_path.join)(dir, CONFIG_FILE_NAME);
    let text;
    try {
      text = (0, import_node_fs.readFileSync)(file, "utf8");
    } catch {
      continue;
    }
    try {
      return parseBaked(JSON.parse(text));
    } catch (error) {
      console.error(
        `[enhancely-lambda-edge] ${file} is not valid JSON (${String(error)}) \u2014 ignoring it and trying SSM`
      );
      return null;
    }
  }
  return null;
}
async function fetchApiKeyFromSsm(parameterName, region, timeoutMs) {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const client = new SSMClient({ region, maxAttempts: 2 });
  const result = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    { abortSignal: AbortSignal.timeout(timeoutMs) }
  );
  return nonEmptyString(result.Parameter?.Value) ?? null;
}
async function resolveOnce() {
  try {
    const baked = bakedOverride !== void 0 ? bakedOverride : readBakedConfig();
    resolvedOriginTimeoutMs = baked?.originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
    let apiKey = baked?.apiKey;
    if (apiKey === void 0) {
      apiKey = await fetchApiKeyFromSsm(
        baked?.ssmParameterName ?? DEFAULT_SSM_PARAMETER_NAME,
        baked?.ssmRegion ?? DEFAULT_SSM_REGION,
        baked?.ssmTimeoutMs ?? DEFAULT_SSM_TIMEOUT_MS
      ) ?? void 0;
    }
    if (apiKey === void 0) {
      console.error(
        "[enhancely-lambda-edge] NO API KEY: neither a baked connector-config.json apiKey nor a non-empty SSM parameter was found \u2014 every response passes through UNINJECTED until this execution environment is recycled"
      );
      return null;
    }
    if (!apiKey.startsWith("sk-")) {
      console.error(
        `[enhancely-lambda-edge] API KEY not configured (value does not look like an Enhancely key) \u2014 passing every response through UNINJECTED. Set the real key in SSM.`
      );
      return null;
    }
    return defineConfig({
      apiKey,
      ...baked?.enhancelyBase !== void 0 && { enhancelyBase: baked.enhancelyBase },
      ...baked?.timeoutMs !== void 0 && { timeoutMs: baked.timeoutMs },
      ...baked?.cacheTtlMs !== void 0 && { cacheTtlMs: baked.cacheTtlMs },
      ...baked?.autoRegister !== void 0 && { autoRegister: baked.autoRegister },
      ...configOverrides
    });
  } catch (error) {
    console.error(
      "[enhancely-lambda-edge] config resolution FAILED \u2014 every response passes through UNINJECTED until this execution environment is recycled:",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return null;
  }
}
function resolveAdapterConfig() {
  if (resolvedConfig !== null) return Promise.resolve(resolvedConfig);
  if (Date.now() < negativeUntil) return Promise.resolve(null);
  if (inflight !== null) return inflight;
  inflight = resolveOnce().then((result) => {
    inflight = null;
    if (result !== null) {
      resolvedConfig = result;
    } else {
      negativeUntil = Date.now() + NEGATIVE_TTL_MS;
    }
    return result;
  });
  return inflight;
}
function getOriginTimeoutMs() {
  return resolvedOriginTimeoutMs;
}

// src/origin-fetch.ts
var http = __toESM(require("node:http"), 1);
var https = __toESM(require("node:https"), 1);
function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
function fetchOriginHtml(originUrl, hostHeader, timeoutMs, maxBytes, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(originUrl);
    const lib = url.protocol === "https:" ? https : http;
    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port !== "" ? Number(url.port) : void 0,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        headers: {
          // Fallback identity — a forwarded viewer User-Agent (in
          // extraHeaders) overrides it, so the origin sees the same UA it
          // already answered.
          "user-agent": "enhancely-connector-lambda-edge",
          // Full forwarded request header set from the caller.
          ...extraHeaders,
          // Non-negotiable, always win over anything forwarded: the vhost
          // Host header and the raw (uncompressed) bytes for injection.
          host: hostHeader,
          "accept-encoding": "identity"
        },
        signal: AbortSignal.timeout(timeoutMs)
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers["content-type"] ?? null;
        const contentEncoding = response.headers["content-encoding"] ?? null;
        const cacheControl = response.headers["cache-control"] ?? null;
        const hasSetCookie = response.headers["set-cookie"] !== void 0;
        const csp = firstHeaderValue(response.headers["content-security-policy"]);
        const cspReportOnly = firstHeaderValue(
          response.headers["content-security-policy-report-only"]
        );
        const chunks = [];
        let size = 0;
        let settled = false;
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            settled = true;
            resolve({
              status,
              contentType,
              contentEncoding,
              cacheControl,
              hasSetCookie,
              contentSecurityPolicy: csp,
              contentSecurityPolicyReportOnly: cspReportOnly,
              body: Buffer.alloc(0),
              truncated: true
            });
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            contentType,
            contentEncoding,
            cacheControl,
            hasSetCookie,
            contentSecurityPolicy: csp,
            contentSecurityPolicyReportOnly: cspReportOnly,
            body: Buffer.concat(chunks),
            truncated: false
          });
        });
        response.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

// src/index.ts
var MAX_GENERATED_RESPONSE_BYTES = 1048576;
var MAX_RESPONSE_HEADER_BYTES = 32768;
var GENERATED_RESPONSE_SAFETY_MARGIN_BYTES = 1024;
var MAX_ORIGIN_BODY_BYTES = MAX_GENERATED_RESPONSE_BYTES - MAX_RESPONSE_HEADER_BYTES - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
var UTF8_COMPATIBLE_CHARSETS = /* @__PURE__ */ new Set(["utf-8", "utf8", "us-ascii", "ascii"]);
var RESPONSE_STATUS_LINE_OVERHEAD_BYTES = 64;
function serializedHeaderBytes(headers) {
  let total = RESPONSE_STATUS_LINE_OVERHEAD_BYTES;
  for (const [name, entries] of Object.entries(headers)) {
    for (const entry of entries) {
      total += (entry.key ?? name).length + entry.value.length + 4;
    }
  }
  return total;
}
function charsetOf(contentType) {
  const match = /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}
var PER_REQUEST_CACHE_CONTROL = /(?:^|[\s,])(?:private|no-store)(?:$|[\s,=])/i;
function shouldAttempt(input, ignoreContentEncoding = false) {
  if (input.method !== "GET") return false;
  if (input.status !== "200") return false;
  const contentType = input.contentType ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/html") return false;
  const charset = charsetOf(contentType);
  if (charset !== null && !UTF8_COMPATIBLE_CHARSETS.has(charset)) return false;
  if (input.hasSetCookie) return false;
  if (input.cacheControl !== null && PER_REQUEST_CACHE_CONTROL.test(input.cacheControl)) {
    return false;
  }
  if (ignoreContentEncoding) return true;
  return input.contentEncoding === null;
}
function buildPageUrl(host, uri, querystring) {
  return `https://${host}${uri}${querystring !== "" ? `?${querystring}` : ""}`;
}
function buildOriginUrl(request) {
  const custom = request.origin?.custom;
  if (custom === void 0) return null;
  const defaultPort = custom.protocol === "https" ? 443 : 80;
  const portPart = custom.port !== defaultPort ? `:${custom.port}` : "";
  const query = request.querystring !== "" ? `?${request.querystring}` : "";
  return `${custom.protocol}://${custom.domainName}${portPart}${custom.path}${request.uri}${query}`;
}
var PAGE_HOST_HEADER = "x-enhancely-page-host";
function customHeaderValue(request, name) {
  const value = request.origin?.custom?.customHeaders[name]?.[0]?.value ?? null;
  return value !== null && value !== "" ? value : null;
}
function headerValue(headers, name) {
  return headers[name]?.[0]?.value ?? null;
}
var NON_FORWARDED_REQUEST_HEADERS = /* @__PURE__ */ new Set([
  "host",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
function forwardedHeaders(headers) {
  const out = {};
  for (const [name, entries] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (NON_FORWARDED_REQUEST_HEADERS.has(key)) continue;
    if (entries.length === 0) continue;
    out[key] = entries.map((entry) => entry.value).join(key === "cookie" ? "; " : ", ");
  }
  return out;
}
var cache = new MemoryCache();
function __resetHandlerStateForTests() {
  cache = new MemoryCache();
}
var handler = async (event) => {
  const record = event.Records[0];
  if (!record) {
    throw new Error("unreachable: CloudFront origin-response event without records");
  }
  const { request, response } = record.cf;
  try {
    if (!shouldAttempt(
      {
        method: request.method,
        status: response.status,
        contentType: headerValue(response.headers, "content-type"),
        contentEncoding: headerValue(response.headers, "content-encoding"),
        cacheControl: headerValue(response.headers, "cache-control"),
        hasSetCookie: response.headers["set-cookie"] !== void 0
      },
      // Ignore the first response's content-encoding — we re-fetch identity.
      true
    )) {
      return response;
    }
    const config = await resolveAdapterConfig();
    if (config === null) return response;
    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return response;
    const originHost = headerValue(request.headers, "host") ?? request.origin?.custom?.domainName ?? "";
    if (originHost === "") return response;
    const pageHost = customHeaderValue(request, PAGE_HOST_HEADER) ?? originHost;
    const pageUrl = buildPageUrl(pageHost, request.uri, request.querystring);
    const snippet = await getJsonLdSnippet(pageUrl, cache, config);
    if (snippet === null) return response;
    const origin = await fetchOriginHtml(
      originUrl,
      originHost,
      getOriginTimeoutMs(),
      MAX_ORIGIN_BODY_BYTES,
      forwardedHeaders(request.headers)
    );
    if (origin.truncated) return response;
    if (!shouldAttempt({
      method: "GET",
      status: String(origin.status),
      contentType: origin.contentType,
      // Non-null despite Accept-Encoding: identity → origin ignored us; the
      // bytes are not injectable HTML.
      contentEncoding: origin.contentEncoding,
      cacheControl: origin.cacheControl,
      hasSetCookie: origin.hasSetCookie
    })) {
      return response;
    }
    const originalHtml = origin.body.toString("utf8");
    if (!Buffer.from(originalHtml, "utf8").equals(origin.body)) return response;
    const injected = injectIntoHead(originalHtml, snippet);
    if (injected === originalHtml) return response;
    const headers = { ...response.headers };
    delete headers["content-length"];
    delete headers["content-encoding"];
    delete headers["etag"];
    delete headers["last-modified"];
    delete headers["content-md5"];
    delete headers["digest"];
    delete headers["content-digest"];
    delete headers["repr-digest"];
    if (origin.contentSecurityPolicy !== null) {
      headers["content-security-policy"] = [
        { key: "Content-Security-Policy", value: origin.contentSecurityPolicy }
      ];
    }
    if (origin.contentSecurityPolicyReportOnly !== null) {
      headers["content-security-policy-report-only"] = [
        {
          key: "Content-Security-Policy-Report-Only",
          value: origin.contentSecurityPolicyReportOnly
        }
      ];
    }
    const bodyBudgetBytes = MAX_GENERATED_RESPONSE_BYTES - serializedHeaderBytes(headers) - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
    if (Buffer.byteLength(injected, "utf8") > bodyBudgetBytes) return response;
    const result = {
      ...response,
      headers,
      body: injected,
      bodyEncoding: "text"
    };
    return result;
  } catch (error) {
    console.error(
      "[enhancely-lambda-edge] fail-open:",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return response;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_ORIGIN_TIMEOUT_MS,
  DEFAULT_SSM_PARAMETER_NAME,
  DEFAULT_SSM_REGION,
  DEFAULT_SSM_TIMEOUT_MS,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  PAGE_HOST_HEADER,
  __resetHandlerStateForTests,
  buildOriginUrl,
  buildPageUrl,
  charsetOf,
  fetchOriginHtml,
  forwardedHeaders,
  handler,
  resolveAdapterConfig,
  serializedHeaderBytes,
  shouldAttempt
});
