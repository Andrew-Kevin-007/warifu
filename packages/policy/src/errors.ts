// Typed policy errors. The policy is loaded at process start; a PolicyError means "refuse to boot"
// (docs/04 K-12: mismatch => refuse to boot). Nothing in this package returns a partially valid policy.

export type PolicyErrorCode =
  /** Input is not a string, is too large, or contains control characters / lone surrogates. */
  | "INPUT_INVALID"
  /** The YAML parser reported an error (syntax, duplicate key, tab indentation, nesting too deep). */
  | "YAML_SYNTAX"
  /** A YAML feature outside the accepted subset (anchors, aliases, tags, directives, block scalars, ...). */
  | "YAML_FEATURE"
  /** The policy does not match the frozen `PolicySchema` / `PolicyOverridesSchema` (packages/schemas). */
  | "SCHEMA_INVALID"
  /** A rule this loader adds on top of the schema (amount precision/overflow, allowlist pattern, duplicates). */
  | "POLICY_INVALID"
  /** The vault configuration itself is malformed. */
  | "VAULT_CONFIG_INVALID"
  /** At least one policy value is looser than the vault it runs against (docs/08 §4 flag name). */
  | "POLICY_LOOSER_THAN_VAULT"
  /** The sandbox policy or sandbox vault exceeds the sandbox profile limits. */
  | "SANDBOX_LIMIT"
  /** An unexpected exception inside the loader; converted so that callers always see a PolicyError. */
  | "INTERNAL";

export interface PolicyIssue {
  /** Dotted path into the policy (e.g. `caps.perTxHardCap`), `$` for the document root. */
  readonly path: string;
  readonly message: string;
}

export class PolicyError extends Error {
  override readonly name = "PolicyError";
  readonly code: PolicyErrorCode;
  readonly issues: readonly PolicyIssue[];

  constructor(code: PolicyErrorCode, issues: readonly PolicyIssue[]) {
    const first = issues[0];
    const summary = first === undefined ? "" : `: ${first.path}: ${first.message}`;
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    super(`${code}${summary}${more}`);
    this.code = code;
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ path: i.path, message: i.message })));
  }
}

export function fail(code: PolicyErrorCode, path: string, message: string): never {
  throw new PolicyError(code, [{ path, message }]);
}

/**
 * Run `fn`; any exception that is not already a PolicyError becomes `INTERNAL` (or `fallback`).
 * This is the fail-closed wrapper: a bug or a runtime error can never yield a policy.
 */
export function failClosed<T>(fn: () => T, fallback: PolicyErrorCode = "INTERNAL"): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    const message = e instanceof Error ? `${e.name}: ${e.message}` : "non-Error exception";
    throw new PolicyError(fallback, [{ path: "$", message: message.slice(0, 200) }]);
  }
}
