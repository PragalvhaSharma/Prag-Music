import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ChecksumMismatch, S3Storage, isChecksumError, parseListPage, unsatisfiableSize } from "../src/storage";

const CONFIG = {
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  bucket: "prag-music-test",
  accessKeyId: "004keyid",
  secretAccessKey: "secret",
};
const ID = "0lTk2LRaRNybgkKn4Q8PQz";
const MEDIA_CACHE = "private, max-age=31536000, immutable";

async function hex(algorithm: string, data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const xmlError = (status: number, code: string, message: string) =>
  new Response("<Error><Code>" + code + "</Code><Message>" + message + "</Message></Error>", {
    status,
    headers: { "Content-Type": "application/xml" },
  });

type FakeMode = "b2" | "wrongSecret" | "ignoreRange" | "wholeFileAs206";

/**
 * A tiny in-memory S3 that checks every request is SigV4-signed for B2 and
 * answers the way a live B2 bucket was measured to:
 * - a wrong x-amz-content-sha256 is 403 AccessDenied "Signature validation failed";
 * - a wrong secret is 403 SignatureDoesNotMatch with the same message, a wrong key id InvalidAccessKeyId;
 * - an unsatisfiable range is 416 InvalidRange with no Content-Range, only
 *   "byte range bytes=500- for a file of length 33" in the message;
 * - a matching If-None-Match is 304 with ETag and Accept-Ranges; a wrong If-Match is 412.
 * Other modes break the protocol on purpose: ignoreRange answers 200 to ranged
 * GETs, wholeFileAs206 labels the whole file as the partial reply.
 */
function fakeS3(options: { pageSize?: number; mode?: FakeMode } = {}) {
  const { pageSize = 2, mode = "b2" } = options;
  const objects = new Map<string, { body: ArrayBuffer; type: string; sha?: string; md5: string }>();
  const requests: Request[] = [];
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    requests.push(request);
    const auth = request.headers.get("Authorization") ?? "";
    if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=" + CONFIG.accessKeyId + "/")) {
      return xmlError(403, "InvalidAccessKeyId", "Malformed Access Key Id");
    }
    if (!auth.includes("/us-west-004/s3/aws4_request") || mode === "wrongSecret") {
      return xmlError(403, "SignatureDoesNotMatch", "Signature validation failed");
    }
    const url = new URL(request.url);
    const prefix = "/" + CONFIG.bucket;
    if (url.pathname === prefix && request.method === "GET") {
      const wanted = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(wanted)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = keys.slice(start, start + pageSize);
      const more = start + pageSize < keys.length;
      const contents = page
        .map((k) => "<Contents><Key>" + k.replace(/&/g, "&amp;") + "</Key><Size>" + objects.get(k)!.body.byteLength +
          "</Size><ETag>&quot;" + objects.get(k)!.md5 + "&quot;</ETag></Contents>")
        .join("");
      const xml = "<ListBucketResult>" + contents + "<IsTruncated>" + more + "</IsTruncated>" +
        (more ? "<NextContinuationToken>" + (start + pageSize) + "</NextContinuationToken>" : "") + "</ListBucketResult>";
      return new Response(xml, { headers: { "Content-Type": "application/xml" } });
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    if (request.method === "PUT") {
      const body = await request.arrayBuffer();
      if (request.headers.get("Content-Length") === null && body.byteLength === 0) return new Response(null, { status: 411 });
      const claimed = request.headers.get("X-Amz-Content-Sha256") ?? "";
      if (/^[0-9a-f]{64}$/.test(claimed) && claimed !== (await hex("SHA-256", body))) {
        return xmlError(403, "AccessDenied", "Signature validation failed");
      }
      const md5 = await hex("MD5", body);
      objects.set(key, {
        body,
        type: request.headers.get("Content-Type") ?? "",
        sha: request.headers.get("x-amz-meta-sha256") ?? undefined,
        md5,
      });
      return new Response(null, { headers: { ETag: '"' + md5 + '"' } });
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    if (!object) return xmlError(404, "NoSuchKey", "Key not found");
    const etag = '"' + object.md5 + '"';
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch !== null && ifMatch !== etag) return xmlError(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold");
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Accept-Ranges": "bytes" } });
    }
    const headers = new Headers({ ETag: etag, "Content-Type": object.type, "Accept-Ranges": "bytes" });
    if (object.sha) headers.set("x-amz-meta-sha256", object.sha);
    const total = object.body.byteLength;
    let body = object.body;
    let status = 200;
    const rangeHeader = request.headers.get("Range");
    const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
    if (range && mode !== "ignoreRange") {
      let start: number;
      let end: number;
      if (range[1] === "") {
        start = Math.max(0, total - Number(range[2]));
        end = total - 1;
      } else {
        start = Number(range[1]);
        end = range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1);
      }
      if (start >= total) return xmlError(416, "InvalidRange", "byte range " + rangeHeader + " for a file of length " + total);
      if (mode === "wholeFileAs206") [start, end] = [0, total - 1];
      body = object.body.slice(start, end + 1);
      headers.set("Content-Range", "bytes " + start + "-" + end + "/" + total);
      status = 206;
    }
    headers.set("Content-Length", String(body.byteLength));
    return new Response(request.method === "HEAD" ? null : body, { status, headers });
  };
  const seed = async (key: string, body: ArrayBuffer, type: string) =>
    objects.set(key, { body, type, md5: await hex("MD5", body) });
  return { objects, requests, handler, seed };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251).buffer;
const view = async (body: ReadableStream | Response) =>
  new Uint8Array(await (body instanceof Response ? body : new Response(body)).arrayBuffer());

describe("S3Storage against a fake B2", () => {
  it("puts with a signed payload hash and reads back size, MD5 ETag and sha256", async () => {
    const s3 = fakeS3();
    const storage = new S3Storage(CONFIG, s3.handler as typeof fetch);
    const body = bytes(5000);
    const sha = await hex("SHA-256", body);
    const put = await storage.put("audio/" + ID + ".m4a", body, { contentType: "audio/mp4", sha256: sha });
    expect(put.size).toBe(5000);
    expect(put.etag).toBe(await hex("MD5", body));
    const head = await storage.head("audio/" + ID + ".m4a");
    expect(head).toMatchObject({ size: 5000, etag: put.etag, httpEtag: '"' + put.etag + '"', sha256: sha, contentType: "audio/mp4" });
    expect(s3.requests[0]!.url).toBe("https://s3.us-west-004.backblazeb2.com/prag-music-test/audio/" + ID + ".m4a");
  });

  it("rejects a body that does not match its sha256 (B2 answers AccessDenied)", async () => {
    const storage = new S3Storage(CONFIG, fakeS3().handler as typeof fetch);
    await expect(storage.put("library.json", bytes(10), { contentType: "application/json", sha256: "a".repeat(64) }))
      .rejects.toBeInstanceOf(ChecksumMismatch);
  });

  it("does not mistake a wrong secret key for a checksum mismatch", async () => {
    const storage = new S3Storage(CONFIG, fakeS3({ mode: "wrongSecret" }).handler as typeof fetch);
    const body = bytes(10);
    const failure = storage.put("library.json", body, { contentType: "application/json", sha256: await hex("SHA-256", body) });
    await expect(failure).rejects.toThrow("b2 put failed: 403 SignatureDoesNotMatch");
    await expect(failure).rejects.not.toBeInstanceOf(ChecksumMismatch);
  });

  it("matches checksum failures by exact error code, not by the word checksum", () => {
    const error = (code: string, message: string) => "<Error><Code>" + code + "</Code><Message>" + message + "</Message></Error>";
    expect(isChecksumError(error("AccessDenied", "Signature validation failed"))).toBe(true);
    expect(isChecksumError(error("BadDigest", "The Content-MD5 you specified did not match"))).toBe(true);
    expect(isChecksumError(error("XAmzContentSHA256Mismatch", "The provided hash does not match"))).toBe(true);
    expect(isChecksumError(error("SignatureDoesNotMatch", "Signature validation failed"))).toBe(false);
    expect(isChecksumError(error("InvalidAccessKeyId", "Malformed Access Key Id"))).toBe(false);
    expect(isChecksumError(error("AccessDenied", "bucket is not authorized"))).toBe(false);
    expect(isChecksumError(error("InternalError", "checksum service unavailable"))).toBe(false);
    expect(isChecksumError(error("BadDigestExtra", "x"))).toBe(false);
    expect(isChecksumError("upstream checksum mismatch")).toBe(false);
  });

  it("reads the object size from a 416 in B2, S3 and Content-Range forms", () => {
    const b2 = "<Error><Code>InvalidRange</Code><Message>byte range bytes=500- for a file of length 33</Message></Error>";
    expect(unsatisfiableSize(null, b2)).toBe(33);
    expect(unsatisfiableSize("bytes */1000", "")).toBe(1000);
    expect(unsatisfiableSize(null, "<Error><Code>InvalidRange</Code><ActualObjectSize>4096</ActualObjectSize></Error>")).toBe(4096);
    expect(unsatisfiableSize(null, "<Error><Code>InvalidRange</Code></Error>")).toBeNull();
  });

  it("streams a known-length body and serves a byte range from one ranged GET", async () => {
    const s3 = fakeS3();
    const storage = new S3Storage(CONFIG, s3.handler as typeof fetch);
    const body = bytes(3000);
    await storage.put("audio/" + ID + ".m4a", new Response(body).body!, { contentType: "audio/mp4", length: 3000 });
    expect(s3.objects.get("audio/" + ID + ".m4a")!.body.byteLength).toBe(3000);
    s3.requests.length = 0;
    const got = await storage.get("audio/" + ID + ".m4a", { range: { offset: 100, length: 50 } });
    if (got?.status !== 206) throw new Error("expected 206, got " + JSON.stringify(got));
    expect(got).toMatchObject({ offset: 100, length: 50, meta: { size: 3000 } });
    expect(await view(got.body)).toEqual(new Uint8Array(body.slice(100, 150)));
    expect(s3.requests.map((r) => [r.method, r.headers.get("Range")])).toEqual([["GET", "bytes=100-149"]]);
  });

  it("turns B2's InvalidRange into a 416 with the size, in one call", async () => {
    const s3 = fakeS3();
    await s3.seed("audio/" + ID + ".m4a", bytes(33), "audio/mp4");
    const storage = new S3Storage(CONFIG, s3.handler as typeof fetch);
    expect(await storage.get("audio/" + ID + ".m4a", { range: { offset: 500 } })).toEqual({ status: 416, size: 33 });
    expect(s3.requests.length).toBe(1);
  });

  it("lists across pages with a prefix, and deletes", async () => {
    const s3 = fakeS3({ pageSize: 2 });
    const storage = new S3Storage(CONFIG, s3.handler as typeof fetch);
    for (const k of ["art/a.jpg", "audio/1.m4a", "audio/2.m4a", "audio/3.m4a", "library.json"]) {
      await storage.put(k, bytes(4), { contentType: "x" });
    }
    expect((await storage.list("audio/")).map((o) => o.key)).toEqual(["audio/1.m4a", "audio/2.m4a", "audio/3.m4a"]);
    expect((await storage.list()).length).toBe(5);
    await storage.delete("audio/2.m4a");
    expect(await storage.head("audio/2.m4a")).toBeNull();
    expect(await storage.get("audio/2.m4a")).toBeNull();
  });

  it("parses escaped keys and quoted ETags from ListObjectsV2 XML", () => {
    const page = parseListPage(
      "<ListBucketResult><Contents><Key>a&amp;b</Key><Size>7</Size><ETag>&quot;abc&quot;</ETag></Contents>" +
        "<IsTruncated>false</IsTruncated></ListBucketResult>",
    );
    expect(page).toEqual({ objects: [{ key: "a&b", size: 7, etag: "abc", httpEtag: '"abc"' }], next: undefined });
  });
});

describe("Worker backed by B2 (no R2 binding)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = {
    APP_TOKEN: "app",
    ADMIN_TOKEN: "admin",
    B2_ENDPOINT: CONFIG.endpoint,
    B2_REGION: CONFIG.region,
    B2_BUCKET: CONFIG.bucket,
    B2_KEY_ID: CONFIG.accessKeyId,
    B2_APP_KEY: CONFIG.secretAccessKey,
  };
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request("https://music.example" + path, init) as Request<unknown, IncomingRequestCfProperties>, env);

  /** Seeds a 33-byte song (the size measured against live B2) and returns the fake and the song. */
  async function withSong(mode: FakeMode = "b2") {
    const s3 = fakeS3({ mode });
    vi.stubGlobal("fetch", s3.handler);
    const song = bytes(33);
    await s3.seed("audio/" + ID + ".m4a", song, "audio/mp4");
    await s3.seed("library.json", new TextEncoder().encode('{"version":1}').buffer as ArrayBuffer, "application/json");
    const etag = '"' + (await hex("MD5", song)) + '"';
    /** Calls the Worker and returns the reply plus the B2 requests it made. */
    const read = async (path: string, init: RequestInit = {}) => {
      const before = s3.requests.length;
      const res = await call(path + (path.includes("?") ? "&" : "?") + "token=app", init);
      return { res, sent: s3.requests.slice(before) };
    };
    return { s3, song, etag, read };
  }

  it("uploads through the admin API, then plays a range to the app", async () => {
    const s3 = fakeS3();
    vi.stubGlobal("fetch", s3.handler);
    const body = bytes(4096);
    const sha = await hex("SHA-256", body);
    const put = await call("/admin/objects/audio/" + ID + ".m4a", {
      method: "PUT",
      body,
      headers: { Authorization: "Bearer admin", "X-Content-SHA256": sha, "Content-Length": "4096" },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ size: 4096 });

    const list = await call("/admin/objects?prefix=audio/", { headers: { Authorization: "Bearer admin" } });
    const listed = (await list.json()) as { objects: { key: string; etag: string; sha256: string | null }[] };
    expect(listed.objects).toEqual([{ key: "audio/" + ID + ".m4a", size: 4096, etag: await hex("MD5", body), sha256: null }]);

    const before = s3.requests.length;
    const range = await call("/audio/" + ID + "?token=app", { headers: { Range: "bytes=0-99" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 0-99/4096");
    expect((await range.arrayBuffer()).byteLength).toBe(100);
    expect(s3.requests.length - before).toBe(1);

    const bad = await call("/admin/objects/library.json", {
      method: "PUT",
      body: "{}",
      headers: { Authorization: "Bearer admin", "X-Content-SHA256": "b".repeat(64) },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "sha256_mismatch" });
  });

  it("a ranged GET is one B2 GET, and the 206 headers come from B2's reply", async () => {
    const { song, etag, read } = await withSong();
    const { res, sent } = await read("/audio/" + ID, { headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/33");
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Cache-Control")).toBe(MEDIA_CACHE);
    expect(await view(res)).toEqual(new Uint8Array(song.slice(0, 5)));
    expect(sent.map((r) => [r.method, r.headers.get("Range")])).toEqual([["GET", "bytes=0-4"]]);
  });

  it("open, suffix and full reads are one GET each", async () => {
    const { song, read } = await withSong();
    const open = await read("/audio/" + ID, { headers: { Range: "bytes=30-" } });
    expect(open.res.status).toBe(206);
    expect(open.res.headers.get("Content-Range")).toBe("bytes 30-32/33");
    expect(await view(open.res)).toEqual(new Uint8Array(song.slice(30)));
    expect(open.sent.map((r) => r.headers.get("Range"))).toEqual(["bytes=30-"]);

    const suffix = await read("/audio/" + ID, { headers: { Range: "bytes=-5" } });
    expect(suffix.res.status).toBe(206);
    expect(suffix.res.headers.get("Content-Range")).toBe("bytes 28-32/33");
    expect(await view(suffix.res)).toEqual(new Uint8Array(song.slice(28)));
    expect(suffix.sent.length).toBe(1);

    const full = await read("/audio/" + ID);
    expect(full.res.status).toBe(200);
    expect(full.res.headers.get("Content-Length")).toBe("33");
    expect(full.res.headers.get("Content-Range")).toBeNull();
    expect(await view(full.res)).toEqual(new Uint8Array(song));
    expect(full.sent.map((r) => [r.method, r.headers.get("Range")])).toEqual([["GET", null]]);
  });

  it("an unsatisfiable range is 416 with Content-Range */size parsed from B2's message, in one call", async () => {
    const { read } = await withSong();
    for (const range of ["bytes=500-", "bytes=-0"]) {
      const { res, sent } = await read("/audio/" + ID, { headers: { Range: range } });
      expect(res.status, range).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */33");
      expect(await res.json()).toEqual({ error: "range_not_satisfiable" });
      expect(sent.length, range).toBe(1);
    }
  });

  it("If-None-Match is forwarded and B2's 304 is passed on, in one call", async () => {
    const { etag, read } = await withSong();
    for (const value of [etag, "W/" + etag, '"other", ' + etag]) {
      const { res, sent } = await read("/audio/" + ID, { headers: { "If-None-Match": value, Range: "bytes=0-4" } });
      expect(res.status, value).toBe(304);
      expect(res.headers.get("ETag")).toBe(etag);
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(await res.text()).toBe("");
      expect(sent.length).toBe(1);
      expect(sent[0]!.headers.get("If-None-Match")).not.toBeNull();
    }
  });

  it("/library is one GET, including the 304", async () => {
    const { read } = await withSong();
    const first = await read("/library");
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await first.res.json()).toEqual({ version: 1 });
    expect(first.sent.map((r) => r.method)).toEqual(["GET"]);

    const again = await read("/library", { headers: { "If-None-Match": first.res.headers.get("ETag")! } });
    expect(again.res.status).toBe(304);
    expect(again.sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("HEAD is one B2 HEAD", async () => {
    const { read } = await withSong();
    const { res, sent } = await read("/audio/" + ID, { method: "HEAD", headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/33");
    expect(sent.map((r) => r.method)).toEqual(["HEAD"]);
  });

  it("If-Range travels as If-Match, so a stale copy gets the whole new file instead of mixed bytes", async () => {
    const { song, etag, read } = await withSong();
    const fresh = await read("/audio/" + ID, { headers: { Range: "bytes=0-4", "If-Range": etag } });
    expect(fresh.res.status).toBe(206);
    expect(await view(fresh.res)).toEqual(new Uint8Array(song.slice(0, 5)));
    expect(fresh.sent.map((r) => [r.headers.get("Range"), r.headers.get("If-Match")])).toEqual([["bytes=0-4", etag]]);

    const stale = await read("/audio/" + ID, { headers: { Range: "bytes=0-4", "If-Range": '"old-version"' } });
    expect(stale.res.status).toBe(200);
    expect(stale.res.headers.get("Content-Range")).toBeNull();
    expect(stale.res.headers.get("ETag")).toBe(etag);
    expect(await view(stale.res)).toEqual(new Uint8Array(song));
    // The ranged GET fails with 412; only then is the whole file read, without Range or If-Match.
    expect(stale.sent.map((r) => [r.headers.get("Range"), r.headers.get("If-Match")])).toEqual([
      ["bytes=0-4", '"old-version"'],
      [null, null],
    ]);
  });

  it("a 200 to a ranged GET goes out as a plain 200, never labelled partial", async () => {
    const { song, read } = await withSong("ignoreRange");
    const { res, sent } = await read("/audio/" + ID, { headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe("33");
    expect(await view(res)).toEqual(new Uint8Array(song));
    expect(sent.length).toBe(1);

    const beyond = await read("/audio/" + ID, { headers: { Range: "bytes=500-" } });
    expect(beyond.res.status).toBe(416);
    expect(beyond.res.headers.get("Content-Range")).toBe("bytes */33");
    await beyond.res.arrayBuffer();
  });

  it("a 206 whose Content-Range is not the requested range is refused", async () => {
    const { read } = await withSong("wholeFileAs206");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { res } = await read("/audio/" + ID, { headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
