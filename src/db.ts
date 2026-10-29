import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const filename = process.env.DATABASE_PATH || "data/shipwatch.sqlite";
if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
export const db = new Database(filename, { create: true, strict: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
    batch TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    yc_url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'community',
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
    next_check INTEGER NOT NULL, last_check INTEGER, last_success INTEGER,
    baseline_at INTEGER, fingerprint TEXT, candidate TEXT, candidate_at INTEGER,
    previous_success INTEGER, checks INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued', error TEXT,
    assets TEXT NOT NULL DEFAULT '{}', robots TEXT, robots_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS companies_due ON companies(enabled, next_check);
  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
    fingerprint TEXT NOT NULL, detected_at INTEGER NOT NULL,
    previous_at INTEGER NOT NULL, confirmed_at INTEGER NOT NULL,
    evidence TEXT NOT NULL, UNIQUE(company_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS releases_time ON releases(detected_at, company_id);
  CREATE TABLE IF NOT EXISTS seen_versions (
    company_id TEXT NOT NULL REFERENCES companies(id), fingerprint TEXT NOT NULL,
    first_seen INTEGER NOT NULL, PRIMARY KEY(company_id,fingerprint)
  );
  CREATE TABLE IF NOT EXISTS daily_checks (
    company_id TEXT NOT NULL REFERENCES companies(id), day TEXT NOT NULL,
    checks INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(company_id, day)
  );
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export interface Company {
  id: string;
  name: string;
  url: string;
  batch: string;
  enabled: number;
  last_success: number | null;
  fingerprint: string | null;
  candidate: string | null;
  candidate_at: number | null;
  previous_success: number | null;
  assets: string;
  failures: number;
  robots: string | null;
  robots_at: number | null;
}

export const now = () => Math.floor(Date.now() / 1000);

export function recordSnapshot(
  company: Company,
  result: { fingerprint: string; evidence: string; assets: unknown },
  confirmed: number,
) {
  db.transaction(() => {
    if (!company.fingerprint) {
      db.query("INSERT OR IGNORE INTO seen_versions VALUES (?,?,?)").run(
        company.id,
        result.fingerprint,
        confirmed,
      );
      db.query(
        "UPDATE companies SET fingerprint=?,baseline_at=?,candidate=NULL,candidate_at=NULL WHERE id=?",
      ).run(result.fingerprint, confirmed, company.id);
    } else if (result.fingerprint === company.fingerprint) {
      db.query(
        "UPDATE companies SET candidate=NULL,candidate_at=NULL,previous_success=NULL WHERE id=?",
      ).run(company.id);
    } else if (
      result.fingerprint === company.candidate &&
      company.candidate_at &&
      company.previous_success
    ) {
      const seen = db
        .query(
          "SELECT 1 FROM seen_versions WHERE company_id=? AND fingerprint=?",
        )
        .get(company.id, result.fingerprint);
      if (!seen) {
        db.query("INSERT INTO seen_versions VALUES (?,?,?)").run(
          company.id,
          result.fingerprint,
          company.candidate_at,
        );
        db.query(
          `INSERT OR IGNORE INTO releases (company_id,fingerprint,detected_at,previous_at,confirmed_at,evidence) VALUES (?,?,?,?,?,?)`,
        ).run(
          company.id,
          result.fingerprint,
          company.candidate_at,
          company.previous_success,
          confirmed,
          result.evidence,
        );
      }
      db.query(
        "UPDATE companies SET fingerprint=?,candidate=NULL,candidate_at=NULL,previous_success=NULL WHERE id=?",
      ).run(result.fingerprint, company.id);
    } else {
      db.query(
        "UPDATE companies SET candidate=?,candidate_at=?,previous_success=? WHERE id=?",
      ).run(
        result.fingerprint,
        confirmed,
        company.last_success || confirmed,
        company.id,
      );
    }
    db.query(
      `UPDATE companies SET last_check=?,last_success=?,checks=checks+1,successes=successes+1,
      failures=0,status='watching',error=NULL,assets=?,next_check=? WHERE id=?`,
    ).run(
      confirmed,
      confirmed,
      JSON.stringify(result.assets),
      confirmed +
        (result.fingerprint !== company.fingerprint &&
        result.fingerprint !== company.candidate &&
        company.fingerprint
          ? 60
          : 300),
      company.id,
    );
  })();
}

export function recordFailure(company: Company, message: string) {
  const unsupported = /No observable|disallowed/.test(message);
  const delay = unsupported
    ? 86400
    : Math.min(3600, 300 * 2 ** Math.min(company.failures, 4));
  db.query(
    `UPDATE companies SET last_check=?,checks=checks+1,failures=failures+1,
    status=?,error=?,candidate=NULL,candidate_at=NULL,previous_success=NULL,next_check=? WHERE id=?`,
  ).run(
    now(),
    unsupported ? "unsupported" : "error",
    message.slice(0, 240),
    now() + delay,
    company.id,
  );
}
