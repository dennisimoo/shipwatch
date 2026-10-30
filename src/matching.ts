import { assetIdentity, hash } from "./detect";

export interface BundleEntry { url: string; hash: string }

export function canonicalUrl(address: string): string {
  const url = new URL(address);
  url.searchParams.delete("dpl");
  url.hash = "";
  return url.href;
}

function location(entry: BundleEntry): string {
  const url = new URL(canonicalUrl(entry.url));
  return JSON.stringify([url.origin, url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1),
    url.search, /\.css$/i.test(url.pathname) ? "css" : "js"]);
}

function stableIdentity(entry: BundleEntry): string {
  const original = new URL(canonicalUrl(entry.url));
  const url = new URL(assetIdentity(entry.url));
  if (/\/(?:CONTENT|turbopack-CONTENT)\.(?:m?js|css)$/.test(url.pathname) ||
    /\/_next\/static\/(?:immutable\/)?chunks\/(?=[\w-]*\d)[\w-]{12,64}\.js$/.test(original.pathname) &&
    !/\/(?:\d+|[A-Za-z][A-Za-z_-]*)[-.][a-f0-9]{8,}\.js$/i.test(original.pathname)) return canonicalUrl(entry.url);
  return url.href;
}

export function pairBundles(before: BundleEntry[], after: BundleEntry[], source: (entry: BundleEntry) => string) {
  const previous = new Set(before);
  const current = new Set(after);
  const locations = new Map([...previous, ...current].map((entry) => [entry, location(entry)]));
  const pairs: [BundleEntry | undefined, BundleEntry | undefined][] = [];
  const pair = (old: BundleEntry, next: BundleEntry) => {
    pairs.push([old, next]);
    previous.delete(old);
    current.delete(next);
  };
  const group = <Entry>(entries: Iterable<Entry>, key: (entry: Entry) => string) => {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const identity = key(entry);
      const members = groups.get(identity) ?? [];
      members.push(entry);
      groups.set(identity, members);
    }
    return groups;
  };
  const match = (key: (entry: BundleEntry) => string, equivalent = false) => {
    const oldGroups = group(previous, key);
    const newGroups = group(current, key);
    for (const [identity, oldEntries] of oldGroups) {
      const newEntries = newGroups.get(identity) ?? [];
      if (!equivalent && (oldEntries.length !== 1 || newEntries.length !== 1)) continue;
      for (let index = 0; index < Math.min(oldEntries.length, newEntries.length); index++)
        pair(oldEntries[index], newEntries[index]);
    }
  };
  const duplicateUrls = new Set(before.map((entry) => canonicalUrl(entry.url))).size !== before.length ||
    new Set(after.map((entry) => canonicalUrl(entry.url))).size !== after.length;
  match((entry) => canonicalUrl(entry.url));
  match((entry) => locations.get(entry)! + entry.hash, true);
  match((entry) => locations.get(entry)! + hash(source(entry)), true);
  match(stableIdentity);

  const signatures = new Map([...previous, ...current].map((entry) => {
    const lines = source(entry).split("\n").map((line) => line.trim()).filter(Boolean);
    const shingles = new Set<string>();
    for (let index = 0; index + 2 < lines.length; index++) {
      const window = lines.slice(index, index + 3).join("\n");
      if (window.length >= 30) shingles.add(hash(window));
    }
    return [entry, { lines: new Set(lines.filter((line) => line.length >= 30)), shingles }] as const;
  }));
  const similarity = (oldLines: Set<string>, newLines: Set<string>) => {
    let common = 0;
    const smaller = oldLines.size <= newLines.size ? oldLines : newLines;
    const larger = smaller === oldLines ? newLines : oldLines;
    for (const line of smaller) if (larger.has(line)) common++;
    return common >= 3 ? 2 * common / (oldLines.size + newLines.size) : 0;
  };
  const candidates: { old: BundleEntry; next: BundleEntry; score: number }[] = [];
  for (const old of previous) for (const next of current) {
    if (locations.get(old) !== locations.get(next)) continue;
    const oldSignature = signatures.get(old)!;
    const newSignature = signatures.get(next)!;
    candidates.push({ old, next, score: Math.max(similarity(oldSignature.lines, newSignature.lines),
      similarity(oldSignature.shingles, newSignature.shingles)) });
  }
  candidates.sort((left, right) => right.score - left.score);
  const byOld = group(candidates, (candidate) => canonicalUrl(candidate.old.url));
  const byNew = group(candidates, (candidate) => canonicalUrl(candidate.next.url));
  for (const candidate of candidates) {
    const oldRanking = byOld.get(canonicalUrl(candidate.old.url))!;
    const newRanking = byNew.get(canonicalUrl(candidate.next.url))!;
    if (candidate.score < 0.9 || oldRanking[0] !== candidate || newRanking[0] !== candidate ||
      candidate.score - Math.max(oldRanking[1]?.score ?? 0, newRanking[1]?.score ?? 0) < 0.1) continue;
    pair(candidate.old, candidate.next);
  }
  const remainingLocations = new Set([...previous].map((entry) => locations.get(entry)));
  const ambiguous = [...current].some((entry) => remainingLocations.has(locations.get(entry)));
  pairs.push(...[...previous].map((entry): [BundleEntry, undefined] => [entry, undefined]),
    ...[...current].map((entry): [undefined, BundleEntry] => [undefined, entry]));
  return { pairs, ambiguous, duplicateUrls };
}
