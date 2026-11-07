import { expect, spyOn, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
const discovery = await import("../src/discovery");
const { AIReplyError } = await import("../src/ai");

test("discovery reply failures return 502 while input errors retain 400", async () => {
  const keys = ["HOST", "PORT", "POLL_ENABLED", "TRUST_PROXY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOST: "127.0.0.1", PORT: "0", POLL_ENABLED: "0", TRUST_PROXY: "1" });
  const { default: server } = await import("../src/server");
  const discover = spyOn(discovery, "discover").mockRejectedValue(new AIReplyError("AI reply was not valid JSON"));
  try {
    const review = async (ip: string) => fetch(`http://127.0.0.1:${server.port}/api/discover`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, Origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const provider = await review("198.51.100.10");
    expect(provider.status).toBe(502);
    expect((await provider.json()).error).not.toContain("Check the URL");
    discover.mockRejectedValue(new Error("Invalid URL"));
    const input = await review("198.51.100.11");
    expect(input.status).toBe(400);
  } finally {
    discover.mockRestore();
    await server.stop(true);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
