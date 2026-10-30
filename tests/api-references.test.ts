import { expect, spyOn, test } from "bun:test";
import { hash, snapshot } from "../src/detect";
import * as network from "../src/network";

process.env.DATABASE_PATH = ":memory:";
const { apiChanges } = await import("../src/api-references");
const { comparison, saveBody } = await import("../src/analysis");
const { db, recordSnapshot } = await import("../src/db");
const { inspect } = await import("../src/discovery");

test("an API root with no page can suggest its public schema", async () => {
  const fetched: string[] = [];
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    fetched.push(path);
    const schema = path === "/openapi.json";
    const body = schema ? '{"openapi":"3.1.0","paths":{"/reports":{"post":{}}}}' : "Not found";
    return { url, body, status: schema ? 200 : 404,
      headers: { "content-type": schema ? "application/json" : "text/plain" }, bytes: body.length };
  });
  try {
    const result = await inspect("http://example.com/", "Passive subdomain discovery");
    expect(result.candidate.url).toBe("http://example.com/openapi.json");
    expect(result.candidate.title).toBe("Public API schema");
    expect(result.candidate.error).toBe(null);
    expect(fetched).not.toContain("/robots.txt");
  } finally { fetch.mockRestore(); }
});

test("widening capture establishes one baseline without manufacturing a release", () => {
  db.query("INSERT INTO companies(id,name,url,created_at) VALUES('scope','Scope','https://app.example.com',1000)").run();
  db.query("INSERT INTO targets(id,company_id,url,next_check) VALUES('scope','scope','https://app.example.com',0)").run();
  const target = () => db.query("SELECT * FROM targets WHERE id='scope'").get() as Parameters<typeof recordSnapshot>[0];
  recordSnapshot(target(), { fingerprint: "content-v3:old-scope", assets: {}, evidence: "{}" }, 1000);
  const expanded = { fingerprint: "content-v3:new-scope", assets: {}, evidence: "{}", captureScope: "registrable-v1" };
  recordSnapshot(target(), expanded, 1300);
  recordSnapshot(target(), expanded, 1600);
  expect(db.query("SELECT COUNT(*) AS count FROM releases WHERE company_id='scope'").get()).toEqual({ count: 0 });
  const changed = { ...expanded, fingerprint: "content-v3:changed-scope" };
  recordSnapshot(target(), changed, 1900);
  recordSnapshot(target(), changed, 1960);
  expect(db.query("SELECT COUNT(*) AS count FROM releases WHERE company_id='scope'").get()).toEqual({ count: 1 });
});

test("jsluice compares first-party request references without sending query values", async () => {
  const evidence = (source: string) => {
    saveBody(hash(source), source);
    return { content: [{ url: "https://cdn.example.com/app.js", hash: hash(source) }] };
  };
  const before = evidence('fetch("https://api.example.com/users?token=oldsecret");');
  const after = evidence('fetch("https://api.example.com/users?token=newsecret"); fetch("https://api.example.com/reports",{method:"POST"});fetch("https://unrelated.com/private");');
  const changes = await apiChanges(before, after, "https://app.example.com/");
  expect(changes.added).toEqual([{ url: "https://api.example.com/reports", method: "POST", queryParams: [], bodyParams: [] }]);
  expect(changes.removed).toEqual([]);
  expect(JSON.stringify(changes)).not.toContain("secret");
  expect(await apiChanges(after, after, "https://app.example.com/")).toEqual({ added: [], removed: [], truncated: false });
  expect(db.query("SELECT COUNT(*) AS count FROM api_references WHERE hash=?").get(after.content[0].hash)).toEqual({ count: 1 });
  const clients = evidence('const xhr=new XMLHttpRequest();xhr.open("GET","/api/xhr");$.get("/api/jquery");axios.get("/api/axios");');
  const clientChanges = await apiChanges({ content: [] }, clients, "https://app.example.com/");
  expect(clientChanges.added.map((entry) => [entry.url, entry.method])).toEqual([
    ["https://app.example.com/api/axios", "GET"],
    ["https://app.example.com/api/jquery", "GET"],
    ["https://app.example.com/api/xhr", "GET"],
  ]);
});

test("public API schemas are captured and compared, arbitrary JSON is rejected", async () => {
  let body = '{"openapi":"3.1.0","paths":{"/users":{"get":{}}}}';
  const fetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => ({
    url, body, status: 200, headers: { "content-type": "application/json" }, bytes: body.length,
  }));
  try {
    const first = await snapshot("http://example.com/openapi.json", {}, saveBody);
    body = '{"openapi":"3.1.0","paths":{"/users":{"get":{}},"/reports":{"post":{}}}}';
    const second = await snapshot("http://example.com/openapi.json", {}, saveBody);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(comparison(JSON.parse(first.evidence), JSON.parse(second.evidence)).patch).toContain("/reports");
    body = '{"timestamp":123}';
    await expect(snapshot("http://example.com/status", {})).rejects.toThrow("HTML or a public API schema");
  } finally {
    fetch.mockRestore();
  }
});
