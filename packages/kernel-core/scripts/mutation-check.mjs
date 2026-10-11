/* global process, console */
// Negative controls for @symbolon/kernel-core and @symbolon/terms (QUESTIONS decision A5: "break the rule, confirm a
// test fails"). Each mutant disables or weakens ONE guard in src/, runs the two packages' test suites, and must make
// them FAIL. The original file is restored in `finally` (also on Ctrl-C). Usage, from the repo root:
//   node packages/kernel-core/scripts/mutation-check.mjs          # all mutants
//   node packages/kernel-core/scripts/mutation-check.mjs k05-     # only mutants whose id starts with "k05-"
// Exit 0 iff every mutant was killed and every mutation applied exactly once.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const K = "packages/kernel-core/src/";
const T = "packages/terms/src/";

/** [id, file (repo-relative), exact text to find (must occur once), replacement] */
const MUTANTS = [
  // --- packages/terms --------------------------------------------------------------------------------------
  ["terms-window-inclusive", `${T}terms.ts`, "if (pay.value > epochSecondsFromIso(windowEnd.value)) {", "if (pay.value >= epochSecondsFromIso(windowEnd.value)) {"],
  ["terms-floor", `${T}terms.ts`, "return (gross * bps) / BPS_DENOMINATOR;", "return (gross * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;"],
  ["terms-schema", `${T}terms.ts`, '  if (!parsed.success) return err("INVALID_TERMS", "payment terms do not satisfy PaymentTermsSchema");\n  const early = parsed.data.earlyPay;\n  if (early === null) return ok(none);', "  const early = input.terms.earlyPay;\n  if (early === null) return ok(none);"],
  ["terms-amount-range", `${T}terms.ts`, 'if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {', 'if (typeof value !== "bigint" || value > MAX_UINT256) {'],
  ["terms-apr-days", `${T}terms.ts`, "if (net.value <= within.value) return err(", "if (false) return err("],
  ["terms-max-epoch", `${T}terms.ts`, "if (end > MAX_EPOCH_SECONDS) return err(", "if (false) return err("],
  ["terms-bps-range", `${T}terms.ts`, "if (!Number.isSafeInteger(bps) || bps < 0 || bps > max) {", "if (!Number.isSafeInteger(bps) || bps < 0) {"],
  // --- verdict algebra -------------------------------------------------------------------------------------
  ["verdict-completeness", `${K}verdict.ts`, 'if (worst === "RELEASE" && !isComplete(checks, required)) {', "if (false) {"],
  ["verdict-skip", `${K}verdict.ts`, "if (!SKIPPABLE_CHECKS.has(c.id)) {", "if (false) {"],
  ["verdict-null-onfail", `${K}verdict.ts`, "if (c.onFail === null || c.code === null) {", "if (false) {"],
  ["verdict-combine-severity", `${K}verdict.ts`, "severity(verdictForOnFail(issue.onFail)) > severity(verdictForOnFail(worst.onFail))", "severity(verdictForOnFail(issue.onFail)) < severity(verdictForOnFail(worst.onFail))"],
  ["verdict-unknown-onfail", `${K}verdict.ts`, 'return "HOLD"; // corrupted value: fail closed', 'return "RELEASE";'],
  // --- pipeline --------------------------------------------------------------------------------------------
  ["pipeline-stage-guard", `${K}pipeline.ts`, "    return asResult(kernelError(stage.id, THREW));", '    throw new Error("unguarded");'],
  ["pipeline-k01-shortcircuit", `${K}pipeline.ts`, "  if (intent === null) return finish(config, checks, ctx, policy, { intent: null, facts: null, replayOf: null });\n", "  if (intent === null && checks.length < 0) return finish(config, checks, ctx, policy, { intent: null, facts: null, replayOf: null });\n"],
  ["pipeline-replay-shortcircuit", `${K}pipeline.ts`, '    if (out.kind === "replay") return finish(', '    if (out.kind === "never") return finish('],
  ["evaluate-last-resort", `${K}evaluate.ts`, "  } catch {\n    return failedEvaluation(ctx, policy);", '  } catch {\n    throw new Error("unguarded");'],
  // --- K-01 ------------------------------------------------------------------------------------------------
  ["k01-strict", `${K}checks/k01-schema.ts`, "  if (!parsed.success) {", "  if (false && !parsed.success) {"],
  ["k01-tenant", `${K}checks/k01-schema.ts`, "if (intent.tenantId !== ctx.tenantId) return reject(", "if (false) return reject("],
  ["k01-dochash", `${K}checks/k01-schema.ts`, "if (intent.docHash !== ctx.doc.hash) return reject(", "if (false) return reject("],
  ["k01-binary-fields", `${K}checks/k01-schema.ts`, "if (kind !== null) return reject(", "if (false) return reject("],
  ["k01-oversize-intent", `${K}checks/k01-schema.ts`, "if (size > maxIntentChars(maxDocChars)) return reject(", "if (false) return reject("],
  ["k01-doc-chars", `${K}checks/k01-schema.ts`, "if (text.length > maxDocChars) return reject(", "if (false) return reject("],
  ["k01-sandbox-bytes", `${K}checks/k01-schema.ts`, "utf8ByteLength(text) > SANDBOX_MAX_DOC_BYTES", "utf8ByteLength(text) > 2 * SANDBOX_MAX_DOC_BYTES"],
  ["k01-doc-binary", `${K}checks/k01-schema.ts`, "if (docKind !== null) return reject(", "if (false) return reject("],
  ["k01-doc-integrity", `${K}checks/k01-schema.ts`, "if (keccak256Utf8(text) !== ctx.doc.normalizedHash) {", "if (false) {"],
  // --- text helpers ----------------------------------------------------------------------------------------
  ["text-nul", `${K}text.ts`, 'if (s.includes("\\u0000")) return "NUL";', ""],
  ["text-control", `${K}text.ts`, 'if (hasControl(s)) return "CONTROL";', ""],
  ["text-data-uri", `${K}text.ts`, 'if (DATA_URI.test(s)) return "DATA_URI";', ""],
  ["text-encoded-run", `${K}text.ts`, "export const ENCODED_RUN_LIMIT = 512;", "export const ENCODED_RUN_LIMIT = 513;"],
  ["text-invoice-strip", `${K}text.ts`, '.replace(/^0+/, "");', ";"],
  // --- parseMoney (K-02) -----------------------------------------------------------------------------------
  ["money-non-ascii", `${K}money.ts`, 'if (ANY_NUMBER_CHAR.test(ch) && !ALLOWED_DIGIT.test(ch)) return { kind: "REJECT", code: "NON_ASCII_DIGITS" };', ""],
  ["money-scientific", `${K}money.ts`, 'if (SCIENTIFIC.test(nfkc)) return { kind: "REJECT", code: "SCIENTIFIC" };', ""],
  ["money-refuse-round", `${K}money.ts`, 'if (frac.length > decimals) return { kind: "REJECT", code: "REFUSE_ROUND" };', "if (frac.length > decimals) frac = frac.slice(0, decimals);"],
  ["money-lone-three", `${K}money.ts`, "if (options.convention === undefined) return LONE_THREE;", ""],
  ["money-grouping-shape", `${K}money.ts`, "return western || indian ? digits : null;", "return digits;"],
  ["money-leading-zero", `${K}money.ts`, 'if (digits.length > 1 && digits.startsWith("0")) return null;', ""],
  ["money-mixed-grouping", `${K}money.ts`, "if (spaceKinds.length > 1) return MALFORMED;", ""],
  ["money-currency-list", `${K}money.ts`, "const CURRENCY_RIGHT = /\\s*(?:US\\$|USDC|USD|EUR|\\p{Sc})$/iu;", "const CURRENCY_RIGHT = /\\s*(?:US\\$|USDC|USD|EUR|\\p{Sc}|[A-Za-z]+)$/iu;"],
  // --- K-02 ------------------------------------------------------------------------------------------------
  ["k02-null-parsed", `${K}checks/k02-precision.ts`, 'if (facts.claimedGross === null) return fail("K-02"', 'if (false) return fail("K-02"'],
  ["k02-decimals", `${K}checks/k02-precision.ts`, "if (amount.decimals !== null && amount.decimals !== facts.declaredDecimals) {", "if (false) {"],
  ["k02-claimed", `${K}checks/k02-precision.ts`, "if (facts.claimedGross !== value) {", "if (false) {"],
  ["k02-lineitem-sum", `${K}checks/k02-precision.ts`, "if (sum !== value) return fail(", "if (false) return fail("],
  // --- K-03 ------------------------------------------------------------------------------------------------
  ["k03-credit-note", `${K}checks/k03-doctype.ts`, '    case "CREDIT_NOTE":\n', '    case "CREDIT_NOTE":\n      return null;\n'],
  ["k03-extraction-b", `${K}checks/k03-doctype.ts`, "if (extractionB !== null) {", "if (false) {"],
  ["k03-zero", `${K}checks/k03-doctype.ts`, "if (facts.gross === 0n)", "if (false)"],
  // --- K-04 ------------------------------------------------------------------------------------------------
  ["k04-norm-overflow", `${K}checks/k04-idempotency.ts`, "if (facts.normInvoiceNo === null) {", "if (false) {"],
  ["k04-reeval-intent", `${K}checks/k04-idempotency.ts`, "if (re !== null && re.intentId !== facts.intentId) {", "if (false) {"],
  ["k04-replay", `${K}checks/k04-idempotency.ts`, "if (re === null && same.length > 0) {", "if (false) {"],
  ["k04-replay-during-reeval", `${K}checks/k04-idempotency.ts`, "if (re === null && same.length > 0) {", "if (same.length > 0) {"],
  ["k04-replay-latest", `${K}checks/k04-idempotency.ts`, "d.createdAt > best.createdAt || (d.createdAt === best.createdAt && d.decisionId > best.decisionId) ? d : best", "best"],
  ["k04-milestone-paid", `${K}checks/k04-idempotency.ts`, "if (paid.length > 0) {", "if (false) {"],
  ["k04-dup-doc", `${K}checks/k04-idempotency.ts`, "if (sameDoc.length > 0) {", "if (false) {"],
  ["k04-near-dup", `${K}checks/k04-idempotency.ts`, "if (near.length > 0) {", "if (false) {"],
  ["k04-near-window", `${K}checks/k04-idempotency.ts`, "<= NEAR_DUPLICATE_WINDOW_SECONDS", "< NEAR_DUPLICATE_WINDOW_SECONDS"],
  // --- K-05 ------------------------------------------------------------------------------------------------
  ["k05-tenant", `${K}facts.ts`, "return e.engagementId === intent.engagementId && e.tenantId === ctx.tenantId ? e : null;", "return e.engagementId === intent.engagementId ? e : null;"],
  ["k05-schema", `${K}checks/k05-engagement.ts`, "if (!EngagementSchema.safeParse(e).success) return kernelError(", "if (false) return kernelError("],
  ["k05-status", `${K}checks/k05-engagement.ts`, 'if (e.status !== "ACTIVE")', "if (false)"],
  ["k05-sigs", `${K}checks/k05-engagement.ts`, "if (e.ownerSig === null || e.payeeSig === null)", "if (false)"],
  ["k05-registered", `${K}checks/k05-engagement.ts`, "if (e.registeredTx === null)", "if (false)"],
  ["k05-terms-hash", `${K}checks/k05-engagement.ts`, "if (computeTermsHash(e) !== e.termsHash)", "if (false)"],
  ["k05-onchain-missing", `${K}checks/k05-engagement.ts`, 'issues.push(inactive("no on-chain EngagementRegistered record for this engagement"));', ""],
  ["k05-onchain-terms", `${K}checks/k05-engagement.ts`, "if (chain.termsHash !== e.termsHash)", "if (false)"],
  ["k05-onchain-cap", `${K}checks/k05-engagement.ts`, "if (chain.capBaseUnits !== BigInt(e.capBaseUnits))", "if (false)"],
  ["k05-window-end", `${K}checks/k05-engagement.ts`, "now > epochSecondsFromIso(e.end)", "now > epochSecondsFromIso(e.end) + 1n"],
  ["k05-window-start", `${K}checks/k05-engagement.ts`, "now < epochSecondsFromIso(e.start)", "now + 1n < epochSecondsFromIso(e.start)"],
  ["k05-ctx-milestone", `${K}checks/k05-engagement.ts`, "if (ctx.milestone === null || jcs(ctx.milestone) !== jcs(m)) {", "if (false) {"],
  ["k05-milestone-paid", `${K}checks/k05-engagement.ts`, '    case "PAID":\n', '    case "PAID":\n      return null;\n'],
  ["k05-sequential", `${K}checks/k05-engagement.ts`, "if (unpaid.length > 0)", "if (false)"],
  // --- K-06 ------------------------------------------------------------------------------------------------
  ["k06-payout", `${K}facts.ts`, "payout: engagement === null ? null : engagement.payee,", "payout: a.payee.walletAddress ?? (engagement === null ? null : engagement.payee),"],
  ["k06-mismatch", `${K}checks/k06-payee.ts`, "if (wallet !== null && wallet.toLowerCase() !== payee) {", "if (false) {"],
  ["k06-extraction-b", `${K}checks/k06-payee.ts`, "const extractions = intent.extraction.b === null ? [intent.extraction.a] : [intent.extraction.a, intent.extraction.b];", "const extractions = [intent.extraction.a];"],
  ["k06-change-claimed", `${K}checks/k06-payee.ts`, "if (x.payee.claimsAddressChange) {", "if (false) {"],
  ["k06-onchain-payee", `${K}checks/k06-payee.ts`, "if (chain !== null && chain.payee.toLowerCase() !== payee) {", "if (false) {"],
  ["k06-pending", `${K}checks/k06-payee.ts`, "if (ctx.payeeChangePending) {", "if (false) {"],
  // --- K-07 ------------------------------------------------------------------------------------------------
  ["k07-usd-alias", `${K}checks/k07-currency.ts`, 'return treatUsdAsUsdc && (c === "USD" || c === "$");', 'return c === "USD" || c === "$";'],
  ["k07-currency", `${K}checks/k07-currency.ts`, "if (!currencyAccepted(", "if (false && !currencyAccepted("],
  ["k07-decimals", `${K}checks/k07-currency.ts`, "if (decimals.some(([, d]) => d !== facts.declaredDecimals)) {", "if (false) {"],
  ["k07-scale", `${K}checks/k07-currency.ts`, "candidates.some((v) => v !== null && v > limit)", "candidates.some((v) => v !== null && v > limit * 10n)"],
  // --- K-08 ------------------------------------------------------------------------------------------------
  ["k08-gross-null", `${K}checks/k08-amount.ts`, 'if (gross === null) return fail("K-08"', 'if (false) return fail("K-08"'],
  ["k08-released-range", `${K}checks/k08-amount.ts`, 'if (typeof released !== "bigint" || released < 0n) return kernelError(', "if (false) return kernelError("],
  ["k08-received-after-now", `${K}checks/k08-amount.ts`, "if (epochSecondsFromIso(ctx.invoiceReceivedAt) > epochSecondsFromIso(ctx.now)) return kernelError(", "if (false) return kernelError("],
  ["k08-terms-crosscheck", `${K}checks/k08-amount.ts`, "if (jcs(ctx.paymentTerms) !== jcs(e.paymentTerms)) return kernelError(", "if (false) return kernelError("],
  ["k08-over", `${K}checks/k08-amount.ts`, "if (gross > milestoneAmount) {", "if (false) {"],
  ["k08-cap", `${K}checks/k08-amount.ts`, "if (released + gross > cap) {", "if (released + gross > cap + 1n) {"],
  ["k08-under", `${K}checks/k08-amount.ts`, "if (gross < milestoneAmount && !m.partialAllowed) {", "if (false) {"],
  ["k08-partial-cumulative", `${K}checks/k08-amount.ts`, "if (priorSum + gross > milestoneAmount) {", "if (false) {"],
  ["k08-release-over", `${K}checks/k08-amount.ts`, "} else if (r.scheduledAmount > r.expected.value.amountDue) {", "} else if (false) {"],
  ["k08-release-under", `${K}checks/k08-amount.ts`, "} else if (r.scheduledAmount < r.expected.value.amountDue) {", "} else if (false) {"],
  ["k08-payat-max", `${K}facts.ts`, "const payAt = epochSecondsFromIso(ctx.now) >= epochSecondsFromIso(re.payAt) ? ctx.now : re.payAt;", "const payAt = re.payAt;"],
  ["k08-gross-kernel-first", `${K}facts.ts`, 'const gross = totalParse.kind === "EXACT" ? totalParse.baseUnits : claimedGross;', "const gross = claimedGross;"],
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
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  const count = original.split(find).length - 1;
  if (count !== 1) {
    results.push([id, `NOT APPLIED (found ${count}x)`]);
    continue;
  }
  restore = () => writeFileSync(path, original);
  try {
    writeFileSync(path, original.replace(find, replace));
    // Stage 1: the fast unit/golden suites; stage 2 (only if stage 1 passed): everything incl. the 1,000-run properties.
    const vitest = (extra) =>
      spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "packages/terms", "packages/kernel-core", "--reporter=dot", "--bail=1", ...extra], {
        cwd: root,
        encoding: "utf8",
      });
    let run = vitest(["--exclude", "**/props-*.test.ts", "--exclude", "**/node_modules/**"]);
    let stage = "unit";
    if (run.status === 0) {
      run = vitest([]);
      stage = "properties";
    }
    const failed = /(\d+) failed/.exec(run.stdout + run.stderr);
    results.push([id, run.status !== 0 ? `killed by ${stage} (${failed ? failed[1] : "?"} failing before bail)` : "SURVIVED"]);
  } finally {
    restore();
    restore = null;
  }
  console.log(`${id.padEnd(30)} ${results[results.length - 1][1]}`);
}

const bad = results.filter(([, r]) => !r.startsWith("killed"));
console.log(bad.length === 0 ? `all ${results.length} mutants killed` : `${bad.length} mutant(s) not killed: ${bad.map(([id]) => id).join(", ")}`);
process.exit(bad.length === 0 ? 0 : 1);
