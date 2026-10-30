import { beforeEach, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
let currentFingerprint = "baseline";
const { db, now, recordSnapshot, recordFailure } = await import("../src/db");
const { syncDirectory } = await import("../src/import-yc");

function company() {
  return db
    .query("SELECT * FROM targets WHERE company_id='test'")
    .get() as Parameters<typeof recordSnapshot>[0];
}
function checkCompany(value: ReturnType<typeof company>) {
  recordSnapshot(
    value,
    {
      fingerprint: currentFingerprint,
      assets: {},
      evidence: JSON.stringify({ version: currentFingerprint }),
    },
    now(),
  );
}
const count = () =>
  (
    db.query("SELECT COUNT(*) AS count FROM releases").get() as {
      count: number;
    }
  ).count;

beforeEach(() => {
  db.exec(
    "DELETE FROM discovery_jobs; DELETE FROM targets; DELETE FROM daily_checks; DELETE FROM releases; DELETE FROM seen_versions; DELETE FROM companies;",
  );
  db.query(
    "INSERT INTO companies(id,name,url,created_at) VALUES ('test','Test','https://example.com',?)",
  ).run(now());
  db.query(
    "INSERT INTO targets(id,company_id,url,next_check) VALUES ('test','test','https://example.com',?)",
  ).run(now());
  currentFingerprint = "baseline";
});

test("baseline is not a release; only persistent, previously unseen versions count", async () => {
  await checkCompany(company());
  expect(count()).toBe(0);
  currentFingerprint = "second";
  await checkCompany(company());
  expect(count()).toBe(0);
  await checkCompany(company());
  expect(count()).toBe(1);
  await checkCompany(company());
  expect(count()).toBe(1);
  currentFingerprint = "third";
  await checkCompany(company());
  currentFingerprint = "second";
  await checkCompany(company());
  expect(count()).toBe(1);
});

test("rollback to initial baseline must not count as a new release", async () => {
  await checkCompany(company());
  currentFingerprint = "second";
  await checkCompany(company());
  await checkCompany(company());
  currentFingerprint = "baseline";
  await checkCompany(company());
  await checkCompany(company());
  expect(count()).toBe(1);
});

test("failed checks never change the baseline or confirm a pending release", async () => {
  await checkCompany(company());
  currentFingerprint = "second";
  await checkCompany(company());
  recordFailure(company(), "Website returned HTTP 503");
  expect(count()).toBe(0);
  expect(company().fingerprint).toBe("baseline");
  expect(company().candidate).toBeNull();
});

test("multiple target URLs retain separate baselines and deduplicate shared company versions", () => {
  db.query(
    "INSERT INTO targets(id,company_id,url,next_check) VALUES ('app-target','test','https://app.example.com',?)",
  ).run(now());
  const target = () =>
    db.query("SELECT * FROM targets WHERE id='app-target'").get() as ReturnType<
      typeof company
    >;
  checkCompany(company());
  recordSnapshot(
    target(),
    { fingerprint: "app-baseline", assets: {}, evidence: "{}" },
    now(),
  );
  expect(count()).toBe(0);
  recordSnapshot(
    target(),
    { fingerprint: "shared-version", assets: {}, evidence: "{}" },
    now(),
  );
  recordSnapshot(
    target(),
    { fingerprint: "shared-version", assets: {}, evidence: "{}" },
    now(),
  );
  expect(count()).toBe(1);
  expect(db.query("SELECT company_id,url FROM releases").get()).toEqual({
    company_id: "test",
    url: "https://app.example.com",
  });
  currentFingerprint = "shared-version";
  checkCompany(company());
  checkCompany(company());
  expect(count()).toBe(1);
});

test("YC sync retains only the selected year's active companies and preserves community sites", () => {
  db.query(
    "INSERT INTO companies(id,name,url,source,created_at) VALUES ('yc-1','Old','https://old.example.com','yc',?)",
  ).run(now());
  db.query(
    "INSERT INTO targets(id,company_id,url,next_check) VALUES ('yc-1','yc-1','https://old.example.com',?)",
  ).run(now());
  const old = db
    .query("SELECT * FROM targets WHERE company_id='yc-1'")
    .get() as ReturnType<typeof company>;
  recordSnapshot(
    old,
    { fingerprint: "old", assets: {}, evidence: "{}" },
    now(),
  );
  const entries = [
    {
      id: 1,
      name: "Old",
      website: "https://old.example.com",
      batch: "Summer 2025",
      status: "Active",
      one_liner: "",
      url: "",
    },
    {
      id: 2,
      name: "Recent",
      website: "https://recent.example.com",
      batch: "Summer 2026",
      status: "Active",
      one_liner: "",
      url: "",
    },
    {
      id: 3,
      name: "Inactive",
      website: "https://inactive.example.com",
      batch: "Fall 2026",
      status: "Inactive",
      one_liner: "",
      url: "",
    },
  ];
  expect(syncDirectory(entries, "2026")).toBe(1);
  expect(db.query("SELECT id FROM companies ORDER BY id").all()).toEqual([
    { id: "test" },
    { id: "yc-2" },
  ]);
  expect(
    db.query("SELECT * FROM seen_versions WHERE company_id='yc-1'").all(),
  ).toEqual([]);
  expect(() => syncDirectory(entries, "1999")).toThrow();
  expect(
    db.query("SELECT id FROM companies WHERE id='yc-2'").get(),
  ).not.toBeNull();
});
