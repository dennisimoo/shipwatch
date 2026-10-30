import { expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { gunzipSync } from "node:zlib";
import * as runtime from "../src/runtime";

process.env.DATABASE_PATH = ":memory:";
const { db, recordSnapshot } = await import("../src/db");
const { saveBody, comparison, classifyChange, analyzeNext } = await import("../src/analysis");
const { hash } = await import("../src/detect");
const { subdomainHosts } = await import("../src/subdomains");

function evidence(source: string, url = "https://analysis.example.com/main.js") {
  saveBody(hash(source), source);
  return { content: [{ url, hash: hash(source) }] };
}

test("unchanged and normalized metadata avoid model calls; real code produces a diff", async () => {
  const before = evidence('const value=1;const deploy="dpl_first";');
  const after = evidence('const value=1;const deploy="dpl_second";');
  expect(comparison(before, after).patch).toBe("");
  expect((await classifyChange(comparison(before, after))).classification).toBe("build-only");
  const changed = comparison(before, evidence('const value=2;const deploy="dpl_second";'));
  expect(changed.patch).toContain("value = 2");
  expect(() => comparison(before, { content: [{ url: before.content[0].url, hash: "missing" }] })).toThrow("not archived");
  expect(comparison(before, { content: [...before.content, ...before.content] }).unseenChanged).toBe(true);
});

test("one structured Luna call returns both fields and guards incomplete evidence", async () => {
  let calls = 0;
  const client = new OpenAI({ apiKey: "test", fetch: async (_url, request) => {
    const input = JSON.parse(String(request?.body));
    expect(input.model).toBe("gpt-6-luna");
    expect(input.store).toBe(false);
    expect(input.instructions).toContain("nontechnical reader");
    expect(input.instructions).toContain("not just visual changes");
    expect(input.text.format.schema.required).toEqual(["classification", "kind", "summary"]);
    calls++;
    return Response.json({ id: "test", object: "response", status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify({ classification: "build-only", kind: "other", summary: "Only module identifiers changed." }), annotations: [] }] }] });
  } });
  const result = await classifyChange({ patch: "module 1 -> module 2", unseenChanged: false }, client);
  expect(result).toEqual({ classification: "build-only", kind: "other", summary: "Only module identifiers changed." });
  expect((await classifyChange({ patch: "module 1 -> module 2", unseenChanged: true }, client)).classification).toBe("uncertain");
  await classifyChange({ patch: "", unseenChanged: false }, client);
  expect(calls).toBe(2);
});

test("confirmed changes queue once, preserve history, and count only application changes", async () => {
  db.query("INSERT INTO companies(id,name,url,created_at) VALUES('analysis','Analysis','https://analysis.example.com',1000)").run();
  db.query("INSERT INTO targets(id,company_id,url,next_check) VALUES('analysis','analysis','https://analysis.example.com',0)").run();
  const target = () => db.query("SELECT * FROM targets WHERE id='analysis'").get() as Parameters<typeof recordSnapshot>[0];
  const record = (fingerprint: string, source: string, at: number) => recordSnapshot(target(), {
    fingerprint, assets: {}, evidence: JSON.stringify(evidence(source)),
  }, at);
  record("content-v3:analysis-first", 'const deploy="dpl_first";', 1000);
  record("content-v3:analysis-next", 'const deploy="dpl_second";', 1300);
  record("content-v3:analysis-next", 'const deploy="dpl_second";', 1360);
  record("content-v3:analysis-next", 'const deploy="dpl_second";', 1660);
  record("content-v3:analysis-next", 'const deploy="dpl_third";', 1900);
  expect(db.query("SELECT first_seen,last_seen FROM bundle_captures WHERE company_id='analysis' ORDER BY first_seen").all())
    .toEqual([{ first_seen: 1000, last_seen: 1000 }, { first_seen: 1300, last_seen: 1660 }, { first_seen: 1900, last_seen: 1900 }]);
  expect(db.query("SELECT COUNT(*) AS count FROM change_analysis WHERE before_fingerprint='content-v3:analysis-first'").get()).toEqual({ count: 1 });
  await analyzeNext();
  expect(db.query("SELECT classification FROM change_analysis a JOIN releases r ON r.id=a.release_id WHERE r.company_id='analysis'").get())
    .toEqual({ classification: "build-only" });
  expect(db.query("SELECT COUNT(*) AS count FROM bundle_releases WHERE company_id='analysis'").get()).toEqual({ count: 1 });
  expect(db.query("SELECT COUNT(*) AS count FROM application_releases WHERE company_id='analysis'").get()).toEqual({ count: 0 });
  db.query("UPDATE change_analysis SET classification='application' WHERE release_id IN (SELECT id FROM releases WHERE company_id='analysis')").run();
  expect(db.query("SELECT COUNT(*) AS count FROM application_releases WHERE company_id='analysis'").get()).toEqual({ count: 1 });
  db.query("DELETE FROM targets WHERE company_id='analysis'").run();
  db.query("DELETE FROM releases WHERE company_id='analysis'").run();
  db.query("DELETE FROM seen_versions WHERE company_id='analysis'").run();
  db.query("DELETE FROM companies WHERE id='analysis'").run();
});

test("passive results cannot escape the submitted domain or inject URLs", () => {
  expect(subdomainHosts("app.acme.co.uk\nAPP.ACME.CO.UK\napi.acme.co.uk evil.co.uk acme.co.uk.evil.com *.acme.co.uk https://acme.co.uk --help", "acme.co.uk"))
    .toEqual(["api.acme.co.uk", "app.acme.co.uk"]);
});

test("a large SDK diff does not hide a small inspectable application change", () => {
  const before = evidence("const sdk=" + JSON.stringify("x".repeat(450000)) + ";", "https://analysis.example.com/sdk.js");
  const after = evidence("const sdk=" + JSON.stringify("y".repeat(450000)) + ";", "https://analysis.example.com/sdk.js");
  before.content.push(...evidence('console.log("before");').content);
  after.content.push(...evidence('console.log("after");').content);
  const input = comparison(before, after);
  const archived = db.query("SELECT body FROM bundle_bodies WHERE hash=?").get(before.content[0].hash) as { body: Uint8Array };
  expect(hash(gunzipSync(archived.body).toString())).toBe(before.content[0].hash);
  expect(input.unseenChanged).toBe(true);
  expect(input.patch).toContain("after");
  expect(input.patch.length).toBeLessThan(400000);
});

test("exact URLs pair without guessing unsupported anonymous renames", () => {
  const before = evidence('const stable=1;', "https://example.com/_next/static/chunks/123456abcdef.js?dpl=dpl_old");
  before.content.push(...evidence('const feature=1;', "https://example.com/_next/static/chunks/abcdef123456.js?dpl=dpl_old").content);
  const after = evidence('const stable=1;', "https://example.com/_next/static/chunks/123456abcdef.js?dpl=dpl_new");
  after.content.push(...evidence('const feature=2;', "https://example.com/_next/static/chunks/fedcba654321.js?dpl=dpl_new").content);
  const result = comparison(before, after);
  expect(result.unseenChanged).toBe(true);
  expect(result.patch).toContain("feature = 2");
  expect(result.patch).not.toContain("stable = 1");
  const renamed = evidence('const stable=1;', "https://example.com/_next/static/chunks/0m9abz2od-1_1.js");
  expect(comparison(before, { content: [...renamed.content, before.content[1]] }).patch).toBe("");
});

test("renamed Next chunks compare as small changes rather than whole-file removals", () => {
  const library = Array.from({ length: 5000 }, (_, index) => `function sdk${index}(){return ${index};}`).join("\n");
  const before = evidence(library + '\nconst version="old";', "https://example.com/_next/static/chunks/3s8gmdxbgu990.js");
  const after = evidence(library + '\nconst version="new";', "https://example.com/_next/static/chunks/03z-24k4s418j.js");
  const result = comparison(before, after);
  expect(result.unseenChanged).toBe(false);
  expect(result.patch.length).toBeLessThan(2000);
  expect(result.patch).toContain('version = \\"new\\"');
});

test("separate hunks preserve small changes in the same large asset", () => {
  const spacing = Array.from({ length: 20 }, (_, index) => `function gap${index}(){return ${index};}`).join("\n");
  const before = evidence(`const sdk=${JSON.stringify("x".repeat(450000))};\n${spacing}\nconst feature=false;`);
  const after = evidence(`const sdk=${JSON.stringify("y".repeat(450000))};\n${spacing}\nconst feature=true;`);
  const result = comparison(before, after);
  expect(result.unseenChanged).toBe(true);
  expect(result.patch).toContain("feature = true");
  expect(result.patch.length).toBeLessThan(400000);
});

test("Turbopack WebAssembly loading is not mistaken for an unresolved JS chunk map", () => {
  const source = 'runtime.u=function(t,r){return environment.loadWebAssemblyModule(parent,this.id,t,r);};';
  const before = evidence(source + 'const version=1;');
  const after = evidence(source + 'const version=2;');
  expect(comparison(before, after).unseenChanged).toBe(false);
  const webpack = 'runtime.u=chunk=>"/static/"+chunk+".js";';
  expect(comparison(evidence(webpack + 'const version=1;'), evidence(webpack + 'const version=2;')).unseenChanged).toBe(false);
  expect(comparison(evidence(webpack), evidence(webpack.replace("/static/", "/updated/"))).unseenChanged).toBe(true);
});

test("uncaptured names ignore deployment parameters, never changed content filenames", () => {
  const before = { ...evidence("const stable=1;"), uninspected: ["https://example.com/chunk-ABCDEFGH.js?dpl=dpl_one"] };
  expect(comparison(before, { ...before, uninspected: ["https://example.com/chunk-ABCDEFGH.js?dpl=dpl_two"] }).unseenChanged).toBe(false);
  expect(comparison(before, { ...before, uninspected: ["https://example.com/chunk-IJKLMNOP.js?dpl=dpl_two"] }).unseenChanged).toBe(true);
});

test("unsupported loader syntax retains other evidence and marks the comparison incomplete", () => {
  const inspect = spyOn(runtime, "changedChunkLoader").mockImplementation(() => { throw new SyntaxError("Unsupported syntax"); });
  try {
    const result = comparison(evidence("const feature=false;"), evidence("const feature=true;"));
    expect(result.patch).toContain("feature = true");
    expect(result.unseenChanged).toBe(true);
    expect(result.reasons).toContain("Runtime loader syntax could not be inspected");
  } finally { inspect.mockRestore(); }
});

test("summaries with code identifiers get one plain-language rewrite", async () => {
  const replies = ["Both cleanup paths now schedule `TO` to run in a microtask.", "Closing a panel now cleans up more reliably."];
  let calls = 0;
  const client = new OpenAI({ apiKey: "test", fetch: async (_url, request) => {
    const input = JSON.parse(String(request?.body));
    if (calls) expect(input.instructions).toContain("Rewrite it in everyday words");
    const text = JSON.stringify({ classification: "application", kind: "fix", summary: replies[calls++] });
    return Response.json({ id: "test", object: "response", status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }] }] });
  } });
  expect(await classifyChange({ patch: "a -> b", unseenChanged: false }, client))
    .toEqual({ classification: "application", kind: "fix", summary: "Closing a panel now cleans up more reliably." });
  expect(calls).toBe(2);
});

test("plain summaries pass the jargon check", async () => {
  const { technicalSummary } = await import("../src/analysis");
  expect(technicalSummary("The pricing page adds a yearly plan option.")).toBe(false);
  expect(technicalSummary("Theme initialization now treats `/network/` routes as marketing pages.")).toBe(true);
  expect(technicalSummary("Adds a useFeatureFlag check before checkout.")).toBe(true);
  expect(technicalSummary("Calls /api/brands before loading.")).toBe(true);
  expect(technicalSummary("Adds Chinese and Japanese translations for the network pages.")).toBe(false);
});
