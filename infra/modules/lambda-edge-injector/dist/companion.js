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

// src/companion.ts
var companion_exports = {};
__export(companion_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(companion_exports);

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
    autoRegister: input.autoRegister ?? false,
    ...input.fetchImpl !== void 0 && { fetchImpl: input.fetchImpl }
  };
}

// ../injector-core/dist/cache.js
var DEFAULT_MEMORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

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

// src/shared.ts
var MAX_GENERATED_RESPONSE_BYTES = 1048576;
var MAX_RESPONSE_HEADER_BYTES = 32768;
var GENERATED_RESPONSE_SAFETY_MARGIN_BYTES = 1024;
var MAX_ORIGIN_BODY_BYTES = MAX_GENERATED_RESPONSE_BYTES - MAX_RESPONSE_HEADER_BYTES - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
var UTF8_COMPATIBLE_CHARSETS = /* @__PURE__ */ new Set(["utf-8", "utf8", "us-ascii", "ascii"]);
var NON_HTML_EXTENSION = /\.(?:js|mjs|cjs|css|map|json|jsonld|geojson|xml|rss|atom|txt|csv|tsv|yaml|yml|wasm|webmanifest|ics|vcf|png|jpe?g|jfif|gif|webp|avif|heic|heif|svg|ico|bmp|tiff?|psd|eps|woff2?|ttf|otf|eot|mp4|m4v|webm|ogv|mkv|flv|mov|avi|mp3|m4a|aac|opus|wav|flac|oga|ogg|vtt|srt|pdf|docx?|xlsx?|pptx?|odt|ods|odp|epub|mobi|zip|gz|tgz|bz2|xz|7z|rar|tar|iso|apk|dmg|exe|msi|deb|rpm|bin)$/i;
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
function shouldAttemptGeneratedResponse(input) {
  if (!isInjectableRepresentation(input)) return false;
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
function isRetryCacheCapCandidate(response, requestHeaders, opts) {
  if (requestHeaders["authorization"] !== void 0 || requestHeaders["cookie"] !== void 0) {
    return false;
  }
  const headers = response.headers ?? {};
  if (parseCacheControlFields(headers) === null) return false;
  if (hasPerRequestCacheControl(headerValues(headers, "cache-control"))) return false;
  if (headers["set-cookie"] !== void 0 && !opts.capSetCookieResponses) return false;
  return retrySharedTtlSeconds(headers, 1e3, opts.assertedDefaultTtlSeconds) !== null;
}
function retryablePassThroughResponse(response, requestHeaders, revalidateInMs, opts) {
  if (!isRetryCacheCapCandidate(response, requestHeaders, opts)) return response;
  const originalHeaders = response.headers ?? {};
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
function getAssertedDefaultTtlSeconds() {
  return bakedConfig()?.assertedDefaultTtlSeconds ?? 0;
}
function getCapSetCookieResponses() {
  return bakedConfig()?.capSetCookieResponses ?? false;
}
function getNonPageMemoTtlMs() {
  return bakedConfig()?.nonPageMemoTtlMs ?? DEFAULT_NON_PAGE_MEMO_TTL_MS;
}
function getExcludePaths() {
  return bakedConfig()?.excludePaths ?? [];
}
function getIncludeHosts() {
  return bakedConfig()?.includeHosts ?? [];
}

// src/companion.ts
function capOptions() {
  return {
    assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
    capSetCookieResponses: getCapSetCookieResponses()
  };
}
var handler = async (event) => {
  const record = event.Records[0];
  if (!record) return void 0;
  const { request, response } = record.cf;
  try {
    if (response.headers[INJECTED_MARKER_HEADER] !== void 0) {
      console.error(
        "[enhancely-lambda-edge:companion] X-Enhancely-Injected present on an origin-response event \u2014 leaving the response untouched. In a correct deployment this header never reaches this trigger; check whether the origin echoes it or the trigger wiring changed."
      );
      return response;
    }
    if (request.method !== "GET") return response;
    if (matchesExcludedPath(getExcludePaths(), request.uri)) return response;
    if (NON_HTML_EXTENSION.test(request.uri)) return response;
    if (request.headers["range"] !== void 0) return response;
    const target = resolvePageRequestTarget(request);
    if (target === null || !isHostIncluded(target.pageHost, getIncludeHosts())) return response;
    const input = {
      method: request.method,
      status: response.status,
      contentType: headerValues(response.headers, "content-type"),
      contentEncoding: null,
      cacheControl: headerValues(response.headers, "cache-control"),
      contentDisposition: headerValues(response.headers, "content-disposition")
    };
    if (!shouldAttemptGeneratedResponse(input)) return response;
    if (blocksIndexing(combinedHeaderValue(response.headers, "x-robots-tag"))) return response;
    if (buildOriginUrl(request) === null) return response;
    const options = capOptions();
    if (!isRetryCacheCapCandidate(response, request.headers, options)) return response;
    const config = await resolveAdapterConfig();
    if (config === null) {
      const retryInMs = getConfigRetryInMs();
      return retryInMs === null ? response : retryablePassThroughResponse(response, request.headers, retryInMs, options);
    }
    return retryablePassThroughResponse(response, request.headers, getNonPageMemoTtlMs(), options);
  } catch (error) {
    console.error(
      "[enhancely-lambda-edge:companion] fail-open:",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return response;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
