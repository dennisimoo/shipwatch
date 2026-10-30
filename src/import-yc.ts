import { db, now } from "./db";
import { normalizeUrl } from "./network";

interface YCCompany {
  id: number;
  name: string;
  website: string;
  batch: string;
  one_liner: string;
  url: string;
  status: string;
}

export async function importYC() {
  const response = await fetch(
    "https://yc-oss.github.io/api/companies/all.json",
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error(`YC import HTTP ${response.status}`);
  const companies = (await response.json()) as YCCompany[];
  if (!Array.isArray(companies) || companies.length < 100)
    throw new Error("Invalid YC directory response");
  return syncDirectory(companies, process.env.MONITOR_YEAR || "2026");
}

export function syncDirectory(companies: YCCompany[], year: string) {
  const selected = companies
    .filter(
      (company) =>
        company.website &&
        company.id &&
        company.name &&
        ["Active", "Public"].includes(company.status) &&
        company.batch?.endsWith(` ${year}`),
    )
    .flatMap((company) => {
      try {
        return [{ ...company, website: normalizeUrl(company.website).href }];
      } catch {
        return [];
      }
    });
  if (!selected.length)
    throw new Error(
      `No eligible YC companies for ${year}; existing data preserved.`,
    );
  const ids = selected.map((company) => `yc-${company.id}`);
  const removed = `SELECT id FROM companies WHERE source='yc' AND id NOT IN (${ids.map(() => "?").join(",")})`;
  const insert =
    db.query(`INSERT INTO companies (id,name,url,batch,description,yc_url,source,enabled,created_at)
    VALUES (?,?,?,?,?,?,'yc',?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,url=excluded.url,batch=excluded.batch,description=excluded.description,
    yc_url=excluded.yc_url,enabled=excluded.enabled`);
  db.transaction(() => {
    for (const company of selected) {
      insert.run(
        `yc-${company.id}`,
        company.name,
        company.website,
        company.batch || "",
        company.one_liner || "",
        company.url || "",
        1,
        now(),
      );
      db.query(
        "INSERT INTO targets(id,company_id,url,next_check) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM targets WHERE company_id=?)",
      ).run(
        `yc-${company.id}`,
        `yc-${company.id}`,
        company.website,
        now() + Math.floor(Math.random() * 300),
        `yc-${company.id}`,
      );
    }
    for (const table of [
      "releases",
      "seen_versions",
      "daily_checks",
      "targets",
      "discovery_jobs",
    ]) {
      db.query(`DELETE FROM ${table} WHERE company_id IN (${removed})`).run(
        ...ids,
      );
    }
    db.query(`DELETE FROM companies WHERE id IN (${removed})`).run(...ids);
    db.query(
      "INSERT OR REPLACE INTO metadata VALUES ('yc_imported_at', ?)",
    ).run(String(now()));
  })();
  console.log(
    JSON.stringify({
      event: "yc_import",
      imported: selected.length,
      year,
      at: now(),
    }),
  );
  return selected.length;
}

if (import.meta.main) await importYC();
