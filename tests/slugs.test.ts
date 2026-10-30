import { expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
const { db, ensureCompanySlug, now } = await import("../src/db");

test("company slugs are readable, unique, and stable across name changes", () => {
  for (const id of ["slug-first", "slug-second"])
    db.query(
      "INSERT INTO companies(id,name,url,created_at) VALUES (?,?,?,?)",
    ).run(id, "Reason Machines", "https://" + id + ".com", now());
  expect(ensureCompanySlug("slug-first", "Reason Machines")).toBe(
    "reason-machines",
  );
  expect(ensureCompanySlug("slug-second", "Reason Machines")).toBe(
    "reason-machines-2",
  );
  expect(ensureCompanySlug("slug-first", "A new name")).toBe("reason-machines");
  db.query(
    "DELETE FROM companies WHERE id IN ('slug-first','slug-second')",
  ).run();
});
