<h1 align="center">SHIPWATCH</h1>

<p align="center"><strong>A closer look at who's shipping.</strong><br>A public pulse on frontend releases across the web.</p>

<p align="center">
  <a href="https://shipwatch.sh">Live site</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-counts-as-a-release">Methodology</a> ·
  <a href="https://github.com/dennisimoo/shipwatch/issues">Feedback</a>
</p>

<p align="center">
  <a href="https://github.com/dennisimoo/shipwatch/actions/workflows/check.yml"><img src="https://github.com/dennisimoo/shipwatch/actions/workflows/check.yml/badge.svg" alt="Tests and typecheck"></a>
</p>

## The idea

Watch public JavaScript bundles every five minutes and see which websites change, how often, and when.

- **Who's shipping:** 7- and 30-day leaderboards, website search, and cohort filters.
- **Browse the index:** rankings live on the homepage; filters use native selects and recent activity sits beside the table.
- **When they ship:** interactive per-website release graphs and hourly/daily views in your local time.
- **Share a website:** readable `/company/:slug` pages with release history and a copy-link control.
- **Show the evidence:** each company has its baseline date, check history, and release fingerprints.
- **Bring a website:** discover subdomains, review Luna's suggestions, and check the URLs you want to monitor.

**Any public website can join.** The prefilled starter dataset is **797 active/public companies from YC's Winter, Spring, Summer, and Fall 2026 batches**. Older companies aren't kept in a separate directory. New sites start with a baseline; history fills in as the observer runs.

> A bundle change is a frontend release signal, not a commit count, backend deployment count, or measure of how hard a team works.

## Quick start

Install [Bun](https://bun.sh) **1.4.4 or newer**, then:

```sh
git clone https://github.com/dennisimoo/shipwatch.git
cd shipwatch
bun install
bun run import:yc
bun run dev
```

Open **http://localhost:3000**. SQLite is created in `data/shipwatch.sqlite`. No database server or cloud credentials needed.

```sh
bun test
bun run typecheck
```

AI discovery and change analysis need a server-side `OPENAI_API_KEY` with access to `gpt-6-luna`. Discovery uses the [Decisions API](https://developers.openai.com/api/docs/guides/decisions); classification and one-sentence change summaries share one structured Responses API call. Polling and read APIs work without a key, but unclassified observations do not enter application-change rankings. Credentials never go to the browser.

Install [Subfinder](https://docs.projectdiscovery.io/opensource/subfinder/install) and [jsluice](https://github.com/BishopFox/jsluice) on the server's `PATH` (`deploy/setup.sh` pins both). Subfinder aggregates passive providers, including certificate-transparency sources; an empty scan triggers a bounded direct crt.sh fallback. Results are cached per domain for a day; scanning is not repeated during five-minute monitoring checks. Jsluice analyzes saved JavaScript locally, without requesting the extracted endpoints.

Optionally install [urlfinder](https://github.com/projectdiscovery/urlfinder) on the server's `PATH` (`deploy/setup.sh` pins it). If the submitted page cannot be monitored, it suggests up to two recognizable same-origin app or documentation paths from public archives. Those paths share the existing inspection budget and public-network checks. Provider queries are limited to two per second and 15 seconds, and successful results are cached for a day. URL discovery never runs during polling; an unavailable tool leaves the existing discovery flow intact.

## Local preview

Run `HOST=127.0.0.1 PORT=3088 POLL_ENABLED=0 DATABASE_PATH=/path/to/local-copy.sqlite bun run dev` to browse a local database snapshot without background polling. The UI marks it as paused preview data. Submission accepts a bare domain such as `example.com`; a name is not required. Discovery still requires the server API key described above.

## Pick what gets watched

Enter a website URL (with or without `https://`), then check or uncheck the discovered URLs. At least one URL is required. **Visitors cannot change discovery or monitoring limits.** Both are owned by the server in `config.json`: review up to **12 candidate domains** and monitor at most **3 domains** per company by default. Operators edit that file and restart the app; there are no environment variables or public settings endpoints for these limits.

Discovery uses passive Subfinder results for subdomains. It can also inspect up to two recognizable same-origin app or documentation links from the submitted page. If that page is unobservable, urlfinder may suggest fallback paths. These checks share the existing inspection budget; visitors can select one URL per domain. When the inventory exceeds the inspection budget, Luna first shortlists hostnames for distinct production apps and API documentation rather than taking the first names alphabetically. This is only a shortlist, not evidence a host is live. The submitted website always retains one inspection slot. The public-suffix list keeps unrelated sites separate, including private suffixes such as `github.io`.

Each shortlisted host is inspected within the 12-host budget. For roots returning 404 or no observable first-party JavaScript, discovery also tries `/openapi.json` and `/swagger.json`. Only pages with observable first-party scripts or valid public API schemas qualify; ordinary JSON responses do not. Luna's Decisions API then asks one yes/no question per usable candidate: **is this a useful public website, application, or API schema to monitor?** Internal dashboards, operational tools, login screens, and public API definitions are eligible. Suggestions with a yes probability of at least 70% are prechecked up to the monitoring cap. You can check or uncheck any inspectable URL before confirming. Hostname shortlisting uses one structured Responses call only when needed; final page selection still uses Decisions.

Each selected URL gets its own baseline and polling state. Company release counts deduplicate identical fingerprints across its URLs. Profiles show the actual monitored URLs; release evidence retains the originating URL. Passive sources are incomplete and can contain stale names; only inspected public pages can be selected.

Readable company slugs are stored once and remain stable if a company name changes; duplicate names get a numeric suffix. Legacy YC-ID page URLs are not retained.

The existing YC cohort is reviewed with at most two background reviews at once and three concurrent page inspections across reviews. Subfinder requests are rate-limited and each scan has a 45-second deadline. Failed reviews retry after an hour. If Luna recommends no URLs or discovery fails, the existing selection stays monitored. Successful reviews are saved. Old reviews are not automatically overwritten; requeue them deliberately to refresh discovery.

## What counts as a release?

```text
Public page → script URLs + content fingerprints → confirm change → SQLite → leaderboard
```

1. **Establish a baseline.** The first successful observation never counts as a release.
2. **Watch first-party content.** Compare normalized content across up to 128 first-party assets and 20 MB per page, with a 5 MB per-asset limit, following JavaScript imports and Vite-listed styles. Ignore Vercel `dpl` parameters, known Sentry debug/release metadata, source-map comments, and asset-reference filename hashes. Conditional requests reuse unchanged content; raw URLs and hashes remain in the evidence. This is not a semantic JavaScript diff.
3. **Confirm it.** A new fingerprint must persist on a follow-up check, targeted for one minute later.
4. **Count it once.** Previously confirmed versions, including the initial baseline, don't count again after a rollback. Multiple confirmed changes in the same UTC-aligned five-minute interval count once per company, not once per changed file or monitored URL.

Confirmed observations are retained separately from **application changes**. Bundle bodies are gzip-compressed and deduplicated by raw SHA-256 in SQLite. Comparisons pair exact URLs first (ignoring deployment parameters), identical raw/normalized contents within the same directory, and stable named or numeric chunk identities. Anonymous renamed chunks require a distinct mutual content match; similar filenames or file sizes are not enough. Ambiguous leftovers remain marked incomplete rather than being guessed. Unchanged or deterministically metadata-only comparisons make no model call.

Bun formats captured code and `diff` produces context hunks within a 400,000-character diff budget. Oversized changed lines, including embedded translation tables, use finer word-level edits with exact character offsets and short context instead of copying entire tables. Both diff passes have a 100 ms/10,000-edit cutoff; an unfinished diff retains the exact changed region rather than silently dropping code. Small chunks are included before large ones, and omitted chunks explicitly mark the evidence incomplete. Acorn compares actual JavaScript chunk-loader definitions and referenced local maps: an unchanged loader or an unrelated `.u` property alone does not trigger a missing-code warning. This is static analysis, not execution or proof of complete lazy-route coverage.

Luna returns `classification` (`application`, `build-only`, or `uncertain`) and a short plain-English `summary` in one request, capped at 1,200 output tokens. Identical version-pair results are reused only within the current analysis version. Incomplete evidence cannot establish build-only. Missing bodies and exhausted API retries stay uncertain. Only `application` results enter rankings, charts, and public release logs. Other observations remain in SQLite, not in the public UI. These are AI interpretations of captured client code, not verified product changelogs.

**Do not restart history.** Run `bun run recheck:history --apply --analyze` to recover and analyze available historical versions (optionally `--company=<id>`). Saved raw hashes must match before recovered code is used. Unrecoverable observations remain unclassified or uncertain. Existing baselines, timestamps, and raw records are preserved. Uncaptured lazy chunks and unavailable historical baselines limit what can be explained.

Full downloaded bundles are retained, not just the snippets sent to Luna. Each distinct capture keeps its URLs, raw hashes, and first/last observation times, including metadata-only versions. Compression and content-addressed storage avoid duplicate bodies without discarding code. Capture is still bounded by the fetch budget; unvisited routes are not magically archived. Future summaries use short, nontechnical language and can describe API/client logic or shared code, but cannot prove an unseen backend deployment.

Sibling assets such as `app.example.com` loading `cdn.example.com` are included within the same registrable domain; unrelated tenants and domains are excluded. Jsluice extracts API request references from archived JavaScript once per raw hash. Before/after comparisons include first-party endpoint paths, methods, and parameter names, with query values and headers omitted. Each extraction has a ten-second deadline; the comparison has a bounded time budget and sends at most 100 added and 100 removed references to Luna. Failures are logged and passed to the model as incomplete coverage, not empty results. These are changes in client references, not proof an endpoint was created or deleted on the server. Public OpenAPI/Swagger URLs can also be monitored directly: captured schema changes use the same confirmation and classification flow. Arbitrary API data and health-response timestamps are not counted as deployments.

Expanding capture scope establishes a fresh fingerprint baseline on the next successful check, without adding a release or deleting existing history. Subsequent changes use the normal confirmation flow.

Content-based tracking uses a fresh baseline without manufacturing a release or deleting old evidence. Earlier deployment-based observations stay in SQLite but do not affect current rankings. `bun run recheck:history` audits all historical records; add `--apply` to restore verified content transitions. It fetches saved asset URLs, checks their raw hashes against the original evidence, and skips unrecoverable history instead of guessing. The first recoverable version establishes a baseline, not a release. Referenced chunks were not originally archived; their historical URLs are fetched where available.

Event times mean **first detected**, with the previous successful check and confirmation time preserved. Rankings cover observed events in the selected window. Company profiles show how long we've actually been watching.

There is no network-wide release total presented as a success metric: adding more websites would inflate it. Profiles show a site's own daily history and releases per observed day. The rate only includes completed UTC dates with successful checks after the baseline, excluding a partial baseline date and today. Missing dates are gaps, not zeroes; a date with successful checks does not imply uninterrupted coverage. A new site with no eligible dates has no rate yet. Charts aggregate all releases in their date range, independently of the profile's 100-event log limit.

**Limits:** backend-only deploys, commits, lazy-loaded routes, and scripts on unrelated CDN domains can be missed. CDN caching delays observations; multiple releases between checks can be missed; A/B tests and regional variants can introduce noise. A marketing homepage may deploy separately from the product. Timestamps and chart periods use the browser’s local timezone. Daily-average rates use completed **UTC** observation dates.

## Small on purpose

**One EC2 instance. One Bun process. One SQLite database.**

The interface is plain HTML, CSS, and a small browser script. It pairs self-hosted [Chakra Petch](https://github.com/google/fonts/tree/main/ofl/chakrapetch) capitals with [Source Serif 4](https://github.com/adobe-fonts/source-serif), both distributed under their included SIL Open Font Licenses. Charts use [uPlot](https://github.com/leeoniya/uPlot) for hover values, with a scrollable HTML data table. Its installed JavaScript and CSS are served locally; no frontend framework or build step. Google’s favicon service supplies the icons beside website names.

| Piece                             | Choice                                            |
| --------------------------------- | ------------------------------------------------- |
| Runtime / server / tests          | Bun                                               |
| Database                          | Built-in `bun:sqlite`, with WAL                   |
| Website                           | HTML, CSS, browser JavaScript — no frontend build |
| IP classification                 | `ipaddr.js`                                       |
| API rate limits                   | `rate-limiter-flexible`, in memory                |
| HTML attribute decoding           | `entities`                                        |
| URL discovery / domain boundaries | `cheerio`, `tldts`                                |
| Yes/no monitoring decisions       | Official `openai` SDK, Luna Decisions             |
| Bounded discovery concurrency     | `p-limit`                                         |
| HTTPS                             | Caddy                                             |

The observer spreads checks across five-minute windows, limits concurrent work, and backs off failures. It does not consult robots.txt. Private and reserved destinations are blocked, DNS is pinned to the validated address, and fetches have byte/time limits. Slow or unobservable sites show their actual monitoring status.

Submission limits: **one per IP per minute**, **100 new sites per day**. Read APIs: **120 requests per IP per minute**. In-memory limits reset on restart; there's no Redis or distributed rate-limit service.

<details>
<summary><strong>Project map</strong></summary>

```text
src/
  db.ts          Schema and release state transitions
  network.ts     Public HTTP fetching and DNS checks
  detect.ts      Script discovery and fingerprints
  poller.ts      Scheduling, confirmations, failure backoff
  import-yc.ts   Import only eligible recent YC companies
  discovery.ts   Public pages, Luna decisions, bounded selection
  subdomains.ts  Cached passive Subfinder discovery
  analysis.ts    Compressed bundles, code diffs, Luna summaries
  api-references.ts  Cached jsluice request-reference comparisons
  server.ts      Website and API
public/          Responsive website
tests/           Detection, safety boundary, and lifecycle checks
deploy/          EC2 service, HTTPS setup, daily SQLite backup
```

</details>

<details>
<summary><strong>Configuration and API</strong></summary>

| Variable           | Default                 | Purpose                                                |
| ------------------ | ----------------------- | ------------------------------------------------------ |
| `DATABASE_PATH`    | `data/shipwatch.sqlite` | Database file                                          |
| `HOST` / `PORT`    | `127.0.0.1` / `3000`    | HTTP listener                                          |
| `POLL_CONCURRENCY` | `24`                    | Maximum concurrent site checks                         |
| `POLL_ENABLED`     | enabled                 | Set to `0` to serve without polling                    |
| `MONITOR_YEAR`     | `2026`                  | YC batch year selected during import                   |
| `TRUST_PROXY`      | disabled                | Set to `1` only behind the trusted local reverse proxy |

| Endpoint                     | Returns                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /api/summary`           | Counts, coverage, activity, batches, UTC heatmap                                                 |
| `GET /api/companies`         | Leaderboard; accepts `days`, `sort`, `batch`, `search`, `page`                                   |
| `GET /api/company/:slug`     | Profile, up to 100 release events, daily check totals                                            |
| `GET /api/discovery-options` | Discovery availability; limits cannot be changed here                                            |
| `POST /api/discover`         | Review `{ "url": "https://example.com", "name": "Example" }`; returns a 30-minute review token   |
| `POST /api/companies`        | Confirm `{ "token": "review-token", "selected": ["https://app.example.com/"] }` from that review |
| `GET /health`                | Database readiness and actual Bun/SQLite versions                                                |

Sort values: `releases`, `weekend`, `recent`. Pages contain up to 50 companies.

</details>

<details>
<summary><strong>Self-hosting and backups</strong></summary>

The live app runs on a regular ARM64 `t4g.small` in **Northern California (`us-west-1`)**, with encrypted gp3 storage and Caddy HTTPS. Compute, disk, and public IPv4 cost roughly **$20/month**, before transfer and small S3 backup charges. CPU credits use standard mode.

Copy the source to `/opt/shipwatch` on an Ubuntu ARM64 instance, then run as root:

```sh
SITE_HOST=your-domain.example BACKUP_BUCKET=your-private-bucket bash deploy/setup.sh
```

Setup installs stable **Bun 1.4.4** and standalone **SQLite 3.54.1** tools. Bun's Linux driver statically links its own SQLite engine; `/health` reports that runtime version. Installing a newer SQLite CLI doesn't change Bun's embedded engine.

The app runs as an unprivileged systemd service. The only backup machinery is a daily, integrity-checked SQLite snapshot uploaded to private S3 storage. Give the instance role `s3:PutObject` on the bucket's `daily/*` prefix and configure 14-day expiration.

```sh
sudo systemctl status shipwatch
sudo journalctl -u shipwatch -n 50
sudo systemctl start shipwatch-backup
```

To restore: stop the app, download/decompress a backup using an operator identity, check `PRAGMA integrity_check`, replace the database, remove stale WAL/SHM files, restore `shipwatch` ownership, and restart. The instance's upload-only role cannot read backups.

This is a side project, not a high-availability service. Measure coverage and resource usage before adding infrastructure.

</details>

## Data and feedback

Company data comes from the unofficial [yc-oss API](https://github.com/yc-oss/api). Only publicly launched companies with valid websites, an eligible batch, and status `Active` or `Public` are imported. Re-running `bun run import:yc` refreshes that selection and removes out-of-scope YC records and their observations; community submissions are preserved.

Found a noisy signal or an unobservable site? [Open an issue](https://github.com/dennisimoo/shipwatch/issues) with the URL and what you observed.
