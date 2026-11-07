import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
process.env.DATABASE_PATH = ":memory:";
const { db } = await import("../src/db");
const { requestJson } = await import("../src/ai");

test("incomplete provider responses retain usage but cannot become analyses", async () => {
  const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async () => Response.json({
    id: "truncated", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "max_tokens",
    content: [{ type: "text", text: '{"classification":"application"}' }],
    usage: { input_tokens: 200, output_tokens: 1200, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
  }) });
  await expect(requestJson("truncated-test", "Return JSON", {}, {}, client)).rejects.toThrow("did not complete");
  const row = db.query("SELECT usage FROM ai_usage WHERE task='truncated-test'").get() as { usage: string };
  expect(JSON.parse(row.usage)).toEqual({ input_tokens: 200, output_tokens: 1200, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 });
});
