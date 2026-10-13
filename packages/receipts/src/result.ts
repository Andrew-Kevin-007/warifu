// Errors are typed values in @symbolon/receipts (AGENTS.md §4): no public function throws. Library calls that
// can throw (schemas' hash/time helpers, viem, an injected signer) are wrapped by `attempt` / `attemptAsync`, which
// turn an exception into a ReceiptError. The exception text is dropped on purpose: it may echo untrusted input.
// Fail closed: a caller that gets `ok: false` has no receipt, no signature, no approval view and no render model.

export type ReceiptErrorCode =
  /** The Decision does not satisfy DecisionSchema, or contradicts itself (a RELEASE with a failed check). */
  | "DECISION_INVALID"
  /** The assembled Receipt (inputs, issuedAt, explanation hash) does not satisfy ReceiptSchema. */
  | "RECEIPT_INVALID"
  /** The injected signer threw, or returned something that is not a canonical 65-byte signature. */
  | "SIGNER_FAILED"
  /** The signature does not recover to the signer's own address (wrong key, wrong digest, malleated). */
  | "SIGNER_MISMATCH"
  /** An approval draft/view is malformed or internally inconsistent (INV-20). */
  | "APPROVAL_INVALID"
  /** An unexpected exception inside this package. */
  | "INTERNAL";

export interface ReceiptError {
  readonly code: ReceiptErrorCode;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ReceiptError };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err(code: ReceiptErrorCode, message: string): { readonly ok: false; readonly error: ReceiptError } {
  return { ok: false, error: { code, message } };
}

/** Run `fn`; an exception becomes `err(code, message)`. */
export function attempt<T>(fn: () => Result<T>, code: ReceiptErrorCode, message: string): Result<T> {
  try {
    return fn();
  } catch {
    return err(code, message);
  }
}

/** Async twin of `attempt`. */
export async function attemptAsync<T>(fn: () => Promise<Result<T>>, code: ReceiptErrorCode, message: string): Promise<Result<T>> {
  try {
    return await fn();
  } catch {
    return err(code, message);
  }
}

/** The structural part of a Zod issue that `describeIssues` reads (kept local so this module needs no zod import). */
interface IssueLike {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly code: string;
}

const MAX_ISSUES_SHOWN = 3;
const MAX_PATH_CHARS = 80;

function safePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "$";
  const joined = path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");
  // Keys in a path come from our own schemas, but never print anything outside a conservative alphabet.
  return joined.replace(/[^A-Za-z0-9_.[\]-]/g, "?").slice(0, MAX_PATH_CHARS);
}

/**
 * A bounded, injection-safe summary of schema issues: "path (code)" only. Zod's own messages can quote the
 * offending input (e.g. unrecognized keys), so they are never forwarded.
 */
export function describeIssues(issues: ReadonlyArray<IssueLike>): string {
  const shown = issues.slice(0, MAX_ISSUES_SHOWN).map((i) => `${safePath(i.path)} (${i.code})`);
  const more = issues.length > MAX_ISSUES_SHOWN ? `, +${issues.length - MAX_ISSUES_SHOWN} more` : "";
  return `${shown.join("; ")}${more}`;
}
