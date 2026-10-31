import { gunzipSync } from "node:zlib";
import { db } from "./db";
import { apiSchema, sameSite } from "./network";

export interface Reference {
  url: string;
  type?: string;
  method: string;
  queryParams: string[];
  bodyParams: string[];
}
interface Evidence {
  content: { url: string; hash: string }[];
  missing?: string[];
  uninspected?: string[];
}
const extractionVersion = 2;
const navigationTypes = /^(?:locationAssignment|locationReplacement|window\.open|location\.href)$/;
const requestReference = (entry: Pick<Reference, "method" | "type">) =>
  !navigationTypes.test(entry.type ?? "") &&
  (!!entry.method || entry.type === "fetch" || /^axios\./.test(entry.type ?? ""));

export async function extract(digest: string): Promise<Reference[]> {
  const cached = db.query("SELECT entries FROM api_references WHERE hash=? AND version=?").get(digest, extractionVersion) as { entries: string } | null;
  if (cached) return JSON.parse(cached.entries);
  const row = db.query("SELECT body FROM bundle_bodies WHERE hash=?").get(digest) as { body: Uint8Array } | null;
  if (!row) throw new Error("API reference source was not archived");
  if (!Bun.which("jsluice")) throw new Error("API reference extraction requires jsluice");
  const source = gunzipSync(row.body).toString();
  if (apiSchema(source)) return [];
  const child = Bun.spawn(["jsluice", "urls", "-I", "/dev/stdin"], {
    stdin: new Blob([source]), stdout: "pipe", stderr: "ignore",
  });
  const deadline = setTimeout(() => child.kill(), 10000);
  let output = "";
  try {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (output.length > 2_000_000) throw new Error("API extraction output exceeds limit");
    }
    if (await child.exited !== 0) throw new Error("API extraction failed or timed out");
    const entries = output.trim() ? output.trim().split("\n").map((line) => JSON.parse(line)) : [];
    const references: Reference[] = entries.filter((entry) =>
      typeof entry.url === "string" && typeof entry.method === "string" &&
      (requestReference(entry) || navigationTypes.test(String(entry.type))) &&
      Array.isArray(entry.queryParams) && Array.isArray(entry.bodyParams),
    ).map((entry) => ({ url: entry.url, type: typeof entry.type === "string" ? entry.type : undefined, method: entry.method.toUpperCase() ||
      /^axios\.(get|post|put|patch|delete|head|options)$/.exec(String(entry.type))?.[1].toUpperCase() || "",
      queryParams: entry.queryParams.filter((value: unknown) => typeof value === "string"),
      bodyParams: entry.bodyParams.filter((value: unknown) => typeof value === "string"),
    }));
    const explicitMethods = new Set(references.filter((entry) => requestReference(entry) && entry.method).map((entry) => entry.url));
    const distinct = references.filter((entry) => !requestReference(entry) || entry.method || !explicitMethods.has(entry.url));
    db.query(`INSERT INTO api_references(hash,entries,version) VALUES (?,?,?)
      ON CONFLICT(hash) DO UPDATE SET entries=excluded.entries,version=excluded.version`)
      .run(digest, JSON.stringify(distinct), extractionVersion);
    return distinct;
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}

export async function apiChanges(before: Evidence, after: Evidence, pageUrl: string) {
  const deadline = Date.now() + 20000;
  const inventory = async (evidence: Evidence) => {
    const references = new Set<string>();
    for (const asset of evidence.content) {
      if (Date.now() >= deadline) throw new Error("API extraction exceeded comparison deadline");
      if (/\.css(?:\?|$)/.test(asset.url)) continue;
      for (const entry of await extract(asset.hash)) {
        if (!requestReference(entry)) continue;
        let target: URL;
        try { target = new URL(entry.url, pageUrl); } catch { continue; }
        if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || !sameSite(pageUrl, target.href)) continue;
        const parameters = [...new Set([...target.searchParams.keys(), ...entry.queryParams])].sort();
        references.add(JSON.stringify({ url: target.origin + target.pathname, method: entry.method || "unspecified",
          queryParams: parameters, bodyParams: [...new Set(entry.bodyParams)].sort() }));
      }
    }
    return references;
  };
  const previous = await inventory(before);
  const current = await inventory(after);
  const availableAdded = [...current].filter((entry) => !previous.has(entry)).sort();
  const availableRemoved = [...previous].filter((entry) => !current.has(entry)).sort();
  const previousUnavailable = !!(before.missing?.length || before.uninspected?.length);
  const currentUnavailable = !!(after.missing?.length || after.uninspected?.length);
  const added = previousUnavailable ? [] : availableAdded;
  const removed = currentUnavailable ? [] : availableRemoved;
  return { added: added.slice(0, 100).map((entry) => JSON.parse(entry)),
    removed: removed.slice(0, 100).map((entry) => JSON.parse(entry)),
    truncated: added.length > 100 || removed.length > 100 || added.length !== availableAdded.length || removed.length !== availableRemoved.length,
    ...(previousUnavailable || currentUnavailable ? { incomplete: true } : {}) };
}
