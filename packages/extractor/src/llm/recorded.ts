// Record/replay for model calls. CI never calls a provider: it replays recordings keyed by the request's
// content hash (same key as the budget cache). A missing recording FAILS CLOSED (ProviderError), it never
// falls through to a live call. Recordings are plain JSON so they can be committed under eval/ and reviewed.
import type { Hex32 } from "@symbolon/schemas";
import { requestCacheKey } from "./budget";
import { ProviderError, type LlmClient, type LlmRequest, type LlmResponse } from "./types";

export type Recordings = Record<Hex32, LlmResponse>;

export class RecordingLlm implements LlmClient {
  readonly recordings: Recordings = {};
  constructor(private readonly inner: LlmClient) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.complete(request);
    this.recordings[requestCacheKey(request)] = response;
    return response;
  }
}

export class ReplayLlm implements LlmClient {
  misses = 0;
  constructor(private readonly recordings: Readonly<Recordings>) {}
  complete(request: LlmRequest): Promise<LlmResponse> {
    const hit = this.recordings[requestCacheKey(request)];
    if (hit === undefined) {
      this.misses++;
      return Promise.reject(new ProviderError(`no recording for request ${requestCacheKey(request)} (replay mode never calls a provider)`));
    }
    return Promise.resolve(hit);
  }
}
