import { expect, spyOn, test } from "bun:test";
import { hash, inspectBundles, type Asset } from "../src/detect";
import * as network from "../src/network";

const root = "https://budget.example.com/";
const address = root + "main-0123456789abcdef.js";
const cached = (size: number): Asset => ({ hash: "saved", contentHash: "saved", method: "content-v3.1",
  immutable: true, fetchedAt: Math.floor(Date.now() / 1000), size, references: [] });

test("immutable reuse spends the decoded budget before accepting each asset", async () => {
  const urls = Array.from({ length: 4 }, (_, index) => `${root}asset-${index}-0123456789abcdef.js`);
  const previous = Object.fromEntries(urls.map((url) => [url, cached(4_900_000)]));
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async () => { throw new Error("Cached assets should not be requested"); });
  try {
    const result = await inspectBundles(root, urls, previous, 800_000);
    expect(result.bytes).toBe(15_500_000);
    expect(result.transferBytes).toBe(0);
    expect(Object.keys(result.assets)).toHaveLength(3);
    expect(JSON.parse(result.evidence).uninspected).toEqual([urls[3]]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(inspectBundles(root, [address], { [address]: cached(5_000_001) })).rejects.toThrow("size limit");
  } finally { fetch.mockRestore(); }
});

test("304 reuse respects the remaining budget without dropping known asset sizes", async () => {
  const urls = Array.from({ length: 4 }, (_, index) => `${root}asset-${index}-0123456789abcdef.js`);
  const previous = Object.fromEntries(urls.map((url) => [url, { ...cached(4_900_000), immutable: false, etag: "saved" }]));
  const limits: number[] = [];
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url, headers, limit) => {
    expect(headers?.["If-None-Match"]).toBe("saved");
    limits.push(limit!);
    return { url, status: 304, body: "", headers: {}, bytes: 0 };
  });
  try {
    const result = await inspectBundles(root, urls, previous, 800_000);
    expect(result.bytes).toBe(15_500_000);
    expect(limits).toHaveLength(3);
    expect(Math.max(...limits)).toBe(5_000_000);
    expect(JSON.parse(result.evidence).uninspected).toEqual([urls[3]]);
  } finally { fetch.mockRestore(); }
});

test("legacy caches without sizes fetch a new body instead of silently spending zero bytes", async () => {
  const previous = { ...cached(100), size: undefined, etag: "legacy" };
  const body = "export const value=2;";
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url, headers) => {
    expect(headers?.["If-None-Match"]).toBeUndefined();
    return { url, body, status: 200, headers: {}, bytes: body.length };
  });
  try {
    const result = await inspectBundles(root, [address], { [address]: previous });
    expect(result.assets[address].hash).toBe(hash(body));
    expect(result.assets[address].size).toBe(body.length);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); }
});

test("a revalidation response can revoke immutable reuse", async () => {
  let requests = 0;
  const body = "export const changed=true;";
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => {
    requests++;
    return requests === 1
      ? { url, body: "", status: 304, headers: { "cache-control": "no-cache" }, bytes: 0 }
      : { url, body, status: 200, headers: { "cache-control": "no-cache" }, bytes: body.length };
  });
  try {
    const old = { ...cached(100), fetchedAt: Math.floor(Date.now() / 1000) - 86401, etag: "old" };
    const revalidated = await inspectBundles(root, [address], { [address]: old });
    expect(revalidated.assets[address].immutable).toBe(false);
    const updated = await inspectBundles(root, [address], revalidated.assets);
    expect(updated.assets[address].hash).toBe(hash(body));
    expect(requests).toBe(2);
  } finally { fetch.mockRestore(); }
});

test("missing script responses remain incomplete observations, not removed application code", async () => {
  process.env.DATABASE_PATH = ":memory:";
  const { comparison, saveBody, classifyChange } = await import("../src/analysis");
  for (const status of [404, 410, 200]) {
    let unavailable = false;
    const urls = [root + "home.js", root + "checkout.js"];
    const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => {
      const missing = unavailable && url === urls[1];
      const body = missing ? "Fallback page" : url === urls[1] ? "const checkoutEnabled=true;" : "const homeEnabled=true;";
      return { url, body, status: missing ? status : 200,
        headers: { "content-type": missing && status === 200 ? "text/html" : "application/javascript" }, bytes: body.length };
    });
    try {
      const before = await inspectBundles(root, urls, {}, 0, null, saveBody);
      unavailable = true;
      const after = await inspectBundles(root, urls, before.assets, 0, null, saveBody);
      expect(JSON.parse(after.evidence).missing).toEqual([urls[1]]);
      const changes = comparison(JSON.parse(before.evidence), JSON.parse(after.evidence));
      expect(changes.patch).toBe("");
      expect(changes.unseenChanged).toBe(true);
      expect((await classifyChange(changes)).classification).toBe("uncertain");
    } finally { fetch.mockRestore(); }
  }
});

test("builder scope remains expanded across consecutive captures without CDN scripts", async () => {
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => ({
    url, status: 200, body: "const website=true;", bytes: 19, headers: { "content-type": "application/javascript" },
  }));
  try {
    const initial = await inspectBundles(root, ["https://framerusercontent.com/sites/12345678/script-main.mjs"]);
    expect(initial.captureScope).toBe("registrable-128-v3");
    const next = await inspectBundles(root, [address], initial.assets, 0, null, undefined, initial.captureScope);
    const subsequent = await inspectBundles(root, [address], next.assets, 0, null, undefined, next.captureScope);
    expect(next.captureScope).toBe(initial.captureScope);
    expect(subsequent.captureScope).toBe(initial.captureScope);
  } finally { fetch.mockRestore(); }
});
