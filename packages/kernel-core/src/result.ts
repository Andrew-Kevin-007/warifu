// Errors are typed values in kernel-core (AGENTS.md §4): nothing here throws. Library helpers that can
// throw (schemas' hash/time helpers) are called through `attempt`, which turns an exception into a
// KernelError; the pipeline additionally wraps every check so that an unexpected exception becomes a
// HOLD with KERNEL_ERROR (docs/04 §1), never a RELEASE.

export type KernelErrorCode =
  /** The KernelContext (assembled by services/kernel) is malformed or internally inconsistent. */
  | "CONTEXT_INVALID"
  /** @symbolon/terms refused its input (see the message). */
  | "TERMS"
  /** An unexpected exception inside kernel-core, converted by `attempt` or the pipeline guard. */
  | "INTERNAL";

export interface KernelError {
  readonly code: KernelErrorCode;
  readonly message: string;
}

export type Result<T, E = KernelError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err(code: KernelErrorCode, message: string): { readonly ok: false; readonly error: KernelError } {
  return { ok: false, error: { code, message } };
}

/** Run `fn`; an exception becomes `err(code, message)` (the exception text is dropped: it may echo input). */
export function attempt<T>(fn: () => T, code: KernelErrorCode, message: string): Result<T> {
  try {
    return ok(fn());
  } catch {
    return err(code, message);
  }
}
