# Shipwatch ↗

A public leaderboard of observed frontend releases. Track the 2026 YC batches and community-submitted websites every five minutes, then explore release frequency, weekend activity, and a weekday/hour heatmap.

## Run

Install [Bun](https://bun.sh) 1.4.4 or newer:

```sh
bun install
bun run import:yc
bun run dev
```

Open `http://localhost:3000`. SQLite is created automatically in `data/shipwatch.sqlite` using Bun's built-in `bun:sqlite` driver. No database server, ORM, frontend build, or cloud credentials are needed to run locally.

```sh
bun test
bun run typecheck
```

## How detection works

1. The first successful check establishes a baseline. It is never counted as a release.
2. Extract and sort first-party script and module-preload URLs. Ignore common analytics scripts. Include an exposed Next.js build ID when present.
3. Fingerprint content for up to eight scripts without recognizable hexadecimal content hashes in their filenames. Use ETag/Last-Modified conditional requests when available. Content-hashed URLs are tracked by URL without repeatedly downloading their contents.
4. When the fingerprint changes, check again after approximately one minute. Record a release only if it persists.
5. Remember previously confirmed fingerprints, including the initial baseline, so rollbacks do not inflate release counts.

Detection timestamps are first observations, not exact deploy timestamps. Each event preserves the previous successful observation and confirmation time. Multiple deploys between checks may be missed. CDN caching can delay observations. A/B variants, personalized scripts, and regional rollouts can still create noise. JavaScript hosted on unrelated CDN domains, lazy-loaded routes, and backend-only deploys are outside coverage. This is not a commit counter or a measure of engineering productivity or employee working hours.

All leaderboard weekend and hour calculations use **UTC**. Rankings cover 7 or 30 days of observed events, with each company's baseline date and successful check totals available in its profile. A new company has a shorter observation history. `—` means there is no successful baseline, rather than zero releases.

## YC directory

`bun run import:yc` imports the public [yc-oss directory](https://github.com/yc-oss/api), an unofficial mirror of YC directory data. All valid company URLs are retained. Monitoring is limited to companies in **Winter, Spring, Summer, and Fall 2026** with status `Active` or `Public`, plus community submissions. Set `MONITOR_YEAR` when importing to select another year. This keeps the initial comparison focused on recent cohorts; release frequency alone does not establish that a company is moving fast. This is a selection of publicly launched companies, not every company funded by YC. Re-run the import to refresh company metadata. Monitoring a marketing homepage does not necessarily reflect product releases.

## Layout

```text
src/db.ts          SQLite schema and release state transitions
src/network.ts     Bounded, DNS-pinned public HTTP fetching and robots rules
src/detect.ts      Script discovery and frontend fingerprints
src/poller.ts      Due-site scheduler, confirmations, and failure backoff
src/import-yc.ts   YC directory import
src/server.ts      Bun HTTP server and read/write API
public/           Buildless, responsive website
tests/            Detection, network boundary, and release lifecycle tests
deploy/           EC2 systemd service, Caddy setup, and daily S3 backup
```

## API

| Endpoint                                                         | Purpose                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/summary`                                               | Directory counts, fresh coverage, activity feed, batches, UTC heatmap         |
| `GET /api/companies?days=30&sort=releases&batch=&search=&page=0` | Paginated leaderboard; sort by `releases`, `weekend`, or `recent`             |
| `GET /api/company/:id`                                           | Profile, up to 100 release events with evidence, daily check totals           |
| `POST /api/companies`                                            | Submit `{ "url": "https://example.com", "name": "Example" }` from the website |
| `GET /health`                                                    | Database readiness and actual Bun/SQLite runtime versions                     |

Community submissions are limited to one per client per minute and 100 new sites per day. Public HTTP/HTTPS URLs on standard ports only; private, loopback, metadata, reserved destinations, and redirects to those destinations are blocked. DNS results are validated and pinned to the actual connection. Requests have time and byte limits. Robots.txt disallows are respected; failure responses back off instead of counting as releases.

## Deployment

The initial deployment is a regular ARM64 EC2 `t4g.small` in Northern California (`us-west-1`), with encrypted gp3 storage. Bun runs as an unprivileged systemd service behind Caddy HTTPS. A public IPv4 address, EBS, and S3 backup usage are billed separately from EC2 compute. CPU credits use standard mode to avoid surplus-credit charges.

Copy this source to `/opt/shipwatch`, then run as root:

```sh
SITE_HOST=your-domain.example BACKUP_BUCKET=your-private-backup-bucket bash deploy/setup.sh
```

The setup pins the stable Bun release verified for this deployment and installs SQLite 3.54.1 command-line tools for backups. **On Linux, Bun statically links its own SQLite library:** the app's SQL engine version follows Bun and may differ from the standalone CLI. `/health` reports the actual version. Updating the CLI does not update Bun's embedded engine.

The EC2 instance needs an IAM role permitting only `s3:PutObject` on the backup bucket's `daily/*` prefix. Keep the bucket private and configure a 14-day expiration. The daily timer uses SQLite's consistent backup API, checks integrity, compresses, and uploads a snapshot. It runs at 09:00 UTC plus up to 15 minutes of jitter. Backup files, live data, environment files, and credentials are never committed.

```sh
sudo systemctl status shipwatch
sudo journalctl -u shipwatch -n 50
sudo systemctl start shipwatch-backup
sudo systemctl status shipwatch-backup
```

Restore with the app stopped: download a backup using an operator identity with read access, decompress it, verify `PRAGMA integrity_check`, replace the database, remove stale WAL/SHM files, set ownership to `shipwatch`, and restart the service. The instance's upload-only role intentionally cannot download backups.

## Operating limits

The scheduler targets five-minute intervals with 24 concurrent site checks and at most one active check per hostname. Slow sites can make checks late; the site shows actual freshness rather than claiming universal coverage. Errors back off up to one hour; unsupported pages and robots disallows retry daily. Raw bundle contents are not retained. Aggregate byte counts cover successful snapshot requests, not every failed or robots request, and are not an AWS billing meter.

The single server is a deliberate first-version boundary. Measure CPU, network, coverage, and database size before adding collectors. Public read APIs are cached briefly, but this deployment does not promise high availability or automatic scaling.
