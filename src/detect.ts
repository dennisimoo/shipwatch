import { createHash } from "node:crypto";
import { apiSchema, checkBackoff, fetchPublic, sameSite } from "./network";
import { decodeHTMLAttribute } from "entities";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface Asset {
  hash: string;
  contentHash?: string;
  method?: string;
  references?: string[];
  etag?: string;
  modified?: string;
  immutable?: boolean;
  fetchedAt?: number;
  /** Decoded size, so the inspection budget is spent the same way whether an asset was reused or fetched. */
  size?: number;
}

const revalidateAfter = 86400;

/** Hashed asset URLs that the server declares cacheable for a month or forever never change in place. */
export function immutableAsset(address: string, cacheControl: string | string[] | undefined): boolean {
  const header = String(cacheControl || "").toLowerCase();
  if (/no-store|no-cache/.test(header)) return false;
  const maxAge = Number(/(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/.exec(header)?.[1] ?? 0);
  const plain = new URL(address);
  plain.searchParams.delete("dpl");
  plain.hash = "";
  const hashed = assetIdentity(address) !== plain.href;
  return hashed && (header.includes("immutable") || maxAge >= 2592000);
}

/** Per-site paths on site-builder CDNs (Framer, Webflow) belong to that one site, so they count as first-party. */
export function builderSite(address: string): string | null {
  const target = new URL(address);
  if (target.hostname === "framerusercontent.com") {
    const id = /^\/sites\/([A-Za-z0-9]{8,40})\//.exec(target.pathname)?.[1];
    return id ? "framer:" + id : null;
  }
  if (/^(?:cdn\.prod\.website-files\.com|assets\.website-files\.com|assets-global\.website-files\.com)$/.test(target.hostname)) {
    const id = /^\/([a-f0-9]{24})\/js\//.exec(target.pathname)?.[1];
    return id ? "webflow:" + id : null;
  }
  return null;
}

const scanner = new Bun.Transpiler({ loader: "js" });
const assetLimit = 128;
const byteLimit = 20_000_000;

export function assetIdentity(address: string): string {
  const target = new URL(address);
  target.searchParams.delete("dpl");
  target.hash = "";
  target.pathname = target.pathname.replace(
    /(?:[-.][a-f0-9]{8,}|-[A-Za-z0-9_-]{8})(?=\.(?:m?js|css)$)/gi,
    "-CONTENT",
  ).replace(/\/[a-f0-9]{8,}(?=\.(?:m?js|css)$)/gi, "/CONTENT")
    .replace(/(\/_next\/static\/)[^/]+(\/(?:_buildManifest|_ssgManifest)\.js)$/, "$1BUILD$2");
  return target.href;
}

export function normalizeContent(source: string, address: string): string {
  const debugIds = source.matchAll(
    /(?:_sentryDebugIds|_debugIds)(?:\[[^\]]+\]|\s*\|\|\s*\([^)]*\)\s*\)\s*\[[^\]]+\])\s*=\s*["'`]([0-9a-f-]{36})["'`]/gi,
  );
  let normalized = source;
  for (const match of debugIds)
    normalized = normalized.replaceAll(match[1], "SENTRY_DEBUG_ID");
  return normalized
    .replace(/(["'`])dpl_[A-Za-z0-9]+\1/g, '$1VERCEL_DEPLOYMENT_ID$1')
    .replace(/^\s*\/\/[#@]\s*(?:sourceMappingURL|debugId)=[^\n]*$/gm, "")
    .replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, "")
    .replace(
      /(SENTRY_RELEASE\s*=\s*\{\s*id\s*:\s*)(["'`])[^"'`]*\2/g,
      '$1"SENTRY_RELEASE_ID"',
    )
    .replace(
      /(["'`])((?:\.{0,2}\/|https?:\/\/|(?:assets|static)\/)[^"'`\s<>]+?\.(?:m?js|css)(?:\?[^"'`\s<>]*)?)\1/g,
      (match, quote, reference) => {
        try {
          return quote + assetIdentity(new URL(reference, address).href) + quote;
        } catch {
          return match;
        }
      },
    );
}

export function bundleReferences(source: string, address: string): string[] {
  const references = /\.css(?:\?|$)/.test(address)
    ? []
    : scanner.scanImports(source).map((entry) => entry.path);
  const viteMap = source.match(/__vite__mapDeps[^;]*?m\.f\s*=\s*\[([^\]]*)\]/)?.[1];
  if (viteMap)
    for (const match of viteMap.matchAll(/["']([^"']+\.(?:m?js|css)(?:\?[^"']*)?)["']/g))
      references.push(new URL(match[1], new URL("../", address)).href);
  return [...new Set(references
    .filter((reference) => /^(?:\.{0,2}\/|https?:\/\/)/.test(reference))
    .map((reference) => new URL(reference, address).href)
    .filter((reference) => /\.(?:m?js|css)(?:\?|$)/.test(reference)))];
}
export interface Snapshot {
  fingerprint: string;
  assets: Record<string, Asset>;
  evidence: string;
  bytes: number;
  transferBytes: number;
  captureScope: string;
}

const hostingHeaders: [string, (headers: Record<string, unknown>) => boolean][] = [
  ["Vercel", (headers) => "x-vercel-id" in headers || /vercel/i.test(String(headers.server))],
  ["Netlify", (headers) => "x-nf-request-id" in headers || /netlify/i.test(String(headers.server))],
  ["Cloudflare", (headers) => "cf-ray" in headers],
  ["AWS CloudFront", (headers) => "x-amz-cf-id" in headers],
  ["Fly.io", (headers) => "fly-request-id" in headers],
  ["Render", (headers) => "rndr-id" in headers || "x-render-origin-server" in headers],
  ["Railway", (headers) => "x-railway-request-id" in headers || /railway/i.test(String(headers.server))],
  ["GitHub Pages", (headers) => "x-github-request-id" in headers],
  ["Google Cloud", (headers) => /^(?:Google Frontend|gws)$/i.test(String(headers.server))],
  ["Firebase Hosting", (headers) => /firebase/i.test(String(headers["x-powered-by"] ?? ""))],
];

/** Names the hosting/CDN layer from response headers (provider names only, no request IDs). */
export function hostingFromHeaders(headers: Record<string, unknown>): string[] {
  return hostingHeaders.filter(([, test]) => test(headers)).map(([name]) => name);
}

/** Platform deploy identifiers: Vercel's dpl_ IDs (stable per deployment), else the Next.js buildId. */
export function deploymentId(html: string, build: string | null): string | null {
  const vercel = /\bdpl_[A-Za-z0-9]{10,64}\b/.exec(html)?.[0];
  return vercel ?? (build ? "next:" + build : null);
}

export async function extractScripts(
  html: string,
  base: string,
): Promise<string[]> {
  const scripts: string[] = [];
  await new HTMLRewriter()
    .on("script[src], link[rel=modulepreload], link[rel=preload][as=script]", {
      element(element) {
        const raw = element.getAttribute("src") || element.getAttribute("href");
        if (!raw) return;
        try {
          const target = new URL(decodeHTMLAttribute(raw), base);
          if (!["https:", "http:"].includes(target.protocol)) return;
          if (!sameSite(base, target.href) && !builderSite(target.href))
            return;
          if (
            /analytics|gtag|googletag|segment|hotjar|clarity|intercom|tracking|pixel/i.test(
              target.pathname,
            )
          )
            return;
          target.hash = "";
          scripts.push(target.href);
        } catch {}
      },
    })
    .transform(new Response(html))
    .text();
  return [...new Set(scripts)].sort();
}

export async function snapshot(
  url: string,
  previous: Record<string, Asset>,
  saveBody?: (hash: string, body: string) => void,
  previousScope?: string,
): Promise<Snapshot> {
  const page = await fetchPublic(url, { Accept: "text/html, application/json;q=0.9" });
  checkBackoff(page);
  if (page.status !== 200)
    throw new Error(`Website returned HTTP ${page.status}`);
  if (apiSchema(page.body)) {
    const digest = hash(page.body);
    const contentHash = hash(JSON.stringify(JSON.parse(page.body)));
    saveBody?.(digest, page.body);
    const evidence = JSON.stringify({ method: "content-v3", content: [{ url: page.url, hash: digest, contentHash }] });
    return { fingerprint: "content-v3:" + contentHash, assets: {}, evidence, bytes: page.bytes, transferBytes: page.transferBytes ?? page.bytes, captureScope: "registrable-128-v2" };
  }
  if (!String(page.headers["content-type"] || "").includes("text/html"))
    throw new Error("Website did not return HTML or a public API schema");
  const scripts = await extractScripts(page.body, page.url);
  if (!scripts.length)
    throw new Error("No observable first-party JavaScript on this page");
  const build = page.body.match(/"buildId"\s*:\s*"([^"<>]{1,200})"/)?.[1] || null;
  const result = await inspectBundles(page.url, scripts, previous, page.bytes, build, saveBody, previousScope);
  result.transferBytes += page.transferBytes ?? page.bytes;
  const hosting = hostingFromHeaders(page.headers);
  const deployment = deploymentId(page.body, build);
  if (hosting.length || deployment)
    result.evidence = JSON.stringify({ ...JSON.parse(result.evidence), ...(hosting.length ? { hosting } : {}), ...(deployment ? { deployment } : {}) });
  return result;
}

export async function inspectBundles(
  url: string,
  scripts: string[],
  previous: Record<string, Asset> = {},
  initialBytes = 0,
  build: string | null = null,
  saveBody?: (hash: string, body: string) => void,
  previousScope?: string,
): Promise<Snapshot> {
  const assets: Record<string, Asset> = {};
  let bytes = initialBytes;
  let transferBytes = 0;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const builders = new Set(scripts.map(builderSite).filter(Boolean));
  const firstParty = (address: string) => sameSite(url, address) || builders.has(builderSite(address));
  const missing: string[] = [];
  // Chunks that did not fit the remaining budget; remembered for a day so they aren't re-downloaded every check.
  const tooLarge: Record<string, Asset> = {};
  const queue = scripts.filter(firstParty);
  const queued = new Set(queue);
  for (let index = 0; index < queue.length && Object.keys(assets).length < assetLimit; index++) {
    const script = queue[index];
    const old = previous[script];
    if (bytes >= byteLimit) {
      if (!Object.keys(assets).length) throw new Error("Bundle inspection exceeds size limit");
      break;
    }
    const limit = Math.min(5_000_000, byteLimit - bytes);
    const currentCache = old?.method === "content-v3.1" && typeof old.size === "number";
    if (currentCache && old.size! > limit) {
      if (!Object.keys(assets).length) throw new Error("Bundle inspection exceeds size limit");
      break;
    }
    if (currentCache && old.immutable && old.fetchedAt && fetchedAt - old.fetchedAt < revalidateAfter) {
      assets[script] = old;
      bytes += old.size!;
      for (const reference of old.references ?? [])
        if (firstParty(reference) && !queued.has(reference)) {
          queue.push(reference);
          queued.add(reference);
        }
      continue;
    }
    const headers: Record<string, string> = {};
    if (currentCache && old.etag) headers["If-None-Match"] = old.etag;
    if (currentCache && old.modified) headers["If-Modified-Since"] = old.modified;
    if (old?.method === "too-large" && old.fetchedAt && fetchedAt - old.fetchedAt < revalidateAfter && (old.size ?? 0) > limit) {
      tooLarge[script] = old;
      break;
    }
    let asset;
    try {
      asset = await fetchPublic(script, headers, limit);
    } catch (error) {
      // Past the budget, leave the remaining chunks uninspected rather than failing the whole site.
      if (Object.keys(assets).length && error instanceof Error && error.message === "Response exceeds size limit") {
        tooLarge[script] = { hash: "", method: "too-large", size: limit + 1, fetchedAt };
        break;
      }
      throw error;
    }
    bytes += asset.status === 304 && currentCache ? old.size! : asset.bytes;
    transferBytes += asset.transferBytes ?? asset.bytes;
    checkBackoff(asset);
    if (!firstParty(asset.url)) throw new Error("Bundle redirected outside the website's domain");
    const html = String(asset.headers["content-type"]).includes("text/html");
    if ([404, 410].includes(asset.status) || (asset.status === 200 && html)) {
      // Stale chunk references and SPA fallbacks serving index.html are common; note them instead of failing the site.
      missing.push(script);
      continue;
    }
    if (asset.status === 304 && currentCache)
      assets[script] = { ...old, immutable: asset.headers["cache-control"] === undefined
        ? old.immutable : immutableAsset(script, asset.headers["cache-control"]), fetchedAt };
    else if (asset.status === 200) {
      let references: string[] = [];
      try {
        references = bundleReferences(asset.body, asset.url);
      } catch {
        // Unparseable bundles still fingerprint by content; only reference following is skipped.
      }
      assets[script] = {
        hash: hash(asset.body),
        contentHash: hash(normalizeContent(asset.body, asset.url)),
        method: "content-v3.1",
        references,
        etag: asset.headers.etag,
        modified: asset.headers["last-modified"],
        immutable: immutableAsset(script, asset.headers["cache-control"]),
        fetchedAt,
        size: asset.bytes,
      };
      saveBody?.(assets[script].hash, asset.body);
    } else throw new Error(`Bundle returned HTTP ${asset.status}`);
    for (const reference of assets[script].references ?? []) {
      if (
        firstParty(reference) &&
        !queued.has(reference)
      ) {
        queue.push(reference);
        queued.add(reference);
      }
    }
  }
  const entries = scripts.filter(firstParty);
  if (entries.length && entries.every((script) => missing.includes(script)))
    throw new Error("Every first-party script is missing");
  const evidence = JSON.stringify({
    method: "content-v3",
    scripts,
    content: Object.entries(assets).map(([url, asset]) => ({
      url,
      hash: asset.hash,
      contentHash: asset.contentHash,
    })),
    build,
    uninspected: queue.filter((script) => !assets[script] && !missing.includes(script)),
    ...(missing.length ? { missing } : {}),
  });
  const content = Object.entries(assets)
    .map(([address, asset]) => [assetIdentity(address), asset.contentHash])
    .sort();
  const uninspected = queue.filter((script) => !assets[script] && !missing.includes(script)).map(assetIdentity).sort();
  // Missing chunks join the fingerprint only when present, so sites without them keep their existing fingerprints.
  const gone = missing.map(assetIdentity).sort();
  const fingerprint = "content-v3:" + hash(JSON.stringify(gone.length ? { content, uninspected, missing: gone } : { content, uninspected }));
  // Sticky once a site has used builder assets, so one page load without them can't reset the baseline.
  const captureScope = builders.size || previousScope === "registrable-128-v3" || Object.keys(previous).some(builderSite)
    ? "registrable-128-v3" : "registrable-128-v2";
  return { fingerprint, assets: { ...assets, ...tooLarge }, evidence, bytes, transferBytes, captureScope };
}
