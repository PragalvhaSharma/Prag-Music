import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveRange } from "../src/index";

const APP = "test-app-token";
const ADMIN = "test-admin-token";
const ID = "3hxIUxnT27p5WcmjGUXNwx";
const ID2 = "0123456789abcdefABCDEF";
const BASE = "https://prag-music.test";

// 1000 bytes where byte i is i % 256, so slices are easy to check.
const AUDIO = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);

function call(path: string, init: RequestInit & { token?: string | null; admin?: boolean } = {}) {
  const { token = APP, admin = false, ...rest } = init;
  const headers = new Headers(rest.headers);
  const auth = admin ? ADMIN : token;
  if (auth !== null && !headers.has("Authorization")) headers.set("Authorization", "Bearer " + auth);
  return exports.default.fetch(new Request(BASE + path, { ...rest, headers }));
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

beforeEach(async () => {
  await reset();
  await env.BUCKET.put("audio/" + ID + ".m4a", AUDIO);
  await env.BUCKET.put("art/" + ID + ".jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.BUCKET.put("library.json", JSON.stringify({ version: 1, tracks: [], playlists: [] }));
});

describe("health and routing", () => {
  it("GET /health needs no auth", async () => {
    const res = await call("/health", { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown paths are 404", async () => {
    expect((await call("/nope")).status).toBe(404);
  });

  it("wrong method on a read route is 405", async () => {
    const res = await call("/library", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("app auth", () => {
  it("accepts the Bearer header", async () => {
    expect((await call("/library")).status).toBe(200);
  });

  it("accepts ?token=", async () => {
    expect((await call("/library?token=" + APP, { token: null })).status).toBe(200);
  });

  it("rejects a missing token", async () => {
    const res = await call("/library", { token: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong header token, a wrong query token, and a prefix of the real token", async () => {
    expect((await call("/library", { token: "nope" })).status).toBe(401);
    expect((await call("/audio/" + ID + "?token=nope", { token: null })).status).toBe(401);
    expect((await call("/library", { token: APP.slice(0, -1) })).status).toBe(401);
  });

  it("rejects the admin token on app routes and the app token on admin routes", async () => {
    expect((await call("/library", { token: ADMIN })).status).toBe(401);
    expect((await call("/admin/objects", { token: APP })).status).toBe(401);
  });

  it("admin routes ignore ?token=", async () => {
    expect((await call("/admin/objects?token=" + ADMIN, { token: null })).status).toBe(401);
  });
});

describe("/library", () => {
  it("returns the manifest with ETag and no-cache", async () => {
    const res = await call("/library");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("ETag")).toMatch(/^"[^"]+"$/);
    expect(await res.json()).toEqual({ version: 1, tracks: [], playlists: [] });
  });

  it("returns 304 when If-None-Match matches, including weak and list forms", async () => {
    const etag = (await call("/library")).headers.get("ETag")!;
    for (const value of [etag, "W/" + etag, '"other", ' + etag, "*"]) {
      const res = await call("/library", { headers: { "If-None-Match": value } });
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(etag);
      expect(await res.text()).toBe("");
    }
  });

  it("returns 200 when If-None-Match does not match", async () => {
    const res = await call("/library", { headers: { "If-None-Match": '"stale"' } });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toHaveProperty("version", 1);
  });

  it("is 404 before the manifest is uploaded", async () => {
    await env.BUCKET.delete("library.json");
    expect((await call("/library")).status).toBe(404);
  });
});

describe("/audio and /art", () => {
  it("full GET has the contract headers", async () => {
    const res = await call("/audio/" + ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("1000");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("ETag")).toMatch(/^"[^"]+"$/);
    expect(await bytes(res)).toEqual(AUDIO);
  });

  it("serves art as image/jpeg via ?token=", async () => {
    const res = await call("/art/" + ID + "?token=" + APP, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(await bytes(res)).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("bytes=a-b", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 10-19/1000");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await bytes(res)).toEqual(AUDIO.slice(10, 20));
  });

  it("bytes=a-b with b past the end is clamped", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=990-5000" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    expect(await bytes(res)).toEqual(AUDIO.slice(990));
  });

  it("bytes=0-1 (the iOS player's probe)", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1/1000");
    expect(await bytes(res)).toEqual(AUDIO.slice(0, 2));
  });

  it("bytes=a-", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=900-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 900-999/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(await bytes(res)).toEqual(AUDIO.slice(900));
  });

  it("bytes=-n", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 995-999/1000");
    expect(await bytes(res)).toEqual(AUDIO.slice(995));
  });

  it("bytes=-n larger than the file returns the whole file as 206", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=-5000" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-999/1000");
    expect(await bytes(res)).toEqual(AUDIO);
  });

  it("unsatisfiable ranges give 416 with Content-Range */size", async () => {
    for (const range of ["bytes=1000-", "bytes=5000-6000", "bytes=-0"]) {
      const res = await call("/audio/" + ID, { headers: { Range: range } });
      expect(res.status, range).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */1000");
      expect(await res.json()).toEqual({ error: "range_not_satisfiable" });
    }
  });

  it("malformed or multi-part ranges are ignored (200, full body)", async () => {
    for (const range of ["bytes=5-2", "items=0-1", "bytes=0-1,5-6", "bytes=-"]) {
      const res = await call("/audio/" + ID, { headers: { Range: range } });
      expect(res.status, range).toBe(200);
      expect(await bytes(res)).toEqual(AUDIO);
    }
  });

  it("If-Range with a stale ETag ignores the Range", async () => {
    const res = await call("/audio/" + ID, { headers: { Range: "bytes=0-9", "If-Range": '"stale"' } });
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag")!;
    await res.arrayBuffer();
    const fresh = await call("/audio/" + ID, { headers: { Range: "bytes=0-9", "If-Range": etag } });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();
  });

  it("HEAD returns headers and no body", async () => {
    const res = await call("/audio/" + ID, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("1000");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(await res.text()).toBe("");
  });

  it("HEAD with a Range returns 206 headers", async () => {
    const res = await call("/audio/" + ID, { method: "HEAD", headers: { Range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(await res.text()).toBe("");
  });

  it("If-None-Match on audio gives 304", async () => {
    const etag = (await call("/audio/" + ID, { method: "HEAD" })).headers.get("ETag")!;
    const res = await call("/audio/" + ID, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
  });

  it("missing objects and malformed ids are 404, after auth", async () => {
    expect((await call("/audio/" + ID2)).status).toBe(404);
    expect((await call("/art/" + ID2, { method: "HEAD" })).status).toBe(404);
    expect((await call("/audio/not-a-track-id")).status).toBe(404);
    expect((await call("/audio/" + ID + ".m4a")).status).toBe(404);
    expect((await call("/audio/" + ID2, { token: null })).status).toBe(401);
  });
});

describe("CORS", () => {
  it("answers preflight for GET/HEAD with Authorization and Range", async () => {
    const res = await call("/audio/" + ID, {
      method: "OPTIONS",
      token: null,
      headers: { Origin: "http://localhost:8081", "Access-Control-Request-Headers": "authorization,range" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Range");
  });

  it("adds CORS headers to reads and errors", async () => {
    const ok = await call("/library");
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(ok.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    const denied = await call("/library", { token: null });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("admin API", () => {
  it("PUT stores the body with sha256 metadata and content type", async () => {
    const body = new TextEncoder().encode("fake m4a bytes");
    const sha = await sha256Hex(body);
    const res = await call("/admin/objects/audio/" + ID2 + ".m4a", {
      method: "PUT",
      admin: true,
      body,
      headers: { "X-Content-SHA256": sha.toUpperCase(), "Content-Length": String(body.byteLength) },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { key: string; size: number; etag: string };
    expect(out.key).toBe("audio/" + ID2 + ".m4a");
    expect(out.size).toBe(body.byteLength);
    expect(out.etag).toMatch(/^[0-9a-f]+$/);

    const stored = await env.BUCKET.head("audio/" + ID2 + ".m4a");
    expect(stored?.customMetadata?.sha256).toBe(sha);
    expect(stored?.httpMetadata?.contentType).toBe("audio/mp4");

    const served = await call("/audio/" + ID2);
    expect(await bytes(served)).toEqual(body);
  });

  it("PUT works without a sha256 header and for library.json and art", async () => {
    const lib = await call("/admin/objects/library.json", { method: "PUT", admin: true, body: '{"version":1}' });
    expect(lib.status).toBe(200);
    const art = await call("/admin/objects/art/" + ID2 + ".jpg", { method: "PUT", admin: true, body: "jpg" });
    expect(art.status).toBe(200);
    expect((await env.BUCKET.head("art/" + ID2 + ".jpg"))?.httpMetadata?.contentType).toBe("image/jpeg");
    expect((await env.BUCKET.head("library.json"))?.customMetadata?.sha256).toBeUndefined();
  });

  it("PUT rejects a body that does not match X-Content-SHA256", async () => {
    const res = await call("/admin/objects/audio/" + ID2 + ".m4a", {
      method: "PUT",
      admin: true,
      body: "actual body",
      headers: { "X-Content-SHA256": await sha256Hex("different body") },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sha256_mismatch" });
    expect(await env.BUCKET.head("audio/" + ID2 + ".m4a")).toBeNull();
  });

  it("PUT rejects a malformed X-Content-SHA256 and an empty body", async () => {
    const bad = await call("/admin/objects/library.json", {
      method: "PUT",
      admin: true,
      body: "{}",
      headers: { "X-Content-SHA256": "abc" },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_sha256" });
    const empty = await call("/admin/objects/library.json", { method: "PUT", admin: true, body: "" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "empty_body" });
  });

  it("rejects bad keys with 400", async () => {
    const badKeys = [
      "audio/short.m4a",
      "audio/" + ID + ".mp3",
      "art/" + ID + ".png",
      "audio/" + ID + "x.m4a",
      "audio/" + ID.slice(0, 21) + "-.m4a",
      "other.json",
      "library.json.bak",
      "audio/" + ID + ".m4a/extra",
      "audio%2F..%2Flibrary.json",
      "%E0%A4%A",
      "",
    ];
    for (const key of badKeys) {
      const put = await call("/admin/objects/" + key, { method: "PUT", admin: true, body: "x" });
      expect(put.status, key).toBe(400);
      expect(await put.json()).toEqual({ error: "invalid_key" });
      const del = await call("/admin/objects/" + key, { method: "DELETE", admin: true });
      expect(del.status, key).toBe(400);
      await del.arrayBuffer();
    }
  });

  it("rejects admin calls without the admin token", async () => {
    expect((await call("/admin/objects/library.json", { method: "PUT", body: "x", token: null })).status).toBe(401);
    expect((await call("/admin/objects/library.json", { method: "DELETE", token: "wrong" })).status).toBe(401);
    expect((await call("/admin/objects/bad-key", { method: "DELETE", token: null })).status).toBe(401);
  });

  it("DELETE removes an object", async () => {
    const res = await call("/admin/objects/audio/" + ID + ".m4a", { method: "DELETE", admin: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "audio/" + ID + ".m4a" });
    expect(await env.BUCKET.head("audio/" + ID + ".m4a")).toBeNull();
    expect((await call("/audio/" + ID)).status).toBe(404);
  });

  it("GET /admin/objects lists everything with sha256 (or null)", async () => {
    await call("/admin/objects/art/" + ID2 + ".jpg", {
      method: "PUT",
      admin: true,
      body: "jpg",
      headers: { "X-Content-SHA256": await sha256Hex("jpg") },
    });
    const res = await call("/admin/objects", { admin: true });
    expect(res.status).toBe(200);
    const { objects } = (await res.json()) as { objects: { key: string; size: number; etag: string; sha256: string | null }[] };
    expect(objects.map((o) => o.key).sort()).toEqual(
      ["art/" + ID + ".jpg", "art/" + ID2 + ".jpg", "audio/" + ID + ".m4a", "library.json"].sort(),
    );
    const art2 = objects.find((o) => o.key === "art/" + ID2 + ".jpg")!;
    expect(art2.sha256).toBe(await sha256Hex("jpg"));
    expect(art2.size).toBe(3);
    expect(objects.find((o) => o.key === "library.json")!.sha256).toBeNull();
  });

  it("GET /admin/objects filters by prefix", async () => {
    const res = await call("/admin/objects?prefix=art/", { admin: true });
    const { objects } = (await res.json()) as { objects: { key: string }[] };
    expect(objects.map((o) => o.key)).toEqual(["art/" + ID + ".jpg"]);
  });

  it("GET /admin/objects paginates past one R2 page", async () => {
    const keys = Array.from({ length: 1205 }, (_, i) => "audio/" + String(i).padStart(22, "0") + ".m4a");
    for (let i = 0; i < keys.length; i += 100) {
      await Promise.all(keys.slice(i, i + 100).map((k) => env.BUCKET.put(k, "x", { customMetadata: { sha256: "a".repeat(64) } })));
    }
    const res = await call("/admin/objects?prefix=audio/", { admin: true });
    const { objects } = (await res.json()) as { objects: { key: string; sha256: string | null }[] };
    expect(objects.length).toBe(1206);
    expect(new Set(objects.map((o) => o.key)).size).toBe(1206);
    expect(objects.filter((o) => o.sha256 === "a".repeat(64)).length).toBe(1205);
  }, 60_000);

  it("wrong methods on admin routes are 405", async () => {
    expect((await call("/admin/objects", { method: "PUT", admin: true, body: "x" })).status).toBe(405);
    expect((await call("/admin/objects/library.json", { method: "GET", admin: true })).status).toBe(405);
  });
});

describe("resolveRange", () => {
  it("handles edge cases", () => {
    expect(resolveRange(null, 10)).toEqual({ kind: "none" });
    expect(resolveRange("bytes=0-0", 10)).toEqual({ kind: "range", offset: 0, length: 1 });
    expect(resolveRange("bytes=9-9", 10)).toEqual({ kind: "range", offset: 9, length: 1 });
    expect(resolveRange("bytes=10-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(resolveRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
    expect(resolveRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(resolveRange("BYTES=1-2", 10)).toEqual({ kind: "range", offset: 1, length: 2 });
  });
});
