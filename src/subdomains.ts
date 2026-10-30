import { getDomain } from "tldts";
import pLimit from "p-limit";
import { db, now } from "./db";
import { fetchPublic } from "./network";

const scanning = pLimit(2);

export function subdomainHosts(output: string, domain: string) {
  return [...new Set(output.toLowerCase().split(/\s+/).filter((hostname) =>
    hostname.length <= 253 && hostname.endsWith("." + domain) &&
    hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
  ))].sort();
}

export async function certificateSubdomains(domain: string) {
  const response = await fetchPublic(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {}, 2_000_000);
  if (response.status !== 200) throw new Error("Certificate discovery unavailable; please retry");
  const rows = JSON.parse(response.body) as { name_value: string }[];
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.name_value !== "string"))
    throw new Error("Invalid certificate discovery response");
  return subdomainHosts(rows.map((row) => row.name_value).join("\n").replace(/\*\./g, ""), domain);
}

export async function scanSubdomains(address: string) {
  const domain = getDomain(new URL(address).hostname, { allowPrivateDomains: true });
  if (!domain) throw new Error("Cannot determine domain for subdomain discovery");
  const key = "subdomains:" + domain;
  const saved = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
  if (saved) {
    const cached = JSON.parse(saved.value) as { at: number; hosts: string[] };
    if (now() - cached.at < 86400) return cached.hosts;
  }
  return scanning(async () => {
    const hosts = await (async () => {
      if (!Bun.which("subfinder")) throw new Error("Subdomain discovery requires subfinder on the server");
      const process = Bun.spawn(["subfinder", "-silent", "-duc", "-d", domain,
        "-timeout", "4", "-max-time", "1", "-rl", "5", "-rsr", "2000000", "-mr", "1000"], { stdout: "pipe", stderr: "ignore" });
      const timeout = setTimeout(() => process.kill(), 45000);
      let output = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of process.stdout) {
          output += decoder.decode(chunk, { stream: true });
          if (output.length > 256000) {
            process.kill();
            throw new Error("Subdomain discovery output exceeds limit");
          }
        }
        const code = await process.exited;
        const hosts = subdomainHosts(output, domain);
        if (!hosts.length) {
          console.warn("subfinder-empty", domain, code);
          return await certificateSubdomains(domain);
        }
        return hosts;
      } finally {
        clearTimeout(timeout);
        process.kill();
      }
    })();
    db.query("INSERT OR REPLACE INTO metadata VALUES (?,?)").run(key, JSON.stringify({ at: now(), hosts }));
    return hosts;
  });
}
