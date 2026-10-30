import { db } from "./db";
import { inspectBundles, type Asset } from "./detect";
import { saveBody, analyzeNext } from "./analysis";
import pLimit from "p-limit";

interface LegacyRelease {
  id: number;
  company_id: string;
  url: string;
  detected_at: number;
  confirmed_at: number;
  evidence: string;
}

export async function recheckHistory(apply: boolean, companyId: string | null = null, analyze = false) {
  const companies = db.query(`SELECT DISTINCT c.id,c.name FROM companies c
    JOIN releases r ON r.company_id=c.id
    WHERE c.enabled=1 AND (? OR r.fingerprint NOT LIKE 'content-v3:%')
      AND (? IS NULL OR c.id=?) ORDER BY c.name`).all(analyze ? 1 : 0, companyId, companyId) as { id: string; name: string }[];
  const limit = pLimit(2);
  const reports = await Promise.all(companies.map((company) => limit(async () => {
    const releases = db.query(`SELECT id,company_id,url,detected_at,confirmed_at,evidence
      FROM releases WHERE company_id=? AND (? OR fingerprint NOT LIKE 'content-v3:%')
      ORDER BY url,detected_at,id`).all(company.id, analyze ? 1 : 0) as LegacyRelease[];
    let previous: { url: string; fingerprint: string; at: number } | undefined;
    let assets: Record<string, Asset> = {};
    const report = { company: company.name, records: releases.length, verified: 0, updates: 0, unavailable: 0, errors: [] as string[] };
    for (const release of releases) {
      try {
        const saved = JSON.parse(release.evidence) as { scripts: string[]; content: { url: string; hash: string }[] };
        if (!saved.content?.length) throw new Error("No recorded content hashes to verify");
        if (previous?.url !== release.url) assets = {};
        const deployments = new Map<string, Set<string>>();
        for (const address of saved.scripts) {
          const target = new URL(address);
          const deployment = target.searchParams.get("dpl");
          if (deployment) {
            if (!deployments.has(target.origin)) deployments.set(target.origin, new Set());
            deployments.get(target.origin)!.add(deployment);
          }
        }
        const pinned = (address: string) => {
          const target = new URL(address);
          const versions = deployments.get(target.origin);
          if (target.searchParams.has("dpl") || versions?.size !== 1) return address;
          target.searchParams.set("dpl", [...versions][0]);
          return target.href;
        };
        const snapshot = await inspectBundles(release.url, saved.scripts.map(pinned), assets, 0, null,
          apply && analyze ? saveBody : undefined);
        if (saved.content.some((entry) => snapshot.assets[pinned(entry.url)]?.hash !== entry.hash))
          throw new Error("Historical asset no longer matches its recorded hash");
        assets = snapshot.assets;
        report.verified++;
        const comparable = previous?.url === release.url;
        const changed = comparable && previous?.fingerprint !== snapshot.fingerprint;
        if (changed) report.updates++;
        if (apply) db.transaction(() => {
          if (analyze) {
            db.query("INSERT OR IGNORE INTO bundle_versions VALUES (?,?)").run(snapshot.fingerprint, snapshot.evidence);
            if (comparable && changed)
              db.query(`INSERT OR IGNORE INTO change_analysis(release_id,before_fingerprint)
                SELECT id,? FROM releases WHERE company_id=? AND fingerprint=?`)
                .run(previous!.fingerprint, company.id, snapshot.fingerprint);
          }
          if (!comparable && !analyze)
            db.query(`UPDATE targets SET content_baseline_at=MIN(COALESCE(content_baseline_at,?),?)
              WHERE company_id=? AND url=?`).run(release.detected_at, release.detected_at, company.id, release.url);
          const seen = db.query("SELECT 1 FROM seen_versions WHERE company_id=? AND fingerprint=? AND first_seen<=?")
            .get(company.id, snapshot.fingerprint, release.detected_at);
          if (changed && !seen && !analyze) {
            const interval = Math.floor(release.detected_at / 300) * 300;
            db.query(`INSERT OR IGNORE INTO releases(company_id,fingerprint,detected_at,previous_at,confirmed_at,evidence,url)
              SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (
                SELECT 1 FROM bundle_releases WHERE company_id=? AND detected_at>=? AND detected_at<?
              )`).run(company.id, snapshot.fingerprint, release.detected_at, previous!.at, release.confirmed_at,
                JSON.stringify({ ...JSON.parse(snapshot.evidence), rechecked_from: release.id }), release.url,
                company.id, interval, interval + 300);
          }
          if (!analyze)
            db.query(`INSERT INTO seen_versions VALUES(?,?,?) ON CONFLICT(company_id,fingerprint)
              DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen)`).run(company.id, snapshot.fingerprint, release.detected_at);
        }).immediate();
        previous = { url: release.url, fingerprint: snapshot.fingerprint, at: release.detected_at };
      } catch (error) {
        previous = undefined;
        assets = {};
        report.unavailable++;
        const message = error instanceof Error ? error.message : String(error);
        if (!report.errors.includes(message)) report.errors.push(message);
      }
    }
    console.log(JSON.stringify(report));
    return report;
  })));
  return reports;
}

if (import.meta.main) {
  const companyId = process.argv.find((argument) => argument.startsWith("--company="))?.slice(10) ?? null;
  const analyze = process.argv.includes("--analyze");
  const reports = await recheckHistory(process.argv.includes("--apply"), companyId, analyze);
  if (analyze && process.argv.includes("--apply")) {
    db.query(`INSERT OR IGNORE INTO change_analysis(release_id)
      SELECT id FROM bundle_releases WHERE (? IS NULL OR company_id=?)`).run(companyId, companyId);
    if (process.env.OPENAI_API_KEY) while (await analyzeNext()) {}
  }
  console.log(JSON.stringify({ apply: process.argv.includes("--apply"), companies: reports.length,
    records: reports.reduce((total, report) => total + report.records, 0),
    verified: reports.reduce((total, report) => total + report.verified, 0),
    updates: reports.reduce((total, report) => total + report.updates, 0),
    unavailable: reports.reduce((total, report) => total + report.unavailable, 0) }));
}
