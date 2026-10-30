const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const clip = (text, length) => (text.length > length ? text.slice(0, length - 1) + "…" : text);
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** Groups endpoints by origin and their first two path segments: /api/brands/limits → /api/brands. */
export function apiGroups(map) {
  const groups = new Map();
  const site = host(map.url);
  for (const api of map.apis)
    for (const endpoint of api.endpoints) {
      const prefix = "/" + endpoint.path.split("/").filter(Boolean).slice(0, 2).join("/");
      const label = (host(api.origin) === site ? "" : host(api.origin)) + prefix;
      const group = groups.get(label) ?? { label, firstParty: api.firstParty, endpoints: 0, methods: new Set() };
      group.endpoints++;
      for (const method of endpoint.methods) group.methods.add(method);
      groups.set(label, group);
    }
  return [...groups.values()].sort((left, right) =>
    Number(right.firstParty) - Number(left.firstParty) || right.endpoints - left.endpoints || left.label.localeCompare(right.label));
}

export function serviceGroups(map) {
  const groups = new Map();
  for (const service of map.services) groups.set(service.category, [...(groups.get(service.category) ?? []), service.name]);
  return [...groups].map(([category, names]) => ({ category, names }));
}

/** Left: pages → middle: the website → right: its own APIs and outside services. */
export function diagram(map) {
  const row = 30;
  const pages = map.pages.slice(0, 10);
  const morePages = map.pages.length - pages.length;
  const apis = apiGroups(map);
  const services = serviceGroups(map);
  const apiRows = (groups, heading, limit) => {
    const shown = groups.slice(0, limit);
    return [
      ...(shown.length ? [{ heading }] : []),
      ...shown.map((group) => ({ text: clip(group.label, 30), note: `${group.endpoints} endpoint${group.endpoints === 1 ? "" : "s"}${group.methods.size ? " · " + [...group.methods].join(" ") : ""}`, kind: "api" })),
      ...(groups.length > shown.length ? [{ text: `${groups.length - shown.length} more groups`, kind: "more" }] : []),
    ];
  };
  const right = [
    ...apiRows(apis.filter((group) => group.firstParty), "Their own APIs", 10),
    ...apiRows(apis.filter((group) => !group.firstParty), "Other APIs", 4),
    ...(services.length ? [{ heading: "Outside services" }] : []),
    ...services.map((group) => ({ text: group.category, note: clip(group.names.join(", "), 38), kind: "service" })),
  ];
  const left = [
    ...(pages.length ? [{ heading: "Pages seen in code" }] : []),
    ...pages.map((page) => ({ text: clip(page, 26), kind: "page" })),
    ...(morePages > 0 ? [{ text: `${morePages} more pages`, kind: "more" }] : []),
  ];
  const rows = Math.max(left.length, right.length, 4);
  const height = rows * row + 20;
  const width = 920;
  const center = { x: 330, y: height / 2 - 48, width: 220, height: 96 };
  const middle = center.y + center.height / 2;
  const curve = (x1, y1, x2, y2) => {
    const bend = (x2 - x1) / 2;
    return `<path class="map-link" d="M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}"/>`;
  };
  const column = (items, x, anchor) => items.map((item, index) => {
    const y = 20 + index * row + row / 2;
    if (item.heading) return `<text class="map-heading" x="${x}" y="${y + 4}" text-anchor="${anchor}">${escape(item.heading.toUpperCase())}</text>`;
    const note = item.note ? `<tspan class="map-note" dx="8">${escape(item.note)}</tspan>` : "";
    const link = item.kind === "more" ? "" : anchor === "end"
      ? curve(x + 8, y, center.x, middle)
      : curve(center.x + center.width, middle, x - 8, y);
    return `${link}<text class="map-item map-${item.kind}" x="${x}" y="${y + 4}" text-anchor="${anchor}">${escape(item.text)}${note}</text>`;
  }).join("");
  const stack = [map.frameworks.join(", "), map.hosting.join(", ")].filter(Boolean).join(" on ");
  return `<svg class="backend-diagram" viewBox="0 0 ${width} ${height}" role="img" aria-label="Diagram of the pages, APIs, and outside services referenced in this website's code">
    ${column(left, 250, "end")}
    ${column(right, 590, "start")}
    <rect class="map-site" x="${center.x}" y="${center.y}" width="${center.width}" height="${center.height}" rx="4"/>
    <text class="map-site-name" x="${center.x + center.width / 2}" y="${middle - 6}" text-anchor="middle">${escape(clip(host(map.url), 28))}</text>
    <text class="map-site-note" x="${center.x + center.width / 2}" y="${middle + 16}" text-anchor="middle">${escape(clip(stack || "Browser code", 34))}</text>
  </svg>`;
}

export function backendSection(map) {
  const endpoints = map.apis.flatMap((api) => api.endpoints.map((endpoint) => ({ ...endpoint, origin: api.origin })));
  const list = (title, items) => items.length
    ? `<details class="backend-list"><summary>${escape(title)} (${items.length})</summary><ul>${items.map((item) => `<li><code>${escape(item)}</code></li>`).join("")}</ul></details>`
    : "";
  const nothing = !endpoints.length && !map.services.length && !map.pages.length;
  return `<section class="backend-map"><h2>How the site talks to servers</h2>
    <p class="history-context">Built from ${map.bundles.toLocaleString()} captured script${map.bundles === 1 ? "" : "s"}${map.incomplete ? ", not every script was captured" : ""}. These are requests the browser code can make. They don't prove an endpoint is live or show what the server does.</p>
    ${nothing ? "<p>No API calls or outside services found in the captured code.</p>" : diagram(map)}
    ${endpoints.length ? `<details class="backend-list"><summary>Endpoints (${endpoints.length})</summary><div class="data-scroll"><table><thead><tr><th>Method</th><th>Path</th><th>Parameters</th></tr></thead><tbody>${endpoints.map((endpoint) => `<tr><td>${escape(endpoint.methods.join(" ") || "—")}</td><td><code>${escape((host(endpoint.origin) === host(map.url) ? "" : host(endpoint.origin)) + endpoint.path)}</code></td><td>${escape(endpoint.params.join(", "))}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
    ${list("Pages", map.pages)}
    ${list("GraphQL operations", map.graphql)}
    ${list("Live connections", map.websockets)}
    ${list("Other outside hosts", map.otherHosts)}
    ${map.sourceMaps ? `<p class="fine-print">${map.sourceMaps} script${map.sourceMaps === 1 ? " points" : "s point"} to a public source map.</p>` : ""}
  </section>`;
}
