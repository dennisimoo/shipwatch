import { db, now, recordSnapshot, recordFailure, type Target } from "./db";
import { snapshot } from "./detect";
import type { Asset } from "./detect";
import { fetchPublic, robotsAllowed } from "./network";
import { saveBody, analyzeNext } from "./analysis";

const inflight = new Set<string>();
const hostInflight = new Set<string>();
const concurrency = Number(process.env.POLL_CONCURRENCY || 24);

export async function checkCompany(company: Target) {
  const started = now();
  let bytes = 0;
  let success = 0;
  const robotsCache = new Map<string, string>();
  async function allowed(url: string) {
    const target = new URL(url);
    let robots = robotsCache.get(target.origin);
    if (robots === undefined) {
      const original = target.origin === new URL(company.url).origin;
      if (
        original &&
        company.robots !== null &&
        company.robots_at &&
        started - company.robots_at < 86400
      )
        robots = company.robots;
      else {
        const response = await fetchPublic(
          `${target.origin}/robots.txt`,
          {},
          128000,
        );
        if (response.status >= 500 || response.status === 429)
          throw new Error("Robots policy temporarily unavailable");
        robots =
          response.status >= 400
            ? response.status === 401 || response.status === 403
              ? "User-agent: *\nDisallow: /"
              : ""
            : response.body;
        if (original)
          db.query("UPDATE targets SET robots=?,robots_at=? WHERE id=?").run(
            robots,
            started,
            company.id,
          );
      }
      robotsCache.set(target.origin, robots);
    }
    return robotsAllowed(robots, target.pathname + target.search);
  }
  try {
    if (!(await allowed(company.url)))
      throw new Error("Monitoring disallowed by robots.txt");
    const previous = JSON.parse(company.assets) as Record<string, Asset>;
    for (const asset of Object.values(previous))
      if (!db.query("SELECT 1 FROM bundle_bodies WHERE hash=?").get(asset.hash)) {
        delete asset.etag;
        delete asset.modified;
      }
    const result = await snapshot(
      company.url,
      previous,
      allowed,
      saveBody,
    );
    bytes = result.bytes;
    recordSnapshot(company, result, now());
    success = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(company, message);
  }
  db.query(
    `INSERT INTO daily_checks (company_id,day,checks,successes,bytes) VALUES (?,?,1,?,?)
    ON CONFLICT(company_id,day) DO UPDATE SET checks=checks+1,successes=successes+excluded.successes,bytes=bytes+excluded.bytes`,
  ).run(
    company.company_id,
    new Date(started * 1000).toISOString().slice(0, 10),
    success,
    bytes,
  );
}

export function startPolling() {
  let analyzing = false;
  const tick = () => {
    if (!analyzing && process.env.OPENAI_API_KEY) {
      analyzing = true;
      void analyzeNext().catch((error) => console.error("analysis", error.message))
        .finally(() => { analyzing = false; });
    }
    if (inflight.size >= concurrency) return;
    const due = db
      .query<Target, [number]>(
        "SELECT t.* FROM targets t JOIN companies c ON c.id=t.company_id WHERE t.enabled=1 AND c.enabled=1 AND t.next_check<=? ORDER BY t.next_check LIMIT 150",
      )
      .all(now());
    for (const company of due) {
      if (inflight.size >= concurrency) break;
      const host = new URL(company.url).hostname;
      if (inflight.has(company.id) || hostInflight.has(host)) continue;
      inflight.add(company.id);
      hostInflight.add(host);
      void checkCompany(company)
        .catch((error) => console.error("poller", error))
        .finally(() => {
          inflight.delete(company.id);
          hostInflight.delete(host);
        });
    }
  };
  tick();
  return setInterval(tick, 1000);
}
