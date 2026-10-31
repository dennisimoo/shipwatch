import { db, now } from "./db";
import { assetIdentity, deploymentId, extractScripts, hash } from "./detect";
import { BackoffError, checkBackoff, fetchPublic } from "./network";

/**
 * Recovers builds from Wayback Machine copies of a monitored page, before Shipwatch started watching.
 * Each archived copy contributes its Vercel deployment ID, Next.js buildId, or (otherwise) the set of
 * hashed first-party script filenames. Archive copies are sparse, so the result is a lower bound and is
 * stored apart from releases and rankings.
 */

const archive = "https://web.archive.org";
const gap = 1500;

export interface ArchivedBuild { build: string; first: number; last: number }

export function archivedBuild(html: string, scripts: string[]): string | null {
  const build = html.match(/"buildId"\s*:\s*"([^"<>]{1,200})"/)?.[1] || null;
  const deployment = deploymentId(html, build);
  if (deployment) return deployment;
  const hashed = scripts
    .map((script) => script.replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z]{2}_)?\//, ""))
    .filter((script) => assetIdentity(script) !== script.split("#")[0])
    .sort();
  return hashed.length ? "assets:" + hash(JSON.stringify(hashed)).slice(0, 16) : null;
}

/** Keeps every digest change when within budget; otherwise one copy per day, evenly thinned. */
export function chooseCaptures(captures: [string, string][], limit: number): string[] {
  let timestamps = captures.map(([timestamp]) => timestamp);
  if (timestamps.length > limit)
    timestamps = [...new Map(timestamps.map((timestamp) => [timestamp.slice(0, 8), timestamp])).values()];
  if (timestamps.length > limit)
    timestamps = Array.from({ length: limit }, (_unused, index) =>
      timestamps[Math.round((index * (timestamps.length - 1)) / Math.max(1, limit - 1))]);
  return [...new Set(timestamps)];
}

const seconds = (timestamp: string) => Date.UTC(
  Number(timestamp.slice(0, 4)), Number(timestamp.slice(4, 6)) - 1, Number(timestamp.slice(6, 8)),
  Number(timestamp.slice(8, 10)), Number(timestamp.slice(10, 12)), Number(timestamp.slice(12, 14)),
) / 1000;

async function archiveFetch(url: string, limit = 3_000_000) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchPublic(url, {}, limit);
      checkBackoff(response);
      if (response.status === 503 && attempt === 0) throw new BackoffError("Archive unavailable", 60);
      return response;
    } catch (error) {
      if (attempt === 0 && error instanceof BackoffError) {
        await Bun.sleep(Math.min(error.seconds, 120) * 1000);
        continue;
      }
      throw error;
    } finally {
      await Bun.sleep(gap);
    }
  }
}

export async function backfillTarget(url: string, since: string, limit: number): Promise<{ builds: ArchivedBuild[]; copies: number; inspected: number }> {
  const target = new URL(url);
  const query = new URL(archive + "/cdx/search/cdx");
  query.search = new URLSearchParams({
    url: target.host + target.pathname, from: since, output: "json",
    fl: "timestamp,digest", filter: "statuscode:200", collapse: "digest", limit: "2000",
  }).toString();
  const listing = await archiveFetch(query.href);
  if (listing.status !== 200) throw new Error(`Archive index returned HTTP ${listing.status}`);
  const rows = (listing.body.trim() ? JSON.parse(listing.body) : []) as string[][];
  const captures = rows.slice(1).filter((row) => /^\d{14}$/.test(row[0])) as [string, string][];
  const builds = new Map<string, ArchivedBuild>();
  const chosen = chooseCaptures(captures, limit);
  for (const timestamp of chosen) {
    const page = await archiveFetch(`${archive}/web/${timestamp}id_/${target.href}`);
    if (page.status !== 200) continue;
    const build = archivedBuild(page.body, await extractScripts(page.body, target.href));
    if (!build) continue;
    const at = seconds(timestamp);
    const entry = builds.get(build) ?? { build, first: at, last: at };
    entry.first = Math.min(entry.first, at);
    entry.last = Math.max(entry.last, at);
    builds.set(build, entry);
  }
  return { builds: [...builds.values()].sort((left, right) => left.first - right.first), copies: captures.length, inspected: chosen.length };
}

export function saveArchivedBuilds(companyId: string, url: string, builds: ArchivedBuild[]) {
  const upsert = db.query(`INSERT INTO archived_builds(company_id,url,build,first_archived,last_archived,recorded_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(company_id,url,build) DO UPDATE SET
    first_archived=MIN(first_archived,excluded.first_archived),last_archived=MAX(last_archived,excluded.last_archived)`);
  db.transaction(() => {
    for (const build of builds) upsert.run(companyId, url, build.build, build.first, build.last, now());
  })();
}

if (import.meta.main) {
  const option = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];
  const apply = process.argv.includes("--apply");
  const company = option("company");
  const since = option("since") ?? new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const limit = Math.min(200, Math.max(1, Number(option("max") ?? 40)));
  if (!company && !process.argv.includes("--all")) {
    console.error("Usage: bun run backfill:wayback --company=<slug>|--all [--since=YYYYMMDD] [--max=40] [--apply]");
    process.exit(1);
  }
  const targets = db.query(`SELECT t.company_id,t.url,c.slug FROM targets t JOIN companies c ON c.id=t.company_id
    WHERE t.enabled=1 AND c.enabled=1 AND (? IS NULL OR c.slug=?) ORDER BY c.slug,t.url`).all(company ?? null, company ?? null) as
    { company_id: string; url: string; slug: string }[];
  for (const target of targets) {
    try {
      const result = await backfillTarget(target.url, since, limit);
      if (apply) saveArchivedBuilds(target.company_id, target.url, result.builds);
      console.log(JSON.stringify({ company: target.slug, url: target.url, archivedCopies: result.copies,
        inspected: result.inspected, builds: result.builds.length, applied: apply,
        first: result.builds[0] ? new Date(result.builds[0].first * 1000).toISOString() : null }));
    } catch (error) {
      console.log(JSON.stringify({ company: target.slug, url: target.url, error: error instanceof Error ? error.message : String(error) }));
      if (error instanceof BackoffError) break;
    }
  }
}
