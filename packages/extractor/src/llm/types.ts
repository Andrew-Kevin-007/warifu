// The network edge. Everything above this interface is real code under test; everything below it (a provider
// SDK, an HTTP call) is mocked or replayed in tests (AGENTS.md §5). No code in this package calls a provider
// directly: all calls go through BudgetedLlm (INV-21).

export type LlmRole = "extractor_a" | "extractor_b" | "advisory" | "planner";

export interface LlmToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool input. */
  readonly inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  /** Untrusted JSON from the model; validated with Zod by the caller. */
  readonly input: unknown;
}

export type LlmMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly toolCalls: readonly LlmToolCall[] }
  | { readonly role: "tool_result"; readonly callId: string; readonly text: string };

export interface LlmRequest {
  readonly role: LlmRole;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolSpec[];
  /** Force this tool, or "any" to force some tool call. */
  readonly toolChoice: { readonly type: "tool"; readonly name: string } | { readonly type: "any" };
  readonly maxOutputTokens: number;
}

export interface LlmUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface LlmResponse {
  readonly toolCalls: readonly LlmToolCall[];
  /** Free text the model emitted alongside (never interpreted). */
  readonly text: string | null;
  readonly usage: LlmUsage;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Thrown by a client when the provider is unavailable / errors / times out. Fails closed upstream. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "ProviderError";
  }
}
