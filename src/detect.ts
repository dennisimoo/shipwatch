import { createHash } from "node:crypto";
import { fetchPublic } from "./network";
import { decodeHTMLAttribute } from "entities";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface Asset {
  hash: string;
  etag?: string;
  modified?: string;
}
export interface Snapshot {
  fingerprint: string;
  assets: Record<string, Asset>;
  evidence: string;
  bytes: number;
}

export async function extractScripts(
  html: string,
  base: string,
): Promise<string[]> {
  const scripts: string[] = [];
  const rootHost = new URL(base).hostname.replace(/^www\./, "");
  await new HTMLRewriter()
    .on("script[src], link[rel=modulepreload], link[rel=preload][as=script]", {
      element(element) {
        const raw = element.getAttribute("src") || element.getAttribute("href");
        if (!raw) return;
        try {
          const target = new URL(decodeHTMLAttribute(raw), base);
          if (!["https:", "http:"].includes(target.protocol)) return;
          if (
            target.hostname !== rootHost &&
            !target.hostname.endsWith(`.${rootHost}`)
          )
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
): Promise<Snapshot> {
  const page = await fetchPublic(url, { Accept: "text/html" });
  if (page.status !== 200)
    throw new Error(`Website returned HTTP ${page.status}`);
  if (!String(page.headers["content-type"] || "").includes("text/html"))
    throw new Error("Website did not return HTML");
  if (!(await allow(page.url)))
    throw new Error("Monitoring disallowed by robots.txt");
  const scripts = await extractScripts(page.body, page.url);
  if (!scripts.length)
    throw new Error("No observable first-party JavaScript on this page");
  const assets: Record<string, Asset> = {};
  let bytes = page.bytes;
  const stable = scripts
    .filter(
      (script) =>
        !/[._/-][a-f0-9]{8,}(?:[._/-]|\?)/i.test(new URL(script).pathname),
    )
    .slice(0, 8);
  for (const script of stable) {
    if (!(await allow(script)))
      throw new Error("Script monitoring disallowed by robots.txt");
    const old = previous[script];
    const headers: Record<string, string> = {};
    if (old?.etag) headers["If-None-Match"] = old.etag;
    if (old?.modified) headers["If-Modified-Since"] = old.modified;
    const asset = await fetchPublic(script, headers, 5_000_000);
    bytes += asset.bytes;
    if (asset.status === 304 && old) assets[script] = old;
    else if (
      asset.status === 200 &&
      !String(asset.headers["content-type"]).includes("text/html")
    ) {
      assets[script] = {
        hash: hash(asset.body),
        etag: asset.headers.etag,
        modified: asset.headers["last-modified"],
      };
    } else throw new Error(`Script returned HTTP ${asset.status}`);
  }
  const build =
    page.body.match(/"buildId"\s*:\s*"([^"<>]{1,200})"/)?.[1] || null;
  const evidence = JSON.stringify({
    scripts,
    content: Object.entries(assets).map(([url, asset]) => ({
      url,
      hash: asset.hash,
    })),
    build,
  });
  return { fingerprint: hash(evidence), assets, evidence, bytes };
}
