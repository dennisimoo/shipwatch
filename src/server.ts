import { db, now } from "./db";
import { startPolling } from "./poller";
import { importYC } from "./import-yc";
import { normalizeUrl } from "./network";
import { hash } from "./detect";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import OpenAI from "openai";
import {
  applyTargets,
  discover,
  draftReview,
  optionsFrom,
  publicReview,
  selectedUrls,
  startDiscovery,
  type Review,
} from "./discovery";

const publicDirectory = new URL("../public/", import.meta.url);
const cache = new Map<string, { at: number; value: unknown }>();
const submissions = new RateLimiterMemory({ points: 1, duration: 60 });
const reads = new RateLimiterMemory({ points: 120, duration: 60 });
let submitting = 0;

function leaderboard(url: URL) {
  const days = url.searchParams.get("days") === "7" ? 7 : 30;
  const since = now() - days * 86400;
  const search = (url.searchParams.get("search") || "").slice(0, 100);
  const batch = (url.searchParams.get("batch") || "").slice(0, 60);
  const sort = url.searchParams.get("sort") || "releases";
  const page = Math.min(
    10000,
    Math.max(0, Number(url.searchParams.get("page")) || 0),
  );
  const order =
    sort === "weekend"
      ? "weekend DESC, releases DESC"
      : sort === "recent"
        ? "last_release DESC"
        : "releases DESC, last_release DESC";
  const condition =
    "WHERE c.enabled=1 AND (?='' OR c.name LIKE ? ESCAPE '\\' OR c.url LIKE ? ESCAPE '\\') AND (?='' OR c.batch=?)";
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const parameters = [search, pattern, pattern, batch, batch];
  const companies = db
    .query(
      `SELECT c.id,c.name,c.url,c.batch,c.description,c.source,c.yc_url,c.status,c.error,
    c.created_at,c.baseline_at,c.last_check,c.last_success,c.checks,c.successes,
    COUNT(r.id) AS releases,MAX(r.detected_at) AS last_release,
    SUM(CASE WHEN strftime('%w',r.detected_at,'unixepoch') IN ('0','6') THEN 1 ELSE 0 END) AS weekend,
    COUNT(DISTINCT strftime('%Y-%m-%d',r.detected_at,'unixepoch')) AS active_days
    FROM company_summary c LEFT JOIN releases r ON r.company_id=c.id AND r.detected_at>=?
    ${condition} GROUP BY c.id ORDER BY ${order},c.name COLLATE NOCASE LIMIT 50 OFFSET ?`,
    )
    .all(since, ...parameters, page * 50);
  const total = db
    .query(`SELECT COUNT(*) AS total FROM company_summary c ${condition}`)
    .get(...parameters);
  return { companies, ...(total as object), page, days, timezone: "UTC" };
}

function summary() {
  const counts = db
    .query(
      `SELECT COUNT(*) AS companies,SUM(enabled) AS enabled,
    SUM(CASE WHEN enabled=1 AND baseline_at IS NOT NULL THEN 1 ELSE 0 END) AS baselined,
    SUM(CASE WHEN enabled=1 AND last_success>=? THEN 1 ELSE 0 END) AS fresh,
    SUM(CASE WHEN enabled=1 AND status='error' THEN 1 ELSE 0 END) AS errors,
    SUM(CASE WHEN enabled=1 AND status='unsupported' THEN 1 ELSE 0 END) AS unsupported,
    MIN(baseline_at) AS started_at FROM company_summary`,
    )
    .get(now() - 900) as Record<string, number>;
  const releases = db
    .query(
      `SELECT COUNT(*) AS releases,
    SUM(CASE WHEN strftime('%w',detected_at,'unixepoch') IN ('0','6') THEN 1 ELSE 0 END) AS weekend
    FROM releases WHERE detected_at>=?`,
    )
    .get(now() - 30 * 86400);
  const heatmap = db
    .query(
      `SELECT CAST(strftime('%w',detected_at,'unixepoch') AS INTEGER) AS day,
    CAST(strftime('%H',detected_at,'unixepoch') AS INTEGER) AS hour,COUNT(*) AS count
    FROM releases WHERE detected_at>=? GROUP BY day,hour`,
    )
    .all(now() - 30 * 86400);
  const activity = db
    .query(
      `SELECT r.id,r.company_id,r.detected_at,r.previous_at,c.name,c.batch
    FROM releases r JOIN companies c ON c.id=r.company_id ORDER BY r.detected_at DESC LIMIT 12`,
    )
    .all();
  const batches = db
    .query(
      "SELECT batch,COUNT(*) AS count FROM companies WHERE enabled=1 AND batch<>'' GROUP BY batch ORDER BY batch DESC",
    )
    .all();
  const bytes = db
    .query(
      "SELECT COALESCE(SUM(bytes),0) AS bytes FROM daily_checks WHERE day>=date('now','-30 days')",
    )
    .get();
  const targets = db
    .query(
      "SELECT COUNT(*) AS targets FROM targets t JOIN companies c ON c.id=t.company_id WHERE t.enabled=1 AND c.enabled=1",
    )
    .get() as { targets: number };
  return {
    ...counts,
    ...(releases as object),
    ...(bytes as object),
    ...targets,
    heatmap,
    activity,
    batches,
    timezone: "UTC",
    interval_seconds: 300,
  };
}

function cached(key: string, build: () => unknown) {
  const previous = cache.get(key);
  if (previous && now() - previous.at < 15) return previous.value;
  const value = build();
  if (cache.size > 100) cache.clear();
  cache.set(key, { at: now(), value });
  return value;
}

const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  maxRequestBodySize: 32768,
  idleTimeout: 180,
  async fetch(request, server) {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200) =>
      Response.json(value, {
        status,
        headers: {
          "Cache-Control": status === 200 ? "public, max-age=15" : "no-store",
        },
      });
    try {
      const directIp = server.requestIP(request)?.address || "unknown";
      const forwardedIp =
        process.env.TRUST_PROXY === "1"
          ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          : null;
      const client = forwardedIp || directIp;
      if (request.method === "GET" && url.pathname.startsWith("/api/"))
        await reads.consume(client);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: db.query("SELECT 1").get() !== null,
          bun: Bun.version,
          sqlite: db.query("SELECT sqlite_version() AS version").get(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/summary")
        return json(cached("summary", summary));
      if (request.method === "GET" && url.pathname === "/api/discovery-options")
        return json({
          available: Boolean(process.env.OPENAI_API_KEY),
        });
      if (request.method === "GET" && url.pathname === "/api/companies")
        return json(cached(url.href, () => leaderboard(url)));
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/company/")
      ) {
        const id = decodeURIComponent(
          url.pathname.slice("/api/company/".length),
        );
        const company = db
          .query(
            `SELECT id,name,url,batch,description,yc_url,status,error,baseline_at,last_check,last_success,checks,successes FROM company_summary WHERE id=?`,
          )
          .get(id);
        if (!company) return json({ error: "Company not found" }, 404);
        const releases = db
          .query(
            "SELECT id,detected_at,previous_at,confirmed_at,evidence,url FROM releases WHERE company_id=? ORDER BY detected_at DESC LIMIT 100",
          )
          .all(id);
        const coverage = db
          .query(
            "SELECT day,checks,successes FROM daily_checks WHERE company_id=? AND day>=date('now','-30 days') ORDER BY day",
          )
          .all(id);
        const targets = db
          .query(
            "SELECT id,url,status,error,baseline_at,last_success,checks,successes FROM targets WHERE company_id=? AND enabled=1 ORDER BY url",
          )
          .all(id);
        const discovery = db
          .query(
            "SELECT status,domain_limit,candidate_limit,error,review,updated_at FROM discovery_jobs WHERE company_id=?",
          )
          .get(id);
        return json({ company, releases, coverage, targets, discovery });
      }
      if (
        request.method === "POST" &&
        ["/api/companies", "/api/discover"].includes(url.pathname)
      ) {
        const proxyScheme = request.headers.get("x-forwarded-proto");
        const expectedOrigin =
          process.env.TRUST_PROXY === "1" &&
          ["http", "https"].includes(proxyScheme || "")
            ? `${proxyScheme}://${request.headers.get("host")}`
            : url.origin;
        if (request.headers.get("origin") !== expectedOrigin)
          return json({ error: "Submit from the website." }, 403);
        if (submitting >= 3)
          return json(
            { error: "Please wait a minute before submitting another site." },
            429,
          );
        const daily = db
          .query(
            "SELECT COUNT(*) AS count FROM companies WHERE source='community' AND created_at>=?",
          )
          .get(now() - 86400) as { count: number };
        if (daily.count >= 100)
          return json(
            { error: "Today's community submission limit has been reached." },
            429,
          );
        if (url.pathname === "/api/companies") {
          const input = (await request.json()) as {
            token?: unknown;
            selected?: unknown;
          };
          if (typeof input.token !== "string")
            return json(
              { error: "Discover URLs before starting monitoring." },
              400,
            );
          const draft = db
            .query(
              "SELECT payload FROM discovery_drafts WHERE token=? AND expires_at>?",
            )
            .get(input.token, now()) as { payload: string } | null;
          if (!draft)
            return json(
              { error: "This review expired. Discover the website again." },
              400,
            );
          const review = JSON.parse(draft.payload) as Review;
          const urls = selectedUrls(review, input.selected);
          const existing = db
            .query("SELECT id FROM companies WHERE url=?")
            .get(review.url);
          if (existing) return json({ company: existing, existing: true });
          const id = `site-${hash(review.url).slice(0, 16)}`;
          db.transaction(() => {
            const count = db
              .query(
                "SELECT COUNT(*) AS count FROM companies WHERE source='community' AND created_at>=?",
              )
              .get(now() - 86400) as { count: number };
            if (count.count >= 100)
              throw new Error("Today's submission limit has been reached.");
            db.query(
              "INSERT INTO companies(id,name,url,created_at) VALUES (?,?,?,?)",
            ).run(id, review.name, review.url, now());
            applyTargets(id, urls);
            db.query(
              "INSERT INTO discovery_jobs(company_id,status,domain_limit,candidate_limit,review,updated_at) VALUES (?,'ready',?,?,?,?)",
            ).run(
              id,
              review.options.domainLimit,
              review.options.candidateLimit,
              JSON.stringify(publicReview(review)),
              now(),
            );
            db.query("DELETE FROM discovery_drafts WHERE token=?").run(
              input.token as string,
            );
          })();
          cache.clear();
          return json(
            { company: { id, name: review.name }, existing: false },
            201,
          );
        }
        await submissions.consume(client);
        submitting++;
        try {
          const input = (await request.json()) as {
            url?: string;
            name?: string;
            domainLimit?: unknown;
            candidateLimit?: unknown;
          };
          if (typeof input.url !== "string" || input.url.length > 1500)
            return json({ error: "Enter a website URL." }, 400);
          if (
            input.domainLimit !== undefined ||
            input.candidateLimit !== undefined
          )
            return json(
              { error: "Discovery limits are managed by the server." },
              400,
            );
          const target = normalizeUrl(input.url);
          const existing = db
            .query("SELECT id FROM companies WHERE url=?")
            .get(target.href);
          if (existing) return json({ company: existing, existing: true });
          const name =
            typeof input.name === "string" && input.name.trim()
              ? input.name.trim().slice(0, 100)
              : target.hostname.replace(/^www\./, "");
          const review = await discover(name, target.href, optionsFrom({}));
          const response = json({
            token: draftReview(review),
            review: publicReview(review),
          });
          response.headers.set("Cache-Control", "no-store");
          return response;
        } finally {
          submitting--;
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({ error: "Method not allowed" }, 405);
      const assets: Record<string, string> = {
        "/": "index.html",
        "/app.js": "app.js",
        "/styles.css": "styles.css",
        "/favicon.svg": "favicon.svg",
        "/source-serif-4.woff2": "source-serif-4.woff2",
      };
      const asset = assets[url.pathname];
      if (!asset) return json({ error: "Not found" }, 404);
      return new Response(Bun.file(new URL(asset, publicDirectory)), {
        headers: {
          "Cache-Control": "public, max-age=60",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "Content-Security-Policy":
            "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError)
        return json(
          {
            error: `Luna discovery failed (HTTP ${error.status || "unknown"}). Please try again later.`,
          },
          502,
        );
      if (error instanceof RateLimiterRes) {
        const response = json(
          { error: "Too many requests. Please try again shortly." },
          429,
        );
        response.headers.set(
          "Retry-After",
          String(Math.ceil(error.msBeforeNext / 1000)),
        );
        return response;
      }
      console.error(error);
      return json(
        {
          error:
            "The request could not be completed. Check the URL and try again.",
        },
        400,
      );
    }
  },
});

console.log(`Shipwatch listening on http://${server.hostname}:${server.port}`);
if (process.env.POLL_ENABLED !== "0") {
  if (
    !(
      db.query("SELECT COUNT(*) AS count FROM companies").get() as {
        count: number;
      }
    ).count
  )
    await importYC();
  startPolling();
  startDiscovery();
}
