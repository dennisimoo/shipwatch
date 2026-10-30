import { expect, test } from "bun:test";
import OpenAI from "openai";
import { gunzipSync } from "node:zlib";

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
    expect(input.text.format.schema.required).toEqual(["classification", "summary"]);
    calls++;
    return Response.json({ id: "test", object: "response", status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify({ classification: "build-only", summary: "Only module identifiers changed." }), annotations: [] }] }] });
  } });
  const result = await classifyChange({ patch: "module 1 -> module 2", unseenChanged: false }, client);
  expect(result).toEqual({ classification: "build-only", summary: "Only module identifiers changed." });
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
