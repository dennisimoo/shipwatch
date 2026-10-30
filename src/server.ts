import { db, now, ensureCompanySlug } from "./db";
import { encodeHTML } from "entities";
import {
  releaseHistory,
  type ObservationDay,
  type ReleaseDay,
} from "./history";
import { startPolling } from "./poller";
import { importYC } from "./import-yc";
import { normalizeUrl } from "./network";
import { hash } from "./detect";
import { backendMap } from "./backend-map";
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
      `SELECT c.id,c.slug,c.name,c.url,c.batch,c.description,c.source,c.yc_url,c.status,c.error,
    c.created_at,c.content_baseline_at AS baseline_at,c.last_check,c.last_success,c.checks,c.successes,c.target_count,
    COUNT(r.id) AS releases,MAX(r.detected_at) AS last_release,
    SUM(CASE WHEN strftime('%w',r.detected_at,'unixepoch') IN ('0','6') THEN 1 ELSE 0 END) AS weekend,
    COUNT(DISTINCT strftime('%Y-%m-%d',r.detected_at,'unixepoch')) AS active_days
    FROM company_summary c LEFT JOIN application_releases r ON r.company_id=c.id AND r.detected_at>=?
    ${condition} GROUP BY c.id ORDER BY ${order},c.name COLLATE NOCASE LIMIT 50 OFFSET ?`,
    )
    .all(since, ...parameters, page * 50);
  const total = db
    .query(`SELECT COUNT(*) AS total FROM companies c ${condition}`)
    .get(...parameters);
  return {
    companies,
    ...(total as object),
    page,
    days,
    timezone: "UTC",
    preview: process.env.POLL_ENABLED === "0",
  };
}

function summary() {
  const counts = db
    .query(
      `SELECT COUNT(*) AS companies,SUM(enabled) AS enabled,
    SUM(CASE WHEN enabled=1 AND content_baseline_at IS NOT NULL THEN 1 ELSE 0 END) AS baselined,
    SUM(CASE WHEN enabled=1 AND last_success>=? THEN 1 ELSE 0 END) AS fresh,
    SUM(CASE WHEN enabled=1 AND status='error' THEN 1 ELSE 0 END) AS errors,
    SUM(CASE WHEN enabled=1 AND status='unsupported' THEN 1 ELSE 0 END) AS unsupported,
    MIN(content_baseline_at) AS started_at FROM company_summary`,
    )
    .get(now() - 900) as Record<string, number>;
  const releases = db
    .query(
      `SELECT COUNT(*) AS releases,
    SUM(CASE WHEN strftime('%w',detected_at,'unixepoch') IN ('0','6') THEN 1 ELSE 0 END) AS weekend
    FROM application_releases WHERE detected_at>=?`,
    )
    .get(now() - 30 * 86400);
  const heatmap = db
    .query(
      `SELECT CAST(strftime('%w',detected_at,'unixepoch') AS INTEGER) AS day,
    CAST(strftime('%H',detected_at,'unixepoch') AS INTEGER) AS hour,COUNT(*) AS count
    FROM application_releases WHERE detected_at>=? GROUP BY day,hour`,
    )
    .all(now() - 30 * 86400);
  const activity = db
    .query(
      `SELECT r.id,r.company_id,r.detected_at,r.previous_at,c.name,c.slug,c.batch
    FROM application_releases r JOIN companies c ON c.id=r.company_id ORDER BY r.detected_at DESC LIMIT 12`,
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
    preview: process.env.POLL_ENABLED === "0",
    observed_at: (
      db.query("SELECT MAX(last_check) AS at FROM targets").get() as {
        at: number | null;
      }
    ).at,
    monitoring: db
      .query(
        `SELECT state,COUNT(*) AS count FROM (SELECT CASE WHEN status IN (\'error\',\'unsupported\',\'queued\') THEN status WHEN last_success>=? THEN \'watching\' ELSE \'stale\' END AS state FROM company_summary WHERE enabled=1) GROUP BY state`,
      )
      .all(now() - 900),
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
      const backendRoute = /^\/api\/company\/([a-zA-Z0-9-]+)\/backend$/.exec(url.pathname);
      if (request.method === "GET" && backendRoute) {
        const company = db.query("SELECT id FROM companies WHERE slug=?").get(backendRoute[1]) as { id: string } | null;
        if (!company) return json({ error: "Website not found" }, 404);
        const map = await backendMap(company.id);
        return map ? json(map) : json({ error: "No captured code yet." }, 404);
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/company/")
      ) {
        const identifier = decodeURIComponent(
          url.pathname.slice("/api/company/".length),
        );
        const company = db
          .query(
            `SELECT id,slug,name,url,batch,description,yc_url,status,error,
            (SELECT COUNT(*) FROM releases r WHERE r.company_id=c.id AND r.fingerprint NOT LIKE 'content-v3:%') AS legacy_releases,
            (SELECT MIN(t.content_baseline_at) FROM targets t WHERE t.company_id=c.id) AS baseline_at,
            last_check,last_success,checks,successes FROM company_summary c WHERE slug=?`,
          )
          .get(identifier);
        if (!company) return json({ error: "Website not found" }, 404);
        const id = (company as { id: string }).id;
        const releases = db
          .query(
            `SELECT r.id,r.detected_at,r.previous_at,r.confirmed_at,r.evidence,r.url,a.classification,a.summary,a.kind
              FROM application_releases r JOIN change_analysis a ON a.release_id=r.id
              WHERE r.company_id=? ORDER BY r.detected_at DESC LIMIT 100`,
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
        const baseline = (company as { baseline_at: number | null })
          .baseline_at;
        const dailyReleases = db
          .query(
            "SELECT strftime('%Y-%m-%d',detected_at,'unixepoch') AS day,COUNT(*) AS releases FROM application_releases WHERE company_id=? AND detected_at>=? GROUP BY day",
          )
          .all(
            id,
            Math.floor(now() / 86400) * 86400 - 29 * 86400,
          ) as ReleaseDay[];
        const history = releaseHistory(
          baseline,
          coverage as ObservationDay[],
          dailyReleases,
          now(),
        );
        const deploys = db.query(`SELECT COUNT(*) AS count,MAX(first_seen) AS latest,
            (SELECT COUNT(*) FROM deploys WHERE company_id=?) AS tracked
            FROM deploys WHERE company_id=? AND baseline=0 AND first_seen>=?`).get(id, id, now() - 30 * 86400);
        return json({
          company,
          deploys,
          releases,
          coverage,
          targets,
          discovery,
          history,
          events: db
            .query(
              "SELECT detected_at FROM application_releases WHERE company_id=? AND detected_at>=? ORDER BY detected_at",
            )
            .all(id, now() - 32 * 86400),
          observed_at: now(),
          preview: process.env.POLL_ENABLED === "0",
        });
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
            .query("SELECT id,slug FROM companies WHERE url=?")
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
          const slug = ensureCompanySlug(id, review.name);
          cache.clear();
          return json(
            { company: { id, slug, name: review.name }, existing: false },
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
            .query("SELECT id,slug FROM companies WHERE url=?")
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
        "/chart.js": "chart.js",
        "/chart-data.js": "chart-data.js",
        "/backend.js": "backend.js",
        "/uplot.js": "../node_modules/uplot/dist/uPlot.esm.js",
        "/uplot.css": "../node_modules/uplot/dist/uPlot.min.css",
        "/styles.css": "styles.css",
        "/favicon.svg": "favicon.svg",
        "/source-serif-4.woff2": "source-serif-4.woff2",
        "/chakra-petch-500.woff2": "chakra-petch-500.woff2",
      };
      const methodPage = url.pathname === "/how-it-works";
      if (url.pathname === "/index")
        return Response.redirect(new URL("/#leaderboard", url), 302);
      const companyPage = /^\/company\/[a-zA-Z0-9-]+$/.test(url.pathname);
      const pageCompany = companyPage
        ? (db
            .query("SELECT name,slug FROM companies WHERE slug=?")
            .get(url.pathname.slice(9)) as {
            name: string;
            slug: string;
          } | null)
        : null;
      if (companyPage && !pageCompany)
        return json({ error: "Website not found" }, 404);
      const asset =
        companyPage || methodPage
          ? "index.html"
          : assets[url.pathname];
      if (!asset) return json({ error: "Not found" }, 404);
      return new Response(
        companyPage || methodPage
          ? (await Bun.file(new URL(asset, publicDirectory)).text())
              .replace(
                "<body>",
                `<body data-view="${methodPage ? "method" : "company"}">`,
              )
              .replace(
                /<title>[^<]*<\/title>/,
                () =>
                  `<title>${methodPage ? "How it works" : encodeHTML(pageCompany!.name)} — Shipwatch</title><meta property="og:title" content="${methodPage ? "How it works" : encodeHTML(pageCompany!.name)} — Shipwatch" />`,
              )
          : Bun.file(new URL(asset, publicDirectory)),
        {
          headers: {
            "Cache-Control": "public, max-age=60",
            ...(companyPage || methodPage
              ? { "Content-Type": "text/html; charset=utf-8" }
              : {}),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' https://www.google.com https://t0.gstatic.com https://t1.gstatic.com https://t2.gstatic.com https://t3.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          },
        },
      );
    } catch (error) {
      if (error instanceof OpenAI.APIError)
        return json(
          {
            error: `Website review failed (HTTP ${error.status || "unknown"}). Please try again later.`,
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
