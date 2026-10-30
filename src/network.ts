import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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
  const address = addresses.find((entry) => entry.family === 4) || addresses[0];
  const response = await new Promise<PageResponse>((resolve, reject) => {
    const requester = target.protocol === "https:" ? https : http;
    const request = requester.get(
      target,
      {
        headers: {
          "User-Agent":
            "Shipwatch/0.1 (+https://github.com/dennisimoo/shipwatch)",
          "Accept-Encoding": "identity",
          ...headers,
        },
        family: address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit)
            incoming.destroy(new Error("Response exceeds size limit"));
          else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode || 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            url: target.href,
            bytes,
          }),
        );
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
