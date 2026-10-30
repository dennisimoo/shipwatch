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
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not yet";
function releaseTimestamp(timestamp) {
  const value = new Date(timestamp * 1000);
  const day = value.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
    ...(value.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
  const time = value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `<time datetime="${value.toISOString()}" title="${escape(date(timestamp))}" aria-label="${escape(date(timestamp))}"><span>${escape(day)}</span><span>${escape(time)}</span></time>`;
}
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
function favicon(url) {
  return `<img class="favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=64" width="20" height="20" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}
const state = { days: 30, search: "", batch: "", sort: "releases", page: 0 };
let companiesRequest = 0;
async function api(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
async function loadSummary() {
  const result = await api("/api/summary");
  if (result.activity.length)
    select("#feed").innerHTML = result.activity
      .map(
        (event) =>
          `<a class="feed-item" href="/company/${encodeURIComponent(event.slug)}"><div><strong>${escape(event.name)}</strong><small>Observed change${event.batch ? " · " + escape(event.batch) : ""}</small></div><time>${ago(event.detected_at)}</time></a>`,
      )
      .join("");
  const choices = [
    { value: "", label: "All websites" },
    ...result.batches.map((batch) => ({
      value: batch.batch,
      label: `${batch.batch} (${batch.count})`,
    })),
  ];
  const batchSelect = select("#batch");
  batchSelect.innerHTML = choices
    .map(
      (choice) =>
        `<option value="${escape(choice.value)}">${escape(choice.label)}</option>`,
    )
    .join("");
  batchSelect.value = state.batch;
}
async function loadCompanies() {
  const request = ++companiesRequest;
  const result = await api("/api/companies?" + new URLSearchParams(state));
  if (request !== companiesRequest) return;
  select("#companies").innerHTML = result.companies.length
    ? result.companies
        .map((company, index) => {
          const stale =
            !result.preview &&
            company.status === "watching" &&
            company.last_success < Date.now() / 1000 - 900;
          const status = stale ? "stale" : company.status;
          const label =
            {
              watching: result.preview ? "Snapshot" : "Watching",
              error: result.preview ? "Fetch error" : "Retrying",
              unsupported: "Unobservable",
              queued: "Queued",
              stale: "Delayed",
            }[status] || status;
          return `<tr class="company-row"><td class="rank">${state.page * 50 + index + 1}</td><td><div class="company-name">${favicon(company.url)}<div><a href="/company/${encodeURIComponent(company.slug)}">${escape(company.name)}</a><small>${escape(host(company.url))}</small></div></div></td><td><span class="batch-tag${company.batch ? "" : " community-tag"}">${escape(company.batch || "COMMUNITY")}</span></td><td class="numeric release-count">${company.baseline_at ? number(company.releases) : "—"}</td><td class="last-ship" title="${escape(date(company.last_release))}">${company.last_release ? ago(company.last_release) : company.baseline_at ? "No release yet" : "Waiting for data"}</td><td><span class="monitor-state ${escape(status)}" title="${escape(company.error || (result.preview ? "Preview polling is paused. Last recorded success: " : "Last successful check: ") + date(company.last_success))}">${label}</span></td></tr>`;
        })
        .join("")
    : '<tr><td colspan="6" class="table-empty">No websites match this search. Try another name or collection.</td></tr>';
  select("#results-label").textContent = result.total
    ? `${number(state.page * 50 + 1)}–${number(Math.min((state.page + 1) * 50, result.total))} of ${number(result.total)} sites · ${state.days}-day window`
    : "No results";
  select("#previous").disabled = state.page === 0;
  select("#next").disabled = (state.page + 1) * 50 >= result.total;
}
async function refresh() {
  try {
    await Promise.all([
      loadSummary(),
      loadCompanies(),
    ]);
    select("#connection-error").hidden = true;
  } catch {
    select("#connection-error").hidden = false;
  }
}
async function showCompany(id) {
  select("#index-page").hidden = true;
  select("#company-page").hidden = false;
  try {
    const [result, { mountChart }] = await Promise.all([
      api("/api/company/" + encodeURIComponent(id)),
      import("/chart.js?v=content-3"),
    ]);
    const company = result.company;
    const history = result.history;
    document.title = company.name + " — Shipwatch";
    const rate =
      history.releasesPerDay === null
        ? ""
        : `${history.releasesPerDay.toLocaleString(undefined, { maximumFractionDigits: 1 })} releases per observed day.`;
    select("#company-detail").innerHTML = `
      <header class="company-heading"><p class="eyebrow">WEBSITE OBSERVATIONS</p><h1>${favicon(company.url)}${escape(company.name)}</h1><div class="company-links"><a href="${escape(company.url)}" target="_blank" rel="noopener">${escape(host(company.url))}</a><button class="text-button" id="copy-company">Copy page link</button><span id="share-status" role="status"></span></div><p>${escape(company.description)}</p></header>
      <section class="company-history"><h2>Release history</h2><p class="metric-sentence">${escape(rate)}</p><p class="history-context">${number(history.total)} releases observed over the past 30 days.</p><details class="metric-method" ${rate ? "" : "hidden"}><summary>How this rate works</summary><p>The rate uses ${number(history.comparableReleases)} releases across ${number(history.observedDays)} completed UTC days with successful checks. Today and a partial first day are excluded. Days without checks are missing, not zero. A checked day does not mean uninterrupted coverage.</p></details><div class="chart-controls"><div class="chart-toggle" role="group" aria-label="Time range"><button data-chart-days="0.5" aria-pressed="true">12 hours</button><button data-chart-days="7" aria-pressed="false">7 days</button><button data-chart-days="30" aria-pressed="false">30 days</button></div></div><div id="release-chart" role="img" aria-label="Interactive release chart"></div><p id="chart-readout" class="chart-readout" aria-live="polite"></p><details class="daily-data"><summary>Release data</summary>${company.legacy_releases ? '<p class="fine-print">Older observations are included only when their content can be reverified.</p>' : ""}<div class="data-scroll"><table><thead><tr><th>Period starts</th><th>Releases</th><th></th></tr></thead><tbody id="chart-data"></tbody></table></div></details></section>
      <section class="observation-notes"><h2>Tracking details</h2><dl><dt>Watching since</dt><dd>${escape(date(company.baseline_at))}</dd><dt>Last checked</dt><dd>${escape(date(company.last_success))}</dd><dt>Successful checks</dt><dd>${number(company.successes)} / ${number(company.checks)}</dd>${result.deploys?.tracked ? `<dt>Deploys, 30 days</dt><dd>${number(result.deploys.count)}${result.deploys.latest ? ` · latest ${escape(ago(result.deploys.latest))}` : ""}<small class="deploy-note">New platform deployment IDs, including deploys with no captured code change.</small></dd>` : ""}</dl>${company.error ? `<p>${escape(company.error)}</p>` : ""}${result.targets.map((target) => `<p class="monitor-target"><a href="${escape(target.url)}" target="_blank" rel="noopener">${escape(host(target.url))}${escape(new URL(target.url).pathname === "/" ? "" : new URL(target.url).pathname)}</a><span>${result.preview ? "Snapshot" : escape(target.status)} · checked ${escape(date(target.last_success))}</span></p>`).join("")}</section>
      <section class="release-log"><h2>Releases</h2>${result.releases.length ? result.releases.map((release) => `<article class="detail-event"><details><summary><span>${release.kind ? `<b class="change-kind">${escape({ feature: "Feature", fix: "Fix", content: "Content", design: "Design", api: "API", other: "Other" }[release.kind] || release.kind)}</b>` : ""}${escape(release.summary)}</span>${releaseTimestamp(release.detected_at)}</summary><dl class="event-details"><dt>Previous check</dt><dd>${escape(date(release.previous_at))}</dd><dt>Detected</dt><dd>${escape(date(release.detected_at))}</dd><dt>Confirmed</dt><dd>${escape(date(release.confirmed_at))}</dd></dl><details><summary>Fingerprint evidence</summary><pre>${escape(JSON.stringify(JSON.parse(release.evidence), null, 2))}</pre></details></details></article>`).join("") : "<p>No releases observed yet.</p>"}${result.releases.length >= 100 ? '<p class="fine-print">Latest 100 releases. The chart includes all releases in the selected range.</p>' : ""}</section>`;
    mountChart(result);
    loadBackend(company.slug);
    select("#copy-company").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(
          location.origin + "/company/" + encodeURIComponent(company.slug),
        );
        select("#share-status").textContent = "Link copied";
      } catch {
        select("#share-status").textContent =
          "Copy this page’s address from your browser.";
      }
    });
  } catch (error) {
    select("#company-detail").textContent = error.message;
  }
}
async function loadBackend(slug) {
  try {
    const [map, { backendSection }] = await Promise.all([
      api("/api/company/" + encodeURIComponent(slug) + "/backend"),
      import("/backend.js?v=1"),
    ]);
    select(".observation-notes")?.insertAdjacentHTML("afterend", backendSection(map));
  } catch {}
}
select("#add-button").addEventListener("click", async () => {
  select("#add-dialog").showModal();
  try {
    const options = await api("/api/discovery-options");
    if (!options.available)
      select("#submission-message").textContent =
        "Website discovery is unavailable right now.";
  } catch {
    select("#submission-message").textContent =
      "Could not load discovery settings. Try again shortly.";
  }
});
document.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close]");
  if (close) document.getElementById(close.dataset.close).close();
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
let discoveryDraft = null;
function updateSelection() {
  if (!discoveryDraft) return;
  const selected = [
    ...document.querySelectorAll(".candidate-checkbox:checked"),
  ];
  const maximum = discoveryDraft.review.options.domainLimit;
  select("#selection-count").textContent =
    `${selected.length} selected · choose 1–${maximum}, one per domain`;
  select("#submit-site").disabled =
    selected.length < 1 || selected.length > maximum;
  select("#submit-site").textContent =
    `Monitor ${selected.length} selected ${selected.length === 1 ? "URL" : "URLs"}`;
}
select("#discovery-candidates").addEventListener("change", (event) => {
  const changed = event.target;
  if (changed.matches(".candidate-checkbox") && changed.checked) {
    const hostname = new URL(changed.value).hostname;
    for (const other of document.querySelectorAll(".candidate-checkbox:checked"))
      if (other !== changed && new URL(other.value).hostname === hostname) other.checked = false;
  }
  updateSelection();
});
select("#discovery-back").addEventListener("click", () => {
  discoveryDraft = null;
  select("#discovery-inputs").disabled = false;
  select("#discovery-inputs").hidden = false;
  select("#discovery-review").hidden = true;
  select("#submit-site").disabled = false;
  select("#submit-site").textContent = "Discover URLs";
  select("#submission-message").textContent = "";
});
select("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = select("#submit-site");
  button.disabled = true;
  button.textContent = discoveryDraft
    ? "Starting monitoring…"
    : "Finding subdomains…";
  select("#submission-message").textContent = "";
  try {
    const fields = Object.fromEntries(new FormData(event.target));
    const body = discoveryDraft
      ? {
          token: discoveryDraft.token,
          selected: [
            ...document.querySelectorAll(".candidate-checkbox:checked"),
          ].map((element) => element.value),
        }
      : fields;
    const result = await api(
      discoveryDraft ? "/api/companies" : "/api/discover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (result.review) {
      discoveryDraft = result;
      select("#discovery-inputs").disabled = true;
      select("#discovery-inputs").hidden = true;
      select("#discovery-review").hidden = false;
      select("#discovery-summary").textContent =
        `Reviewed ${result.review.candidates.length} websites. ${result.review.recommended.length} suggested. Select at least one to monitor.`;
      select("#discovery-candidates").innerHTML = result.review.candidates
        .map(
          (candidate) =>
            `<label class="candidate-choice"><input class="candidate-checkbox" type="checkbox" value="${escape(candidate.url)}" ${result.review.recommended.includes(candidate.url) ? "checked" : ""} ${candidate.error ? "disabled" : ""}><span><strong>${escape(candidate.title || host(candidate.url))}</strong><small>${escape(candidate.url)}</small>${candidate.source === "Passively discovered page" ? "<small>Found through public archives</small>" : candidate.source === "Linked public page" ? "<small>Linked from submitted page</small>" : ""}${candidate.error ? `<small>${escape(candidate.error)}</small>` : result.review.recommended.includes(candidate.url) ? "<small>Suggested</small>" : ""}</span></label>`,
        )
        .join("");
      updateSelection();
      return;
    }
    select("#submission-message").textContent = result.existing
      ? "Already in the index. Opening its profile…"
      : "Added. We’ll start watching for changes.";
    await refresh();
    setTimeout(() => {
      select("#add-dialog").close();
      select("#discovery-back").click();
      event.target.reset();
      location.href = "/company/" + encodeURIComponent(result.company.slug);
    }, 900);
  } catch (error) {
    select("#submission-message").textContent = error.message;
  } finally {
    if (discoveryDraft) updateSelection();
    else {
      button.disabled = false;
      button.textContent = "Discover URLs";
    }
  }
});
const companyPath = location.pathname.match(/^\/company\/([a-zA-Z0-9-]+)$/);
if (companyPath) showCompany(companyPath[1]);
else if (location.pathname !== "/how-it-works") {
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 30000);
}

document.addEventListener(
  "error",
  (event) => {
    if (
      event.target instanceof HTMLImageElement &&
      event.target.classList.contains("favicon")
    )
      event.target.hidden = true;
  },
  true,
);
