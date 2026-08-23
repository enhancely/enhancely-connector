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
  cacheDirectiveSeconds: () => cacheDirectiveSeconds,
  charsetOf: () => charsetOf,
  fetchOriginHtml: () => fetchOriginHtml,
  forwardedHeaders: () => forwardedHeaders,
  getConfigRetryInMs: () => getConfigRetryInMs,
  handler: () => handler,
  resolveAdapterConfig: () => resolveAdapterConfig,
  retrySharedTtlSeconds: () => retrySharedTtlSeconds,
  retryablePassThroughResponse: () => retryablePassThroughResponse,
  serializedHeaderBytes: () => serializedHeaderBytes,
  shouldAttempt: () => shouldAttempt
});
module.exports = __toCommonJS(index_exports);

// ../injector-core/dist/config.js
var DEFAULT_ENHANCELY_BASE = "https://app.enhancely.ai";
var DEFAULT_TIMEOUT_MS = 800;
var DEFAULT_CACHE_TTL_MS = 3e5;
var DEFAULT_MAX_JSONLD_BYTES = 256 * 1024;
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
  const maxJsonLdBytes = input.maxJsonLdBytes ?? DEFAULT_MAX_JSONLD_BYTES;
  if (!Number.isSafeInteger(maxJsonLdBytes) || maxJsonLdBytes <= 0 || maxJsonLdBytes > DEFAULT_MAX_JSONLD_BYTES) {
    throw new RangeError(`maxJsonLdBytes must be a positive integer no greater than ${DEFAULT_MAX_JSONLD_BYTES}`);
  }
  return {
    enhancelyBase: base,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    maxJsonLdBytes,
    injectPosition: "before-head-close",
    autoRegister: input.autoRegister ?? false,
    ...input.fetchImpl !== void 0 && { fetchImpl: input.fetchImpl }
  };
}

// ../injector-core/dist/normalize.js
function normalizeLite(url) {
  try {
    const parsed = new URL(url);
    return normalizeParsedUrl(parsed);
  } catch {
    return url;
  }
}
function normalizeParsedUrl(parsed) {
  parsed.protocol = "https:";
  parsed.search = "";
  parsed.hash = "";
  const clean = parsed.toString();
  return clean.endsWith("/") ? clean.slice(0, -1) : clean;
}
function normalizeForEnhancely(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    if (parsed.hostname === "")
      return null;
    if (parsed.username !== "" || parsed.password !== "")
      return null;
    const normalized = normalizeParsedUrl(parsed);
    return normalizeLite(normalized) === normalized ? normalized : null;
  } catch {
    return null;
  }
}

// ../injector-core/dist/cache.js
var DEFAULT_MEMORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
var DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 5e3;
function estimatedEntryBytes(key, entry) {
  const stringUnits = key.length + (entry.jsonldRaw?.length ?? 0) + (entry.etag?.length ?? 0);
  return 256 + stringUnits * 2;
}
var MemoryCache = class {
  maxEntries;
  maxEstimatedBytes;
  entries = /* @__PURE__ */ new Map();
  entryBytes = /* @__PURE__ */ new Map();
  retainedBytes = 0;
  constructor(maxEntries = DEFAULT_MEMORY_CACHE_MAX_ENTRIES, maxEstimatedBytes = DEFAULT_MEMORY_CACHE_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxEstimatedBytes = maxEstimatedBytes;
  }
  get(key) {
    return Promise.resolve(this.entries.get(key));
  }
  set(key, entry) {
    const existingBytes = this.entryBytes.get(key);
    if (existingBytes !== void 0) {
      this.entries.delete(key);
      this.entryBytes.delete(key);
      this.retainedBytes -= existingBytes;
    }
    const bytes = estimatedEntryBytes(key, entry);
    if (bytes > this.maxEstimatedBytes || this.maxEntries <= 0)
      return Promise.resolve();
    while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxEstimatedBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0)
        break;
      this.entries.delete(oldest);
      this.retainedBytes -= this.entryBytes.get(oldest) ?? 0;
      this.entryBytes.delete(oldest);
    }
    this.entries.set(key, entry);
    this.entryBytes.set(key, bytes);
    this.retainedBytes += bytes;
    return Promise.resolve();
  }
};
function isFresh(entry, ttlMs, now = Date.now()) {
  return entry.storedAt + ttlMs > now;
}

// ../injector-core/dist/client.js
function cancelResponseBody(response, reason) {
  if (response.body === null || response.body.locked)
    return;
  try {
    void response.body.cancel(reason).catch(() => void 0);
  } catch {
  }
}
function declaredContentLength(response) {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim()))
    return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}
function errorName(error, fallback) {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" && error.name !== "") {
    return error.name;
  }
  return fallback;
}
async function readJsonLdBody(response, maxBytes, signal) {
  const contentLength = declaredContentLength(response);
  if (contentLength !== null && contentLength > maxBytes) {
    cancelResponseBody(response, "body-too-large");
    return { status: "error", reason: "body-too-large" };
  }
  if (response.body === null)
    return { status: "ok", text: "" };
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let aborted = signal.aborted;
  const cancelReader = (reason) => {
    try {
      void reader.cancel(reason).catch(() => void 0);
    } catch {
    }
  };
  const onAbort = () => {
    aborted = true;
    cancelReader(signal.reason);
  };
  if (aborted) {
    cancelReader(signal.reason);
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (aborted) {
        return {
          status: "error",
          reason: errorName(signal.reason, "body-read-failed")
        };
      }
      if (done)
        break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader("body-too-large");
        return { status: "error", reason: "body-too-large" };
      }
      chunks.push(value);
    }
    if (aborted) {
      return {
        status: "error",
        reason: errorName(signal.reason, "body-read-failed")
      };
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: "ok", text: new TextDecoder().decode(bytes) };
  } catch (error) {
    cancelReader(error);
    return {
      status: "error",
      reason: signal.aborted ? errorName(signal.reason, "body-read-failed") : "body-read-failed"
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
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
function rateLimitBackoffSeconds(response) {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== null)
    return retryAfter;
  const reset = response.headers.get("ratelimit-reset");
  if (reset !== null && /^\d+$/.test(reset.trim()))
    return Number.parseInt(reset, 10);
  return null;
}
async function evaluateOkResponse(response, maxBytes, signal) {
  if (response.headers.get("x-jsonld-status")?.trim().toLowerCase() === "ignored") {
    cancelResponseBody(response, "ignored-record");
    return { status: "terminal-negative", reason: "ignored" };
  }
  let body;
  try {
    body = await readJsonLdBody(response, maxBytes, signal);
  } catch {
    return { status: "error", reason: "body-read-failed" };
  }
  if (body.status === "error")
    return body;
  const trimmed = body.text.trim();
  if (trimmed === "")
    return { status: "error", reason: "empty-body" };
  if (trimmed === "{}")
    return { status: "terminal-negative", reason: "empty-record" };
  return { status: "ok", jsonldRaw: body.text, etag: response.headers.get("etag") };
}
async function fetchJsonLd(config, pageUrl, etag) {
  const safePageUrl = normalizeForEnhancely(pageUrl);
  if (safePageUrl === null)
    return { status: "error", reason: "invalid-page-url" };
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const endpoint = `${config.enhancelyBase}/api/v1/jsonld/${encodeURIComponent(safePageUrl)}`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/ld+json"
  };
  if (etag)
    headers["If-None-Match"] = etag;
  let response;
  let signal;
  try {
    signal = AbortSignal.timeout(config.timeoutMs);
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
      signal
    });
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.name : "fetch-failed" };
  }
  if (response.status === 304) {
    cancelResponseBody(response, "not-modified");
    return { status: "not-modified" };
  }
  if (response.status === 404) {
    cancelResponseBody(response, "not-found");
    return { status: "not-found" };
  }
  if (response.status === 202) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    cancelResponseBody(response, "pending");
    return { status: "pending", retryAfterSeconds };
  }
  if (response.status === 429) {
    const retryAfterSeconds = rateLimitBackoffSeconds(response);
    cancelResponseBody(response, "rate-limited");
    return {
      status: "rate-limited",
      retryAfterSeconds
    };
  }
  if (response.status !== 200) {
    cancelResponseBody(response, `http-${response.status}`);
    return { status: "error", reason: `http-${response.status}` };
  }
  return evaluateOkResponse(response, config.maxJsonLdBytes, signal);
}
async function registerOrRevalidate(config, pageUrl, etag) {
  const safePageUrl = normalizeForEnhancely(pageUrl);
  if (safePageUrl === null)
    return { status: "error", reason: "invalid-page-url" };
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/ld+json"
  };
  if (etag)
    headers["If-None-Match"] = etag;
  let response;
  let signal;
  try {
    signal = AbortSignal.timeout(config.timeoutMs);
    response = await fetchImpl(`${config.enhancelyBase}/api/v1/jsonld`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: safePageUrl }),
      signal
    });
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.name : "fetch-failed" };
  }
  if (response.status === 412) {
    cancelResponseBody(response, "not-modified");
    return { status: "not-modified" };
  }
  if (response.status === 201 || response.status === 202) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    cancelResponseBody(response, "pending");
    return { status: "pending", retryAfterSeconds };
  }
  if (response.status === 400) {
    cancelResponseBody(response, "rejected");
    return { status: "terminal-negative", reason: "rejected" };
  }
  if (response.status === 429) {
    const retryAfterSeconds = rateLimitBackoffSeconds(response);
    cancelResponseBody(response, "rate-limited");
    return { status: "rate-limited", retryAfterSeconds };
  }
  if (response.status === 403) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    cancelResponseBody(response, "registration-limited");
    if (retryAfterSeconds === null) {
      return { status: "terminal-negative", reason: "rejected" };
    }
    return { status: "registration-limited", retryAfterSeconds };
  }
  if (response.status !== 200) {
    cancelResponseBody(response, `http-${response.status}`);
    return { status: "error", reason: `http-${response.status}` };
  }
  return evaluateOkResponse(response, config.maxJsonLdBytes, signal);
}

// ../injector-core/dist/inject.js
function etagAttributeValue(etag) {
  return etag.replace(/^W\//i, "").replace(/^"|"$/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
function buildScriptTag(jsonldRaw, etag) {
  const safe = jsonldRaw.replace(/</g, "\\u003c");
  const etagAttr = etag ? ` data-etag="${etagAttributeValue(etag)}"` : "";
  return `<script type="application/ld+json" data-source="Enhancely.ai"${etagAttr}>${safe}</script>`;
}
var RAW_TEXT_ELEMENTS = ["script", "style", "title", "noframes"];
var HEAD_VOID_ELEMENTS = ["base", "basefont", "bgsound", "link", "meta"];
var NOSCRIPT_VOID_ELEMENTS = ["basefont", "bgsound", "link", "meta"];
var NOSCRIPT_RAW_TEXT_ELEMENTS = ["style", "noframes"];
var PLAINTEXT_ELEMENT = "plaintext";
function endOfTag(html, start) {
  let state = "tag-name";
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i] ?? "";
    const whitespace = /[\t\n\f\r ]/.test(char);
    switch (state) {
      case "tag-name":
        if (whitespace)
          state = "before-attribute-name";
        else if (char === "/")
          state = "self-closing-start-tag";
        else if (char === ">")
          return i + 1;
        break;
      case "before-attribute-name":
        if (whitespace)
          break;
        if (char === "/")
          state = "self-closing-start-tag";
        else if (char === ">")
          return i + 1;
        else
          state = "attribute-name";
        break;
      case "attribute-name":
        if (whitespace)
          state = "after-attribute-name";
        else if (char === "/")
          state = "self-closing-start-tag";
        else if (char === "=")
          state = "before-attribute-value";
        else if (char === ">")
          return i + 1;
        break;
      case "after-attribute-name":
        if (whitespace)
          break;
        if (char === "/")
          state = "self-closing-start-tag";
        else if (char === "=")
          state = "before-attribute-value";
        else if (char === ">")
          return i + 1;
        else
          state = "attribute-name";
        break;
      case "before-attribute-value":
        if (whitespace)
          break;
        if (char === '"')
          state = "attribute-value-double";
        else if (char === "'")
          state = "attribute-value-single";
        else if (char === ">")
          return i + 1;
        else
          state = "attribute-value-unquoted";
        break;
      case "attribute-value-double":
        if (char === '"')
          state = "after-attribute-value-quoted";
        break;
      case "attribute-value-single":
        if (char === "'")
          state = "after-attribute-value-quoted";
        break;
      case "attribute-value-unquoted":
        if (whitespace)
          state = "before-attribute-name";
        else if (char === ">")
          return i + 1;
        break;
      case "after-attribute-value-quoted":
        if (whitespace)
          state = "before-attribute-name";
        else if (char === "/")
          state = "self-closing-start-tag";
        else if (char === ">")
          return i + 1;
        else {
          state = "before-attribute-name";
          i -= 1;
        }
        break;
      case "self-closing-start-tag":
        if (char === ">")
          return i + 1;
        state = "before-attribute-name";
        i -= 1;
        break;
    }
  }
  return -1;
}
function endOfComment(html, start) {
  if (html.startsWith("<!-->", start))
    return start + 5;
  if (html.startsWith("<!--->", start))
    return start + 6;
  for (let index = start + 4; index < html.length - 1; index += 1) {
    if (html[index] !== "-" || html[index + 1] !== "-")
      continue;
    if (html[index + 2] === ">")
      return index + 3;
    if (html[index + 2] === "!" && html[index + 3] === ">")
      return index + 4;
  }
  return -1;
}
function startsDoctype(html, start) {
  return html.slice(start, start + "<!doctype".length).replace(/[A-Z]/g, (char) => char.toLowerCase()) === "<!doctype";
}
function endOfStructuralToken(html, start) {
  if (startsDoctype(html, start)) {
    const end = html.indexOf(">", start + 2);
    return end < 0 ? -1 : end + 1;
  }
  return endOfTag(html, start);
}
function endOfRawTextElement(html, lower, tag, start) {
  const needle = `</${tag}`;
  let from = start;
  while (from < html.length) {
    const close = lower.indexOf(needle, from);
    if (close < 0)
      return -1;
    const after = html[close + needle.length];
    if (after === void 0 || !/[\t\n\f\r />]/.test(after)) {
      from = close + needle.length;
      continue;
    }
    if (tag === "script") {
      const rawTextSpan = lower.slice(start, close);
      const escaped = rawTextSpan.indexOf("<!--");
      if (escaped >= 0) {
        let nested = rawTextSpan.indexOf("<script", escaped + 4);
        while (nested >= 0) {
          if (startsElement(rawTextSpan, nested, "script"))
            return -1;
          nested = rawTextSpan.indexOf("<script", nested + 7);
        }
      }
    }
    return endOfTag(html, close);
  }
  return -1;
}
function startsElement(lower, start, tag) {
  const prefix = `<${tag}`;
  if (!lower.startsWith(prefix, start))
    return false;
  const after = lower[start + prefix.length];
  return after !== void 0 && /[\t\n\f\r />]/.test(after);
}
function isHeadCloseTag(html, start, end) {
  return /^<\/head[\t\n\f\r ]*>$/i.test(html.slice(start, end));
}
function plainEndTagName(lower, start, end) {
  return /^<\/([a-z][a-z0-9:-]*)[\t\n\f\r ]*>$/.exec(lower.slice(start, end))?.[1] ?? null;
}
function endOfSafeHeadNoscript(html, lower, contentStart) {
  const needle = "</noscript";
  let close = lower.indexOf(needle, contentStart);
  while (close >= 0) {
    const after = html[close + needle.length];
    if (after !== void 0 && /[\t\n\f\r />]/.test(after))
      break;
    close = lower.indexOf(needle, close + needle.length);
  }
  if (close < 0)
    return -1;
  const closeEnd = endOfTag(html, close);
  if (closeEnd < 0)
    return -1;
  let i = contentStart;
  while (i < close) {
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 || lt >= close ? close : lt;
    if (/[^\t\n\f\r ]/.test(html.slice(i, textEnd)))
      return -1;
    if (textEnd === close)
      return closeEnd;
    if (lower.startsWith("<!--", lt)) {
      const commentEnd = endOfComment(html, lt);
      if (commentEnd < 0 || commentEnd > close)
        return -1;
      i = commentEnd;
      continue;
    }
    const tagEnd = endOfStructuralToken(html, lt);
    if (tagEnd < 0 || tagEnd > close)
      return -1;
    const endTagName = plainEndTagName(lower, lt, tagEnd);
    if (endTagName !== null) {
      if (endTagName === "br" || endTagName === "noscript")
        return -1;
      i = tagEnd;
      continue;
    }
    if (startsDoctype(html, lt)) {
      i = tagEnd;
      continue;
    }
    if (NOSCRIPT_VOID_ELEMENTS.some((element) => startsElement(lower, lt, element))) {
      i = tagEnd;
      continue;
    }
    const raw = NOSCRIPT_RAW_TEXT_ELEMENTS.find((element) => startsElement(lower, lt, element));
    if (raw !== void 0) {
      const rawEnd = endOfRawTextElement(html, lower, raw, tagEnd);
      if (rawEnd < 0 || rawEnd > close)
        return -1;
      i = rawEnd;
      continue;
    }
    return -1;
  }
  return closeEnd;
}
function findHeadInjectionPoint(html) {
  const lower = html.replace(/[A-Z]/g, (char) => char.toLowerCase());
  let sawHeadOpen = false;
  let sawBodyOpen = false;
  let sawHtmlOpen = false;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0)
      return null;
    const textBeforeTag = html.slice(i, lt);
    const structuralText = i === 0 && textBeforeTag.startsWith("\uFEFF") ? textBeforeTag.slice(1) : textBeforeTag;
    if (/[^\t\n\f\r ]/.test(structuralText))
      return null;
    if (lower.startsWith("<!--", lt)) {
      const end = endOfComment(html, lt);
      if (end < 0)
        return null;
      i = end;
      continue;
    }
    const tagEnd = endOfStructuralToken(html, lt);
    if (tagEnd < 0)
      return null;
    const endTagName = plainEndTagName(lower, lt, tagEnd);
    if (isHeadCloseTag(html, lt, tagEnd)) {
      if (sawHeadOpen)
        return lt;
      return null;
    }
    if (startsElement(lower, lt, "head")) {
      if (sawBodyOpen || sawHeadOpen)
        return null;
      sawHeadOpen = true;
      i = tagEnd;
      continue;
    }
    if (startsElement(lower, lt, "body")) {
      if (sawHeadOpen)
        return null;
      sawBodyOpen = true;
      i = tagEnd;
      continue;
    }
    if (!sawHeadOpen) {
      if (startsElement(lower, lt, "html")) {
        if (sawBodyOpen || sawHtmlOpen)
          return null;
        sawHtmlOpen = true;
        i = tagEnd;
        continue;
      }
      if (startsDoctype(html, lt)) {
        if (sawBodyOpen)
          return null;
        i = tagEnd;
        continue;
      }
      if (endTagName !== null && endTagName !== "head" && endTagName !== "body" && endTagName !== "html" && endTagName !== "br") {
        i = tagEnd;
        continue;
      }
      return null;
    }
    if (startsElement(lower, lt, "template"))
      return null;
    if (startsElement(lower, lt, PLAINTEXT_ELEMENT))
      return null;
    if (startsElement(lower, lt, "noscript")) {
      const closeEnd = endOfSafeHeadNoscript(html, lower, tagEnd);
      if (closeEnd < 0)
        return null;
      i = closeEnd;
      continue;
    }
    if (endTagName !== null) {
      if (endTagName === "head" || endTagName === "body" || endTagName === "html" || endTagName === "br" || endTagName === "template") {
        return null;
      }
      i = tagEnd;
      continue;
    }
    let raw = null;
    for (const t of RAW_TEXT_ELEMENTS) {
      if (startsElement(lower, lt, t)) {
        raw = t;
        break;
      }
    }
    if (raw !== null) {
      const closeEnd = endOfRawTextElement(html, lower, raw, tagEnd);
      if (closeEnd < 0)
        return null;
      i = closeEnd;
    } else if (sawHeadOpen && HEAD_VOID_ELEMENTS.some((element) => startsElement(lower, lt, element))) {
      i = tagEnd;
    } else if (sawHeadOpen) {
      return null;
    }
  }
  return null;
}
function injectIntoHead(html, snippet, injectionPoint = findHeadInjectionPoint(html)) {
  const index = injectionPoint;
  if (index === null || index < 0 || index >= html.length)
    return html;
  const tagEnd = endOfTag(html, index);
  if (tagEnd < 0 || !isHeadCloseTag(html, index, tagEnd))
    return html;
  return html.slice(0, index) + snippet + html.slice(index);
}

// ../injector-core/dist/header-value.js
function splitHttpQuotedValue(value, delimiter) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return { parts, balanced: !quoted };
}
function trimHttpOws(value) {
  return value.replace(/^[\t ]+|[\t ]+$/g, "");
}
function splitOutsideHttpQuotes(value, delimiter) {
  return splitHttpQuotedValue(value, delimiter).parts;
}
function splitOutsideHttpQuotesStrict(value, delimiter) {
  const parsed = splitHttpQuotedValue(value, delimiter);
  return parsed.balanced ? parsed.parts : null;
}

// ../injector-core/dist/encoding.js
function charsetOf(contentType) {
  const parameters = splitOutsideHttpQuotes(contentType, ";");
  for (let index = 1; index < parameters.length; index += 1) {
    const parameter = parameters[index] ?? "";
    const equalsAt = parameter.indexOf("=");
    if (equalsAt < 0 || trimHttpOws(parameter.slice(0, equalsAt)).toLowerCase() !== "charset") {
      continue;
    }
    const raw = trimHttpOws(parameter.slice(equalsAt + 1));
    if (!raw.startsWith('"'))
      return raw.toLowerCase();
    let value = "";
    let escaped = false;
    for (let cursor = 1; cursor < raw.length; cursor += 1) {
      const char = raw[cursor];
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        return trimHttpOws(raw.slice(cursor + 1)) === "" ? value.toLowerCase() : null;
      } else {
        value += char;
      }
    }
    return null;
  }
  return null;
}
function containsOnlyAscii(body) {
  return body.every((byte) => byte <= 127);
}
function hasUtf8Bom(body) {
  return body.length >= 3 && body[0] === 239 && body[1] === 187 && body[2] === 191;
}
function latin1Window(body) {
  let value = "";
  const length = Math.min(body.byteLength, 1024);
  for (let i = 0; i < length; i++)
    value += String.fromCharCode(body[i] ?? 0);
  return value;
}
function htmlTagAt(value, start) {
  let nameStart = start + 1;
  const isEnd = value[nameStart] === "/";
  if (isEnd)
    nameStart += 1;
  const match = /^[A-Za-z][^\t\n\f\r />]*/.exec(value.slice(nameStart));
  const originalName = match?.[0];
  if (originalName === void 0)
    return null;
  return {
    name: originalName.toLowerCase(),
    isEnd,
    attributesStart: nameStart + originalName.length
  };
}
var ASCII_WHITESPACE = /[\t\n\f\r ]/;
function asciiLowerChar(char) {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
}
function prescanAttributes(value, start) {
  const attributes = /* @__PURE__ */ new Map();
  let position = start;
  while (true) {
    while (position < value.length && (ASCII_WHITESPACE.test(value[position] ?? "") || value[position] === "/")) {
      position += 1;
    }
    if (position >= value.length)
      return null;
    if (value[position] === ">")
      return { attributes, end: position + 1 };
    let name = "";
    let hasEquals = false;
    while (position < value.length) {
      const char = value[position] ?? "";
      if (char === "=" && name !== "") {
        hasEquals = true;
        position += 1;
        break;
      }
      if (ASCII_WHITESPACE.test(char)) {
        while (position < value.length && ASCII_WHITESPACE.test(value[position] ?? "")) {
          position += 1;
        }
        if (value[position] === "=") {
          hasEquals = true;
          position += 1;
        }
        break;
      }
      if (char === "/" || char === ">")
        break;
      name += asciiLowerChar(char);
      position += 1;
    }
    if (!hasEquals) {
      if (name !== "" && !attributes.has(name))
        attributes.set(name, "");
      if (value[position] === ">")
        return { attributes, end: position + 1 };
      continue;
    }
    while (position < value.length && ASCII_WHITESPACE.test(value[position] ?? "")) {
      position += 1;
    }
    if (position >= value.length)
      return null;
    let attributeValue = "";
    const quote = value[position];
    if (quote === '"' || quote === "'") {
      position += 1;
      while (position < value.length && value[position] !== quote) {
        attributeValue += asciiLowerChar(value[position] ?? "");
        position += 1;
      }
      if (value[position] !== quote)
        return null;
      position += 1;
    } else {
      while (position < value.length && !ASCII_WHITESPACE.test(value[position] ?? "") && value[position] !== ">") {
        attributeValue += asciiLowerChar(value[position] ?? "");
        position += 1;
      }
    }
    if (name !== "" && !attributes.has(name))
      attributes.set(name, attributeValue);
    if (value[position] === ">")
      return { attributes, end: position + 1 };
  }
}
function charsetFromMetaContent(content) {
  const lower = content.toLowerCase();
  let position = 0;
  while (position < content.length) {
    const match = lower.indexOf("charset", position);
    if (match < 0)
      return null;
    position = match + "charset".length;
    while (position < content.length && ASCII_WHITESPACE.test(content[position] ?? "")) {
      position += 1;
    }
    if (content[position] !== "=")
      continue;
    position += 1;
    while (position < content.length && ASCII_WHITESPACE.test(content[position] ?? "")) {
      position += 1;
    }
    if (position >= content.length)
      return null;
    const quote = content[position];
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, position + 1);
      return end < 0 ? null : content.slice(position + 1, end);
    }
    const start = position;
    while (position < content.length && !ASCII_WHITESPACE.test(content[position] ?? "") && content[position] !== ";") {
      position += 1;
    }
    return content.slice(start, position);
  }
  return null;
}
function isUtf8EncodingLabel(value) {
  const normalized = (value ?? "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  return normalized === "utf-8" || normalized === "utf8";
}
function declaresUtf8MetaInPrescan(body) {
  const window = latin1Window(body);
  let cursor = 0;
  while (cursor < window.length) {
    const start = window.indexOf("<", cursor);
    if (start < 0)
      return false;
    if (window.startsWith("<!--", start)) {
      const commentEnd = window.indexOf("-->", start + 2);
      if (commentEnd < 0)
        return false;
      cursor = commentEnd + 3;
      continue;
    }
    const tag = htmlTagAt(window, start);
    if (tag === null) {
      if (window.startsWith("<!", start) || window.startsWith("</", start) || window.startsWith("<?", start)) {
        const end = window.indexOf(">", start + 2);
        if (end < 0)
          return false;
        cursor = end + 1;
      } else {
        cursor = start + 1;
      }
      continue;
    }
    const parsed = prescanAttributes(window, tag.attributesStart);
    if (parsed === null)
      return false;
    if (tag.isEnd) {
      cursor = parsed.end;
      continue;
    }
    if (tag.name === "meta") {
      const attrs = parsed.attributes;
      const direct = attrs.get("charset");
      const declared = direct !== void 0 ? direct : attrs.get("http-equiv") === "content-type" ? charsetFromMetaContent(attrs.get("content") ?? "") : null;
      if (declared !== null)
        return isUtf8EncodingLabel(declared);
      cursor = parsed.end;
      continue;
    }
    cursor = parsed.end;
  }
  return false;
}
function isValidUtf8(body) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}
function isUtf8SafeHtmlBytes(body, contentType) {
  const charset = charsetOf(contentType);
  if (charset === "utf-8" || charset === "utf8")
    return isValidUtf8(body);
  if (charset === "ascii" || charset === "us-ascii")
    return containsOnlyAscii(body);
  if (charset !== null)
    return false;
  return isValidUtf8(body) && (containsOnlyAscii(body) || hasUtf8Bom(body) || declaresUtf8MetaInPrescan(body));
}

// ../injector-core/dist/exclude.js
function globMatch(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p += 1;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*")
    p += 1;
  return p === pattern.length;
}
function decodeUnreservedOctets(pathname) {
  return pathname.replace(/%([0-9A-Fa-f]{2})/g, (encoded, hex) => {
    const code = parseInt(hex, 16);
    const isUnreserved = code >= 65 && code <= 90 || // A-Z
    code >= 97 && code <= 122 || // a-z
    code >= 48 && code <= 57 || // 0-9
    code === 45 || // -
    code === 46 || // .
    code === 95 || // _
    code === 126;
    return isUnreserved ? String.fromCharCode(code) : encoded;
  });
}
function normalizePathForMatch(pathname) {
  const segments = [];
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === ".")
      continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const endsAsDirectory = /\/\.{0,2}$/.test(pathname);
  if (segments.length === 0)
    return "/";
  return `/${segments.join("/")}${endsAsDirectory ? "/" : ""}`;
}
function matchesExcludedPath(patterns, pathname) {
  const normalized = normalizePathForMatch(decodeUnreservedOctets(pathname).replaceAll("\\", "/"));
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern === "" || pattern.length > 255)
      continue;
    const anchored = pattern.startsWith("/") || pattern.startsWith("*") ? pattern : `/${pattern}`;
    if (globMatch(anchored, normalized))
      return true;
  }
  return false;
}

// ../injector-core/dist/host-filter.js
function hasForbiddenHostCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 32 || codePoint === 127 || "\\/?#@%".includes(character))
      return true;
  }
  return false;
}
function isDnsHostname(hostname) {
  if (hostname === "" || hostname.length > 254)
    return false;
  const bare = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (bare === "" || bare.length > 253)
    return false;
  for (const label of bare.split(".")) {
    if (label.length === 0 || label.length > 63)
      return false;
    for (let index = 0; index < label.length; index += 1) {
      const code = label.charCodeAt(index);
      const alphaNumeric = code >= 48 && code <= 57 || code >= 97 && code <= 122 || code >= 65 && code <= 90;
      if (!alphaNumeric && code !== 45)
        return false;
    }
    if (label.startsWith("-") || label.endsWith("-"))
      return false;
  }
  return true;
}
function parsedDnsHostname(authority) {
  try {
    const parsed = new URL(`https://${authority}/`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "") {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    return isDnsHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}
function canonicalConfiguredHost(value) {
  if (value === "" || value !== value.trim() || hasForbiddenHostCharacter(value))
    return null;
  if (value.includes(":"))
    return null;
  return parsedDnsHostname(value);
}
function canonicalRequestHost(value) {
  if (value === "" || value !== value.trim() || hasForbiddenHostCharacter(value))
    return null;
  let hostnamePart = value;
  let portPart = null;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0)
      return null;
    hostnamePart = value.slice(0, close + 1);
    const suffix = value.slice(close + 1);
    if (suffix !== "") {
      if (!suffix.startsWith(":"))
        return null;
      portPart = suffix.slice(1);
    }
  } else {
    const colon = value.lastIndexOf(":");
    if (colon >= 0) {
      if (value.indexOf(":") !== colon)
        return null;
      hostnamePart = value.slice(0, colon);
      portPart = value.slice(colon + 1);
    }
  }
  if (hostnamePart === "")
    return null;
  if (portPart !== null && !/^0*443$/.test(portPart))
    return null;
  return parsedDnsHostname(value);
}
function isHostIncluded(host, includeHosts) {
  if (includeHosts.length === 0)
    return true;
  const candidate = canonicalRequestHost(host);
  if (candidate === null)
    return false;
  let matched = false;
  for (const configured of includeHosts) {
    const canonical = canonicalConfiguredHost(configured);
    if (canonical === null)
      return false;
    if (canonical === candidate)
      matched = true;
  }
  return matched;
}

// ../injector-core/dist/robots.js
var VALUE_BEARING_ROBOTS_DIRECTIVES = /* @__PURE__ */ new Set([
  "max-image-preview",
  "max-snippet",
  "max-video-preview",
  "unavailable_after"
]);
function blocksIndexing(xRobotsTag) {
  if (xRobotsTag === null || xRobotsTag === void 0)
    return false;
  return xRobotsTag.split(",").some((rawClause) => {
    const clause = rawClause.trim();
    if (clause === "")
      return false;
    if (/(?:^|[\s:;])noindex(?=$|[\s:;])/i.test(clause))
      return true;
    const nonePattern = /(?:^|[\s:;])(none)(?=$|[\s;])/gi;
    for (const match of clause.matchAll(nonePattern)) {
      const noneAt = (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0);
      let cursor = noneAt - 1;
      while (cursor >= 0 && /[\t\n\f\r ]/.test(clause[cursor] ?? ""))
        cursor -= 1;
      if (clause[cursor] !== ":")
        return true;
      cursor -= 1;
      while (cursor >= 0 && /[\t\n\f\r ]/.test(clause[cursor] ?? ""))
        cursor -= 1;
      const keyEnd = cursor + 1;
      while (cursor >= 0 && /[A-Za-z0-9_-]/.test(clause[cursor] ?? ""))
        cursor -= 1;
      const key = clause.slice(cursor + 1, keyEnd).toLowerCase();
      if (!VALUE_BEARING_ROBOTS_DIRECTIVES.has(key))
        return true;
    }
    return false;
  });
}

// ../injector-core/dist/representation.js
function fieldInstances(value) {
  if (value === null || value === void 0)
    return [];
  return typeof value === "string" ? [value] : value;
}
function isHtmlMediaType(value) {
  const instances = fieldInstances(value);
  if (instances.length !== 1)
    return false;
  const fieldValues = splitOutsideHttpQuotesStrict(instances[0] ?? "", ",");
  if (fieldValues === null || fieldValues.length !== 1)
    return false;
  const parameters = splitOutsideHttpQuotesStrict(fieldValues[0] ?? "", ";");
  return parameters !== null && trimHttpOws(parameters[0] ?? "").toLowerCase() === "text/html";
}
var HTTP_TOKEN_AT_START = /^[\t ]*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)/;
var COMPLETE_HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function leadingHttpToken(value) {
  return HTTP_TOKEN_AT_START.exec(value)?.[1]?.toLowerCase() ?? null;
}
function instanceHasNoTransformDirective(value) {
  if (splitOutsideHttpQuotesStrict(value, ",") === null)
    return true;
  let quoted = false;
  let escaped = false;
  let start = 0;
  const inspect = (end) => {
    let tokenStart = start;
    while (tokenStart < end && /^[\t\n\f\r ]$/.test(value[tokenStart] ?? ""))
      tokenStart += 1;
    if (tokenStart >= end)
      return false;
    let previous = tokenStart - 1;
    while (previous >= 0 && /^[\t\n\f\r ]$/.test(value[previous] ?? ""))
      previous -= 1;
    if (value[previous] === "=")
      return false;
    return leadingHttpToken(value.slice(tokenStart, end)) === "no-transform";
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quoted) {
      if (escaped)
        escaped = false;
      else if (char === "\\")
        escaped = true;
      else if (char === '"')
        quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "," || char === ";" || /^[\t\n\f\r ]$/.test(char)) {
      if (inspect(index))
        return true;
      start = index + 1;
    }
  }
  return inspect(value.length);
}
function hasNoTransformDirective(value) {
  return fieldInstances(value).some(instanceHasNoTransformDirective);
}
function isAttachmentDisposition(value) {
  return fieldInstances(value).some((instance) => {
    const members = splitOutsideHttpQuotesStrict(instance, ",");
    if (members === null)
      return true;
    return members.some((member) => {
      const parameters = splitOutsideHttpQuotesStrict(member, ";");
      if (parameters === null)
        return true;
      const disposition = trimHttpOws(parameters[0] ?? "");
      return COMPLETE_HTTP_TOKEN.test(disposition) && disposition.toLowerCase() !== "inline";
    });
  });
}

// ../injector-core/dist/rate-limit-circuit.js
var MAX_SCOPES_PER_FETCH_IMPL = 128;
var missingGlobalFetchOwner = {};
var rateLimitDeadlines = /* @__PURE__ */ new WeakMap();
function __resetRateLimitCircuitForTests() {
  rateLimitDeadlines = /* @__PURE__ */ new WeakMap();
}
function fetchOwner(config) {
  return config.fetchImpl ?? globalThis.fetch ?? missingGlobalFetchOwner;
}
function scopeKey(config) {
  return JSON.stringify([config.enhancelyBase, config.apiKey]);
}
function pruneExpired(scopes, now) {
  for (const [key, deadline] of scopes) {
    if (deadline <= now)
      scopes.delete(key);
  }
}
function getRateLimitDeadline(config, now) {
  const owner = fetchOwner(config);
  const scopes = rateLimitDeadlines.get(owner);
  if (scopes === void 0)
    return null;
  const currentTime = now ?? Date.now();
  pruneExpired(scopes, currentTime);
  if (scopes.size === 0) {
    rateLimitDeadlines.delete(owner);
    return null;
  }
  const key = scopeKey(config);
  const deadline = scopes.get(key);
  if (deadline === void 0)
    return null;
  scopes.delete(key);
  scopes.set(key, deadline);
  return deadline;
}
function recordRateLimitDeadline(config, deadline) {
  const now = Date.now();
  if (deadline <= now)
    return;
  const owner = fetchOwner(config);
  let scopes = rateLimitDeadlines.get(owner);
  if (scopes === void 0) {
    scopes = /* @__PURE__ */ new Map();
    rateLimitDeadlines.set(owner, scopes);
  } else {
    pruneExpired(scopes, now);
  }
  const key = scopeKey(config);
  const current = scopes.get(key) ?? 0;
  scopes.delete(key);
  scopes.set(key, Math.max(current, deadline));
  while (scopes.size > MAX_SCOPES_PER_FETCH_IMPL) {
    const oldest = scopes.keys().next().value;
    if (oldest === void 0)
      break;
    scopes.delete(oldest);
  }
}

// ../injector-core/dist/index.js
function snippetFromEntry(entry) {
  return entry.jsonldRaw !== null ? buildScriptTag(entry.jsonldRaw, entry.etag) : null;
}
function lookupFromEntry(entry, cacheTtlMs, now = Date.now()) {
  if (entry.jsonldRaw !== null) {
    return { snippet: snippetFromEntry(entry), revalidateInMs: null };
  }
  const cacheExpiry = entry.storedAt > 0 ? entry.storedAt + cacheTtlMs : 0;
  const nextLookupAt = Math.max(cacheExpiry, entry.retryNotBefore ?? 0);
  return {
    snippet: null,
    revalidateInMs: Math.max(1, nextLookupAt - now)
  };
}
var DEFAULT_RETRY_BACKOFF_MS = 1e4;
var MAX_RETRY_BACKOFF_MS = 6e4;
var MAX_REGISTER_BACKOFF_MS = 864e5;
var lookupFlights = /* @__PURE__ */ new WeakMap();
var cacheWriteLocks = /* @__PURE__ */ new WeakMap();
async function withCacheWriteLock(cache2, key, operation) {
  let locks = cacheWriteLocks.get(cache2);
  if (locks === void 0) {
    locks = /* @__PURE__ */ new Map();
    cacheWriteLocks.set(cache2, locks);
  }
  const previous = locks.get(key) ?? Promise.resolve();
  const state = {};
  const current = new Promise((resolve) => {
    state.release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    state.release?.();
    if (locks.get(key) === current) {
      locks.delete(key);
      if (locks.size === 0)
        cacheWriteLocks.delete(cache2);
    }
  }
}
function runLookupSingleFlight(cache2, flightKey, operation) {
  let flights = lookupFlights.get(cache2);
  if (flights === void 0) {
    flights = /* @__PURE__ */ new Map();
    lookupFlights.set(cache2, flights);
  }
  const existing = flights.get(flightKey);
  if (existing !== void 0)
    return existing;
  const pending = operation().finally(() => {
    if (flights?.get(flightKey) === pending) {
      flights.delete(flightKey);
      if (flights.size === 0)
        lookupFlights.delete(cache2);
    }
  });
  flights.set(flightKey, pending);
  return pending;
}
function sameCacheEntry(left, right) {
  if (left === right)
    return true;
  if (left === void 0 || right === void 0)
    return false;
  return left.jsonldRaw === right.jsonldRaw && left.etag === right.etag && left.storedAt === right.storedAt && left.registrationPending === right.registrationPending && left.retryNotBefore === right.retryNotBefore;
}
function sameCacheEntryIgnoringRetry(left, right) {
  if (left === void 0 || right === void 0)
    return false;
  return left.jsonldRaw === right.jsonldRaw && left.etag === right.etag && left.storedAt === right.storedAt && left.registrationPending === right.registrationPending;
}
async function storeIfSnapshotUnchanged(cache2, key, snapshot, entry, preferPositive = false) {
  return withCacheWriteLock(cache2, key, async () => {
    const current = await cache2.get(key);
    const isConcurrentRetryOnlyMemo = current !== void 0 && current.retryNotBefore !== void 0 && !sameCacheEntry(current, snapshot) && sameCacheEntryIgnoringRetry(current, snapshot);
    if (isConcurrentRetryOnlyMemo) {
      const resolved = entry.jsonldRaw === null ? {
        ...entry,
        retryNotBefore: Math.max(entry.retryNotBefore ?? 0, current.retryNotBefore ?? 0)
      } : entry;
      await cache2.set(key, resolved);
      return resolved;
    }
    if (current !== void 0 && !sameCacheEntry(current, snapshot) && !(preferPositive && entry.jsonldRaw !== null && current.jsonldRaw === null)) {
      return current;
    }
    await cache2.set(key, entry);
    return entry;
  });
}
async function storeBackoffMemo(cache2, key, snapshot, memo) {
  return withCacheWriteLock(cache2, key, async () => {
    const current = await cache2.get(key);
    if (sameCacheEntry(current, snapshot) || current === void 0) {
      await cache2.set(key, memo);
      return memo;
    }
    const isRetryOnlySnapshotMemo = current.retryNotBefore !== void 0 && sameCacheEntryIgnoringRetry(current, snapshot);
    if (current.jsonldRaw !== null && !isRetryOnlySnapshotMemo)
      return current;
    const merged = {
      ...current,
      retryNotBefore: Math.max(current.retryNotBefore ?? 0, memo.retryNotBefore)
    };
    await cache2.set(key, merged);
    return merged;
  });
}
async function storeNotFoundMergingConcurrentBackoff(cache2, key, snapshot, entry) {
  return withCacheWriteLock(cache2, key, async () => {
    const current = await cache2.get(key);
    if (sameCacheEntry(current, snapshot) || current === void 0) {
      await cache2.set(key, entry);
      return entry;
    }
    const isRetryOnlySnapshotMemo = current.retryNotBefore !== void 0 && sameCacheEntryIgnoringRetry(current, snapshot);
    if (current.retryNotBefore === void 0 || current.jsonldRaw !== null && !isRetryOnlySnapshotMemo) {
      return current;
    }
    const merged = {
      ...entry,
      ...current.registrationPending === true && { registrationPending: true },
      retryNotBefore: Math.max(entry.retryNotBefore ?? 0, current.retryNotBefore)
    };
    await cache2.set(key, merged);
    return merged;
  });
}
function localLookup(cached, cacheTtlMs) {
  if (cached && isFresh(cached, cacheTtlMs))
    return lookupFromEntry(cached, cacheTtlMs);
  if (cached?.retryNotBefore !== void 0 && Date.now() < cached.retryNotBefore) {
    return lookupFromEntry(cached, cacheTtlMs);
  }
  return null;
}
function lookupDuringRateLimit(cached, cacheTtlMs, retryNotBefore, now = Date.now()) {
  const entry = cached ? {
    ...cached,
    retryNotBefore: Math.max(cached.retryNotBefore ?? 0, retryNotBefore)
  } : {
    jsonldRaw: null,
    etag: null,
    storedAt: 0,
    retryNotBefore
  };
  return lookupFromEntry(entry, cacheTtlMs, now);
}
async function resolveLookup(url, cache2, config, call, opts) {
  try {
    const key = normalizeForEnhancely(url);
    if (key === null)
      return { snippet: null, revalidateInMs: null };
    const autoRegisterSuffix = opts.registerOnNotFound && config.autoRegister ? ":auto-register" : ":lookup-only";
    const flightKey = `${opts.flightMode}${autoRegisterSuffix}:${key}`;
    return await runLookupSingleFlight(cache2, flightKey, async () => {
      const cached = await cache2.get(key);
      const rateLimitDeadline = getRateLimitDeadline(config);
      if (rateLimitDeadline !== null) {
        return lookupDuringRateLimit(cached, config.cacheTtlMs, rateLimitDeadline);
      }
      const local = localLookup(cached, config.cacheTtlMs);
      if (local !== null)
        return local;
      const result = await call(key, cached?.etag);
      switch (result.status) {
        case "ok": {
          const entry = await storeIfSnapshotUnchanged(cache2, key, cached, {
            jsonldRaw: result.jsonldRaw,
            etag: result.etag,
            storedAt: Date.now()
          }, true);
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case "not-modified": {
          if (!cached)
            return { snippet: null, revalidateInMs: null };
          const refreshed = await storeIfSnapshotUnchanged(cache2, key, cached, {
            jsonldRaw: cached.jsonldRaw,
            etag: cached.etag,
            storedAt: Date.now(),
            ...cached.registrationPending === true && { registrationPending: true }
          });
          return lookupFromEntry(refreshed, config.cacheTtlMs);
        }
        case "pending": {
          const candidate = result.retryAfterSeconds !== null ? {
            jsonldRaw: null,
            etag: null,
            storedAt: 0,
            retryNotBefore: Date.now() + Math.min(Math.max(result.retryAfterSeconds, 1) * 1e3, config.cacheTtlMs)
          } : { jsonldRaw: null, etag: null, storedAt: Date.now() };
          const entry = await storeIfSnapshotUnchanged(cache2, key, cached, candidate);
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case "terminal-negative": {
          const entry = await storeIfSnapshotUnchanged(cache2, key, cached, {
            jsonldRaw: null,
            etag: null,
            storedAt: Date.now()
          });
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case "not-found": {
          if (opts.registerOnNotFound && config.autoRegister) {
            const registration = await registerOrRevalidate(config, key);
            if (registration.status === "ok") {
              const entry2 = await storeIfSnapshotUnchanged(cache2, key, cached, {
                jsonldRaw: registration.jsonldRaw,
                etag: registration.etag,
                storedAt: Date.now()
              }, true);
              return lookupFromEntry(entry2, config.cacheTtlMs);
            }
            if (registration.status === "pending") {
              const entry2 = await storeIfSnapshotUnchanged(cache2, key, cached, registration.retryAfterSeconds !== null ? {
                jsonldRaw: null,
                etag: null,
                storedAt: 0,
                registrationPending: true,
                retryNotBefore: Date.now() + Math.min(Math.max(registration.retryAfterSeconds, 1) * 1e3, config.cacheTtlMs)
              } : {
                jsonldRaw: null,
                etag: null,
                storedAt: Date.now(),
                registrationPending: true
              });
              return lookupFromEntry(entry2, config.cacheTtlMs);
            }
            if (registration.status === "terminal-negative") {
              const entry2 = await storeIfSnapshotUnchanged(cache2, key, cached, {
                jsonldRaw: null,
                etag: null,
                storedAt: Date.now()
              });
              return lookupFromEntry(entry2, config.cacheTtlMs);
            }
            if (registration.status === "rate-limited" || registration.status === "registration-limited" || registration.status === "error" || registration.status === "not-modified") {
              const backoffMs = (registration.status === "rate-limited" || registration.status === "registration-limited") && registration.retryAfterSeconds !== null ? Math.min(Math.max(registration.retryAfterSeconds, 1) * 1e3, MAX_REGISTER_BACKOFF_MS) : DEFAULT_RETRY_BACKOFF_MS;
              const now = Date.now();
              const retryNotBefore = now + backoffMs;
              if (registration.status === "rate-limited") {
                recordRateLimitDeadline(config, now + Math.min(backoffMs, MAX_RETRY_BACKOFF_MS));
              }
              const entry2 = await storeBackoffMemo(cache2, key, cached, {
                jsonldRaw: null,
                etag: null,
                storedAt: 0,
                retryNotBefore
              });
              return lookupFromEntry(entry2, config.cacheTtlMs);
            }
          }
          const entry = await storeNotFoundMergingConcurrentBackoff(cache2, key, cached, {
            jsonldRaw: null,
            etag: null,
            storedAt: Date.now(),
            ...opts.registerOnNotFound && config.autoRegister && { registrationPending: true }
          });
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case "registration-limited":
        case "rate-limited":
        case "error": {
          const backoffMs = (result.status === "rate-limited" || result.status === "registration-limited") && result.retryAfterSeconds !== null ? Math.min(Math.max(result.retryAfterSeconds, 1) * 1e3, opts.maxBackoffMs) : DEFAULT_RETRY_BACKOFF_MS;
          const now = Date.now();
          const retryNotBefore = now + backoffMs;
          if (result.status === "rate-limited") {
            recordRateLimitDeadline(config, now + Math.min(backoffMs, MAX_RETRY_BACKOFF_MS));
          }
          const memo = {
            jsonldRaw: cached?.jsonldRaw ?? null,
            etag: cached?.etag ?? null,
            storedAt: cached?.storedAt ?? 0,
            ...cached?.registrationPending === true && { registrationPending: true },
            retryNotBefore
          };
          let served = memo;
          try {
            served = await storeBackoffMemo(cache2, key, cached, memo);
          } catch {
          }
          return lookupFromEntry(served, config.cacheTtlMs);
        }
      }
    });
  } catch {
    return { snippet: null, revalidateInMs: null };
  }
}
async function getJsonLdLookup(url, cache2, config) {
  return resolveLookup(url, cache2, config, (key, etag) => fetchJsonLd(config, key, etag), {
    registerOnNotFound: true,
    maxBackoffMs: MAX_RETRY_BACKOFF_MS,
    flightMode: "conditional-get"
  });
}
async function getJsonLdRegisterLookup(url, cache2, config) {
  return resolveLookup(url, cache2, config, (key, etag) => registerOrRevalidate(config, key, etag), {
    registerOnNotFound: false,
    maxBackoffMs: MAX_REGISTER_BACKOFF_MS,
    flightMode: "register-or-revalidate"
  });
}

// src/config.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var DEFAULT_SSM_PARAMETER_NAME = "/enhancely/connector/api-key";
var DEFAULT_SSM_REGION = "us-east-1";
var CONFIG_FILE_NAME = "connector-config.json";
var DEFAULT_ORIGIN_TIMEOUT_MS = 2e3;
var DEFAULT_SSM_TIMEOUT_MS = 2e3;
var LAMBDA_HARD_TIMEOUT_MS = 1e4;
var FAIL_OPEN_SETTLEMENT_RESERVE_MS = 2e3;
var MAX_SEQUENTIAL_NETWORK_TIMEOUT_MS = LAMBDA_HARD_TIMEOUT_MS - FAIL_OPEN_SETTLEMENT_RESERVE_MS;
var DEFAULT_NON_PAGE_MEMO_TTL_MS = 18e5;
var resolvedConfig = null;
var negativeUntil = 0;
var inflight = null;
var NEGATIVE_TTL_MS = 3e4;
var resolvedOriginTimeoutMs = DEFAULT_ORIGIN_TIMEOUT_MS;
var resolvedAssertedDefaultTtlSeconds = 0;
var resolvedCapSetCookieResponses = false;
var resolvedNonPageMemoTtlMs = DEFAULT_NON_PAGE_MEMO_TTL_MS;
var bakedCache;
var bakedOverride;
var configOverrides = null;
function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function positiveWholeNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function parseBaked(raw) {
  const baked = {};
  if (typeof raw !== "object" || raw === null) return baked;
  const source = raw;
  const apiKey = nonEmptyString(source["apiKey"]);
  if (apiKey !== void 0) baked.apiKey = apiKey;
  const enhancelyBase = nonEmptyString(source["enhancelyBase"]);
  if (enhancelyBase !== void 0) baked.enhancelyBase = enhancelyBase;
  const timeoutMs = positiveWholeNumber(source["timeoutMs"]);
  const cacheTtlMs = positiveNumber(source["cacheTtlMs"]);
  if (cacheTtlMs !== void 0) baked.cacheTtlMs = cacheTtlMs;
  if (typeof source["autoRegister"] === "boolean") baked.autoRegister = source["autoRegister"];
  const originTimeoutMs = positiveWholeNumber(source["originTimeoutMs"]);
  const ssmParameterName = nonEmptyString(source["ssmParameterName"]);
  if (ssmParameterName !== void 0) baked.ssmParameterName = ssmParameterName;
  const ssmRegion = nonEmptyString(source["ssmRegion"]);
  if (ssmRegion !== void 0) baked.ssmRegion = ssmRegion;
  const ssmTimeoutMs = positiveWholeNumber(source["ssmTimeoutMs"]);
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const effectiveOriginTimeoutMs = originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
  const effectiveSsmTimeoutMs = ssmTimeoutMs ?? DEFAULT_SSM_TIMEOUT_MS;
  if (effectiveTimeoutMs + effectiveOriginTimeoutMs + effectiveSsmTimeoutMs <= MAX_SEQUENTIAL_NETWORK_TIMEOUT_MS) {
    if (timeoutMs !== void 0) baked.timeoutMs = timeoutMs;
    if (originTimeoutMs !== void 0) baked.originTimeoutMs = originTimeoutMs;
    if (ssmTimeoutMs !== void 0) baked.ssmTimeoutMs = ssmTimeoutMs;
  } else {
    console.error(
      `[enhancely-lambda-edge] connector-config timeouts total ${effectiveTimeoutMs + effectiveOriginTimeoutMs + effectiveSsmTimeoutMs} ms, exceeding the ${MAX_SEQUENTIAL_NETWORK_TIMEOUT_MS} ms safe network budget under Lambda's 10-second limit \u2014 ignoring timeout overrides and using safe defaults`
    );
  }
  const assertedDefaultTtlSeconds = positiveNumber(source["assertedDefaultTtlSeconds"]);
  if (assertedDefaultTtlSeconds !== void 0 && assertedDefaultTtlSeconds >= 1) {
    baked.assertedDefaultTtlSeconds = Math.floor(assertedDefaultTtlSeconds);
  }
  const nonPageMemoTtlMs = positiveNumber(source["nonPageMemoTtlMs"]);
  if (nonPageMemoTtlMs !== void 0) baked.nonPageMemoTtlMs = nonPageMemoTtlMs;
  if (typeof source["capSetCookieResponses"] === "boolean") {
    baked.capSetCookieResponses = source["capSetCookieResponses"];
  }
  if (Array.isArray(source["excludePaths"])) {
    const patterns = source["excludePaths"].filter(
      (entry) => typeof entry === "string" && entry !== ""
    );
    if (patterns.length > 0) baked.excludePaths = patterns;
  }
  if (Object.hasOwn(source, "includeHosts")) {
    if (Array.isArray(source["includeHosts"])) {
      baked.includeHosts = source["includeHosts"].map(
        (entry) => typeof entry === "string" ? entry : ""
      );
    } else {
      baked.includeHosts = [""];
    }
  }
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
function bakedConfig() {
  if (bakedOverride !== void 0) return bakedOverride;
  if (bakedCache === void 0) bakedCache = readBakedConfig();
  return bakedCache;
}
async function resolveOnce() {
  try {
    const baked = bakedConfig();
    resolvedOriginTimeoutMs = baked?.originTimeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS;
    resolvedAssertedDefaultTtlSeconds = baked?.assertedDefaultTtlSeconds ?? 0;
    resolvedCapSetCookieResponses = baked?.capSetCookieResponses ?? false;
    resolvedNonPageMemoTtlMs = baked?.nonPageMemoTtlMs ?? DEFAULT_NON_PAGE_MEMO_TTL_MS;
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
        "[enhancely-lambda-edge] NO API KEY: neither a baked connector-config.json apiKey nor a non-empty SSM parameter was found \u2014 responses pass through UNINJECTED for 30 seconds, then config resolution is retried"
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
      "[enhancely-lambda-edge] config resolution FAILED \u2014 every response passes through UNINJECTED for 30 seconds, then config resolution is retried:",
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
function getConfigRetryInMs() {
  if (resolvedConfig !== null || negativeUntil <= Date.now()) return null;
  return negativeUntil - Date.now();
}
function getOriginTimeoutMs() {
  return resolvedOriginTimeoutMs;
}
function getAssertedDefaultTtlSeconds() {
  return resolvedAssertedDefaultTtlSeconds;
}
function getCapSetCookieResponses() {
  return resolvedCapSetCookieResponses;
}
function getExcludePaths() {
  return bakedConfig()?.excludePaths ?? [];
}
function getIncludeHosts() {
  return bakedConfig()?.includeHosts ?? [];
}

// src/origin-fetch.ts
var http = __toESM(require("node:http"), 1);
var https = __toESM(require("node:https"), 1);
var OriginFetchError = class extends Error {
  scope;
  constructor(scope, cause) {
    super(cause instanceof Error ? cause.message : "Origin fetch failed", { cause });
    this.name = "OriginFetchError";
    this.scope = scope;
  }
};
var ENDPOINT_SETUP_ERROR_CODES = /* @__PURE__ */ new Set([
  // DNS.
  "ENOTFOUND",
  "EAI_AGAIN",
  // TCP/routing. AbortSignal timeouts surface as ABORT_ERR on Node 20/22.
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EPIPE",
  // TLS/OpenSSL codes without a shared prefix.
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);
function errorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}
function isEndpointSetupFailure(error) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  const code = errorCode(error);
  if (code === null) return false;
  return ENDPOINT_SETUP_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.startsWith("ERR_OSSL_") || code.startsWith("CERT_");
}
function fetchOriginHtml(originUrl, hostHeader, timeoutMs, maxBytes, maxHeaderBytes, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(originUrl);
    const lib = url.protocol === "https:" ? https : http;
    let transportReady = false;
    const rejectScoped = (error) => {
      const scope = !transportReady && isEndpointSetupFailure(error) ? "endpoint" : "request";
      reject(new OriginFetchError(scope, error));
    };
    const authorityEnd = originUrl.indexOf("/", originUrl.indexOf("://") + 3);
    const rawPath = authorityEnd === -1 ? "/" : originUrl.slice(authorityEnd);
    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port !== "" ? Number(url.port) : void 0,
        path: rawPath,
        method: "GET",
        agent: false,
        // Node's client default is 16 KiB, but CloudFront accepts 32 KiB.
        // The caller supplies the connector's single quota constant so this
        // low-level module neither duplicates it nor imports shared.ts.
        maxHeaderSize: maxHeaderBytes,
        // TLS SNI (and cert-hostname verification) must present the PUBLIC
        // host, not the origin's own DNS name. A CloudFront custom origin is
        // usually addressed by an internal name (for example an ALB under
        // `elb.amazonaws.com`) whose certificate is issued for the public
        // domain, and the origin selects the right cert by SNI. Node would
        // otherwise default SNI to the origin hostname, the cert fails
        // verification, the re-fetch rejects and the handler fails open (no
        // injection). Using the same value as the Host header is correct for
        // every name-based vhosted origin and needs no per-site configuration.
        // Ignored for plain-http origins.
        servername: hostHeader,
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
        transportReady = true;
        const status = response.statusCode ?? 0;
        const decodeHeaderValue = (raw) => {
          const utf8 = Buffer.from(raw, "latin1").toString("utf8");
          return Buffer.from(utf8, "utf8").toString("latin1") === raw ? utf8 : raw;
        };
        const allHeaders = {};
        for (const [name, values] of Object.entries(response.headersDistinct)) {
          if (values === void 0) continue;
          allHeaders[name.toLowerCase()] = values.map(decodeHeaderValue);
        }
        const combinedHeader = (name) => allHeaders[name]?.join(", ") ?? null;
        const contentType = combinedHeader("content-type");
        const contentEncoding = combinedHeader("content-encoding");
        const cacheControl = combinedHeader("cache-control");
        const expires = combinedHeader("expires");
        const contentDisposition = combinedHeader("content-disposition");
        const hasSetCookie = allHeaders["set-cookie"] !== void 0;
        const csp = combinedHeader("content-security-policy");
        const cspReportOnly = combinedHeader("content-security-policy-report-only");
        const xRobotsTag = combinedHeader("x-robots-tag");
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
              expires,
              contentDisposition,
              hasSetCookie,
              contentSecurityPolicy: csp,
              contentSecurityPolicyReportOnly: cspReportOnly,
              xRobotsTag,
              body: Buffer.alloc(0),
              truncated: true,
              allHeaders
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
            expires,
            contentDisposition,
            hasSetCookie,
            contentSecurityPolicy: csp,
            contentSecurityPolicyReportOnly: cspReportOnly,
            xRobotsTag,
            body: Buffer.concat(chunks),
            truncated: false,
            allHeaders
          });
        });
        response.on("error", (error) => {
          if (settled) return;
          settled = true;
          rejectScoped(error);
        });
      }
    );
    request.once("socket", (socket) => {
      if (url.protocol === "https:") {
        socket.once("secureConnect", () => {
          transportReady = true;
        });
        return;
      }
      if (!socket.connecting) {
        transportReady = true;
        return;
      }
      socket.once("connect", () => {
        transportReady = true;
      });
    });
    request.on("error", rejectScoped);
    request.end();
  });
}

// src/shared.ts
var MAX_GENERATED_RESPONSE_BYTES = 1048576;
var MAX_RESPONSE_HEADER_BYTES = 32768;
var GENERATED_RESPONSE_SAFETY_MARGIN_BYTES = 1024;
var MAX_ORIGIN_BODY_BYTES = MAX_GENERATED_RESPONSE_BYTES - MAX_RESPONSE_HEADER_BYTES - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
var UTF8_COMPATIBLE_CHARSETS = /* @__PURE__ */ new Set(["utf-8", "utf8", "us-ascii", "ascii"]);
var GENERATED_HTML_CONTENT_TYPE = "text/html; charset=utf-8";
var RESPONSE_STATUS_LINE_OVERHEAD_BYTES = 64;
function serializedHeaderBytes(headers, status = "200", statusDescription = "OK") {
  const actualFramingBytes = Buffer.byteLength(`HTTP/1.1 ${status} ${statusDescription}\r
`, "utf8") + 2;
  let total = Math.max(RESPONSE_STATUS_LINE_OVERHEAD_BYTES, actualFramingBytes);
  for (const [name, entries] of Object.entries(headers)) {
    for (const entry of entries) {
      total += Buffer.byteLength(entry.key ?? name, "utf8") + Buffer.byteLength(entry.value, "utf8") + 4;
    }
  }
  return total;
}
var PER_REQUEST_CACHE_CONTROL = /(?:^|[\s,])(?:private|no-store)(?:$|[\s,=])/i;
function hasPerRequestCacheControl(cacheControl) {
  if (cacheControl === null || cacheControl === void 0) return false;
  const instances = typeof cacheControl === "string" ? [cacheControl] : cacheControl;
  return instances.some((value) => PER_REQUEST_CACHE_CONTROL.test(value));
}
var INJECTED_MARKER_HEADER = "x-enhancely-injected";
function isInjectableRepresentation(input) {
  if (input.method !== "GET") return false;
  if (input.status !== "200") return false;
  if (!isHtmlMediaType(input.contentType)) return false;
  const contentType = typeof input.contentType === "string" ? input.contentType : input.contentType?.[0] ?? "";
  const charset = charsetOf(contentType);
  if (charset !== null && !UTF8_COMPATIBLE_CHARSETS.has(charset)) return false;
  if (hasNoTransformDirective(input.cacheControl)) return false;
  if (isAttachmentDisposition(input.contentDisposition)) return false;
  return true;
}
function shouldAttempt(input, ignoreContentEncoding = false) {
  if (!isInjectableRepresentation(input)) return false;
  if (input.hasSetCookie) return false;
  if (hasPerRequestCacheControl(input.cacheControl)) {
    return false;
  }
  if (ignoreContentEncoding) return true;
  return input.contentEncoding === null;
}
function buildPageUrl(host, uri, querystring) {
  return `https://${host}${uri}${querystring !== "" ? `?${querystring}` : ""}`;
}
function resolvePageRequestTarget(request) {
  const hostEntries = request.headers["host"];
  if (hostEntries !== void 0 && hostEntries.length !== 1) return null;
  const originHost = hostEntries?.[0]?.value ?? request.origin?.custom?.domainName ?? "";
  if (originHost === "") return null;
  const pageHostEntries = request.origin?.custom?.customHeaders[PAGE_HOST_HEADER];
  if (pageHostEntries !== void 0 && pageHostEntries.length !== 1) return null;
  const pageHost = pageHostEntries?.[0]?.value ?? originHost;
  if (pageHost === "") return null;
  return {
    originHost,
    pageHost,
    pageUrl: buildPageUrl(pageHost, request.uri, request.querystring)
  };
}
function buildOriginUrl(request) {
  const custom = request.origin?.custom;
  if (custom === void 0) return null;
  const defaultPort = custom.protocol === "https" ? 443 : 80;
  const portPart = custom.port !== defaultPort ? `:${custom.port}` : "";
  const query = request.querystring !== "" ? `?${request.querystring}` : "";
  const origin = `${custom.protocol}://${custom.domainName}${portPart}`;
  const url = `${origin}${custom.path}${request.uri}${query}`;
  let resolved;
  try {
    resolved = new URL(url);
  } catch {
    return null;
  }
  if (`${resolved.protocol}//${resolved.host}` !== origin) return null;
  const prefix = custom.path === "" ? "/" : `${custom.path}/`;
  if (resolved.pathname !== custom.path && !resolved.pathname.startsWith(prefix)) return null;
  return url;
}
var PAGE_HOST_HEADER = "x-enhancely-page-host";
function originCustomHeaders(request) {
  const out = {};
  for (const [name, entries] of Object.entries(request.origin?.custom?.customHeaders ?? {})) {
    const value = entries?.[0]?.value;
    if (value !== void 0) out[name.toLowerCase()] = value;
  }
  return out;
}
function headerValue(headers, name) {
  return headers[name]?.[0]?.value ?? null;
}
function combinedHeaderValue(headers, name) {
  const entries = headers[name];
  return entries === void 0 ? null : entries.map((entry) => entry.value).join(", ");
}
function headerValues(headers, name) {
  const entries = headers[name];
  return entries === void 0 ? null : entries.map((entry) => entry.value);
}
var NON_FORWARDED_REQUEST_HEADERS = /* @__PURE__ */ new Set([
  "host",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
function forwardedHeaders(headers) {
  const out = {};
  const blocked = new Set(NON_FORWARDED_REQUEST_HEADERS);
  for (const entry of headers["connection"] ?? []) {
    for (const token of entry.value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name !== "") blocked.add(name);
    }
  }
  for (const [name, entries] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (blocked.has(key)) continue;
    if (entries.length === 0) continue;
    out[key] = entries.map((entry) => entry.value).join(key === "cookie" ? "; " : ", ");
  }
  return out;
}

// src/cache-cap.ts
var CACHE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function trimOws(value) {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}
function parseCacheControl(policy) {
  const rawDirectives = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index < policy.length; index += 1) {
    const char = policy[index];
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inQuotes = false;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      rawDirectives.push(policy.slice(start, index));
      start = index + 1;
    }
  }
  if (inQuotes || escaped) return null;
  rawDirectives.push(policy.slice(start));
  const parsed = [];
  for (const rawDirective of rawDirectives) {
    const directive = trimOws(rawDirective);
    if (directive === "") continue;
    const equalsAt = directive.indexOf("=");
    const namePart = equalsAt === -1 ? directive : directive.slice(0, equalsAt);
    const rawName = namePart;
    if (!CACHE_TOKEN.test(rawName)) return null;
    if (equalsAt === -1) {
      parsed.push({ name: rawName.toLowerCase(), value: null });
      continue;
    }
    const valuePart = directive.slice(equalsAt + 1);
    const rawValue = valuePart;
    if (rawValue === "") return null;
    if (rawValue.startsWith('"')) {
      if (!rawValue.endsWith('"') || rawValue.length < 2) return null;
      const inner = rawValue.slice(1, -1);
      for (let index = 0; index < inner.length; index += 1) {
        const char = inner[index];
        const code = char?.charCodeAt(0) ?? 0;
        if (char === '"' || code < 32 && char !== "	" || code === 127) return null;
        if (char === "\\") return null;
      }
      parsed.push({ name: rawName.toLowerCase(), value: inner });
      continue;
    }
    if (!CACHE_TOKEN.test(rawValue)) return null;
    parsed.push({ name: rawName.toLowerCase(), value: rawValue });
  }
  return parsed;
}
function parseCacheControlFields(headers) {
  const entries = headers["cache-control"];
  if (entries === void 0) return void 0;
  const directives = [];
  for (const entry of entries) {
    const parsed = parseCacheControl(entry.value);
    if (parsed === null) return null;
    directives.push(...parsed);
  }
  return directives;
}
function parseCacheDirective(directives, wanted) {
  if (directives === null) return { state: "invalid" };
  let matchedValue = null;
  for (const directive of directives) {
    if (directive.name !== wanted) continue;
    if (matchedValue !== null || directive.value === null) return { state: "invalid" };
    matchedValue = directive.value;
  }
  if (matchedValue === null) return { state: "absent" };
  if (!/^\d+$/.test(matchedValue)) return { state: "invalid" };
  const seconds = Number(matchedValue);
  return Number.isSafeInteger(seconds) ? { state: "valid", seconds } : { state: "invalid" };
}
function cacheDirectiveSeconds(policy, wanted) {
  const parsed = parseCacheDirective(parseCacheControl(policy), wanted);
  return parsed.state === "valid" ? parsed.seconds : null;
}
var IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function strictHttpDate(value) {
  const match = IMF_FIXDATE.exec(value);
  if (match === null) return null;
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = MONTHS.indexOf(monthText ?? "");
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1601 || month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = /* @__PURE__ */ new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || WEEKDAYS[date.getUTCDay()] !== weekday) {
    return null;
  }
  return date.getTime();
}
function retrySharedTtlSeconds(headers, revalidateInMs, assertedDefaultTtlSeconds) {
  const retryTtl = Math.max(1, Math.ceil(revalidateInMs / 1e3));
  const directives = parseCacheControlFields(headers);
  if (directives === null) return 0;
  if (directives !== void 0) {
    if (directives.some((directive) => directive.name === "no-cache")) {
      return 0;
    }
    const sharedTtl = parseCacheDirective(directives, "s-maxage");
    const browserTtl = parseCacheDirective(directives, "max-age");
    if (sharedTtl.state === "invalid" || browserTtl.state === "invalid") return 0;
    if (sharedTtl.state === "valid") {
      return Math.min(retryTtl, sharedTtl.seconds);
    }
    if (browserTtl.state === "valid") {
      return Math.min(retryTtl, browserTtl.seconds);
    }
  }
  const expiresEntries = headers["expires"];
  if (expiresEntries !== void 0) {
    if (expiresEntries.length !== 1) return 0;
    const expires = expiresEntries[0]?.value ?? "";
    const expiresAt = strictHttpDate(expires);
    if (expiresAt === null) {
      return 0;
    }
    const dateEntries = headers["date"];
    let reference = Date.now();
    if (dateEntries !== void 0) {
      if (dateEntries.length !== 1) return 0;
      const responseDate = strictHttpDate(headerValue(headers, "date") ?? "");
      if (responseDate === null) return 0;
      reference = responseDate;
    }
    return Math.min(retryTtl, Math.max(0, Math.floor((expiresAt - reference) / 1e3)));
  }
  return assertedDefaultTtlSeconds > 0 ? Math.min(retryTtl, Math.floor(assertedDefaultTtlSeconds)) : null;
}
function retryablePassThroughResponse(response, requestHeaders, revalidateInMs, opts) {
  if (requestHeaders["authorization"] !== void 0 || requestHeaders["cookie"] !== void 0) {
    return response;
  }
  const originalHeaders = response.headers ?? {};
  if (parseCacheControlFields(originalHeaders) === null) {
    return response;
  }
  if (hasPerRequestCacheControl(headerValues(originalHeaders, "cache-control"))) {
    return response;
  }
  if (originalHeaders["set-cookie"] !== void 0 && !opts.capSetCookieResponses) {
    return response;
  }
  const sharedTtlSeconds = retrySharedTtlSeconds(
    originalHeaders,
    revalidateInMs,
    opts.assertedDefaultTtlSeconds
  );
  if (sharedTtlSeconds === null) return response;
  const headers = { ...originalHeaders };
  headers["cache-control"] = [
    {
      key: "Cache-Control",
      value: `max-age=0, s-maxage=${sharedTtlSeconds}, must-revalidate`
    }
  ];
  delete headers["expires"];
  delete headers["etag"];
  delete headers["last-modified"];
  if (serializedHeaderBytes(headers, response.status, response.statusDescription) > MAX_RESPONSE_HEADER_BYTES) {
    return response;
  }
  return { ...response, headers };
}

// src/index.ts
function normalizedRobotsTag(xRobotsTag) {
  if (xRobotsTag === null) return null;
  return xRobotsTag.split(",").map((directive) => {
    const trimmed = trimHttpOws(directive);
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }).join(",");
}
function normalizedCacheControl(policy) {
  if (policy === null || policy === void 0) return null;
  const instances = typeof policy === "string" ? [policy] : policy;
  const directives = [];
  const names = /* @__PURE__ */ new Set();
  for (const instance of instances) {
    const parsed = splitOutsideHttpQuotesStrict(instance, ",");
    if (parsed === null) return void 0;
    for (const directive of parsed) {
      const trimmed = trimHttpOws(directive);
      if (trimmed === "") continue;
      const equalsAt = trimmed.indexOf("=");
      const name = (equalsAt < 0 ? trimmed : trimmed.slice(0, equalsAt)).toLowerCase();
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || names.has(name)) {
        return void 0;
      }
      names.add(name);
      directives.push(equalsAt < 0 ? name : `${name}${trimmed.slice(equalsAt)}`);
    }
  }
  return directives.sort().join(",");
}
function normalizedCspStructure(policy) {
  return policy.split(";").map((rawDirective) => {
    const [rawName, ...rawSources] = rawDirective.trim().split(/\s+/);
    if (rawName === void 0 || rawName === "") return "";
    const sources = rawSources.map((source) => {
      if (/^'nonce-[^']+'$/i.test(source)) return "'nonce-*'";
      const hash = /^'(sha256|sha384|sha512)-[^']+'$/i.exec(source);
      return hash?.[1] === void 0 ? source : `'${hash[1].toLowerCase()}-*'`;
    });
    return [rawName.toLowerCase(), ...sources].join(" ");
  }).filter((directive) => directive !== "").join(";");
}
var cache = new MemoryCache();
function __resetHandlerStateForTests() {
  cache = new MemoryCache();
  __resetRateLimitCircuitForTests();
}
var handler = async (event) => {
  const record = event.Records[0];
  if (!record) {
    throw new Error("unreachable: CloudFront origin-response event without records");
  }
  const { request, response } = record.cf;
  try {
    if (matchesExcludedPath(getExcludePaths(), request.uri)) {
      return response;
    }
    if (response.headers[INJECTED_MARKER_HEADER] !== void 0) return response;
    if (!shouldAttempt(
      {
        method: request.method,
        status: response.status,
        contentType: headerValues(response.headers, "content-type"),
        contentEncoding: headerValue(response.headers, "content-encoding"),
        cacheControl: headerValues(response.headers, "cache-control"),
        contentDisposition: headerValues(response.headers, "content-disposition"),
        hasSetCookie: response.headers["set-cookie"] !== void 0
      },
      // Ignore the first response's content-encoding — we re-fetch identity.
      true
    )) {
      return response;
    }
    const xRobotsTag = combinedHeaderValue(response.headers, "x-robots-tag");
    if (blocksIndexing(xRobotsTag)) {
      return response;
    }
    const target = resolvePageRequestTarget(request);
    if (target === null || !isHostIncluded(target.pageHost, getIncludeHosts())) return response;
    const { originHost, pageUrl } = target;
    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return response;
    const config = await resolveAdapterConfig();
    if (config === null) {
      const retryInMs = getConfigRetryInMs();
      return retryInMs === null ? response : retryablePassThroughResponse(response, request.headers, retryInMs, {
        assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
        capSetCookieResponses: getCapSetCookieResponses()
      });
    }
    const lookup = config.autoRegister ? await getJsonLdRegisterLookup(pageUrl, cache, config) : await getJsonLdLookup(pageUrl, cache, config);
    if (lookup.snippet === null) {
      return lookup.revalidateInMs === null ? response : retryablePassThroughResponse(response, request.headers, lookup.revalidateInMs, {
        assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
        capSetCookieResponses: getCapSetCookieResponses()
      });
    }
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
        ...originCustomHeaders(request)
      }
    );
    if (origin.truncated) return response;
    if (!shouldAttempt({
      method: "GET",
      status: String(origin.status),
      contentType: origin.allHeaders["content-type"] ?? null,
      // Non-null despite Accept-Encoding: identity → origin ignored us; the
      // bytes are not injectable HTML.
      contentEncoding: origin.contentEncoding,
      cacheControl: origin.allHeaders["cache-control"] ?? null,
      contentDisposition: origin.allHeaders["content-disposition"] ?? null,
      hasSetCookie: origin.hasSetCookie
    })) {
      return response;
    }
    if (blocksIndexing(origin.xRobotsTag)) {
      return response;
    }
    if (normalizedRobotsTag(xRobotsTag) !== normalizedRobotsTag(origin.xRobotsTag)) {
      return response;
    }
    const firstNormalizedCacheControl = normalizedCacheControl(
      headerValues(response.headers, "cache-control")
    );
    const originNormalizedCacheControl = normalizedCacheControl(
      origin.allHeaders["cache-control"] ?? null
    );
    if (firstNormalizedCacheControl === void 0 || originNormalizedCacheControl === void 0 || firstNormalizedCacheControl !== originNormalizedCacheControl) {
      return response;
    }
    if (headerValue(response.headers, "expires") !== origin.expires) {
      return response;
    }
    const firstCsp = combinedHeaderValue(response.headers, "content-security-policy");
    const firstCspReportOnly = combinedHeaderValue(
      response.headers,
      "content-security-policy-report-only"
    );
    if (firstCsp !== null && origin.contentSecurityPolicy === null || firstCsp !== null && origin.contentSecurityPolicy !== null && normalizedCspStructure(firstCsp) !== normalizedCspStructure(origin.contentSecurityPolicy) || firstCspReportOnly !== null && origin.contentSecurityPolicyReportOnly === null || firstCspReportOnly !== null && origin.contentSecurityPolicyReportOnly !== null && normalizedCspStructure(firstCspReportOnly) !== normalizedCspStructure(origin.contentSecurityPolicyReportOnly)) {
      return response;
    }
    if (!isUtf8SafeHtmlBytes(origin.body, origin.contentType ?? "")) return response;
    const originalHtml = origin.body.toString("utf8");
    const injected = injectIntoHead(originalHtml, lookup.snippet);
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
    headers["content-type"] = [{ key: "Content-Type", value: GENERATED_HTML_CONTENT_TYPE }];
    if (origin.cacheControl === null) {
      delete headers["cache-control"];
    } else {
      headers["cache-control"] = [{ key: "Cache-Control", value: origin.cacheControl }];
    }
    if (origin.expires === null) {
      delete headers["expires"];
    } else {
      headers["expires"] = [{ key: "Expires", value: origin.expires }];
    }
    delete headers["content-security-policy"];
    delete headers["content-security-policy-report-only"];
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
    const responseHeaderBytes = serializedHeaderBytes(
      headers,
      response.status,
      response.statusDescription
    );
    if (responseHeaderBytes > MAX_RESPONSE_HEADER_BYTES) return response;
    const bodyBudgetBytes = MAX_GENERATED_RESPONSE_BYTES - responseHeaderBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
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
  cacheDirectiveSeconds,
  charsetOf,
  fetchOriginHtml,
  forwardedHeaders,
  getConfigRetryInMs,
  handler,
  resolveAdapterConfig,
  retrySharedTtlSeconds,
  retryablePassThroughResponse,
  serializedHeaderBytes,
  shouldAttempt
});
