import { createHash } from "node:crypto";
import { apiSchema, fetchPublic, sameSite } from "./network";
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
  captureScope: string;
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
          if (!sameSite(base, target.href))
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
  allow: (url: string) => Promise<boolean> = async () => true,
  saveBody?: (hash: string, body: string) => void,
): Promise<Snapshot> {
  const page = await fetchPublic(url, { Accept: "text/html, application/json;q=0.9" });
  if (page.status !== 200)
    throw new Error(`Website returned HTTP ${page.status}`);
  if (!(await allow(page.url)))
    throw new Error("Monitoring disallowed by robots.txt");
  if (apiSchema(page.body)) {
    const digest = hash(page.body);
    const contentHash = hash(JSON.stringify(JSON.parse(page.body)));
    saveBody?.(digest, page.body);
    const evidence = JSON.stringify({ method: "content-v3", content: [{ url: page.url, hash: digest, contentHash }] });
    return { fingerprint: "content-v3:" + contentHash, assets: {}, evidence, bytes: page.bytes, captureScope: "registrable-128-v2" };
  }
  if (!String(page.headers["content-type"] || "").includes("text/html"))
    throw new Error("Website did not return HTML or a public API schema");
  const scripts = await extractScripts(page.body, page.url);
  if (!scripts.length)
    throw new Error("No observable first-party JavaScript on this page");
  const build = page.body.match(/"buildId"\s*:\s*"([^"<>]{1,200})"/)?.[1] || null;
  return inspectBundles(page.url, scripts, previous, allow, page.bytes, build, saveBody);
}

export async function inspectBundles(
  url: string,
  scripts: string[],
  previous: Record<string, Asset> = {},
  allow: (url: string) => Promise<boolean> = async () => true,
  initialBytes = 0,
  build: string | null = null,
  saveBody?: (hash: string, body: string) => void,
): Promise<Snapshot> {
  const assets: Record<string, Asset> = {};
  let bytes = initialBytes;
  const queue = scripts.filter((script) => sameSite(url, script));
  const queued = new Set(queue);
  for (let index = 0; index < queue.length && Object.keys(assets).length < assetLimit; index++) {
    const script = queue[index];
    if (!(await allow(script)))
      throw new Error("Script monitoring disallowed by robots.txt");
    const old = previous[script];
    const headers: Record<string, string> = {};
    const currentCache = old?.method === "content-v3.1";
    if (currentCache && old.etag) headers["If-None-Match"] = old.etag;
    if (currentCache && old.modified) headers["If-Modified-Since"] = old.modified;
    if (bytes >= byteLimit) throw new Error("Bundle inspection exceeds size limit");
    const asset = await fetchPublic(script, headers, Math.min(5_000_000, byteLimit - bytes));
    bytes += asset.bytes;
    if (!sameSite(url, asset.url)) throw new Error("Bundle redirected outside the website's domain");
    if (!(await allow(asset.url))) throw new Error("Bundle monitoring disallowed by robots.txt");
    if (asset.status === 304 && currentCache) assets[script] = old;
    else if (
      asset.status === 200 &&
      !String(asset.headers["content-type"]).includes("text/html")
    ) {
      assets[script] = {
        hash: hash(asset.body),
        contentHash: hash(normalizeContent(asset.body, asset.url)),
        method: "content-v3.1",
        references: bundleReferences(asset.body, asset.url),
        etag: asset.headers.etag,
        modified: asset.headers["last-modified"],
      };
      saveBody?.(assets[script].hash, asset.body);
    } else throw new Error(`Bundle returned HTTP ${asset.status}`);
    for (const reference of assets[script].references ?? []) {
      if (
        sameSite(url, reference) &&
        !queued.has(reference)
      ) {
        queue.push(reference);
        queued.add(reference);
      }
    }
  }
  const evidence = JSON.stringify({
    method: "content-v3",
    scripts,
    content: Object.entries(assets).map(([url, asset]) => ({
      url,
      hash: asset.hash,
      contentHash: asset.contentHash,
    })),
    build,
    uninspected: queue.filter((script) => !assets[script]),
  });
  const content = Object.entries(assets)
    .map(([address, asset]) => [assetIdentity(address), asset.contentHash])
    .sort();
  const uninspected = queue.filter((script) => !assets[script]).map(assetIdentity).sort();
  return { fingerprint: "content-v3:" + hash(JSON.stringify({ content, uninspected })), assets, evidence, bytes, captureScope: "registrable-128-v2" };
}
