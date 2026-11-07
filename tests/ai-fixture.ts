import Anthropic from "@anthropic-ai/sdk";

export function aiFixture(respond: (request: Anthropic.MessageCreateParamsNonStreaming) => unknown) {
  return new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async (_url, request) => {
    const reply = respond(JSON.parse(String(request?.body)));
    return Response.json({ id: "test", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 100, output_tokens: 20 } });
  } });
}
