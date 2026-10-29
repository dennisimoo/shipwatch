import { beforeEach, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
let currentFingerprint = "baseline";
const { db, now, recordSnapshot, recordFailure } = await import("../src/db");

function company() {
  return db
    .query("SELECT * FROM companies WHERE id='test'")
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
    "DELETE FROM daily_checks; DELETE FROM releases; DELETE FROM seen_versions; DELETE FROM companies;",
  );
  db.query(
    "INSERT INTO companies(id,name,url,created_at,next_check) VALUES ('test','Test','https://example.com',?,?)",
  ).run(now(), now());
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
