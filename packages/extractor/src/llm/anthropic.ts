// Anthropic Messages API adapter over an injected `fetch` (no SDK dependency; tests use a fake fetch).
// The API key is a constructor argument supplied by the server runtime; it is never read from the environment
// here, never logged, and never placed in an error message. Only the web/challenge servers (own LLM key,
// INV-11/INV-16) construct this; no real key exists in this repo or its tests.
//
// VERIFY(V-22): request/response field names follow the public Messages API (tools, tool_choice, tool_use /
// tool_result content blocks, usage.input_tokens/output_tokens) and the default model ids in
// `DEFAULT_MODELS` come from docs/03 §4; both must be re-checked against the provider docs before the first
// live call. No pricing is assumed anywhere (see CostModel).
import { ProviderError, type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse, type LlmToolCall } from "./types";

export const DEFAULT_MODELS = { extractorA: "claude-sonnet-5-5", extractorB: "claude-haiku-5-5" } as const;

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly anthropicVersion?: string;
}

interface WireBlock {
  readonly type: string;
  readonly text?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

function toWireMessages(messages: readonly LlmMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "user":
        return { role: "user", content: [{ type: "text", text: m.text }] };
      case "assistant":
        return { role: "assistant", content: m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })) };
      case "tool_result":
        return { role: "user", content: [{ type: "tool_result", tool_use_id: m.callId, content: m.text }] };
      default: {
        const never: never = m;
        throw new Error(`unhandled message ${JSON.stringify(never)}`);
      }
    }
  });
}

export function createAnthropicClient(opts: AnthropicClientOptions): LlmClient {
  if (opts.apiKey.length === 0) throw new Error("apiKey required");
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await opts.fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          signal: ctl.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": opts.anthropicVersion ?? "2023-06-01",
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: toWireMessages(request.messages),
            tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
            tool_choice: request.toolChoice,
          }),
        });
      } catch {
        // Do not include the underlying error text: it may contain request details.
        throw new ProviderError("provider request failed or timed out", true);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new ProviderError(`provider returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError("provider returned a non-JSON body");
      }
      return parseResponse(body);
    },
  };
}

function parseResponse(body: unknown): LlmResponse {
  if (typeof body !== "object" || body === null) throw new ProviderError("malformed provider response");
  const b = body as { content?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!Array.isArray(b.content)) throw new ProviderError("malformed provider response (content)");
  const toolCalls: LlmToolCall[] = [];
  let text: string | null = null;
  for (const block of b.content as WireBlock[]) {
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    } else if (block.type === "text" && typeof block.text === "string") {
      text = (text ?? "") + block.text;
    }
  }
  const tin = b.usage?.input_tokens;
  const tout = b.usage?.output_tokens;
  if (typeof tin !== "number" || typeof tout !== "number" || !Number.isInteger(tin) || !Number.isInteger(tout) || tin < 0 || tout < 0) {
    throw new ProviderError("malformed provider response (usage)");
  }
  return { toolCalls, text, usage: { tokensIn: tin, tokensOut: tout } };
}
