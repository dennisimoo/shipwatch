import { db, now } from "./db";
import { normalizeUrl } from "./network";

export async function importYC() {
  const response = await fetch(
    "https://yc-oss.github.io/api/companies/all.json",
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error(`YC import HTTP ${response.status}`);
  const companies = (await response.json()) as {
    id: number;
    name: string;
    website: string;
    batch: string;
    one_liner: string;
    url: string;
    status: string;
  }[];
  if (!Array.isArray(companies) || companies.length < 100)
    throw new Error("Invalid YC directory response");
  const insert =
    db.query(`INSERT INTO companies (id,name,url,batch,description,yc_url,source,enabled,created_at,next_check)
    VALUES (?,?,?,?,?,?,'yc',?,?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,url=excluded.url,batch=excluded.batch,description=excluded.description,
    yc_url=excluded.yc_url,enabled=excluded.enabled`);
  let imported = 0;
  db.transaction(() => {
    for (const company of companies) {
      if (!company.website || !company.id || !company.name) continue;
      try {
        const url = normalizeUrl(company.website).href;
        const monitoringYear = process.env.MONITOR_YEAR || "2026";
        const enabled =
          ["Active", "Public"].includes(company.status) &&
          company.batch?.endsWith(` ${monitoringYear}`)
            ? 1
            : 0;
        insert.run(
          `yc-${company.id}`,
          company.name,
          url,
          company.batch || "",
          company.one_liner || "",
          company.url || "",
          enabled,
          now(),
          now() + Math.floor(Math.random() * 300),
        );
        imported++;
      } catch {}
    }
    db.query(
      "INSERT OR REPLACE INTO metadata VALUES ('yc_imported_at', ?)",
    ).run(String(now()));
  })();
  console.log(JSON.stringify({ event: "yc_import", imported, at: now() }));
  return imported;
}

if (import.meta.main) await importYC();
