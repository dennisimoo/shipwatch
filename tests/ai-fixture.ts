import Anthropic from "@anthropic-ai/sdk";

export function aiFixture(respond: (request: Anthropic.MessageCreateParamsNonStreaming) => unknown,
  count: (request: Anthropic.MessageCountTokensParams) => number = () => 100) {
  return new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async (url, request) => {
    if (String(url).endsWith("/count_tokens")) return Response.json({ input_tokens: count(JSON.parse(String(request?.body))) });
    const reply = respond(JSON.parse(String(request?.body)));
    return Response.json({ id: "test", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 100, output_tokens: 20 } });
  } });
}
