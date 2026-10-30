import { afterEach, expect, spyOn, test } from "bun:test";
import * as network from "../src/network";
import { assetIdentity, bundleReferences, hash, normalizeContent, snapshot } from "../src/detect";

afterEach(() => { mockFetch?.mockRestore(); });
let mockFetch: ReturnType<typeof spyOn<typeof network, "fetchPublic">> | undefined;

test("asset identities ignore deployment IDs and filename hashes, not meaningful query values", () => {
  expect(assetIdentity("https://example.com/main-ABCDEFGH.js?dpl=dpl_one&locale=en"))
    .toBe(assetIdentity("https://example.com/main-IJKLMNOP.js?dpl=dpl_two&locale=en"));
  expect(assetIdentity("https://example.com/main.js?locale=en"))
    .not.toBe(assetIdentity("https://example.com/main.js?locale=fr"));
  expect(assetIdentity("https://example.com/_next/static/build-one/_buildManifest.js?dpl=one"))
    .toBe(assetIdentity("https://example.com/_next/static/build-two/_buildManifest.js?dpl=two"));
  expect(assetIdentity("https://example.com/_next/static/chunks/abcdef123456.js"))
    .toBe(assetIdentity("https://example.com/_next/static/chunks/123456abcdef.js"));
});

test("normalization ignores injected Sentry metadata but preserves application values", () => {
  const source = (id: string, deploy: string, filename: string, value = 1) =>
    `_sentryDebugIds[n]="${id}";import "./vendor-${filename}.js?dpl=${deploy}";const value=${value};\n//# debugId=${id}\n//# sourceMappingURL=${filename}.js.map`;
  const first = source("11111111-1111-1111-1111-111111111111", "dpl_one", "ABCDEFGH");
  const second = source("22222222-2222-2222-2222-222222222222", "dpl_two", "IJKLMNOP");
  expect(normalizeContent(first, "https://example.com/main-ABCDEFGH.js"))
    .toBe(normalizeContent(second, "https://example.com/main-IJKLMNOP.js"));
  expect(normalizeContent(first, "https://example.com/main.js"))
    .not.toBe(normalizeContent(source("11111111-1111-1111-1111-111111111111", "dpl_one", "ABCDEFGH", 2), "https://example.com/main.js"));
  expect(normalizeContent('const id="11111111-1111-1111-1111-111111111111";', "https://example.com/main.js"))
    .toContain("11111111-1111-1111-1111-111111111111");
  expect(normalizeContent('const example="http://[invalid].js";', "https://example.com/main.js"))
    .toBe('const example="http://[invalid].js";');
  expect(normalizeContent('window.SENTRY_RELEASE={id:"first"};', "https://example.com/main.js"))
    .toBe(normalizeContent('window.SENTRY_RELEASE={id:"second"};', "https://example.com/main.js"));
  const debug = (id: string) => `var context=window;context._debugIds||(context._debugIds={});(context._debugIds||(context._debugIds={}))[stack]="${id}";`;
  expect(normalizeContent(debug("11111111-1111-1111-1111-111111111111"), "https://example.com/main.js"))
    .toBe(normalizeContent(debug("22222222-2222-2222-2222-222222222222"), "https://example.com/main.js"));
  expect(normalizeContent('s.setAttribute("data-deployment-id","dpl_first");', "https://example.com/webpack-abcdef123.js"))
    .toBe(normalizeContent('s.setAttribute("data-deployment-id","dpl_second");', "https://example.com/webpack-123abcdef.js"));
  expect(normalizeContent('self.__BUILD_MANIFEST={"/":["static/chunks/123-abcdef123456.js"]};', "https://example.com/_next/static/build/_buildManifest.js"))
    .toBe(normalizeContent('self.__BUILD_MANIFEST={"/":["static/chunks/123-123456abcdef.js"]};', "https://example.com/_next/static/build/_buildManifest.js"));
});

test("native import scanning follows static, dynamic, and Vite stylesheet references", () => {
  const source = 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/style-ABCDEFGH.css"])));import "./vendor.js";import("./app.js");';
  expect(bundleReferences(source, "https://example.com/assets/main.js"))
    .toEqual(["https://example.com/assets/vendor.js", "https://example.com/assets/app.js", "https://example.com/assets/style-ABCDEFGH.css"]);
});

test("snapshots capture sibling scripts and imports, never another tenant", async () => {
  const seen: string[] = [];
  mockFetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => {
    seen.push(url);
    const html = url === "https://app.example.com/";
    const body = html ? '<script src="https://cdn.example.com/main.js"></script><script src="https://evil.com/app.js"></script>'
      : url.endsWith("main.js") ? 'import "https://assets.example.com/child.js";import "https://evil.com/child.js";' : 'export const value=1;';
    return { url, body, status: 200, headers: { "content-type": html ? "text/html" : "application/javascript" }, bytes: body.length };
  });
  const result = await snapshot("https://app.example.com/", {});
  expect(Object.keys(result.assets)).toEqual(["https://cdn.example.com/main.js", "https://assets.example.com/child.js"]);
  expect(seen.some((url) => url.includes("evil.com"))).toBe(false);
});

test("capture follows up to 128 assets and retains the five-megabyte asset bound", async () => {
  const limits: number[] = [];
  mockFetch = spyOn(network, "fetchPublic").mockImplementation(async (url, _headers, limit) => {
    if (limit) limits.push(limit);
    const html = url === "https://example.com/";
    const body = html ? Array.from({ length: 130 }, (_, index) => `<script src="/asset-${index}.js"></script>`).join("") : "export const value=1;";
    return { url, body, status: 200, headers: { "content-type": html ? "text/html" : "application/javascript" }, bytes: body.length };
  });
  const result = await snapshot("https://example.com/", {});
  expect(Object.keys(result.assets)).toHaveLength(128);
  expect(JSON.parse(result.evidence).uninspected).toHaveLength(2);
  expect(Math.max(...limits)).toBe(5_000_000);
  expect(result.captureScope).toBe("registrable-128-v2");
});

test("snapshots ignore rebuild metadata, follow actual child changes, and reuse conditional caches", async () => {
  let deploy = "one";
  let value = 1;
  const seen: string[] = [];
  mockFetch = spyOn(network, "fetchPublic").mockImplementation(async (url, headers) => {
    seen.push(url);
    const target = new URL(url);
    let body = "";
    let status = 200;
    if (target.pathname === "/") body = `<script src="/main-${deploy === "one" ? "ABCDEFGH" : "IJKLMNOP"}.js?dpl=${deploy}"></script><script src="https://other.com/external.js"></script><script type="application/json">{"buildId":"${deploy}"}</script>`;
    else if (target.pathname.startsWith("/main-")) body = `import "./child-ABCDEFGH.js?dpl=${deploy}";`;
    else if (target.pathname.startsWith("/child-")) {
      body = `export const value=${value};`;
      if (headers?.["If-None-Match"] === String(value)) status = 304;
    } else throw new Error("Unexpected fetch: " + url);
    return { url, body, status, headers: { "content-type": target.pathname === "/" ? "text/html" : "application/javascript", etag: String(value) }, bytes: body.length };
  });
  const first = await snapshot("https://example.com/", {});
  deploy = "two";
  const rebuilt = await snapshot("https://example.com/", first.assets);
  expect(rebuilt.fingerprint).toBe(first.fingerprint);
  value = 2;
  const changed = await snapshot("https://example.com/", rebuilt.assets);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
  const cached = await snapshot("https://example.com/", changed.assets);
  expect(cached.fingerprint).toBe(changed.fingerprint);
  expect(seen.some((url) => url.includes("other.com"))).toBe(false);
  await expect(snapshot("https://example.com/", {}, async (url) => !url.includes("child-"))).rejects.toThrow("robots");
});

test("historical repair preserves original evidence and only restores verified content transitions", async () => {
  process.env.DATABASE_PATH = ":memory:";
  const { db } = await import("../src/db");
  const { recheckHistory } = await import("../src/recheck-history");
  db.query("INSERT INTO companies(id,name,url,created_at) VALUES('history-fixture','History','https://history.example.com',900)").run();
  db.query("INSERT INTO targets(id,company_id,url,next_check) VALUES('history-fixture','history-fixture','https://history.example.com/',0)").run();
  const bodies = new Map<string, string>();
  for (const [index, deploy] of ["one", "two", "three", "missing"].entries()) {
    const address = `https://history.example.com/main-ABCDEFGH.js?dpl=${deploy}`;
    const body = `export const value=${index < 2 ? 1 : 2};`;
    bodies.set(address, deploy === "missing" ? "export const value=99;" : body);
    const theme = "https://history.example.com/theme.js";
    bodies.set(theme + "?dpl=" + deploy, "const theme=1;");
    db.query(`INSERT INTO releases(company_id,fingerprint,detected_at,previous_at,confirmed_at,evidence,url)
      VALUES('history-fixture',?, ?, ?, ?, ?, 'https://history.example.com/')`).run(
      "legacy-" + deploy, 1000 + index * 300, 900 + index * 300, 1060 + index * 300,
      JSON.stringify({ scripts: [address, theme], content: [{ url: address, hash: hash(body) }, { url: theme, hash: hash("const theme=1;") }] }),
    );
  }
  mockFetch = spyOn(network, "fetchPublic").mockImplementation(async (url) => {
    const body = url.endsWith("/robots.txt") ? "" : bodies.get(url)!;
    if (body === undefined) throw new Error("Unexpected historical fixture URL: " + url);
    return { url, body, status: 200, headers: { "content-type": "application/javascript" }, bytes: body.length };
  });
  const reports = await recheckHistory(true);
  expect(reports.find((entry) => entry.company === "History"))
    .toMatchObject({ verified: 3, updates: 1, unavailable: 1 });
  expect(reports.find((entry) => entry.company === "History")?.errors)
    .toContain("Historical asset no longer matches its recorded hash");
  expect(db.query("SELECT COUNT(*) AS count FROM releases WHERE company_id='history-fixture'").get()).toEqual({ count: 5 });
  expect(db.query("SELECT detected_at,previous_at FROM bundle_releases WHERE company_id='history-fixture'").get())
    .toEqual({ detected_at: 1600, previous_at: 1300 });
  await recheckHistory(true);
  expect(db.query("SELECT COUNT(*) AS count FROM bundle_releases WHERE company_id='history-fixture'").get()).toEqual({ count: 1 });
  await recheckHistory(true, "history-fixture", true);
  expect(db.query(`SELECT COUNT(*) AS count FROM change_analysis a JOIN releases r ON r.id=a.release_id
    WHERE r.company_id='history-fixture' AND a.before_fingerprint IS NOT NULL`).get()).toEqual({ count: 1 });
  db.query("DELETE FROM targets WHERE company_id='history-fixture'").run();
  db.query("DELETE FROM releases WHERE company_id='history-fixture'").run();
  db.query("DELETE FROM seen_versions WHERE company_id='history-fixture'").run();
  db.query("DELETE FROM companies WHERE id='history-fixture'").run();
});
