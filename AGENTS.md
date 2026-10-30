# Working on Shipwatch

- Keep this a small side project: one Bun app, one SQLite database, one EC2 instance.
- Apply ponytail: remove unnecessary work and prefer the smallest working change.
- Fix proven root causes at their existing owner, check sibling paths for the same defect, and retain a regression test. Do not hide incomplete evidence to improve counts.
- Prefer maintained libraries for standard plumbing such as IP classification, robots rules, and rate limiting. Use native Bun and platform APIs where they already solve the problem.
- When adding a dependency, check the latest stable release and commit the lockfile. Do not build a custom substitute for a suitable maintained library.
- Research with the Exa CLI first; if it fails, use web search and verify against primary sources.
- Shipwatch is for any public website, not just YC companies. Recent active YC companies are only a prefilled starter dataset; community websites are first-class. Do not retain an older YC directory for hypothetical future use.
- Count observed frontend releases honestly. Never manufacture history, commits, productivity scores, or employee working hours.
- Do not add services, frameworks, distributed infrastructure, or production machinery without a demonstrated requirement.
- Keep the README concise, visual, and accurate. Use real screenshots and match the site's style.
- Run `bun test` and `bun run typecheck` for code changes; manually check relevant website interactions.
- Keep credentials and database files out of Git.
- Discovery budgets and monitoring caps belong to the server in `config.json`. Never expose them as visitor-editable form fields or accept client overrides. Visitors only select discovered URLs within the cap, with at least one selected.
- Keep the UI plain HTML/CSS with minimal browser JavaScript: editorial serif typography, restrained controls, and no decorative arrow icons.
- Avoid boxed network-wide release totals as success metrics: growing the monitored population inflates them. Keep shareable per-website histories honest about observation gaps and partial days.
