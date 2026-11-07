/**
 * Storage backends for the Worker. Production uses Backblaze B2 through its
 * S3-compatible API (free tier, no card). Tests use an R2 binding named BUCKET;
 * when it is present it wins.
 *
 * B2's free tier counts every GET and HEAD as a download-class transaction, so
 * get() answers a client request (including ranges, 304, 412 and 416) with a
 * single upstream read.
 */
import { AwsClient } from "aws4fetch";

export interface StoredObject {
  key: string;
  size: number;
  /** Bare entity tag, no quotes. */
  etag: string;
  /** Quoted entity tag for the ETag header. */
  httpEtag: string;
  contentType?: string;
  sha256?: string;
}

/** One byte range as the client asked for it, before the object size is known. */
export type ByteRange = { offset: number; length?: number } | { suffix: number };

export interface GetOptions {
  range?: ByteRange;
  /** Bare entity tag the object must still have, or the result is 412. Carries If-Range. */
  ifMatch?: string;
  /** If-None-Match value; a match gives 304. */
  ifNoneMatch?: string;
  /** If-Modified-Since value; ignored when ifNoneMatch is set (RFC 9110). */
  ifModifiedSince?: string;
}

export type GetResult =
  | { status: 200; meta: StoredObject; body: ReadableStream }
  | { status: 206; meta: StoredObject; body: ReadableStream; offset: number; length: number }
  | { status: 304; etag: string; httpEtag: string }
  | { status: 412 }
  | { status: 416; size: number };

export interface PutOptions {
  contentType: string;
  /** Lower-case hex. The store rejects the upload when the body does not hash to it. */
  sha256?: string;
  /** Body length when known; lets the S3 backend stream instead of buffering. */
  length?: number;
}

export class ChecksumMismatch extends Error {}

export interface Storage {
  head(key: string): Promise<StoredObject | null>;
  /** One upstream read. Null when the object does not exist. */
  get(key: string, options?: GetOptions): Promise<GetResult | null>;
  put(key: string, body: ReadableStream | ArrayBuffer, options: PutOptions): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<StoredObject[]>;
}

export interface StorageEnv {
  BUCKET?: R2Bucket;
  B2_ENDPOINT?: string;
  B2_REGION?: string;
  B2_BUCKET?: string;
  B2_KEY_ID?: string;
  B2_APP_KEY?: string;
}

export function storageFor(env: StorageEnv): Storage {
  if (env.BUCKET) return new R2Storage(env.BUCKET);
  const { B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APP_KEY } = env;
  if (!B2_ENDPOINT || !B2_REGION || !B2_BUCKET || !B2_KEY_ID || !B2_APP_KEY) {
    throw new Error("storage is not configured: set the B2_* vars and secrets, or bind BUCKET");
  }
  return new S3Storage({
    endpoint: B2_ENDPOINT,
    region: B2_REGION,
    bucket: B2_BUCKET,
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY,
  });
}

// ---------- shared helpers ----------

const unquote = (tag: string) => tag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

/** Parses an If-None-Match list into bare entity tags ("*" kept as is). */
export function parseEtags(header: string): string[] {
  return header
    .split(",")
    .map((tag) => unquote(tag.trim()))
    .filter(Boolean);
}

/** Weak comparison against an If-None-Match list, as RFC 9110 asks for. */
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (header === null || header === undefined) return false;
  const tags = parseEtags(header);
  return tags.includes("*") || tags.includes(etag);
}

/** Resolves a range against the object size; null when no byte of it exists. */
export function resolveByteRange(range: ByteRange, size: number): { offset: number; length: number } | null {
  if ("suffix" in range) {
    if (range.suffix === 0 || size === 0) return null;
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  if (range.offset >= size) return null;
  const end = range.length === undefined ? size - 1 : Math.min(range.offset + range.length - 1, size - 1);
  return { offset: range.offset, length: end - range.offset + 1 };
}

/**
 * The range to send upstream. bytes=-0 matches nothing in any object, so it is
 * not sent; the full reply then gives the size for the 416.
 */
const upstreamRange = (range: ByteRange | undefined) =>
  range && !("suffix" in range && range.suffix === 0) ? range : undefined;

function conditionHeaders(options: GetOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.ifMatch !== undefined) headers["If-Match"] = '"' + options.ifMatch + '"';
  if (options.ifNoneMatch !== undefined) headers["If-None-Match"] = options.ifNoneMatch;
  else if (options.ifModifiedSince !== undefined) headers["If-Modified-Since"] = options.ifModifiedSince;
  return headers;
}

/**
 * Checks If-Match and If-None-Match against the etag the store answered with.
 * The store already evaluated them; this catches a condition it ignored.
 */
function failedCondition(etag: string, options: GetOptions): GetResult | null {
  if (options.ifMatch !== undefined && etag !== options.ifMatch) return { status: 412 };
  if (etagMatches(options.ifNoneMatch, etag)) return { status: 304, etag, httpEtag: '"' + etag + '"' };
  return null;
}

// ---------- R2 ----------

function fromR2(object: R2Object): StoredObject {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    contentType: object.httpMetadata?.contentType,
    sha256: object.customMetadata?.sha256,
  };
}

export class R2Storage implements Storage {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string) {
    const object = await this.bucket.head(key);
    return object ? fromR2(object) : null;
  }

  async get(key: string, options: GetOptions = {}): Promise<GetResult | null> {
    const range = upstreamRange(options.range);
    let object: R2Object | R2ObjectBody | null;
    try {
      object = await this.bucket.get(key, { range, onlyIf: new Headers(conditionHeaders(options)) });
    } catch (err) {
      // R2 throws "The requested range is not satisfiable (10039)" instead of answering 416.
      if (!range || !(err instanceof Error) || !err.message.includes("10039")) throw err;
      const current = await this.bucket.head(key);
      if (!current) return null;
      return failedCondition(current.etag, options) ?? { status: 416, size: current.size };
    }
    if (!object) return null;
    // No body: a condition failed. If-Modified-Since is the only one not rechecked here.
    if (!("body" in object)) return failedCondition(object.etag, options) ?? { status: 304, etag: object.etag, httpEtag: object.httpEtag };

    const meta = fromR2(object);
    if (!options.range) return { status: 200, meta, body: object.body };
    const served = resolveByteRange(options.range, object.size);
    if (!served) {
      await object.body.cancel();
      return { status: 416, size: object.size };
    }
    return { status: 206, meta, body: object.body, ...served };
  }

  async put(key: string, body: ReadableStream | ArrayBuffer, options: PutOptions) {
    try {
      const object = await this.bucket.put(key, body, {
        httpMetadata: { contentType: options.contentType },
        customMetadata: options.sha256 ? { sha256: options.sha256 } : undefined,
        sha256: options.sha256,
      });
      if (!object) throw new Error("put_failed");
      return fromR2(object);
    } catch (err) {
      if (options.sha256 && !(err instanceof Error && err.message === "put_failed")) throw new ChecksumMismatch();
      throw err;
    }
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }

  async list(prefix?: string) {
    const out: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
      out.push(...page.objects.map(fromR2));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
}

// ---------- S3 (Backblaze B2) ----------

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlField(block: string, name: string): string | undefined {
  const match = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(block);
  return match ? xmlUnescape(match[1]!) : undefined;
}

/** Parses one ListObjectsV2 page. Exported for tests. */
export function parseListPage(xml: string): { objects: StoredObject[]; next?: string } {
  const objects: StoredObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1]!;
    const key = xmlField(block, "Key");
    if (key === undefined) continue;
    const etag = unquote(xmlField(block, "ETag") ?? "");
    objects.push({ key, size: Number(xmlField(block, "Size") ?? 0), etag, httpEtag: '"' + etag + '"' });
  }
  const truncated = xmlField(xml, "IsTruncated") === "true";
  return { objects, next: truncated ? xmlField(xml, "NextContinuationToken") : undefined };
}

/** S3 error codes meaning "the body does not hash to the checksum sent with it". */
const CHECKSUM_CODES = new Set(["BadDigest", "XAmzContentSHA256Mismatch"]);

/**
 * True when an S3 error body reports a checksum mismatch. Only meaningful when
 * the upload carried a sha256. Exported for tests.
 */
export function isChecksumError(xml: string): boolean {
  const code = xmlField(xml, "Code")?.trim();
  if (code !== undefined && CHECKSUM_CODES.has(code)) return true;
  // B2 reports a wrong x-amz-content-sha256 as 403 AccessDenied "Signature
  // validation failed". A wrong secret key gives the same message under
  // SignatureDoesNotMatch, so the code has to be AccessDenied.
  return code === "AccessDenied" && xmlField(xml, "Message")?.trim() === "Signature validation failed";
}

/**
 * Total object size from a 416 reply: a Content-Range of bytes * /N, S3's
 * ActualObjectSize, or B2's message "byte range bytes=500- for a file of length 33".
 * Exported for tests.
 */
export function unsatisfiableSize(contentRange: string | null, xml: string): number | null {
  const header = /^bytes \*\/(\d+)$/.exec(contentRange?.trim() ?? "");
  if (header) return Number(header[1]);
  const actual = xmlField(xml, "ActualObjectSize");
  if (actual !== undefined && /^\s*\d+\s*$/.test(actual)) return Number(actual);
  const message = /length (\d+)/.exec(xmlField(xml, "Message") ?? "");
  return message ? Number(message[1]) : null;
}

function rangeHeader(range: ByteRange): string {
  if ("suffix" in range) return "bytes=-" + range.suffix;
  const end = range.length === undefined ? "" : String(range.offset + range.length - 1);
  return "bytes=" + range.offset + "-" + end;
}

function contentLength(response: Response): number | null {
  const value = response.headers.get("Content-Length");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

const discard = (response: Response) => response.body?.cancel().catch(() => {});

export class S3Storage implements Storage {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(config: S3Config, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      retries: 0,
    });
    const endpoint = config.endpoint.startsWith("http") ? config.endpoint : "https://" + config.endpoint;
    this.base = endpoint.replace(/\/+$/, "") + "/" + encodeURIComponent(config.bucket);
  }

  private url(key: string): string {
    return this.base + "/" + key.split("/").map(encodeURIComponent).join("/");
  }

  private async send(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const signed = await this.client.sign(url, init);
    return this.fetcher(signed);
  }

  private static meta(key: string, response: Response, size: number): StoredObject {
    const etag = unquote(response.headers.get("ETag") ?? "");
    return {
      key,
      size,
      etag,
      httpEtag: '"' + etag + '"',
      contentType: response.headers.get("Content-Type") ?? undefined,
      sha256: response.headers.get("x-amz-meta-sha256") ?? undefined,
    };
  }

  private static async fail(what: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    throw new Error("b2 " + what + " failed: " + response.status + " " + (xmlField(text, "Code") ?? ""));
  }

  async head(key: string) {
    const response = await this.send(this.url(key), { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) return S3Storage.fail("head", response);
    const length = response.headers.get("Content-Length");
    if (length === null) throw new Error("b2 head returned no Content-Length");
    return S3Storage.meta(key, response, Number(length));
  }

  async get(key: string, options: GetOptions = {}): Promise<GetResult | null> {
    const range = upstreamRange(options.range);
    const headers = conditionHeaders(options);
    if (range) headers.Range = rangeHeader(range);
    const response = await this.send(this.url(key), { method: "GET", headers });
    const { status } = response;

    if (status === 404) {
      await discard(response);
      return null;
    }
    if (status === 304) {
      await discard(response);
      const etag = unquote(response.headers.get("ETag") ?? "");
      return { status: 304, etag, httpEtag: '"' + etag + '"' };
    }
    if (status === 412) {
      await discard(response);
      return { status: 412 };
    }
    if (status === 416) {
      const text = await response.text().catch(() => "");
      const size = unsatisfiableSize(response.headers.get("Content-Range"), text);
      if (size !== null) return { status: 416, size };
      // Unrecognised 416 body: one extra HEAD learns the size for Content-Range.
      const current = await this.head(key);
      return current ? { status: 416, size: current.size } : null;
    }
    if ((status !== 200 && status !== 206) || !response.body) return S3Storage.fail("get", response);

    const body = response.body;
    const failed = failedCondition(unquote(response.headers.get("ETag") ?? ""), options);
    if (failed) {
      await body.cancel();
      return failed;
    }

    if (status === 200) {
      const size = contentLength(response);
      if (size === null) {
        await body.cancel();
        throw new Error("b2 get: 200 without a Content-Length");
      }
      // A 200 to a ranged GET carries the whole object. Pass it on as a plain
      // 200 (servers may ignore Range), or answer 416 when nothing could match.
      if (options.range && !resolveByteRange(options.range, size)) {
        await body.cancel();
        return { status: 416, size };
      }
      return { status: 200, meta: S3Storage.meta(key, response, size), body };
    }

    // 206: accept it only when it is exactly the range that was asked for.
    const served = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
    const total = served ? Number(served[3]!) : NaN;
    const offset = served ? Number(served[1]!) : NaN;
    const length = served ? Number(served[2]!) - offset + 1 : NaN;
    const expected = range && served ? resolveByteRange(range, total) : null;
    const declared = contentLength(response);
    if (!expected || expected.offset !== offset || expected.length !== length || (declared !== null && declared !== length)) {
      await body.cancel();
      throw new Error("b2 get: partial reply " + (response.headers.get("Content-Range") ?? "without Content-Range") + " does not match the requested range");
    }
    return { status: 206, meta: S3Storage.meta(key, response, total), body, offset, length };
  }

  async put(key: string, body: ReadableStream | ArrayBuffer, options: PutOptions) {
    const headers: Record<string, string> = { "Content-Type": options.contentType };
    if (options.sha256) {
      // S3 verifies the signed payload hash and rejects the PUT on mismatch.
      headers["X-Amz-Content-Sha256"] = options.sha256;
      headers["x-amz-meta-sha256"] = options.sha256;
    }
    let payload: BodyInit;
    let size: number;
    if (body instanceof ArrayBuffer) {
      payload = body;
      size = body.byteLength;
    } else if (options.length !== undefined) {
      // B2 needs a fixed Content-Length; this streams without buffering the song.
      const fixed = new FixedLengthStream(options.length);
      void body.pipeTo(fixed.writable).catch(() => {});
      payload = fixed.readable;
      size = options.length;
    } else {
      const buffered = await new Response(body).arrayBuffer();
      payload = buffered;
      size = buffered.byteLength;
    }
    const response = await this.send(this.url(key), { method: "PUT", headers, body: payload });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (options.sha256 && isChecksumError(text)) throw new ChecksumMismatch();
      throw new Error("b2 put failed: " + response.status + " " + (xmlField(text, "Code") ?? ""));
    }
    const meta = S3Storage.meta(key, response, size);
    meta.contentType = options.contentType;
    meta.sha256 = options.sha256;
    return meta;
  }

  async delete(key: string) {
    const response = await this.send(this.url(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) await S3Storage.fail("delete", response);
  }

  async list(prefix?: string) {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
      if (prefix) query.set("prefix", prefix);
      if (token) query.set("continuation-token", token);
      const response = await this.send(this.base + "?" + query.toString(), { method: "GET" });
      if (!response.ok) await S3Storage.fail("list", response);
      const page = parseListPage(await response.text());
      out.push(...page.objects);
      token = page.next;
    } while (token);
    return out;
  }
}
