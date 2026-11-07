/**
 * Prag Music Worker: serves library.json, audio and art from private storage
 * (Backblaze B2 in production, an R2 binding in tests), plus a small admin API
 * used by the ingest scripts.
 * The binding contract is docs/contract.md at the repo root.
 */

import {
  ChecksumMismatch,
  etagMatches,
  parseEtags,
  resolveByteRange,
  storageFor,
  type ByteRange,
  type GetOptions,
  type GetResult,
  type Storage,
  type StorageEnv,
  type StoredObject,
} from "./storage";

export interface Env extends StorageEnv {
  APP_TOKEN: string;
  ADMIN_TOKEN: string;
}

const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const ADMIN_KEY = /^(?:library\.json|audio\/[A-Za-z0-9]{22}\.m4a|art\/[A-Za-z0-9]{22}\.jpg)$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const MEDIA_CACHE = "private, max-age=31536000, immutable";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
};

const PREFLIGHT_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Range, If-None-Match, If-Modified-Since, If-Range",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

const error = (status: number, code: string, extra: HeadersInit = {}) => json({ error: code }, status, extra);
const unauthorized = () => error(401, "unauthorized");
const notFound = () => error(404, "not_found");
const methodNotAllowed = (allow: string) => error(405, "method_not_allowed", { Allow: allow });

// ---------- auth ----------

const encoder = new TextEncoder();

/** Constant-time string compare: hash both sides so lengths match, then timingSafeEqual. */
async function tokenMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false; // fail closed when the secret is unset
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** App routes accept the token from the Authorization header or ?token=. */
async function isAppAuthorized(request: Request, url: URL, env: Env): Promise<boolean> {
  const [viaHeader, viaQuery] = await Promise.all([
    tokenMatches(bearer(request), env.APP_TOKEN),
    tokenMatches(url.searchParams.get("token"), env.APP_TOKEN),
  ]);
  return viaHeader || viaQuery;
}

/** Admin routes accept the Authorization header only. */
function isAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  return tokenMatches(bearer(request), env.ADMIN_TOKEN);
}

// ---------- conditional requests and ranges ----------

/** The bare tag of an If-Range entity tag, or null when If-Range carries a date. */
function ifRangeEtag(header: string): string | null {
  const match = /^(?:W\/)?"([^"]*)"$/.exec(header.trim());
  return match ? match[1]! : null;
}

/** Normalises If-None-Match to quoted tags (or "*"), so the store sees one simple form. */
function ifNoneMatchValue(header: string | null): string | undefined {
  if (header === null) return undefined;
  const tags = parseEtags(header);
  if (tags.includes("*")) return "*";
  return tags.length ? tags.map((tag) => '"' + tag + '"').join(", ") : undefined;
}

/** If-None-Match and If-Modified-Since from the client, ready for storage.get. */
function conditions(request: Request): GetOptions {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null) return { ifNoneMatch: ifNoneMatchValue(ifNoneMatch) };
  // RFC 9110: If-Modified-Since only counts when If-None-Match is absent.
  const since = request.headers.get("If-Modified-Since");
  return since !== null && !Number.isNaN(Date.parse(since)) ? { ifModifiedSince: since } : {};
}

/** Parses a single bytes=a-b, bytes=a- or bytes=-n. Malformed or multi-range headers give null. */
export function parseRange(header: string | null): ByteRange | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") return { suffix: Number(last) };
  const offset = Number(first);
  if (last === "") return { offset };
  if (Number(last) < offset) return null; // invalid spec, ignore
  return { offset, length: Number(last) - offset + 1 };
}

export type RangeResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; offset: number; length: number };

/**
 * Resolves a Range header against an object size. Malformed or multi-range
 * headers are ignored (full 200 response), as RFC 9110 allows.
 */
export function resolveRange(header: string | null, size: number): RangeResult {
  const range = parseRange(header);
  if (!range) return { kind: "none" };
  const resolved = resolveByteRange(range, size);
  return resolved ? { kind: "range", ...resolved } : { kind: "unsatisfiable" };
}

const contentRange = (offset: number, length: number, size: number) =>
  "bytes " + offset + "-" + (offset + length - 1) + "/" + size;

function unexpected(result: GetResult): never {
  throw new Error("unexpected storage status " + result.status);
}

// ---------- read routes ----------
//
// Every read costs one storage call: GET forwards Range and the conditions to
// the store and builds the reply from its answer, HEAD is one HEAD. The only
// second call is a stale If-Range (412), which then fetches the whole file.

async function serveLibrary(request: Request, env: Env): Promise<Response> {
  const storage = storageFor(env);

  if (request.method === "HEAD") {
    const meta = await storage.head("library.json");
    if (!meta) return notFound();
    const headers = libraryHeaders(meta.httpEtag);
    if (etagMatches(request.headers.get("If-None-Match"), meta.etag)) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(meta.size));
    return new Response(null, { status: 200, headers });
  }

  const result = await storage.get("library.json", conditions(request));
  if (!result) return notFound();
  if (result.status === 304) return new Response(null, { status: 304, headers: libraryHeaders(result.httpEtag) });
  if (result.status !== 200) return unexpected(result);
  const headers = libraryHeaders(result.meta.httpEtag);
  headers.set("Content-Length", String(result.meta.size));
  return new Response(result.body, { status: 200, headers });
}

function libraryHeaders(httpEtag: string): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    ETag: httpEtag,
  });
}

function mediaHeaders(contentType: string): Headers {
  return new Headers({ "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": MEDIA_CACHE });
}

function rangeNotSatisfiable(headers: Headers, size: number): Response {
  headers.set("Content-Range", "bytes */" + size);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: "range_not_satisfiable" }), { status: 416, headers });
}

async function serveMedia(request: Request, env: Env, key: string, contentType: string): Promise<Response> {
  const storage = storageFor(env);
  if (request.method === "HEAD") return headMedia(request, storage, key, contentType);

  const options = conditions(request);
  options.range = parseRange(request.headers.get("Range")) ?? undefined;
  const ifRange = request.headers.get("If-Range");
  if (options.range && ifRange !== null) {
    // If-Range goes upstream as If-Match on the ranged GET, so a 206 is always
    // cut from the version the client already holds.
    const tag = ifRangeEtag(ifRange);
    if (tag === null) options.range = undefined; // date validators: send the whole file
    else options.ifMatch = tag;
  }

  let result = await storage.get(key, options);
  if (result?.status === 412) {
    // The client's copy is stale, so If-Range asks for the whole current file.
    result = await storage.get(key, conditions(request));
  }
  if (!result) return notFound();

  const headers = mediaHeaders(contentType);
  switch (result.status) {
    case 304:
      headers.set("ETag", result.httpEtag);
      return new Response(null, { status: 304, headers });
    case 416:
      return rangeNotSatisfiable(headers, result.size);
    case 200:
      headers.set("ETag", result.meta.httpEtag);
      headers.set("Content-Length", String(result.meta.size));
      return new Response(result.body, { status: 200, headers });
    case 206:
      headers.set("ETag", result.meta.httpEtag);
      headers.set("Content-Range", contentRange(result.offset, result.length, result.meta.size));
      headers.set("Content-Length", String(result.length));
      return new Response(result.body, { status: 206, headers });
    default:
      return unexpected(result);
  }
}

/** HEAD: one storage HEAD, with conditions and Range evaluated here. */
async function headMedia(request: Request, storage: Storage, key: string, contentType: string): Promise<Response> {
  const meta = await storage.head(key);
  if (!meta) return notFound();
  const headers = mediaHeaders(contentType);
  headers.set("ETag", meta.httpEtag);
  if (etagMatches(request.headers.get("If-None-Match"), meta.etag)) return new Response(null, { status: 304, headers });

  const ifRange = request.headers.get("If-Range");
  const rangeHeader = ifRange === null || ifRangeEtag(ifRange) === meta.etag ? request.headers.get("Range") : null;
  const range = resolveRange(rangeHeader, meta.size);
  if (range.kind === "unsatisfiable") return rangeNotSatisfiable(headers, meta.size);
  if (range.kind === "none") {
    headers.set("Content-Length", String(meta.size));
    return new Response(null, { status: 200, headers });
  }
  headers.set("Content-Range", contentRange(range.offset, range.length, meta.size));
  headers.set("Content-Length", String(range.length));
  return new Response(null, { status: 206, headers });
}

// ---------- admin routes ----------

function contentTypeForKey(key: string): string {
  if (key.endsWith(".m4a")) return "audio/mp4";
  if (key.endsWith(".jpg")) return "image/jpeg";
  return "application/json";
}

async function adminList(url: URL, env: Env): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? undefined;
  // B2 listings carry no custom metadata, so sha256 is null there; the ingest
  // script then compares the MD5 ETag of single-part uploads instead.
  const objects = (await storageFor(env).list(prefix)).map((object) => ({
    key: object.key,
    size: object.size,
    etag: object.etag,
    sha256: object.sha256 ?? null,
  }));
  return json({ objects });
}

async function adminPut(request: Request, env: Env, key: string): Promise<Response> {
  const shaHeader = request.headers.get("X-Content-SHA256");
  let sha256: string | undefined;
  if (shaHeader !== null) {
    if (!SHA256_HEX.test(shaHeader.trim())) return error(400, "invalid_sha256");
    sha256 = shaHeader.trim().toLowerCase();
  }

  // Storage needs a body of known length; buffer chunked uploads.
  const declared = request.headers.get("Content-Length");
  let body: ReadableStream | ArrayBuffer | null = request.body;
  let length: number | undefined;
  if (declared === null || body === null) {
    body = await request.arrayBuffer();
    if (body.byteLength === 0) return error(400, "empty_body");
  } else if (Number(declared) === 0) {
    return error(400, "empty_body");
  } else {
    length = Number(declared);
  }

  let object: StoredObject;
  try {
    // The store rejects the upload if the body does not hash to sha256.
    object = await storageFor(env).put(key, body, { contentType: contentTypeForKey(key), sha256, length });
  } catch (err) {
    if (err instanceof ChecksumMismatch) return error(400, "sha256_mismatch");
    throw err;
  }
  return json({ key: object.key, size: object.size, etag: object.etag });
}

async function adminDelete(env: Env, key: string): Promise<Response> {
  await storageFor(env).delete(key);
  return json({ deleted: key });
}

async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!(await isAdminAuthorized(request, env))) return unauthorized();

  if (url.pathname === "/admin/objects") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return adminList(url, env);
  }

  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice("/admin/objects/".length));
  } catch {
    return error(400, "invalid_key");
  }
  if (!ADMIN_KEY.test(key)) return error(400, "invalid_key");

  if (request.method === "PUT") return adminPut(request, env, key);
  if (request.method === "DELETE") return adminDelete(env, key);
  return methodNotAllowed("PUT, DELETE");
}

// ---------- router ----------

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/admin/objects" || path.startsWith("/admin/objects/")) {
    return handleAdmin(request, url, env);
  }

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });

  if (path === "/health") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return json({ ok: true });
  }

  const media = /^\/(audio|art)\/([^/]+)$/.exec(path);
  if (path !== "/library" && !media) return notFound();
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  if (!(await isAppAuthorized(request, url, env))) return unauthorized();

  if (path === "/library") return serveLibrary(request, env);

  const [, kind, id = ""] = media!;
  if (!TRACK_ID.test(id)) return notFound();
  return kind === "audio"
    ? serveMedia(request, env, "audio/" + id + ".m4a", "audio/mp4")
    : serveMedia(request, env, "art/" + id + ".jpg", "image/jpeg");
}

export default {
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      console.error("unhandled error", err);
      response = error(500, "internal_error");
    }
    if (!new URL(request.url).pathname.startsWith("/admin/")) {
      for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

