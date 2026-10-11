// Policy normalization: defaults (docs/04 §7) -> frozen PolicySchema (packages/schemas) -> loader rules ->
// canonical form -> policyHash = keccak256(JCS(canonical policy JSON)).
//
// Canonical form (one value, one spelling, so semantically equal policies hash equally):
// - every amount is rewritten with exactly `currency.decimals` fraction digits ("100" -> "100.000000");
// - `caps.hourlyCap` of zero is dropped (absent and "0" both mean "off", docs/04 §7);
// - `evidence.urlAllowlist` is sorted (it is a set; duplicates are an error);
// - key order does not matter: JCS sorts keys.
// normalizePolicy is idempotent: normalizePolicy(normalizePolicy(x).policy) has the same policy and hash.
import { PolicySchema, hashJcs } from "@symbolon/schemas";
import type { Hex32, Policy } from "@symbolon/schemas";
import { formatPolicyAmount, parsePolicyAmount } from "./amounts";
import { PolicyError, failClosed, issuesFromZod } from "./errors";
import type { PolicyIssue } from "./errors";
import { parseStrictYaml } from "./yaml";

/**
 * Defaults applied per key when a section or key is absent (docs/04 §7 values). Deliberately NOT defaulted:
 * `version`, `tenant`, `currency` (decimals must be stated and are checked against the vault, V-04),
 * `caps` and `categories` (tenant money limits are never implied). `evidence.urlAllowlist` defaults to
 * `[]` (deny all), not to the example's tenant-specific patterns. `caps.hourlyCap` has no default
 * (absent = off). Amounts are written without a fraction so they are valid for any `currency.decimals`.
 */
export const POLICY_DEFAULTS = deepFreeze({
  velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "150" },
  newPayee: { firstPaymentMax: "25", alwaysHuman: true },
  reserve: { floor: "10", lookaheadDays: 14 },
  timing: {
    disputeWindowHours: 0,
    payBeforeDueBufferHours: 24,
    allowImmediate: true,
    defaultNetDays: 30,
    windowSafetyMarginMinutes: 60,
  },
  treasury: { costOfCapitalBps: 0 },
  escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 },
  limits: { maxDocChars: 20_000 },
  evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: [] as string[] },
  extraction: { allowSingle: false },
  screening: { required: false, staleAfterHours: 24 },
  reconciliation: { ackWindowHours: 72 },
});

/** Top-level keys that have no default and must be present in every policy. */
export const REQUIRED_POLICY_KEYS = Object.freeze(["version", "tenant", "currency", "caps", "categories"] as const);

/** Policy amounts in token base units (INV-10). `hourlyCap === 0n` means off (same convention as the vault). */
export interface PolicyAmounts {
  readonly perTxHardCap: bigint;
  readonly dailyCap: bigint;
  readonly hourlyCap: bigint;
  readonly weeklyCap: bigint;
  readonly humanApprovalAbove: bigint;
  readonly maxAmountPerPayeePerDay: bigint;
  readonly firstPaymentMax: bigint;
  readonly reserveFloor: bigint;
  /** Monthly budget per category. Null prototype: a lookup of "constructor" or "__proto__" is `undefined`. */
  readonly categories: Readonly<Record<string, bigint>>;
}

export interface LoadedPolicy {
  /** Canonical policy JSON: what is hashed, stored (`policies.policy`) and handed to the kernel. Deep-frozen. */
  readonly policy: Policy;
  /** keccak256(JCS(policy)); recorded in every receipt (docs/04 §7). */
  readonly policyHash: Hex32;
  readonly decimals: number;
  readonly amounts: PolicyAmounts;
}

// One label: lowercase letters, digits and inner hyphens, at most 63 characters.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// The last label starts with a letter, so IPv4 literals are refused; at least two labels after any wildcard.
const TLD = "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ORIGIN_PATTERN_RE = new RegExp(`^https://(?:\\*\\.)?(?:${LABEL}\\.)+${TLD}$`);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** Fill absent sections and absent keys inside present sections from POLICY_DEFAULTS. Unknown keys are kept
 *  so that the strict schema reports them. */
export function applyPolicyDefaults(input: unknown): Record<string, unknown> {
  if (!isPlainRecord(input)) throw new PolicyError("SCHEMA_INVALID", [{ path: "$", message: "policy must be a mapping" }]);
  const out: Record<string, unknown> = { ...input };
  for (const [section, defaults] of Object.entries(POLICY_DEFAULTS)) {
    if (!Object.hasOwn(input, section)) {
      out[section] = clone(defaults);
    } else {
      const given = input[section];
      if (isPlainRecord(given)) out[section] = { ...clone(defaults), ...given };
    }
  }
  return out;
}

function schemaParse(value: unknown): Policy {
  const r = PolicySchema.safeParse(value);
  if (!r.success) throw new PolicyError("SCHEMA_INVALID", issuesFromZod(r.error.issues));
  return r.data;
}

interface AmountField {
  readonly path: string;
  readonly get: (p: Policy) => string | undefined;
}

const AMOUNT_FIELDS: readonly AmountField[] = [
  { path: "caps.perTxHardCap", get: (p) => p.caps.perTxHardCap },
  { path: "caps.dailyCap", get: (p) => p.caps.dailyCap },
  { path: "caps.hourlyCap", get: (p) => p.caps.hourlyCap },
  { path: "caps.weeklyCap", get: (p) => p.caps.weeklyCap },
  { path: "caps.humanApprovalAbove", get: (p) => p.caps.humanApprovalAbove },
  { path: "velocity.maxAmountPerPayeePerDay", get: (p) => p.velocity.maxAmountPerPayeePerDay },
  { path: "newPayee.firstPaymentMax", get: (p) => p.newPayee.firstPaymentMax },
  { path: "reserve.floor", get: (p) => p.reserve.floor },
];

/** Parse one amount, collecting its issue instead of stopping, so one error report lists every bad amount.
 *  parsePolicyAmount throws only PolicyError; anything else has no `issues`, the spread throws a TypeError,
 *  and the fail-closed wrapper reports INTERNAL. */
function toUnits(issues: PolicyIssue[], amount: string, decimals: number, path: string): bigint {
  try {
    return parsePolicyAmount(amount, decimals, path);
  } catch (e) {
    issues.push(...(e as PolicyError).issues);
    return 0n;
  }
}

function checkAllowlist(issues: PolicyIssue[], list: readonly string[]): string[] {
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const path = `evidence.urlAllowlist[${i}]`;
    if (!ORIGIN_PATTERN_RE.test(entry) || entry.length > 8 + 253) {
      issues.push({
        path,
        message:
          "expected a lowercase https origin pattern such as https://example.com or https://*.example.com " +
          "(no port, path, userinfo, IP literal or single-label host; a wildcard only as the first label)",
      });
    }
    if (seen.has(entry)) issues.push({ path, message: "duplicate allowlist entry" });
    seen.add(entry);
  });
  return [...seen].sort();
}

function normalizeUnchecked(input: unknown): LoadedPolicy {
  const parsed = schemaParse(applyPolicyDefaults(input));
  const decimals = parsed.currency.decimals;
  const issues: PolicyIssue[] = [];

  const units = new Map<string, bigint>();
  for (const f of AMOUNT_FIELDS) {
    const v = f.get(parsed);
    if (v !== undefined) units.set(f.path, toUnits(issues, v, decimals, f.path));
  }
  const categoryUnits: Record<string, bigint> = Object.create(null) as Record<string, bigint>;
  for (const [name, amount] of Object.entries(parsed.categories)) {
    categoryUnits[name] = toUnits(issues, amount, decimals, `categories.${name}`);
  }
  const urlAllowlist = checkAllowlist(issues, parsed.evidence.urlAllowlist);
  if (issues.length > 0) throw new PolicyError("POLICY_INVALID", issues);

  const u = (path: string): bigint => units.get(path) ?? 0n;
  const fmt = (path: string): string => formatPolicyAmount(u(path), decimals);
  const hourlyCap = u("caps.hourlyCap");

  const canonical = schemaParse({
    version: parsed.version,
    tenant: parsed.tenant,
    currency: { ...parsed.currency },
    caps: {
      perTxHardCap: fmt("caps.perTxHardCap"),
      dailyCap: fmt("caps.dailyCap"),
      ...(hourlyCap > 0n ? { hourlyCap: fmt("caps.hourlyCap") } : {}),
      weeklyCap: fmt("caps.weeklyCap"),
      humanApprovalAbove: fmt("caps.humanApprovalAbove"),
    },
    velocity: { ...parsed.velocity, maxAmountPerPayeePerDay: fmt("velocity.maxAmountPerPayeePerDay") },
    newPayee: { ...parsed.newPayee, firstPaymentMax: fmt("newPayee.firstPaymentMax") },
    categories: Object.fromEntries(
      Object.entries(categoryUnits).map(([name, v]) => [name, formatPolicyAmount(v, decimals)]),
    ),
    reserve: { ...parsed.reserve, floor: fmt("reserve.floor") },
    timing: { ...parsed.timing },
    treasury: { ...parsed.treasury },
    escalation: { ...parsed.escalation },
    limits: { ...parsed.limits },
    evidence: { ...parsed.evidence, urlAllowlist },
    extraction: { ...parsed.extraction },
    screening: { ...parsed.screening },
    reconciliation: { ...parsed.reconciliation },
  });

  const amounts: PolicyAmounts = {
    perTxHardCap: u("caps.perTxHardCap"),
    dailyCap: u("caps.dailyCap"),
    hourlyCap,
    weeklyCap: u("caps.weeklyCap"),
    humanApprovalAbove: u("caps.humanApprovalAbove"),
    maxAmountPerPayeePerDay: u("velocity.maxAmountPerPayeePerDay"),
    firstPaymentMax: u("newPayee.firstPaymentMax"),
    reserveFloor: u("reserve.floor"),
    categories: categoryUnits,
  };
  return deepFreeze({ policy: canonical, policyHash: hashJcs(canonical), decimals, amounts });
}

/**
 * Validate a policy given as JSON (e.g. the stored `policies.policy` jsonb, or parsed YAML), apply defaults,
 * enforce the loader rules and return the canonical, deep-frozen policy with its hash and bigint amounts.
 * Throws PolicyError (SCHEMA_INVALID | POLICY_INVALID | INTERNAL); never returns a partially valid policy.
 */
export function normalizePolicy(input: unknown): LoadedPolicy {
  return failClosed(() => normalizeUnchecked(input));
}

/** Load `policy.yaml` text (the caller reads the file; this package does no I/O). */
export function loadPolicy(yamlText: string): LoadedPolicy {
  return failClosed(() => normalizeUnchecked(parseStrictYaml(yamlText)));
}

/** policyHash of any policy JSON = keccak256(JCS(canonical form)). Throws PolicyError if it is invalid. */
export function policyHash(input: unknown): Hex32 {
  return normalizePolicy(input).policyHash;
}

/** Monthly budget of `category` in base units, or `undefined` if the policy has none (own keys only). */
export function categoryBudget(loaded: LoadedPolicy, category: string): bigint | undefined {
  return Object.hasOwn(loaded.amounts.categories, category) ? loaded.amounts.categories[category] : undefined;
}
