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
async function loadSummary() {
  const result = await api("/api/summary");
  select("#coverage-note").textContent =
    `${number(result.enabled)} websites. ${number(result.fresh)} checked in the last 15 minutes. Updated every five minutes.`;
  if (result.activity.length)
    select("#feed").innerHTML = result.activity
      .map(
        (event) =>
          `<a class="feed-item" href="/company/${encodeURIComponent(event.company_id)}"><div><strong>${escape(event.name)}</strong><small>New frontend version${event.batch ? " · " + escape(event.batch) : ""}</small></div><time>${ago(event.detected_at)}</time></a>`,
      )
      .join("");
  const batchSelect = select("#batch");
  const previous = batchSelect.value;
  batchSelect.innerHTML =
    '<option value="">All websites</option>' +
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
          return `<tr class="company-row"><td class="rank">${state.page * 50 + index + 1}</td><td><div class="company-name"><div><a href="/company/${encodeURIComponent(company.id)}">${escape(company.name)}</a><small>${escape(host(company.url))}</small></div></div></td><td><span class="batch-tag${company.batch ? "" : " community-tag"}">${escape(company.batch || "COMMUNITY")}</span></td><td class="numeric release-count">${company.baseline_at ? number(company.releases) : "—"}</td><td class="numeric muted">${company.baseline_at ? number(company.weekend) : "—"}</td><td class="last-ship" title="${escape(date(company.last_release))}">${company.last_release ? ago(company.last_release) : company.baseline_at ? "No release yet" : "Waiting for data"}</td><td><span class="monitor-state ${escape(status)}" title="${escape(company.error || "Last successful check: " + date(company.last_success))}">${label}</span></td></tr>`;
        })
        .join("")
    : '<tr><td colspan="7" class="table-empty">No websites match this search. Try another name or collection.</td></tr>';
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
function historyChart(history) {
  const max = Math.max(1, ...history.days.map((day) => day.releases ?? 0));
  const bars = history.days
    .map((day, index) => {
      const position = 45 + index * 27;
      if (day.releases === null)
        return `<text x="${position + 8}" y="205" class="chart-missing"><title>${escape(day.day)}: no successful observation</title>·</text>`;
      const height = (day.releases / max) * 150;
      return `<rect x="${position}" y="${190 - height}" width="15" height="${Math.max(2, height)}" class="chart-bar"><title>${escape(day.day)}: ${day.releases} observed releases${day.complete ? "" : " (partial day)"}</title></rect>`;
    })
    .join("");
  return `<figure class="release-chart"><svg viewBox="0 0 900 240" role="img" aria-label="Daily observed frontend releases over the last 30 UTC days. Dots indicate no observations; today is partial."><text x="12" y="43">${max}</text><text x="12" y="194">0</text><line x1="40" y1="190" x2="860" y2="190" class="chart-axis"/>${bars}<text x="45" y="230">${escape(history.days[0].day.slice(5))}</text><text x="430" y="230">${escape(history.days[14].day.slice(5))}</text><text x="800" y="230">Today</text></svg><figcaption>Daily observed releases · UTC · dots mean no observations, not zero releases. Today is partial.</figcaption><details><summary>Daily data</summary><table><thead><tr><th>Date (UTC)</th><th>Observed releases</th></tr></thead><tbody>${history.days.map((day) => `<tr><td>${escape(day.day)}</td><td>${day.releases === null ? "Not observed" : number(day.releases)}${day.releases !== null && !day.complete ? " (partial day)" : ""}</td></tr>`).join("")}</tbody></table></details></figure>`;
}
async function showCompany(id) {
  select("#index-page").hidden = true;
  select("#company-page").hidden = false;
  try {
    const result = await api("/api/company/" + encodeURIComponent(id));
    const company = result.company;
    const history = result.history;
    const discovery = result.discovery;
    const review = discovery?.review ? JSON.parse(discovery.review) : null;
    const monitoringNote = discovery?.error
      ? "URL review could not finish. The existing website remains monitored."
      : review && !review.recommended.length
        ? "No product URL was recommended. The existing website remains monitored."
        : ["queued", "running"].includes(discovery?.status)
          ? "URL review is in progress. The current website remains monitored."
          : "Watching these public URLs.";
    document.title = company.name + " — Shipwatch";
    const rate =
      history.releasesPerDay === null
        ? "Still getting to know this website."
        : `${history.releasesPerDay.toLocaleString(undefined, { maximumFractionDigits: 1 })} releases per observed day.`;
    select("#company-detail").innerHTML = `
      <header class="company-heading"><p class="eyebrow">WEBSITE OBSERVATIONS</p><h1>${escape(company.name)}</h1><div class="company-links"><a href="${escape(company.url)}" target="_blank" rel="noopener">${escape(host(company.url))}</a><button class="text-button" id="copy-company">Copy page link</button><span id="share-status" role="status"></span></div><p>${escape(company.description)}</p></header>
      <section class="company-history"><h2>Release history</h2><p class="metric-sentence">${escape(rate)}</p><p class="history-context">${number(history.total)} releases observed over the past 30 days.</p><details class="metric-method"><summary>How this rate works</summary><p>The rate uses ${number(history.comparableReleases)} releases across ${number(history.observedDays)} completed UTC days with successful checks. Today and a partial first day are excluded. Days without checks are missing, not zero. A checked day does not mean uninterrupted coverage.</p></details>${historyChart(history)}</section>
      <section class="observation-notes"><h2>What we can see</h2><dl><dt>First observed</dt><dd>${escape(date(company.baseline_at))}</dd><dt>Last successful check</dt><dd>${escape(date(company.last_success))}</dd><dt>Successful checks</dt><dd>${number(company.successes)} of ${number(company.checks)} attempts</dd></dl><p>${escape(company.error || "Public frontend changes, checked every five minutes.")}</p><h3>Monitored URLs</h3><p class="fine-print">${escape(monitoringNote)}</p>${result.targets.map((target) => `<p class="monitor-target"><a href="${escape(target.url)}" target="_blank" rel="noopener">${escape(target.url)}</a><span>${escape(target.status)} · last success ${escape(ago(target.last_success))}</span></p>`).join("")}</section>
      <section class="release-log"><h2>Observation log</h2>${result.releases.length ? result.releases.map((release) => `<article class="detail-event"><time>${escape(date(release.detected_at))}</time><p>Changed between ${escape(date(release.previous_at))} and ${escape(date(release.detected_at))}. Confirmed ${escape(date(release.confirmed_at))}.</p><details><summary>Release evidence</summary><pre>${escape(JSON.stringify(JSON.parse(release.evidence), null, 2))}</pre></details></article>`).join("") : "<p>No releases observed yet. Changes will appear here as we see them.</p>"}<p class="fine-print">Latest 100 events. The chart counts all releases in its date range, not just this log. These are frontend signals, not commits, backend deploys, or working hours.</p></section>`;
    select("#copy-company").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(
          location.origin + "/company/" + encodeURIComponent(id),
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
select("#add-button").addEventListener("click", async () => {
  select("#add-dialog").showModal();
  try {
    const options = await api("/api/discovery-options");
    if (!options.available)
      select("#submission-message").textContent =
        "AI discovery is not configured on this server yet.";
  } catch {
    select("#submission-message").textContent =
      "Could not load discovery settings. Try again shortly.";
  }
});
for (const id of ["#method-button", "#method-inline", "#hero-method"])
  select(id).addEventListener("click", () =>
    select("#method-dialog").showModal(),
  );
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
    `${selected.length} selected · choose 1–${maximum}`;
  select("#submit-site").disabled =
    selected.length < 1 || selected.length > maximum;
  select("#submit-site").textContent =
    `Monitor ${selected.length} selected ${selected.length === 1 ? "URL" : "URLs"}`;
}
select("#discovery-candidates").addEventListener("change", updateSelection);
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
    : "Discovering and reviewing with Luna…";
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
        `Inspected ${result.review.candidates.length} of ${result.review.discovered} discovered domains. Luna suggested ${result.review.recommended.length}. Check or uncheck any inspectable URL; select at least one.`;
      select("#discovery-candidates").innerHTML = result.review.candidates
        .map(
          (candidate) =>
            `<label class="candidate-choice"><input class="candidate-checkbox" type="checkbox" value="${escape(candidate.url)}" ${result.review.recommended.includes(candidate.url) ? "checked" : ""} ${candidate.error ? "disabled" : ""}><span><strong>${escape(candidate.title || host(candidate.url))}</strong><small>${escape(candidate.url)}</small><small>${escape(candidate.error || (candidate.probability === null ? "No decision" : `Luna: ${Math.round(candidate.probability * 100)}% yes${candidate.probability >= 0.7 ? " · recommended" : " · not recommended"}`))}</small></span></label>`,
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
      location.href = "/company/" + encodeURIComponent(result.company.id);
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
else {
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 30000);
}
