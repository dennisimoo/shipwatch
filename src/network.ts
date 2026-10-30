import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import ipaddr from "ipaddr.js";
import { getDomain } from "tldts";

export function sameSite(left: string, right: string): boolean {
  const leftHost = new URL(left).hostname;
  const rightHost = new URL(right).hostname;
  const domain = getDomain(leftHost, { allowPrivateDomains: true });
  return leftHost === rightHost || (domain !== null && domain === getDomain(rightHost, { allowPrivateDomains: true }));
}

export function apiSchema(source: string): boolean {
  try {
    const document = JSON.parse(source);
    return document !== null && typeof document === "object" &&
      (typeof document.openapi === "string" || document.swagger === "2.0") &&
      document.paths !== null && typeof document.paths === "object" && !Array.isArray(document.paths);
  } catch {
    return false;
  }
}

export function publicAddress(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.parse(address).range() === "unicast";
}

export function normalizeUrl(input: string): URL {
  input = input.trim();
  const target = new URL(input.includes("://") ? input : `https://${input}`);
  if (
    !["https:", "http:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    (target.port && target.port !== "80" && target.port !== "443") ||
    target.hostname.length > 253 ||
    !target.hostname.includes(".")
  ) {
    throw new Error("Use a public HTTP or HTTPS website on port 80 or 443.");
  }
  target.hash = "";
  return target;
}

export interface PageResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
  bytes: number;
  transferBytes?: number;
}

/** A site asked us to slow down (429/503 + Retry-After) or served a bot challenge. */
export class BackoffError extends Error {
  constructor(message: string, readonly seconds: number) {
    super(message);
  }
}

export function retryAfterSeconds(value: string | string[] | undefined, fallback: number): number {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return fallback;
  const seconds = /^\d+$/.test(header.trim())
    ? Number(header)
    : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(21600, Math.max(fallback, Math.ceil(seconds))) : fallback;
}

/** Throws a BackoffError when a response says the site is limiting or challenging us. */
export function checkBackoff(response: PageResponse) {
  if (String(response.headers["cf-mitigated"] || "") === "challenge")
    throw new BackoffError("Website served a bot challenge", 21600);
  if (response.status === 429)
    throw new BackoffError("Website rate limited Shipwatch (HTTP 429)", retryAfterSeconds(response.headers["retry-after"], 900));
  if (response.status === 503 && response.headers["retry-after"])
    throw new BackoffError("Website asked Shipwatch to retry later (HTTP 503)", retryAfterSeconds(response.headers["retry-after"], 600));
}

const lastRequest = new Map<string, number>();
const defaultGap = 250;

/** Space requests to the same host so one check never bursts a site. */
async function pace(hostname: string) {
  const gap = defaultGap;
  const previous = lastRequest.get(hostname) ?? 0;
  const at = Math.max(Date.now(), previous + gap);
  lastRequest.set(hostname, at);
  if (lastRequest.size > 5000)
    for (const [host, time] of lastRequest)
      if (time < Date.now() - 60000) lastRequest.delete(host);
  if (at > Date.now()) await Bun.sleep(at - Date.now());
}

export async function fetchPublic(
  input: string,
  headers: Record<string, string> = {},
  limit = 2_000_000,
  redirects = 0,
  scope?: (url: URL) => boolean,
): Promise<PageResponse> {
  const target = normalizeUrl(input);
  if (scope && !scope(target)) throw new Error("Redirect outside the allowed website");
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DNS timeout")), 5000).unref(),
    ),
  ]);
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address))
  )
    throw new Error("Private or reserved destination blocked.");
  await pace(hostname);
  const address = addresses.find((entry) => entry.family === 4) || addresses[0];
  const response = await new Promise<PageResponse>((resolve, reject) => {
    const requester = target.protocol === "https:" ? https : http;
    const request = requester.get(
      target,
      {
        headers: {
          "User-Agent":
            "Shipwatch/0.1 (+https://github.com/dennisimoo/shipwatch)",
          "Accept-Encoding": "br, gzip",
          ...headers,
        },
        family: address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let transferBytes = 0;
        const encoding = String(incoming.headers["content-encoding"] || "").trim().toLowerCase();
        const decoder = incoming.statusCode === 204 || incoming.statusCode === 304 ? null
          : encoding === "br" ? zlib.createBrotliDecompress()
          : encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
          : encoding === "deflate" ? zlib.createInflate()
          : null;
        const fail = (error: Error) => {
          incoming.destroy();
          decoder?.destroy();
          reject(error);
        };
        incoming.on("data", (chunk: Buffer) => { transferBytes += chunk.length; });
        const body = decoder ? incoming.pipe(decoder) : incoming;
        body.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) fail(new Error("Response exceeds size limit"));
          else chunks.push(chunk);
        });
        incoming.on("error", reject);
        decoder?.on("error", () => fail(new Error("Response could not be decompressed")));
        body.on("end", () => {
          if (decoder) {
            delete incoming.headers["content-encoding"];
            delete incoming.headers["content-length"];
          }
          resolve({
            status: incoming.statusCode || 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            url: target.href,
            bytes,
            transferBytes,
          });
        });
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("Request timeout")),
      12000,
    );
    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject);
  });
  if (
    [301, 302, 303, 307, 308].includes(response.status) &&
    response.headers.location
  ) {
    if (redirects >= 4) throw new Error("Too many redirects");
    return fetchPublic(
      new URL(response.headers.location, target).href,
      headers,
      limit,
      redirects + 1,
      scope,
    );
  }
  return response;
}
