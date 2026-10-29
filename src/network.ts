import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [first, second, third] = octets;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 168 || second === 0 || second === 2)) ||
      (first === 198 &&
        (second === 18 || second === 19 || (second === 51 && third === 100))) ||
      (first === 203 && second === 0 && third === 113)
    );
  }
  if (isIP(address) === 6) {
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2001:(db8|0|10|20):/i.test(address) &&
      !/^2002:/i.test(address)
    );
  }
  return false;
}

export function normalizeUrl(input: string): URL {
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
): Promise<PageResponse> {
  const target = normalizeUrl(input);
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
    );
  }
  return response;
}

export function robotsAllowed(text: string, path: string): boolean {
  const groups: {
    agents: string[];
    rules: { path: string; allow: boolean }[];
  }[] = [];
  let group: (typeof groups)[number] = { agents: [], rules: [] };
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (group.rules.length) {
        groups.push(group);
        group = { agents: [], rules: [] };
      }
      group.agents.push(value.toLowerCase());
    } else if (
      (key === "allow" || key === "disallow") &&
      value &&
      group.agents.length
    ) {
      group.rules.push({ path: value, allow: key === "allow" });
    }
  }
  groups.push(group);
  const specific = groups.filter((entry) =>
    entry.agents.some((agent) => agent !== "*" && "shipwatch".includes(agent)),
  );
  const applicable = specific.length
    ? specific
    : groups.filter((entry) => entry.agents.includes("*"));
  const matches = applicable
    .flatMap((entry) => entry.rules)
    .filter((rule) => {
      const anchored = rule.path.endsWith("$");
      const parts = (anchored ? rule.path.slice(0, -1) : rule.path).split("*");
      let cursor = 0;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const position =
          index === 0
            ? path.startsWith(part)
              ? 0
              : -1
            : anchored && index === parts.length - 1
              ? path.endsWith(part)
                ? path.length - part.length
                : -1
              : path.indexOf(part, cursor);
        if (position < cursor) return false;
        cursor = position + part.length;
      }
      return !anchored || cursor === path.length;
    })
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        Number(right.allow) - Number(left.allow),
    );
  return matches[0]?.allow ?? true;
}
