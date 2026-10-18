// The Gemini adapter against a fake fetch (the network edge is the only thing mocked, AGENTS.md section 5).
import { describe, expect, it } from "vitest";
import { createGeminiClient, stripUnsupportedConstraints, toOpenApiSchema } from "../src/llm/gemini";
import { ProviderError, type LlmRequest } from "../src/llm/types";

const REQ: LlmRequest = {
  role: "extractor_a",
  model: "gemini-test",
  system: "sys",
  messages: [{ role: "user", text: "invoice text" }],
  tools: [{ name: "submit_extraction", description: "d", inputSchema: { type: "object", additionalProperties: false, properties: { n: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["n"] } }],
  toolChoice: { type: "tool", name: "submit_extraction" },
  maxOutputTokens: 512,
};

const OK_BODY = { candidates: [{ content: { parts: [{ functionCall: { name: "submit_extraction", args: { n: "x" } }, thoughtSignature: "sig" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 } };

function fakeFetch(statuses: number[], seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>): typeof fetch {
  let i = 0;
  return ((url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
    return Promise.resolve(new Response(JSON.stringify(status === 200 ? OK_BODY : { error: { message: "secret detail" } }), { status }));
  }) as unknown as typeof fetch;
}

describe("createGeminiClient", () => {
  it("sends the key in a header only, forces the named tool, and parses the call and usage", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const c = createGeminiClient({ apiKey: "KEY-123", fetch: fakeFetch([200], seen) });
    const r = await c.complete(REQ);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: "submit_extraction", input: { n: "x" } });
    expect(r.usage).toEqual({ tokensIn: 10, tokensOut: 6 });
    expect(seen[0]?.headers["x-goog-api-key"]).toBe("KEY-123");
    expect(seen[0]?.url).not.toContain("KEY-123");
    expect(JSON.stringify(seen[0]?.body)).not.toContain("KEY-123");
    expect(seen[0]?.body["toolConfig"]).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_extraction"] } });
  });

  it("drops optional features one at a time on HTTP 400, ending with the sanitised schema", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const c = createGeminiClient({ apiKey: "k".repeat(30), fetch: fakeFetch([400, 400, 200], seen) });
    await c.complete(REQ);
    expect(seen).toHaveLength(3);
    const decl = (s: number) => ((seen[s]?.body["tools"] as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]?.functionDeclarations[0]) ?? {};
    expect(decl(0)["parametersJsonSchema"]).toBeDefined();
    expect((seen[0]?.body["generationConfig"] as Record<string, unknown>)["thinkingConfig"]).toBeDefined();
    expect((seen[1]?.body["generationConfig"] as Record<string, unknown>)["thinkingConfig"]).toBeUndefined();
    expect(decl(2)["parameters"]).toBeDefined();
    expect(decl(2)["parametersJsonSchema"]).toBeUndefined();
  });

  it("fails closed with an error that never contains provider text or the key", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const c = createGeminiClient({ apiKey: "KEY-123", fetch: fakeFetch([500], seen) });
    const err = await c.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String((err as Error).message)).not.toMatch(/secret detail|KEY-123/);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it("replays the returned function call part (with its thought signature) and answers it by name", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const c = createGeminiClient({ apiKey: "KEY-123", fetch: fakeFetch([200], seen) });
    const first = await c.complete(REQ);
    const call = first.toolCalls[0]!;
    await c.complete({ ...REQ, messages: [...REQ.messages, { role: "assistant", toolCalls: [call] }, { role: "tool_result", callId: call.id, text: "ok" }] });
    const contents = seen[1]?.body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents.map((x) => x.role)).toEqual(["user", "model", "user"]);
    expect(contents[1]?.parts[0]?.["thoughtSignature"]).toBe("sig");
    expect((contents[2]?.parts[0]?.["functionResponse"] as { name: string }).name).toBe("submit_extraction");
  });
});

describe("toOpenApiSchema", () => {
  it("turns anyOf-with-null into nullable and drops additionalProperties", () => {
    expect(toOpenApiSchema({ type: "object", additionalProperties: false, properties: { a: { anyOf: [{ type: "string", maxLength: 5 }, { type: "null" }] } } })).toEqual({ type: "object", properties: { a: { type: "string", maxLength: 5, nullable: true } } });
  });
});

describe("stripUnsupportedConstraints", () => {
  it("drops length, range, pattern and item-count keywords at every depth and keeps the rest", () => {
    const schema = { type: "object", properties: { a: { type: "string", maxLength: 5, pattern: "^x$" }, b: { type: "array", maxItems: 2, items: { type: "integer", minimum: 0, maximum: 9 } } }, required: ["a"], additionalProperties: false };
    expect(stripUnsupportedConstraints(schema)).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "array", items: { type: "integer" } } }, required: ["a"], additionalProperties: false });
  });
});
