/* global process, console */
// Negative controls for @symbolon/policy (AGENTS.md / QUESTIONS decision A5: "break the rule, confirm a test
// fails"). Each mutant disables one guard in src/, runs the package's test suite, and must make it FAIL.
// The original file is restored in `finally` (also on Ctrl-C). Usage, from the repo root:
//   node packages/policy/scripts/mutation-check.mjs            # all mutants (~25 s each)
//   node packages/policy/scripts/mutation-check.mjs vault-     # only mutants whose id starts with "vault-"
// Exit 0 iff every mutant was killed and every mutation applied exactly once.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const src = (f) => join(pkg, "src", f);

/** [id, file, exact text to find (must occur once), replacement] */
const MUTANTS = [
  ["yaml-anchors", "yaml.ts", "if (node.anchor !== undefined) issues.push", "if (false) issues.push"],
  ["yaml-tags", "yaml.ts", "if (node.tag !== undefined) issues.push", "if (false) issues.push"],
  ["yaml-aliases", "yaml.ts", 'issues.push({ path: "$", message: `${where(src, node)}aliases', 'void ({ path: "$", message: `${where(src, node)}aliases'],
  ["yaml-canonical-numbers", "yaml.ts", "if (!Number.isFinite(value) || node.source !== String(value)) {", "if (!Number.isFinite(value)) {"],
  ["yaml-null", "yaml.ts", 'return fail("YAML_FEATURE", path, `${where(src, node)}null / empty values are not accepted`);', "return value as JsonValue;"],
  ["yaml-forbidden-keys", "yaml.ts", 'new Set(["__proto__", "constructor", "prototype"])', "new Set<string>()"],
  ["yaml-hidden-chars", "yaml.ts", "if (isHidden(c) || (c === BOM && i > 0)) {", "if (c === BOM && i > 0) {"],
  ["yaml-multi-doc", "yaml.ts", "if (docs.length !== 1) fail(", "if (docs.length === 0) fail("],
  ["yaml-directives", "yaml.ts", "if (directives.yaml.explicit === true) fail(", "if (false) fail("],
  ["yaml-depth", "yaml.ts", "if (depth >= MAX_POLICY_DEPTH) fail(", "if (depth >= 64) fail("],
  ["amount-rounding", "amounts.ts", "if (BigInt(frac.length) > d) {", "if (false) {"],
  ["amount-uint256", "amounts.ts", 'if (units > MAX_UINT256) fail("POLICY_INVALID", path, "amount exceeds uint256 base units");', ""],
  ["policy-allowlist-pattern", "policy.ts", "if (!ORIGIN_PATTERN_RE.test(entry) || entry.length > 8 + 253) {", "if (entry.length > 8 + 253) {"],
  ["policy-allowlist-dupes", "policy.ts", 'if (seen.has(entry)) issues.push({ path, message: "duplicate allowlist entry" });', ""],
  ["policy-allowlist-sort", "policy.ts", "return [...seen].sort();", "return [...seen];"],
  ["policy-hourly-zero", "policy.ts", "...(hourlyCap > 0n ? { hourlyCap:", "...(hourlyCap >= 0n && parsed.caps.hourlyCap !== undefined ? { hourlyCap:"],
  ["policy-default-allowlist", "policy.ts", "urlAllowlist: [] as string[] }", 'urlAllowlist: ["https://*.vercel.app"] as string[] }'],
  ["policy-default-caps", "policy.ts", "  treasury: { costOfCapitalBps: 0 },\n", '  treasury: { costOfCapitalBps: 0 },\n  caps: { perTxHardCap: "100", dailyCap: "200", weeklyCap: "600", humanApprovalAbove: "50" },\n'],
  ["policy-freeze", "policy.ts", "return deepFreeze({ policy: canonical", "return ({ policy: canonical"],
  ["vault-per-tx", "vault.ts", 'cmp("PER_TX_CAP", "caps.perTxHardCap", "perTxCap", a.perTxHardCap, v.perTxCap);', ""],
  ["vault-daily", "vault.ts", 'cmp("DAILY_CAP", "caps.dailyCap", "dailyCap", a.dailyCap, v.dailyCap);', ""],
  ["vault-human", "vault.ts", 'cmp("HUMAN_THRESHOLD", "caps.humanApprovalAbove", "humanThreshold", a.humanApprovalAbove, v.humanThreshold);', ""],
  ["vault-hourly-off", "vault.ts", "if (a.hourlyCap === 0n) {", "if (false) {"],
  ["vault-hourly-cmp", "vault.ts", 'cmp("HOURLY_CAP", "caps.hourlyCap", "hourlyCap", a.hourlyCap, v.hourlyCap);', ""],
  ["vault-release-count", "vault.ts", "if (releases > BigInt(v.ringSize)) {", "if (false) {"],
  ["vault-decimals", "vault.ts", "if (d !== v.tokenDecimals) {", "if (false) {"],
  ["vault-hash-binding", "vault.ts", "if (policy.policyHash !== loaded.policyHash) {", "if (false) {"],
  ["vault-off-by-one", "vault.ts", "if (p > limit) {", "if (p > limit + 1n) {"],
  ["vault-config-zero-cap", "vault.ts", '!isUint256(input.dailyCap) || input.dailyCap > 0n, "dailyCap"', 'true, "dailyCap"'],
  ["sandbox-profile", "sandbox.ts", 'vault.profile === "sandbox", "vault.profile"', 'true, "vault.profile"'],
  ["sandbox-vault-limit", "sandbox.ts", "vault.perTxCap <= maxPerTxVault,", "true,"],
  ["sandbox-doc-chars", "sandbox.ts", "policy.policy.limits.maxDocChars <= SANDBOX_LIMITS.maxDocChars,", "true,"],
  ["sandbox-vault-check", "sandbox.ts", "    assertPolicyWithinVault(policy, vault);\n", "\n"],
  ["errors-fail-closed", "errors.ts", "    if (e instanceof PolicyError) throw e;\n    const message", "    throw e;\n    const message"],
];

const filter = process.argv[2] ?? "";
const selected = MUTANTS.filter(([id]) => id.startsWith(filter));
if (selected.length === 0) {
  console.error(`no mutant id starts with "${filter}"`);
  process.exit(2);
}

let restore = null;
process.on("SIGINT", () => {
  if (restore) restore();
  process.exit(130);
});

const results = [];
for (const [id, file, find, replace] of selected) {
  const path = src(file);
  const original = readFileSync(path, "utf8");
  const count = original.split(find).length - 1;
  if (count !== 1) {
    results.push([id, `NOT APPLIED (found ${count}x)`]);
    continue;
  }
  restore = () => writeFileSync(path, original);
  try {
    writeFileSync(path, original.replace(find, replace));
    const run = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "packages/policy", "--reporter=dot"], {
      cwd: root,
      encoding: "utf8",
    });
    const failed = /(\d+) failed/.exec(run.stdout + run.stderr);
    results.push([id, run.status !== 0 ? `killed (${failed ? failed[1] : "?"} failing tests)` : "SURVIVED"]);
  } finally {
    restore();
    restore = null;
  }
}

for (const [id, r] of results) console.log(`${id.padEnd(28)} ${r}`);
const bad = results.filter(([, r]) => !r.startsWith("killed"));
console.log(bad.length === 0 ? `all ${results.length} mutants killed` : `${bad.length} mutant(s) not killed`);
process.exit(bad.length === 0 ? 0 : 1);
