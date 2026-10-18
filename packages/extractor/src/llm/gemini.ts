// Google Gemini (AI Studio, free tier) adapter over an injected `fetch`, same contract as the Anthropic adapter: no SDK, the key is a
// constructor argument sent in a header, never logged and never placed in an error message. Added so the extractor can run on a free key
// when no paid model key exists. The kernel still re-derives every field (INV-8): a model reading here is advisory only.
//
// VERIFY(V-22b): field names follow the public Gemini API (generateContent: systemInstruction, contents[].parts, tools[].functionDeclarations
// with `parametersJsonSchema`, toolConfig.functionCallingConfig, usageMetadata) as remembered, and are checked by the first live call.
// Quirks handled: optional features are dropped one at a time on an HTTP 400 (thinking config, then the JSON-schema field in favour of a
// sanitised OpenAPI-style `parameters`); thought signatures on returned function calls are replayed with the call.
import { ProviderError, type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse, type LlmToolCall } from "./types";

export interface GeminiClientOptions {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface Part {
  text?: string;
  functionCall?: { name: string; args: unknown; id?: string };
  functionResponse?: { name: string; response: unknown };
  thoughtSignature?: string;
  [k: string]: unknown;
}
interface Content {
  role: "user" | "model";
  parts: Part[];
}

/** JSON Schema subset -> the OpenAPI-style subset older Gemini endpoints accept (nullable instead of anyOf-null, no additionalProperties). */
export function toOpenApiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenApiSchema);
  if (typeof node !== "object" || node === null) return node;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o["anyOf"])) {
    const alts = o["anyOf"] as Array<Record<string, unknown>>;
    const nonNull = alts.filter((a) => a["type"] !== "null");
    if (nonNull.length === 1 && alts.length === 2) return { ...(toOpenApiSchema(nonNull[0]) as Record<string, unknown>), nullable: true };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "additionalProperties" || k === "$schema" || k === "$id" || k === "title") continue;
    out[k] = toOpenApiSchema(v);
  }
  return out;
}

export function createGeminiClient(opts: GeminiClientOptions): LlmClient {
  if (opts.apiKey.length === 0) throw new Error("apiKey required");
  const baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // callId -> the exact part the model returned (keeps thoughtSignature), and callId -> function name for the tool result.
  const rawParts = new Map<string, Part>();
  const names = new Map<string, string>();

  function toContents(messages: readonly LlmMessage[]): Content[] {
    const out: Content[] = [];
    const push = (role: "user" | "model", parts: Part[]): void => {
      const last = out[out.length - 1];
      if (last !== undefined && last.role === role && role === "user") last.parts.push(...parts);
      else out.push({ role, parts });
    };
    for (const m of messages) {
      switch (m.role) {
        case "user":
          push("user", [{ text: m.text }]);
          break;
        case "assistant":
          push(
            "model",
            m.toolCalls.map((c) => rawParts.get(c.id) ?? { functionCall: { name: c.name, args: c.input } }),
          );
          break;
        case "tool_result":
          push("user", [{ functionResponse: { name: names.get(m.callId) ?? "tool", response: { result: m.text } } }]);
          break;
        default: {
          const never: never = m;
          throw new Error(`unhandled message ${JSON.stringify(never)}`);
        }
      }
    }
    return out;
  }

  async function attempt(request: LlmRequest, features: { thinkingOff: boolean; jsonSchema: boolean }): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: toContents(request.messages),
        tools: [
          {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              ...(features.jsonSchema ? { parametersJsonSchema: t.inputSchema } : { parameters: toOpenApiSchema(t.inputSchema) }),
            })),
          },
        ],
        toolConfig: {
          functionCallingConfig: request.toolChoice.type === "tool" ? { mode: "ANY", allowedFunctionNames: [request.toolChoice.name] } : { mode: "ANY" },
        },
        generationConfig: { maxOutputTokens: request.maxOutputTokens, temperature: 0, ...(features.thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      };
      return await opts.fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
        body: JSON.stringify(body),
      });
    } catch {
      // Do not include the underlying error text: it may contain request details.
      throw new ProviderError("provider request failed or timed out", true);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const ladder = [
        { thinkingOff: true, jsonSchema: true },
        { thinkingOff: false, jsonSchema: true },
        { thinkingOff: false, jsonSchema: false },
      ];
      let res: Response | undefined;
      for (const f of ladder) {
        // A busy (503) or rate-limited (429) answer is transient: wait and retry the same shape a few times before giving up.
        for (let retry = 0; retry < 4; retry++) {
          res = await attempt(request, f);
          if (res.status !== 503 && res.status !== 429) break;
          await new Promise((r) => setTimeout(r, retry === 3 ? 0 : 1500 * (retry + 1)));
        }
        if (res?.status !== 400) break; // only a 400 means "this request shape is not accepted": try the next, plainer shape
      }
      if (res === undefined) throw new ProviderError("provider request failed", true);
      if (!res.ok) throw new ProviderError(`provider returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError("provider returned a non-JSON body");
      }
      return parseResponse(body, rawParts, names);
    },
  };
}

function parseResponse(body: unknown, rawParts: Map<string, Part>, names: Map<string, string>): LlmResponse {
  if (typeof body !== "object" || body === null) throw new ProviderError("malformed provider response");
  const b = body as { candidates?: Array<{ content?: { parts?: Part[] } }>; usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown } };
  const parts = b.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new ProviderError("malformed provider response (candidates)");
  const toolCalls: LlmToolCall[] = [];
  let text: string | null = null;
  let n = 0;
  for (const part of parts) {
    if (part.functionCall !== undefined && typeof part.functionCall.name === "string") {
      const id = typeof part.functionCall.id === "string" && part.functionCall.id !== "" ? part.functionCall.id : `gemini-call-${Date.now().toString(36)}-${String(n++)}`;
      rawParts.set(id, part);
      names.set(id, part.functionCall.name);
      toolCalls.push({ id, name: part.functionCall.name, input: part.functionCall.args ?? {} });
    } else if (typeof part.text === "string") {
      text = (text ?? "") + part.text;
    }
  }
  const tin = b.usageMetadata?.promptTokenCount;
  const tout = (typeof b.usageMetadata?.candidatesTokenCount === "number" ? b.usageMetadata.candidatesTokenCount : 0) + (typeof b.usageMetadata?.thoughtsTokenCount === "number" ? b.usageMetadata.thoughtsTokenCount : 0);
  if (typeof tin !== "number" || !Number.isInteger(tin) || tin < 0 || !Number.isInteger(tout) || tout < 0) throw new ProviderError("malformed provider response (usage)");
  return { toolCalls, text, usage: { tokensIn: tin, tokensOut: tout } };
}
