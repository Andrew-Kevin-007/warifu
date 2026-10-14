// Stand-in for lib/utils/openai-error-handler (OURS; the original imports the openai SDK for its error classes).
export function handleOpenAIError(error: unknown): { status: number; body: { error: string; retryable: boolean } } {
  return { status: 500, body: { error: error instanceof Error ? error.message : "validator error", retryable: false } };
}
