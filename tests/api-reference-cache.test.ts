import { expect, spyOn, test } from "bun:test";
import { hash } from "../src/detect";

process.env.DATABASE_PATH = ":memory:";
const { extract, apiChanges } = await import("../src/api-references");
const { saveBody } = await import("../src/analysis");
const { db } = await import("../src/db");

test("legacy extraction caches are rebuilt with request type and reused", async () => {
  const source = 'fetch("/checkout",{method:"POST"});';
  const digest = hash(source);
  saveBody(digest, source);
  db.query("INSERT OR REPLACE INTO api_references(hash,entries) VALUES (?,?)").run(digest,
    JSON.stringify([{ url: "/checkout", method: "POST", queryParams: [], bodyParams: [] }]));
  const entries = await extract(digest);
  expect(entries).toEqual([{ url: "/checkout", type: "fetch", method: "POST", queryParams: [], bodyParams: [] }]);
  expect(db.query("SELECT version FROM api_references WHERE hash=?").get(digest)).toEqual({ version: 2 });
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Fresh cache must not spawn jsluice"); });
  try { expect(await extract(digest)).toEqual(entries); }
  finally { spawn.mockRestore(); }
});

test("cache versions distinguish legacy empty results without rejecting optional types", async () => {
  const source = 'fetch("/cached-empty");';
  const digest = hash(source);
  saveBody(digest, source);
  db.query("INSERT OR REPLACE INTO api_references(hash,entries) VALUES (?,?)").run(digest, "[]");
  expect((await extract(digest))[0]?.type).toBe("fetch");
  const optionalType = [{ url: "/request", method: "POST", queryParams: [], bodyParams: [] }];
  db.query("UPDATE api_references SET entries=? WHERE hash=?").run(JSON.stringify(optionalType), digest);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Versioned cache may have optional type"); });
  try { expect(await extract(digest)).toEqual(optionalType); }
  finally { spawn.mockRestore(); }
});

test("navigation references remain available to maps without becoming API changes", async () => {
  const source = 'window.location.href="/settings";fetch("/checkout",{method:"POST"});window.open("/checkout");';
  const digest = hash(source);
  saveBody(digest, source);
  const references = await extract(digest);
  expect(references.some((entry) => entry.url === "/settings" && entry.type === "locationAssignment")).toBe(true);
  expect(references.some((entry) => entry.url === "/checkout" && entry.type === "window.open")).toBe(true);
  const changes = await apiChanges({ content: [] }, { content: [{ url: "https://example.com/app.js", hash: digest }] }, "https://example.com/");
  expect(changes.added).toEqual([{ url: "https://example.com/checkout", method: "POST", queryParams: [], bodyParams: [] }]);
});

test("unavailable bundles are not interpreted as removed or newly added API requests", async () => {
  const source = 'fetch("/checkout-missing",{method:"POST"});';
  const digest = hash(source);
  saveBody(digest, source);
  const url = "https://example.com/checkout.js";
  const captured = { content: [{ url, hash: digest }] };
  const missing = { content: [], missing: [url] };
  expect(await apiChanges(captured, missing, "https://example.com/")).toEqual({
    added: [], removed: [], truncated: true, incomplete: true,
  });
  const uninspected = { content: [], uninspected: [url] };
  expect(await apiChanges(uninspected, captured, "https://example.com/")).toEqual({
    added: [], removed: [], truncated: true, incomplete: true,
  });
  expect(await apiChanges({ content: [] }, { ...captured, missing: ["https://example.com/other.js"] }, "https://example.com/")).toEqual({
    added: [{ url: "https://example.com/checkout-missing", method: "POST", queryParams: [], bodyParams: [] }],
    removed: [], truncated: false, incomplete: true,
  });
});
