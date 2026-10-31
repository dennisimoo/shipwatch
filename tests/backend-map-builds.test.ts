import { expect, spyOn, test } from "bun:test";
import { gzipSync } from "node:zlib";

process.env.DATABASE_PATH = ":memory:";
const { backendMap, buildBackendMap } = await import("../src/backend-map");
const { db } = await import("../src/db");
const references = await import("../src/api-references");
const { hash } = await import("../src/detect");

test("map builds are globally bounded, deduplicated, and get their deadline after queueing", async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `map-build-test-${index}`);
  for (const id of ids) {
    const url = `https://${id}.example.com/`;
    const source = `fetch('/api/${id}');`;
    const digest = hash(source);
    db.query("INSERT INTO companies(id,name,url,created_at) VALUES(?,?,?,0)").run(id, id, url);
    db.query("INSERT INTO targets(id,company_id,url,next_check) VALUES(?,?,?,0)").run(id, id, url);
    db.query("INSERT OR IGNORE INTO bundle_bodies VALUES(?,?)").run(digest, gzipSync(source));
    db.query("INSERT INTO bundle_captures VALUES(?,?,?,?,?,0,0)").run(id, id, url, digest,
      JSON.stringify({ content: [{ url: url + "app.js", hash: digest }] }));
  }
  let active = 0;
  let peak = 0;
  let calls = 0;
  let clock = Date.now();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  const extraction = spyOn(references, "extract").mockImplementation(async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try { await gate; return []; }
    finally { active--; }
  });
  try {
    const requests = ids.map((id) => backendMap(id));
    const duplicate = backendMap(ids[0]);
    await Bun.sleep(0);
    expect(calls).toBe(2);
    expect(peak).toBe(2);
    clock += 26000;
    release();
    const maps = await Promise.all(requests);
    expect(await duplicate).toBe(maps[0]);
    expect(calls).toBe(ids.length);
    expect(peak).toBe(2);
    expect(maps.every((map) => map?.bundles === 1 && !map.incomplete)).toBe(true);
    expect(await backendMap(ids[0])).toEqual(maps[0]);
    expect(calls).toBe(ids.length);
  } finally {
    release();
    extraction.mockRestore();
    time.mockRestore();
    for (const id of ids) {
      db.query("DELETE FROM metadata WHERE key=?").run("backend:" + id);
      db.query("DELETE FROM targets WHERE company_id=?").run(id);
      db.query("DELETE FROM companies WHERE id=?").run(id);
    }
  }
});

test("missing asset evidence marks the backend map incomplete", async () => {
  const map = await buildBackendMap("https://example.com/", [{
    url: "https://example.com/",
    evidence: JSON.stringify({ content: [], missing: ["https://example.com/missing.js"] }),
  }]);
  expect(map.incomplete).toBe(true);
});
