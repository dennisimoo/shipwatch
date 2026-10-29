const select = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const number = (value) => Number(value || 0).toLocaleString();
const date = (timestamp) =>
  timestamp
    ? new Date(timestamp * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC"
    : "Not yet";
function ago(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
const state = { days: 30, search: "", batch: "", sort: "releases", page: 0 };
let companiesRequest = 0;
async function api(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function drawHeatmap(entries, total) {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  let html = "";
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    html += `<span class="day-label">${days[day]}</span>`;
    for (let hour = 0; hour < 24; hour++) {
      const count =
        entries.find((entry) => entry.day === day && entry.hour === hour)
          ?.count || 0;
      const level = count ? Math.max(1, Math.ceil((count / max) * 4)) : 0;
      html += `<div class="heat-cell" data-level="${level}" title="${days[day]} ${String(hour).padStart(2, "0")}:00 UTC · ${count} releases" aria-label="${days[day]} ${hour}:00 UTC: ${count} releases"></div>`;
    }
  }
  html += "<span></span>";
  for (let hour = 0; hour < 24; hour++)
    html += `<span class="hour-label">${hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>`;
  select("#heatmap").innerHTML = html;
  select("#heatmap-note").textContent = total
    ? `${number(total)} observed releases. Every square is an hour in UTC.`
    : "No confirmed releases yet. The clock fills in as companies ship.";
}
async function loadSummary() {
  const result = await api("/api/summary");
  select("#stat-sites").textContent = number(result.enabled);
  select("#stat-sites-note").textContent =
    `${number(result.baselined)} baselines · ${number(result.companies)} in directory`;
  select("#stat-releases").textContent = number(result.releases);
  select("#stat-weekend").textContent = number(result.weekend);
  select("#stat-coverage").textContent = result.enabled
    ? `${Math.round((result.fresh / result.enabled) * 100)}%`
    : "—";
  select("#stat-coverage-note").textContent =
    `${number(result.fresh)} checked successfully in the last 15m`;
  drawHeatmap(result.heatmap, result.releases);
  if (result.activity.length)
    select("#feed").innerHTML = result.activity
      .map(
        (event) =>
          `<div class="feed-item" data-company="${escape(event.company_id)}" role="button" tabindex="0"><span class="feed-logo">${escape(event.name.slice(0, 1))}</span><div><strong>${escape(event.name)}</strong><small>New frontend version${event.batch ? " · " + escape(event.batch) : ""}</small></div><time>${ago(event.detected_at)}</time></div>`,
      )
      .join("");
  const batchSelect = select("#batch");
  const previous = batchSelect.value;
  batchSelect.innerHTML =
    '<option value="">All batches + community</option>' +
    result.batches
      .map(
        (batch) =>
          `<option value="${escape(batch.batch)}">${escape(batch.batch)} (${batch.count})</option>`,
      )
      .join("");
  batchSelect.value = previous;
}
async function loadCompanies() {
  const request = ++companiesRequest;
  const result = await api("/api/companies?" + new URLSearchParams(state));
  if (request !== companiesRequest) return;
  select("#companies").innerHTML = result.companies.length
    ? result.companies
        .map((company, index) => {
          const stale =
            company.status === "watching" &&
            company.last_success < Date.now() / 1000 - 900;
          const status = stale ? "stale" : company.status;
          const label =
            {
              watching: "Watching",
              error: "Retrying",
              unsupported: "Unobservable",
              queued: "Queued",
              stale: "Delayed",
            }[status] || status;
          return `<tr class="company-row" data-company="${escape(company.id)}" tabindex="0" role="button" aria-label="View ${escape(company.name)}"><td class="rank">${state.page * 50 + index + 1}</td><td><div class="company-name"><span class="company-avatar">${escape(company.name.slice(0, 1))}</span><div><strong>${escape(company.name)}</strong><small>${escape(host(company.url))}</small></div></div></td><td><span class="batch-tag${company.batch ? "" : " community-tag"}">${escape(company.batch || "COMMUNITY")}</span></td><td class="numeric release-count">${company.baseline_at ? number(company.releases) : "—"}</td><td class="numeric muted">${company.baseline_at ? number(company.weekend) : "—"}</td><td class="last-ship" title="${escape(date(company.last_release))}">${company.last_release ? ago(company.last_release) : company.baseline_at ? "No release yet" : "Awaiting baseline"}</td><td><span class="monitor-state ${escape(status)}" title="${escape(company.error || "Last successful check: " + date(company.last_success))}">${label}</span></td><td class="row-arrow">↗</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="8" class="table-empty">No companies match this search. Try another name or batch.</td></tr>';
  select("#results-label").textContent = result.total
    ? `${number(state.page * 50 + 1)}–${number(Math.min((state.page + 1) * 50, result.total))} of ${number(result.total)} sites · ${state.days}-day window`
    : "No results";
  select("#previous").disabled = state.page === 0;
  select("#next").disabled = (state.page + 1) * 50 >= result.total;
}
async function refresh() {
  try {
    await Promise.all([loadSummary(), loadCompanies()]);
    select("#connection-error").hidden = true;
  } catch {
    select("#connection-error").hidden = false;
  }
}
async function showCompany(id) {
  const dialog = select("#company-dialog");
  select("#company-detail").textContent = "Loading observation history…";
  if (!dialog.open) dialog.showModal();
  try {
    const result = await api("/api/company/" + encodeURIComponent(id));
    const company = result.company;
    select("#company-detail").innerHTML =
      `<h2>${escape(company.name)}</h2><a class="detail-link" href="${escape(company.url)}" target="_blank" rel="noopener">${escape(host(company.url))} ↗</a><p>${escape(company.description)}</p><div class="detail-stats"><div><small>BASELINE ESTABLISHED</small><strong>${escape(date(company.baseline_at))}</strong></div><div><small>SUCCESSFUL CHECKS / ATTEMPTS</small><strong>${number(company.successes)} / ${number(company.checks)}</strong></div><div><small>LAST SUCCESSFUL CHECK</small><strong>${escape(date(company.last_success))}</strong></div><div><small>LAST CHECK ATTEMPT</small><strong>${escape(date(company.last_check))}</strong></div></div><div class="detail-status">${escape(company.error || "Monitoring public frontend changes every five minutes.")}</div><h3>Observed releases</h3>${result.releases.length ? result.releases.map((release) => `<article class="detail-event"><time>${escape(date(release.detected_at))}</time><p>Changed between ${escape(date(release.previous_at))} and ${escape(date(release.detected_at))}. Confirmed ${escape(date(release.confirmed_at))}.</p><details><summary>Inspect release evidence</summary><pre>${escape(JSON.stringify(JSON.parse(release.evidence), null, 2))}</pre></details></article>`).join("") : "<p>No confirmed releases yet. Monitoring starts from the baseline; historical deploys cannot be reconstructed from these checks.</p>"}<p class="fine-print">Showing up to 100 most recent releases. Times are UTC. Backend-only deploys, commits, and working hours are not observable.</p>`;
  } catch (error) {
    select("#company-detail").textContent = error.message;
  }
}
select("#add-button").addEventListener("click", () =>
  select("#add-dialog").showModal(),
);
for (const id of ["#method-button", "#method-inline"])
  select(id).addEventListener("click", () =>
    select("#method-dialog").showModal(),
  );
document.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close]");
  if (close) document.getElementById(close.dataset.close).close();
  const company = event.target.closest("[data-company]");
  if (company) showCompany(company.dataset.company);
});
document.addEventListener("keydown", (event) => {
  const company = event.target.closest("[data-company]");
  if (company && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    showCompany(company.dataset.company);
  }
});
let debounce;
select("#search").addEventListener("input", (event) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.search = event.target.value;
    state.page = 0;
    refresh();
  }, 250);
});
for (const key of ["batch", "sort"])
  select("#" + key).addEventListener("change", (event) => {
    state[key] = event.target.value;
    state.page = 0;
    refresh();
  });
document.querySelectorAll("[data-days]").forEach((button) =>
  button.addEventListener("click", () => {
    state.days = Number(button.dataset.days);
    state.page = 0;
    document
      .querySelectorAll("[data-days]")
      .forEach((option) =>
        option.classList.toggle("selected", option === button),
      );
    refresh();
  }),
);
select("#previous").addEventListener("click", () => {
  state.page = Math.max(0, state.page - 1);
  refresh();
});
select("#next").addEventListener("click", () => {
  state.page++;
  refresh();
});
select("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = select("#submit-site");
  button.disabled = true;
  button.textContent = "Checking the website…";
  select("#submission-message").textContent = "";
  try {
    const result = await api("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    select("#submission-message").textContent = result.existing
      ? "Already in the index. Opening its profile…"
      : "Added. The first check will establish its baseline.";
    await refresh();
    setTimeout(() => {
      select("#add-dialog").close();
      showCompany(result.company.id);
    }, 900);
  } catch (error) {
    select("#submission-message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Start watching ↗";
  }
});
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
