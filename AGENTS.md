# Working on Shipwatch

- Keep this a small side project: one Bun app, one SQLite database, one EC2 instance.
- Apply ponytail: remove unnecessary work and prefer the smallest working change.
- Prefer maintained libraries for standard plumbing such as IP classification, robots rules, and rate limiting. Use native Bun and platform APIs where they already solve the problem.
- When adding a dependency, check the latest stable release and commit the lockfile. Do not build a custom substitute for a suitable maintained library.
- Research with the Exa CLI first; if it fails, use web search and verify against primary sources.
- Keep monitoring focused on active companies in the selected recent YC year and community submissions. Do not retain an older company directory for hypothetical future use.
- Count observed frontend releases honestly. Never manufacture history, commits, productivity scores, or employee working hours.
- Do not add services, frameworks, distributed infrastructure, or production machinery without a demonstrated requirement.
- Keep the README concise, visual, and accurate. Use real screenshots and match the site's style.
- Run `bun test` and `bun run typecheck` for code changes; manually check relevant website interactions.
- Keep credentials and database files out of Git.
