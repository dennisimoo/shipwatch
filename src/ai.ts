import Anthropic from "@anthropic-ai/sdk";
import { db, now } from "./db";

export const aiModel = "claude-haiku-5-5";

/** A returned reply cannot be used; repeating the same request is not a transport retry. */
export class AIReplyError extends Error {}

export const inputTokenLimit = 90000;
export class AIPromptTooLargeError extends AIReplyError {}

function parameters(instructions: string, input: unknown, schema: Record<string, unknown>): Anthropic.MessageCountTokensParams {
  return {
    model: aiModel, thinking: { type: "disabled" }, system: instructions,
    messages: [{ role: "user", content: JSON.stringify(input) }],
    output_config: { format: { type: "json_schema", schema } },
  };
}

/** Include instructions, evidence, and output grammar; keep margin for provider count estimates. */
export async function countJson(instructions: string, input: unknown, schema: Record<string, unknown>,
  client = new Anthropic({ timeout: 45000, maxRetries: 0 })) {
  const { input_tokens } = await client.messages.countTokens(parameters(instructions, input, schema));
  if (!Number.isSafeInteger(input_tokens) || input_tokens < 0) throw new AIReplyError("Invalid input token count");
  return input_tokens;
}

/** Every paid request is guarded, including discovery and sentence-only rewrites. */
export async function requestJson(
  task: string, instructions: string, input: unknown, schema: Record<string, unknown>,
  client = new Anthropic({ timeout: 45000, maxRetries: 0 }),
): Promise<{ data: unknown; inputTokens: number }> {
  const params = parameters(instructions, input, schema);
  const { input_tokens: counted } = await client.messages.countTokens(params);
  if (!Number.isSafeInteger(counted) || counted < 0) throw new AIReplyError("Invalid input token count");
  if (counted > inputTokenLimit) throw new AIPromptTooLargeError("AI evidence exceeds the per-request token budget");
  const result = await client.messages.create({ ...params, max_tokens: 1200 });
  db.query("INSERT INTO ai_usage(task,model,usage,created_at) VALUES (?,?,?,?)")
    .run(task, result.model, JSON.stringify({ ...result.usage, preflight_input_tokens: counted }), now());
  if (result.stop_reason !== "end_turn") throw new AIReplyError("AI request did not complete");
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  let data: unknown;
  try { data = JSON.parse(text); }
  catch (cause) { throw new AIReplyError("AI reply was not valid JSON", { cause }); }
  return { data, inputTokens: result.usage.input_tokens +
    (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) };
}
