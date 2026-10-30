import { db, now } from "./db";
import pLimit from "p-limit";

const scanning = pLimit(1);

// Only stable, recognizable public app or documentation paths are worth a fallback inspection.
export function fallbackPaths(output: string, address: string): string[] {
  const origin = new URL(address).origin;
  const paths = new Set<string>();
  for (const line of output.split(/\s+/)) {
    try {
      const url = new URL(line);
      if (url.origin !== origin || url.username || url.password || url.search || url.hash) continue;
      if (!/^\/(?:app|dashboard|console|docs|developers|api-docs|swagger)(?:\/)?$/i.test(url.pathname)) continue;
      paths.add(url.href);
    } catch {}
  }
  return [...paths].sort().slice(0, 2);
}

export async function passivePaths(address: string): Promise<string[]> {
  if (!Bun.which("urlfinder")) return [];
  return scanning(() => scanPassivePaths(address));
}

async function scanPassivePaths(address: string): Promise<string[]> {
  const origin = new URL(address).origin;
  const key = "passive-urls:" + origin;
  const saved = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
  if (saved) {
    const cached = JSON.parse(saved.value) as { at: number; paths: string[] };
    if (now() - cached.at < 86400) return cached.paths;
  }
  const child = Bun.spawn(["urlfinder", "-silent", "-duc", "-d", new URL(origin).hostname,
    "-rl", "2", "-timeout", "4", "-max-time", "1"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => child.kill(), 15000);
  let output = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (output.length > 256000) { child.kill(); break; }
    }
    const code = await child.exited;
    const paths = fallbackPaths(output, origin);
    // A failed or timed-out provider run is not cached as an empty result.
    if (code === 0) db.query("INSERT OR REPLACE INTO metadata VALUES (?,?)")
      .run(key, JSON.stringify({ at: now(), paths }));
    return paths;
  } finally { clearTimeout(timeout); child.kill(); }
}
