import Anthropic from "@anthropic-ai/sdk";
import { db, now } from "./db";

export const aiModel = "claude-haiku-5-5";

/** One provider and one usage ledger for discovery, classification, and wording. */
export async function requestJson(
  task: string, instructions: string, input: unknown, schema: Record<string, unknown>,
  client = new Anthropic({ timeout: 45000, maxRetries: 0 }),
): Promise<{ data: unknown; inputTokens: number }> {
  const result = await client.messages.create({
    model: aiModel, max_tokens: 1200, thinking: { type: "disabled" },
    system: instructions,
    messages: [{ role: "user", content: JSON.stringify(input) }],
    output_config: { format: { type: "json_schema", schema } },
  });
  db.query("INSERT INTO ai_usage(task,model,usage,created_at) VALUES (?,?,?,?)")
    .run(task, result.model, JSON.stringify(result.usage), now());
  if (result.stop_reason !== "end_turn") throw new Error("AI request did not complete");
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  return { data: JSON.parse(text), inputTokens: result.usage.input_tokens +
    (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) };
}
