/**
 * Prag Music Worker: serves library.json, audio and art from the private R2
 * bucket, plus a small admin API used by the ingest scripts.
 * The binding contract is docs/contract.md at the repo root.
 */

export interface Env {
  BUCKET: R2Bucket;
  APP_TOKEN: string;
  ADMIN_TOKEN: string;
}

const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const ADMIN_KEY = /^(?:library\.json|audio\/[A-Za-z0-9]{22}\.m4a|art\/[A-Za-z0-9]{22}\.jpg)$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const MEDIA_CACHE = "private, max-age=31536000, immutable";
const LIST_PAGE = 1000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
};

const PREFLIGHT_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Range, If-None-Match, If-Range",
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

/** Parses an If-None-Match / If-Range list into bare entity tags ("*" kept as is). */
function parseEtags(header: string): string[] {
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const tags = parseEtags(header);
  return tags.includes("*") || tags.includes(etag);
}

export type RangeResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; offset: number; length: number };

/**
 * Resolves a Range header against an object size. Supports a single
 * bytes=a-b, bytes=a- or bytes=-n. Malformed or multi-range headers are
 * ignored (full 200 response), as RFC 9110 allows.
 */
export function resolveRange(header: string | null, size: number): RangeResult {
  if (header === null) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { kind: "none" };
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return { kind: "none" };

  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffix, size);
    return { kind: "range", offset: size - length, length };
  }

  const start = Number(first);
  if (last !== "" && Number(last) < start) return { kind: "none" }; // invalid spec, ignore
  if (start >= size) return { kind: "unsatisfiable" };
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { kind: "range", offset: start, length: end - start + 1 };
}

// ---------- read routes ----------

async function serveLibrary(request: Request, env: Env): Promise<Response> {
  const head = request.method === "HEAD";
  const conditional = request.headers.get("If-None-Match");

  if (conditional !== null || head) {
    const meta = await env.BUCKET.head("library.json");
    if (!meta) return notFound();
    const headers = libraryHeaders(meta);
    if (etagMatches(conditional, meta.etag)) return new Response(null, { status: 304, headers });
    if (head) {
      headers.set("Content-Length", String(meta.size));
      return new Response(null, { status: 200, headers });
    }
  }

  const object = await env.BUCKET.get("library.json");
  if (!object) return notFound();
  const headers = libraryHeaders(object);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function libraryHeaders(meta: R2Object): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    ETag: meta.httpEtag,
  });
}

async function serveMedia(request: Request, env: Env, key: string, contentType: string): Promise<Response> {
  const meta = await env.BUCKET.head(key);
  if (!meta) return notFound();

  const headers = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": MEDIA_CACHE,
    ETag: meta.httpEtag,
  });

  if (etagMatches(request.headers.get("If-None-Match"), meta.etag)) {
    return new Response(null, { status: 304, headers });
  }

  // If-Range: only honour Range when the client's validator still matches.
  const ifRange = request.headers.get("If-Range");
  const rangeHeader = ifRange === null || etagMatches(ifRange, meta.etag) ? request.headers.get("Range") : null;
  const range = resolveRange(rangeHeader, meta.size);

  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", "bytes */" + meta.size);
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify({ error: "range_not_satisfiable" }), { status: 416, headers });
  }

  const head = request.method === "HEAD";
  if (range.kind === "none") {
    headers.set("Content-Length", String(meta.size));
    if (head) return new Response(null, { status: 200, headers });
    const object = await env.BUCKET.get(key);
    if (!object) return notFound();
    return new Response(object.body, { status: 200, headers });
  }

  const end = range.offset + range.length - 1;
  headers.set("Content-Range", "bytes " + range.offset + "-" + end + "/" + meta.size);
  headers.set("Content-Length", String(range.length));
  if (head) return new Response(null, { status: 206, headers });
  const object = await env.BUCKET.get(key, { range: { offset: range.offset, length: range.length } });
  if (!object) return notFound();
  return new Response(object.body, { status: 206, headers });
}

// ---------- admin routes ----------

function contentTypeForKey(key: string): string {
  if (key.endsWith(".m4a")) return "audio/mp4";
  if (key.endsWith(".jpg")) return "image/jpeg";
  return "application/json";
}

async function adminList(url: URL, env: Env): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const objects: { key: string; size: number; etag: string; sha256: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: LIST_PAGE, include: ["customMetadata"] });
    for (const object of page.objects) {
      objects.push({
        key: object.key,
        size: object.size,
        etag: object.etag,
        sha256: object.customMetadata?.sha256 ?? null,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ objects });
}

async function adminPut(request: Request, env: Env, key: string): Promise<Response> {
  const shaHeader = request.headers.get("X-Content-SHA256");
  let sha256: string | undefined;
  if (shaHeader !== null) {
    if (!SHA256_HEX.test(shaHeader.trim())) return error(400, "invalid_sha256");
    sha256 = shaHeader.trim().toLowerCase();
  }

  // R2 needs a body of known length; buffer chunked uploads.
  const declared = request.headers.get("Content-Length");
  let body: ReadableStream | ArrayBuffer | null = request.body;
  if (declared === null || body === null) {
    body = await request.arrayBuffer();
    if (body.byteLength === 0) return error(400, "empty_body");
  } else if (Number(declared) === 0) {
    return error(400, "empty_body");
  }

  let object: R2Object | null;
  try {
    object = await env.BUCKET.put(key, body, {
      httpMetadata: { contentType: contentTypeForKey(key) },
      customMetadata: sha256 ? { sha256 } : undefined,
      sha256, // R2 rejects the upload if the body does not hash to this value
    });
  } catch (err) {
    if (sha256) return error(400, "sha256_mismatch");
    throw err;
  }
  if (!object) return error(500, "put_failed");
  return json({ key: object.key, size: object.size, etag: object.etag });
}

async function adminDelete(env: Env, key: string): Promise<Response> {
  await env.BUCKET.delete(key);
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

