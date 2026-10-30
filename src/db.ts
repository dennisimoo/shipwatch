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
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS targets (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
    url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    next_check INTEGER NOT NULL, last_check INTEGER, last_success INTEGER,
    baseline_at INTEGER, fingerprint TEXT, candidate TEXT, candidate_at INTEGER,
    previous_success INTEGER, checks INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued', error TEXT,
    assets TEXT NOT NULL DEFAULT '{}', robots TEXT, robots_at INTEGER,
    UNIQUE(company_id,url)
  );
  CREATE INDEX IF NOT EXISTS targets_due ON targets(enabled,next_check);
  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
    fingerprint TEXT NOT NULL, detected_at INTEGER NOT NULL,
    previous_at INTEGER NOT NULL, confirmed_at INTEGER NOT NULL,
    evidence TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', UNIQUE(company_id, fingerprint)
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
  CREATE TABLE IF NOT EXISTS discovery_jobs (
    company_id TEXT PRIMARY KEY REFERENCES companies(id), status TEXT NOT NULL DEFAULT 'queued',
    domain_limit INTEGER NOT NULL DEFAULT 3 CHECK(domain_limit BETWEEN 1 AND 10),
    candidate_limit INTEGER NOT NULL DEFAULT 12 CHECK(candidate_limit BETWEEN 1 AND 30),
    next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, review TEXT, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS discovery_drafts (
    token TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
`);

if (
  !(db.query("PRAGMA table_info(releases)").all() as { name: string }[]).some(
    (column) => column.name === "url",
  )
) {
  db.exec("ALTER TABLE releases ADD COLUMN url TEXT NOT NULL DEFAULT ''");
}
if (
  (db.query("PRAGMA table_info(companies)").all() as { name: string }[]).some(
    (column) => column.name === "next_check",
  )
) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      db.exec(`INSERT OR IGNORE INTO targets
        (id,company_id,url,enabled,next_check,last_check,last_success,baseline_at,fingerprint,candidate,candidate_at,previous_success,checks,successes,failures,status,error,assets,robots,robots_at)
        SELECT id,id,url,enabled,next_check,last_check,last_success,baseline_at,fingerprint,candidate,candidate_at,previous_success,checks,successes,failures,status,error,assets,robots,robots_at FROM companies;
        UPDATE releases SET url=(SELECT url FROM companies WHERE id=releases.company_id) WHERE url='';
        CREATE TABLE companies_new (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,batch TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',yc_url TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'community',
          enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL
        );
        INSERT INTO companies_new SELECT id,name,url,batch,description,yc_url,source,enabled,created_at FROM companies;
        DROP TABLE companies;
        ALTER TABLE companies_new RENAME TO companies;
      `);
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Target migration failed foreign-key validation");
    })();
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
db.exec(`CREATE VIEW IF NOT EXISTS company_summary AS
  SELECT c.id,c.name,c.url,c.batch,c.description,c.yc_url,c.source,c.enabled,c.created_at,
    MIN(t.baseline_at) AS baseline_at,MAX(t.last_check) AS last_check,MAX(t.last_success) AS last_success,
    COALESCE(SUM(t.checks),0) AS checks,COALESCE(SUM(t.successes),0) AS successes,
    CASE WHEN SUM(t.status='watching')>0 THEN 'watching'
      WHEN SUM(t.status='queued')>0 THEN 'queued' WHEN SUM(t.status='error')>0 THEN 'error'
      WHEN COUNT(t.id)>0 THEN 'unsupported' ELSE 'queued' END AS status,
    CASE WHEN SUM(t.status='watching')>0 THEN NULL ELSE MAX(t.error) END AS error,
    COUNT(t.id) AS target_count
  FROM companies c LEFT JOIN targets t ON t.company_id=c.id AND t.enabled=1 GROUP BY c.id;
`);

export interface Target {
  id: string;
  company_id: string;
  url: string;
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
  company: Target,
  result: { fingerprint: string; evidence: string; assets: unknown },
  confirmed: number,
) {
  db.transaction(() => {
    if (!company.fingerprint) {
      db.query("INSERT OR IGNORE INTO seen_versions VALUES (?,?,?)").run(
        company.company_id,
        result.fingerprint,
        confirmed,
      );
      db.query(
        "UPDATE targets SET fingerprint=?,baseline_at=?,candidate=NULL,candidate_at=NULL WHERE id=?",
      ).run(result.fingerprint, confirmed, company.id);
    } else if (result.fingerprint === company.fingerprint) {
      db.query(
        "UPDATE targets SET candidate=NULL,candidate_at=NULL,previous_success=NULL WHERE id=?",
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
        .get(company.company_id, result.fingerprint);
      if (!seen) {
        db.query("INSERT INTO seen_versions VALUES (?,?,?)").run(
          company.company_id,
          result.fingerprint,
          company.candidate_at,
        );
        db.query(
          `INSERT OR IGNORE INTO releases (company_id,fingerprint,detected_at,previous_at,confirmed_at,evidence,url) VALUES (?,?,?,?,?,?,?)`,
        ).run(
          company.company_id,
          result.fingerprint,
          company.candidate_at,
          company.previous_success,
          confirmed,
          result.evidence,
          company.url,
        );
      }
      db.query(
        "UPDATE targets SET fingerprint=?,candidate=NULL,candidate_at=NULL,previous_success=NULL WHERE id=?",
      ).run(result.fingerprint, company.id);
    } else {
      db.query(
        "UPDATE targets SET candidate=?,candidate_at=?,previous_success=? WHERE id=?",
      ).run(
        result.fingerprint,
        confirmed,
        company.last_success || confirmed,
        company.id,
      );
    }
    db.query(
      `UPDATE targets SET last_check=?,last_success=?,checks=checks+1,successes=successes+1,
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

export function recordFailure(company: Target, message: string) {
  const unsupported = /No observable|disallowed/.test(message);
  const delay = unsupported
    ? 86400
    : Math.min(3600, 300 * 2 ** Math.min(company.failures, 4));
  db.query(
    `UPDATE targets SET last_check=?,checks=checks+1,failures=failures+1,
    status=?,error=?,candidate=NULL,candidate_at=NULL,previous_success=NULL,next_check=? WHERE id=?`,
  ).run(
    now(),
    unsupported ? "unsupported" : "error",
    message.slice(0, 240),
    now() + delay,
    company.id,
  );
}
