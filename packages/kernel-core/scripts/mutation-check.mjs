/* global process, console */
// Negative controls for @symbolon/kernel-core and @symbolon/terms (QUESTIONS decision A5: "break the rule, confirm a
// test fails"). WP-04 guards (terms math, verdict algebra, pipeline, K-01..K-08) and WP-05 guards (feasiblePlans, plan
// evaluator, evidence/K-09, K-10, K-11/patterns, K-12, owner-approval and budget gates, digest, K-13, K-14, schedule,
// K-16/breaker, explanation, reevaluate). Each mutant disables or weakens ONE guard in src/, runs the two packages' test suites, and must make
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
  ["terms-window-inclusive", `${T}terms.ts`, "if (payAtSec > windowEndSec) return {", "if (payAtSec >= windowEndSec) return {"],
  ["terms-floor", `${T}terms.ts`, "return (gross * bps) / BPS_DENOMINATOR;", "return (gross * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;"],
  ["terms-schema", `${T}terms.ts`, '  const parsed = PaymentTermsSchema.safeParse(input.terms);\n  if (!parsed.success) return err("INVALID_TERMS", "payment terms do not satisfy PaymentTermsSchema");\n  const early = parsed.data.earlyPay;', "  const early = input.terms.earlyPay;"],
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
  ["pipeline-k01-shortcircuit", `${K}pipeline.ts`, "  if (intent === null) return finish(config, checks, ctx, policy, { intent: null, facts: null, inputs: null, replayOf: null });\n", "  if (intent === null && checks.length < 0) return finish(config, checks, ctx, policy, { intent: null, facts: null, inputs: null, replayOf: null });\n"],
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
  ["k08-release-over", `${K}checks/k08-amount.ts`, "} else if (r.scheduledAmount > due.amountDue) {", "} else if (false) {"],
  ["k08-release-under", `${K}checks/k08-amount.ts`, "} else if (r.scheduledAmount < due.amountDue) {", "} else if (false) {"],
  ["k08-payat-max", `${K}facts.ts`, "const payAt = epochSecondsFromIso(ctx.now) >= epochSecondsFromIso(re.payAt) ? ctx.now : re.payAt;", "const payAt = re.payAt;"],
  ["k08-gross-kernel-first", `${K}facts.ts`, 'const gross = totalParse.kind === "EXACT" ? totalParse.baseUnits : claimedGross;', "const gross = claimedGross;"],
  // ===================================== WP-05 ===============================================================
  // --- packages/terms: feasiblePlans ------------------------------------------------------------------------
  ["plans-reserve-floor", `${T}plans.ts`, "if (after < liq.reserveFloor) {", "if (after + 1n < liq.reserveFloor) {"],
  ["plans-discount-margin", `${T}plans.ts`, "minOf(windowEndSec - BigInt(timing.windowSafetyMarginMinutes) * SECONDS_PER_MINUTE, latest)", "minOf(windowEndSec, latest)"],
  ["plans-discount-earliest", `${T}plans.ts`, "payAt: t < earliest ? null : t,", "payAt: t,"],
  ["plans-immediate-allowed", `${T}plans.ts`, "if (!terms.allowImmediate) candidates.push(", "if (false) candidates.push("],
  ["plans-immediate-now", `${T}plans.ts`, "payAt: earliest === N ? N : null,", "payAt: N,"],
  ["plans-late", `${T}plans.ts`, "const late = latestRaw < earliest;", "const late = false;"],
  ["plans-evidence-required", `${T}plans.ts`, "  if (E === null) {\n    const plan = hold();", "  if (false) {\n    const plan = hold();"],
  ["plans-dispute-window", `${T}plans.ts`, "maxOf(R, E) + BigInt(timing.disputeWindowHours) * SECONDS_PER_HOUR", "maxOf(R, E)"],
  ["plans-earliest-dispute", `${T}plans.ts`, "const earliest = E === null ? N : maxOf(N, E, disputeEnd);", "const earliest = E === null ? N : maxOf(N, E);"],
  ["plans-due-buffer", `${T}plans.ts`, "const latestRaw = due - BigInt(terms.payBeforeDueBufferHours) * SECONDS_PER_HOUR;", "const latestRaw = due;"],
  ["plans-signed-netdays", `${T}plans.ts`, "    netDays: p.netDays,", "    netDays: timing.defaultNetDays,"],
  ["plans-immediate-both", `${T}plans.ts`, "allowImmediate: p.allowImmediate && timing.allowImmediate,", "allowImmediate: p.allowImmediate,"],
  ["plans-received-after-now", `${T}plans.ts`, 'if (received.value > now.value) return err("INVALID_TIME", "invoiceReceivedAt is after now");', ""],
  ["plans-amount-ceiling", `${T}plans.ts`, "} else if (input.amountCeiling !== null && d.amountDue > input.amountCeiling) {", "} else if (false) {"],
  ["plans-hold-only-if-empty", `${T}plans.ts`, "  if (plans.length === 0) {\n    const plan = hold();", "  if (true) {\n    const plan = hold();"],
  // --- packages/terms: plan evaluator -----------------------------------------------------------------------
  ["score-cost-ceil", `${T}eval/score.ts`, "return discount - ceilDiv(amount * costBps * early, YEAR_SECONDS_BPS);", "return discount - (amount * costBps * early) / YEAR_SECONDS_BPS;"],
  ["score-early-nonneg", `${T}eval/score.ts`, "const early = reference > payAt ? reference - payAt : 0n;", "const early = reference - payAt;"],
  ["score-safe-not-hold", `${T}eval/score.ts`, 'return plan.mode !== "HOLD" && plan.reserveFloorOk;', "return plan.reserveFloorOk;"],
  ["score-tiebreak", `${T}eval/score.ts`, 'Object.freeze(["DUE_MINUS_BUFFER", "TAKE_DISCOUNT",', 'Object.freeze(["TAKE_DISCOUNT", "DUE_MINUS_BUFFER",'],
  ["score-rank-desc", `${T}eval/score.ts`, "return a.netBenefit > b.netBenefit ? -1 : 1;", "return a.netBenefit > b.netBenefit ? 1 : -1;"],
  ["score-dup-ids", `${T}eval/score.ts`, "if (ids.size !== plans.length) return err(", "if (false) return err("],
  ["score-bps-range", `${T}eval/score.ts`, "|| p.costOfCapitalBps > MAX_COST_OF_CAPITAL_BPS) {", ") {"],
  // --- evidence (K-09 pure side) ----------------------------------------------------------------------------
  ["ev-other-milestone", `${K}evidence.ts`, "parsed.data.milestoneId !== milestone.milestoneId || ", ""],
  ["ev-future-dated", `${K}evidence.ts`, " || epochSecondsFromIso(parsed.data.collectedAt) > now) {", ") {"],
  ["ev-sandbox-fixtures-only", `${K}evidence.ts`, '  if (ctx.profile !== "production") {\n    // Sandbox', "  if (false) {\n    // Sandbox"],
  ["ev-fixture-requirement", `${K}evidence.ts`, "if (FIXTURE_SOURCE.test(e.source) && isRecord(p) && jcs(p.requirement ?? null) === jcs(req)) {", "if (FIXTURE_SOURCE.test(e.source) && isRecord(p)) {"],
  ["ev-fixture-source", `${K}evidence.ts`, "if (FIXTURE_SOURCE.test(e.source) && isRecord(p) && jcs(p.requirement ?? null) === jcs(req)) {", "if (isRecord(p) && jcs(p.requirement ?? null) === jcs(req)) {"],
  ["ev-url-denied", `${K}evidence.ts`, 'if (!decision.allowed) return { ...base, state: "DENIED"', 'if (false) return { ...base, state: "DENIED"'],
  ["ev-production-source", `${K}evidence.ts`, "if (e.source !== productionSource(req)) {", "if (false) {"],
  ["ev-freshness", `${K}evidence.ts`, "now - epochSecondsFromIso(o.evidence.collectedAt) <= freshFor", "now - epochSecondsFromIso(o.evidence.collectedAt) <= freshFor + 1n"],
  ["ev-latest-decides", `${K}evidence.ts`, "const latest = fresh.reduce((best, o) => (later(o.evidence, best.evidence) ? o : best));", "const latest = fresh[0] as Observation;"],
  ["ev-ack-signer", `${K}evidence.ts`, "|| signer === null || signer.toLowerCase() !== owner.toLowerCase()) return null;", "|| signer === null) return null;"],
  ["ev-ack-milestone", `${K}evidence.ts`, 'if (str(p, "milestoneId") !== milestoneId || signer', "if (signer"],
  ["ev-ack-deadline", `${K}evidence.ts`, "|| BigInt(deadline) < epochSecondsFromIso(e.collectedAt)) return null;", ") return null;"],
  ["ev-ci-commit", `${K}evidence.ts`, "const wrongCommit = SHA40.test(req.ref) && (headSha === null || headSha.toLowerCase() !== req.ref.toLowerCase());", "const wrongCommit = false;"],
  ["ev-ci-conclusion", `${K}evidence.ts`, 'str(p, "conclusion") !== "success" || wrongCommit', "wrongCommit"],
  ["ev-ci-repo-ref", `${K}evidence.ts`, 'if (str(p, "repo") !== req.repo || str(p, "ref") !== req.ref) return null;', "if (false) return null;"],
  ["ev-url-status", `${K}evidence.ts`, 'if (p.status !== req.expectStatus) return "FAILED";', ""],
  ["ev-url-hash", `${K}evidence.ts`, 'if (req.contentSha256 !== undefined && p.bodySha256 !== req.contentSha256) return "TAMPERED";', ""],
  ["ev-artifact-hash", `${K}evidence.ts`, 'p.sha256 === req.sha256 ? "SATISFIED" : "TAMPERED"', '"SATISFIED"'],
  ["ev-result-pass", `${K}evidence.ts`, 'if (e.result === "PASS") return passCondition();', "return passCondition();"],
  ["ev-result-fail", `${K}evidence.ts`, 'return e.result === "FAIL" ? "FAILED" : "MISSING";', 'return "MISSING";'],
  ["ev-override-not-tampered", `${K}evidence.ts`, 'r.state === "SATISFIED" || r.state === "TAMPERED" ? r :', 'r.state === "SATISFIED" ? r :'],
  ["ev-override-sandbox", `${K}evidence.ts`, 'if (ctx.profile !== "production" || !policy.policy.evidence.allowOwnerOverride) return null;', "if (!policy.policy.evidence.allowOwnerOverride) return null;"],
  ["ev-override-policy", `${K}evidence.ts`, 'if (ctx.profile !== "production" || !policy.policy.evidence.allowOwnerOverride) return null;', 'if (ctx.profile !== "production") return null;'],
  ["ev-override-fresh", `${K}evidence.ts`, "now - epochSecondsFromIso(e.collectedAt) <= freshFor &&", "true &&"],
  ["ev-override-result", `${K}evidence.ts`, 'e.result === "PASS" &&', "true &&"],
  ["ev-override-flag", `${K}evidence.ts`, "readAck(e, milestoneId, owner)?.override === true,", "readAck(e, milestoneId, owner) !== null,"],
  ["ev-empty-spec", `${K}evidence.ts`, "const satisfiedAt = !satisfied ? null : times.length === 0 ?", "const satisfiedAt = !satisfied || times.length === 0 ? null : times.length === 0 ?"],
  ["ev-satisfied-at-max", `${K}evidence.ts`, "times.reduce((a, b) => (b > a ? b : a))", "(times[0] as ISODateTime)"],
  ["url-scheme", `${K}evidence.ts`, 'if (typeof url !== "string" || !url.startsWith("https://")) return', 'if (typeof url !== "string") return'],
  ["url-userinfo", `${K}evidence.ts`, 'if (authority.includes("@")) return { allowed: false, reason: "USERINFO" };', ""],
  ["url-ipv6", `${K}evidence.ts`, 'if (authority.startsWith("[")) return { allowed: false, reason: "IP_LITERAL" };', ""],
  ["url-port", `${K}evidence.ts`, 'if (colon !== -1 && authority.slice(colon + 1) !== "443") return { allowed: false, reason: "PORT" };', ""],
  ["url-ip-literal", `${K}evidence.ts`, 'if (!LETTER_START.test(labels[labels.length - 1] as string)) return { allowed: false, reason: "IP_LITERAL" };', ""],
  ["url-labels", `${K}evidence.ts`, "if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) return", "if (host.length > 253 || labels.length < 2) return"],
  ["url-wildcard-strict", `${K}evidence.ts`, "if (host.endsWith(base.slice(1))) return { allowed: true, host };", "if (host.endsWith(base.slice(2))) return { allowed: true, host };"],
  ["url-exact-host", `${K}evidence.ts`, "} else if (host === base) {", "} else if (host.endsWith(base)) {"],
  ["plan-sandbox-fixture", `${K}evidence.ts`, 'if (profile !== "production") return { kind: "FIXTURE", index };', ""],
  ["plan-url-denied", `${K}evidence.ts`, 'return d.allowed ? { kind: "URL_HEALTH", index, url: req.url } : { kind: "DENIED", index, reason: d.reason };', 'return { kind: "URL_HEALTH", index, url: req.url };'],
  // --- K-09 ------------------------------------------------------------------------------------------------
  ["k09-tampered-reject", `${K}checks/k09-evidence.ts`, 'if (state === "TAMPERED") return { onFail: "REJECT",', 'if (state === "TAMPERED") return { onFail: "HOLD",'],
  ["k09-code-priority", `${K}checks/k09-evidence.ts`, "{ TAMPERED: 0, DENIED: 1, FAILED: 2, MISSING: 3 }", "{ TAMPERED: 0, DENIED: 3, FAILED: 2, MISSING: 1 }"],
  // --- K-10 ------------------------------------------------------------------------------------------------
  ["k10-disagree", `${K}checks/k10-consensus.ts`, 'if (recomputed.status === "DISAGREE") {', "if (false) {"],
  ["k10-misreport", `${K}checks/k10-consensus.ts`, "if (intent.consensus.status !== recomputed.status || jcs(intent.consensus.diffs) !== jcs(recomputed.diffs)) {", "if (false) {"],
  ["k10-degenerate", `${K}checks/k10-consensus.ts`, "const degenerate = x.b !== null && (x.modelA === x.modelB || x.promptHashA === x.promptHashB);", "const degenerate = false;"],
  ["k10-single", `${K}checks/k10-consensus.ts`, 'if ((recomputed.status === "SINGLE" || degenerate) && !policy.policy.extraction.allowSingle) {', "if (degenerate && !policy.policy.extraction.allowSingle) {"],
  // --- K-11 + patterns -------------------------------------------------------------------------------------
  ["k11-extractor-instruction", `${K}checks/k11-instruction.ts`, 'if (extractions.some((x) => x.anomalies.some((a) => a.code === "INSTRUCTION_IN_DOC"))) {', "if (false) {"],
  ["k11-extractor-address", `${K}checks/k11-instruction.ts`, 'if (extractions.some((x) => x.anomalies.some((a) => a.code === "ADDRESS_CHANGE"))) {', "if (false) {"],
  ["k11-change-only-code", `${K}checks/k11-instruction.ts`, 'const changeOnly = found.every((f) => f.group === "CHANGE_OF_DETAILS" || f.id === "EX-02");', "const changeOnly = false;"],
  ["k11-known-payee", `${K}checks/k11-instruction.ts`, "if (facts.engagement !== null) known.push(facts.engagement.payee, facts.engagement.owner);", ""],
  ["pat-hidden-zero-tolerance", `${K}patterns.ts`, "export const HIDDEN_CHAR_LIMIT = 0;", "export const HIDDEN_CHAR_LIMIT = 5;"],
  ["pat-hidden-stored-count", `${K}patterns.ts`, "const hidden = input.zeroWidthCount + folded.hidden;", "const hidden = folded.hidden;"],
  ["pat-hidden-stripped", `${K}patterns.ts`, '      if (mode === "canonical") continue;\n', ""],
  ["pat-homoglyph-map", `${K}patterns.ts`, "(HOMOGLYPHS[part] ?? part)", "part"],
  ["pat-ascii-lowercase", `${K}patterns.ts`, "emit(cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 32) : ch, at);", "emit(ch, at);"],
  ["pat-squashed-view", `${K}patterns.ts`, "    { view: squashed, pick: (p: TextPattern) => p.squashed },\n", ""],
  ["pat-literal-view", `${K}patterns.ts`, 'const literal = folded.hidden > 0 ? [foldForScan(input.text, "literal")] : [];', "const literal: Folded[] = [];"],
  ["pat-cd04-known-only", `${K}patterns.ts`, "if (next !== null && known.has(next[0])) continue;", "if (next !== null) continue;"],
  ["pat-unknown-address", `${K}patterns.ts`, "if (!known.has(m[0])) add({", "if (false) add({"],
  ["pat-base64-limit", `${K}patterns.ts`, "{${BASE64_RUN_LIMIT + 1},}", "{${BASE64_RUN_LIMIT + 2},}"],
  // --- K-12 ------------------------------------------------------------------------------------------------
  ["k12-gross-null", `${K}checks/k12-authority.ts`, 'if (gross === null) return fail("K-12"', 'if (false) return fail("K-12"'],
  ["k12-malformed", `${K}checks/k12-authority.ts`, "if (![r.tenantDay, r.tenantWeek, r.payeeDay, spentRaw].every(isAmount) || ![r.payeeCountDay, r.tenantCountDay, h.priorPayments].every(isCount)) {", "if (false) {"],
  ["k12-per-tx", `${K}checks/k12-authority.ts`, "if (gross > a.perTxHardCap)", "if (gross > a.perTxHardCap + 1n)"],
  ["k12-daily", `${K}checks/k12-authority.ts`, "if (r.tenantDay + gross > a.dailyCap)", "if (r.tenantDay + gross > a.dailyCap + 1n)"],
  ["k12-weekly", `${K}checks/k12-authority.ts`, "if (r.tenantWeek + gross > a.weeklyCap)", "if (r.tenantWeek + gross > a.weeklyCap + 1n)"],
  ["k12-payee-count", `${K}checks/k12-authority.ts`, "if (r.payeeCountDay + 1 > v.maxReleasesPerPayeePerDay)", "if (r.payeeCountDay > v.maxReleasesPerPayeePerDay)"],
  ["k12-tenant-count", `${K}checks/k12-authority.ts`, "if (r.tenantCountDay + 1 > v.maxReleasesPerDay)", "if (r.tenantCountDay > v.maxReleasesPerDay)"],
  ["k12-payee-amount", `${K}checks/k12-authority.ts`, "if (r.payeeDay + gross > a.maxAmountPerPayeePerDay)", "if (r.payeeDay + gross > a.maxAmountPerPayeePerDay + 1n)"],
  ["k12-category-missing", `${K}checks/k12-authority.ts`, 'if (budget === undefined) issues.push({ onFail: "ESCALATE"', 'if (false) issues.push({ onFail: "ESCALATE"'],
  ["k12-category-budget", `${K}checks/k12-authority.ts`, "else if (spent + gross > budget)", "else if (spent + gross > budget + 1n)"],
  ["k12-human-gate", `${K}checks/k12-authority.ts`, "if (gross > a.humanApprovalAbove)", "if (gross > a.humanApprovalAbove + 1n)"],
  ["k12-first-payment", `${K}checks/k12-authority.ts`, "if (h.priorPayments === 0) {", "if (false) {"],
  ["k12-first-large", `${K}checks/k12-authority.ts`, "if (gross > a.firstPaymentMax)", "if (false)"],
  ["k12-always-human", `${K}checks/k12-authority.ts`, "if (policy.policy.newPayee.alwaysHuman)", "if (false)"],
  // --- gates: owner approval and escalation budget ----------------------------------------------------------
  ["gate-approval-schema", `${K}gates.ts`, "if (!EIP712_MESSAGE_SCHEMAS.OwnerApproval.safeParse(a).success) return invalid(", "if (false) return invalid("],
  ["gate-approval-receipt", `${K}gates.ts`, 'if (a.receiptHash !== (ctx.approvedEscalation as NonNullable<KernelContext["approvedEscalation"]>).receiptHash) return invalid(', "if (false) return invalid("],
  ["gate-approval-intent", `${K}gates.ts`, "if (!facts.intentIdBound || a.intentId !== facts.intentId) return invalid(", "if (false) return invalid("],
  ["gate-approval-amount", `${K}gates.ts`, "if (a.amount !== releaseAmount.toString()) return invalid(", "if (false) return invalid("],
  ["gate-approval-deadline", `${K}gates.ts`, "if (BigInt(a.deadline) <= epochSecondsFromIso(ctx.now)) return invalid(", "if (BigInt(a.deadline) < epochSecondsFromIso(ctx.now)) return invalid("],
  ["gate-approved-findings-only", `${K}gates.ts`, " && approval.approved.has(findingKey(c.id, i.code));", ";"],
  ["gate-never-approvable", `${K}gates.ts`, 'const resolves = (i: Issue): boolean => i.onFail === "ESCALATE" && !NEVER_APPROVABLE.has(i.code) &&', 'const resolves = (i: Issue): boolean => i.onFail === "ESCALATE" &&'],
  ["gate-escalate-only", `${K}gates.ts`, 'const resolves = (i: Issue): boolean => i.onFail === "ESCALATE" && ', "const resolves = (i: Issue): boolean => "],
  ["gate-budget-only-escalate", `${K}gates.ts`, 'if (!input.budgetMet || aggregate(approved, required).verdict !== "ESCALATE") return approved;', "if (!input.budgetMet) return approved;"],
  ["gate-budget-met", `${K}gates.ts`, 'if (!input.budgetMet || aggregate(approved, required).verdict !== "ESCALATE") return approved;', 'if (aggregate(approved, required).verdict !== "ESCALATE") return approved;'],
  ["gate-budget-holds", `${K}gates.ts`, '{ ...i, onFail: "HOLD", detail: `held, not escalated', '{ ...i, onFail: "ESCALATE", detail: `held, not escalated'],
  ["budget-per-day-boundary", `${K}gates.ts`, "return e.today >= policy.policy.escalation.maxPerDay ||", "return e.today > policy.policy.escalation.maxPerDay ||"],
  ["budget-per-engagement", `${K}gates.ts`, " || (perEngagement as number) >= policy.policy.escalation.maxPerEngagementPerDay;", ";"],
  ["budget-malformed-met", `${K}gates.ts`, "c >= 0)) return true;", "c >= 0)) return false;"],
  ["pipeline-budget-unreadable", `${K}pipeline.ts`, "budgetMet: budget.ok ? budget.value : true,", "budgetMet: budget.ok ? budget.value : false,"],
  // --- digest ----------------------------------------------------------------------------------------------
  ["digest-fewest-passing", `${K}digest.ts`, "return a.passingChecks - b.passingChecks;", "return b.passingChecks - a.passingChecks;"],
  ["digest-largest-amount", `${K}digest.ts`, "return a.amountBaseUnits > b.amountBaseUnits ? -1 : 1;", "return a.amountBaseUnits > b.amountBaseUnits ? 1 : -1;"],
  ["digest-unknown-amount-first", `${K}digest.ts`, "if (a.amountBaseUnits === null) return -1;", "if (a.amountBaseUnits === null) return 1;"],
  ["digest-newest-payee", `${K}digest.ts`, "return a.payeePriorPayments - b.payeePriorPayments;", "return b.payeePriorPayments - a.payeePriorPayments;"],
  ["digest-passing-count", `${K}digest.ts`, 'c.status === "PASS" && c.code === null', 'c.status === "PASS"'],
  // --- K-13 ------------------------------------------------------------------------------------------------
  ["k13-hit-always", `${K}checks/k13-screening.ts`, 'if (s !== null && s.status === "HIT") return fail(', "if (false) return fail("],
  ["k13-skip", `${K}checks/k13-screening.ts`, "if (!policy.policy.screening.required) return skip(", "if (false) return skip("],
  ["k13-future", `${K}checks/k13-screening.ts`, 'if (age < 0n) return fail("K-13", "HOLD", "SCREENING_PENDING", "screening record is dated after now");', ""],
  ["k13-stale", `${K}checks/k13-screening.ts`, "if (age > BigInt(policy.policy.screening.staleAfterHours) * 3_600n)", "if (age > BigInt(policy.policy.screening.staleAfterHours) * 3_600n + 1n)"],
  ["k13-clear", `${K}checks/k13-screening.ts`, 'if (s.status !== "CLEAR") return fail(', "if (false) return fail("],
  // --- K-14 + K-08 TOCTOU ----------------------------------------------------------------------------------
  ["k14-terms-crosscheck", `${K}checks/k14-timing.ts`, 'if (jcs(ctx.paymentTerms) !== jcs(e.paymentTerms)) return kernelError("K-14"', 'if (false) return kernelError("K-14"'],
  ["k14-not-signed", `${K}checks/k14-timing.ts`, "    if (terms.earlyPay === null) {", "    if (false) {"],
  ["k14-early-mismatch", `${K}checks/k14-timing.ts`, "} else if (early.discountBps !== terms.earlyPay.discountBps || early.withinDays !== terms.earlyPay.withinDays) {", "} else if (early.discountBps !== terms.earlyPay.discountBps) {"],
  ["k14-netdays-both-ways", `${K}checks/k14-timing.ts`, "if (stated.netDays !== null && stated.netDays !== terms.netDays) {", "if (stated.netDays !== null && stated.netDays > terms.netDays) {"],
  ["k14-ambiguous", `${K}checks/k14-timing.ts`, "if (stated.ambiguous && !statesNothing) {", "if (false) {"],
  ["k14-states-nothing", `${K}checks/k14-timing.ts`, "const statesNothing = stated.raw === null && stated.netDays === null && early === null;", "const statesNothing = false;"],
  ["k14-extraction-b", `${K}checks/k14-timing.ts`, "  extractions.forEach((x, i) => issues.push(...termsIssues(", "  [intent.extraction.a].forEach((x, i) => issues.push(...termsIssues("],
  ["k14-window-closed", `${K}checks/k14-timing.ts`, "if (scheduledInWindow && !due.discountApplied && r.scheduledAmount !== due.amountDue) {", "if (false) {"],
  ["k14-liquidity-boundary", `${K}checks/k14-timing.ts`, "if (headroom >= amount + policy.amounts.reserveFloor) return null;", "if (headroom + 1n >= amount + policy.amounts.reserveFloor) return null;"],
  ["k14-reeval-liquidity", `${K}checks/k14-timing.ts`, "    const liquidity = liquidityIssue(ctx, policy, due.amountDue);\n    if (liquidity !== null) issues.push(liquidity);\n", ""],
  ["k14-no-plan-holds", `${K}checks/k14-timing.ts`, "  if (chosen === null) {", "  if (false) {"],
  ["k14-flag-recorded", `${K}checks/k14-timing.ts`, 'return result.status === "PASS" && flag !== undefined ? note("K-14", flag, detail, refs) : result;', "return result;"],
  ["k08-window-closed", `${K}checks/k08-amount.ts`, "const windowClosed = due.windowEnd !== null && !due.discountApplied && epochSecondsFromIso(r.scheduledPayAt) <= epochSecondsFromIso(due.windowEnd);", "const windowClosed = false;"],
  // --- schedule (planner selection, legacy proposal) -------------------------------------------------------
  ["sched-planid-in-set", `${K}schedule.ts`, 'const picked = offered.plans.find((p) => p.planId === selection.planId && p.mode !== "HOLD");', 'const picked = offered.plans.find((p) => p.mode !== "HOLD");'],
  ["sched-not-hold", `${K}schedule.ts`, 'const picked = offered.plans.find((p) => p.planId === selection.planId && p.mode !== "HOLD");', "const picked = offered.plans.find((p) => p.planId === selection.planId);"],
  ["sched-same-amount", `${K}schedule.ts`, "current.plans.find((p) => p.mode === picked.mode && p.amountDue === picked.amountDue);", "current.plans.find((p) => p.mode === picked.mode);"],
  ["sched-asof-range", `${K}schedule.ts`, 'if (typeof asOf !== "string" || !isIsoDateTime(asOf) || seconds(asOf) > seconds(ctx.now) || seconds(asOf) < seconds(ctx.invoiceReceivedAt)) {', 'if (typeof asOf !== "string" || !isIsoDateTime(asOf)) {'],
  ["sched-out-of-envelope-flag", `${K}schedule.ts`, 'flags: ["PLAN_OUT_OF_ENVELOPE"]', "flags: []"],
  ["sched-proposal-exact", `${K}schedule.ts`, "const exact = seconds(plan.payAt) === p;", "const exact = true;"],
  ["sched-late-flag", `${K}schedule.ts`, 'if (choice.chosen !== null && current.window?.late === true) flags.push("LATE");', ""],
  ["sched-nearest-tie-later", `${K}schedule.ts`, "(d === bestDistance && at >= seconds(best.payAt))", "(d === bestDistance && at < seconds(best.payAt))"],
  // --- K-16 + breaker ----------------------------------------------------------------------------------------
  ["k16-halted", `${K}checks/k16-breaker.ts`, 'if (b.halted) return fail("K-16"', 'if (false) return fail("K-16"'],
  ["k16-malformed", `${K}checks/k16-breaker.ts`, 'if (typeof b !== "object" || b === null || typeof b.halted !== "boolean") return kernelError(', "if (b === null) return kernelError("],
  ["breaker-high-only", `${K}breaker.ts`, 'if (s.severity === "HIGH") reasons.add(', 'if (s.severity !== "LOW") reasons.add('],
  ["breaker-exception-limit", `${K}breaker.ts`, "if (exceptions > KERNEL_EXCEPTION_LIMIT)", "if (exceptions >= KERNEL_EXCEPTION_LIMIT)"],
  ["breaker-exception-window", `${K}breaker.ts`, "age <= KERNEL_EXCEPTION_WINDOW_SECONDS) exceptions++;", "age < KERNEL_EXCEPTION_WINDOW_SECONDS) exceptions++;"],
  ["breaker-exception-future", `${K}breaker.ts`, "if (age >= 0n && age <=", "if (age <="],
  ["breaker-trip-keeps-first", `${K}breaker.ts`, "    if (state.halted) return ok(state);\n", ""],
  ["breaker-unfreeze-halted", `${K}breaker.ts`, "if (!state.halted) return err(", "if (false) return err("],
  ["breaker-unfreeze-owner", `${K}breaker.ts`, "if (event.ownerSigned !== true) return err(", "if (false) return err("],
  ["breaker-unfreeze-reason", `${K}breaker.ts`, 'if (typeof event.reason !== "string" || event.reason.trim() === "") return err(', "if (false) return err("],
  // --- explanation templater ---------------------------------------------------------------------------------
  ["explain-max-words", `${K}explain/index.ts`, "if (count + words(s) > EXPLAIN_MAX_WORDS) continue;", "if (false) continue;"],
  ["explain-slug-denylist", `${K}explain/index.ts`, ' && !slug.split("-").some((w) => SLUG_DENYLIST.has(w))) return slug;', ") return slug;"],
  ["explain-slug-shape", `${K}explain/index.ts`, "/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && ", ""],
  ["explain-most-severe-first", `${K}explain/index.ts`, 'rank: severity(verdictForOnFail(c.onFail as NonNullable<CheckResult["onFail"]>)) * 1000 - i', "rank: -i"],
  ["explain-others-capped", `${K}explain/index.ts`, "const shown = others.slice(0, MAX_OTHER);", "const shown = others;"],
  // --- reevaluate() (TOCTOU) ---------------------------------------------------------------------------------
  ["reeval-context", `${K}reevaluate.ts`, "    reevaluation: { decisionId: scheduled.decisionId, intentId: scheduled.intentId, payAt: scheduled.payAt, releaseAmountBaseUnits: scheduled.releaseAmountBaseUnits },", "    reevaluation: null,"],
  ["reeval-not-release", `${K}reevaluate.ts`, 'if (fresh.verdict !== "RELEASE") mismatches.push("NOT_RELEASE");', ""],
  ["reeval-intent", `${K}reevaluate.ts`, 'if (fresh.intentId !== scheduled.intentId) mismatches.push("INTENT_ID");', ""],
  ["reeval-amount", `${K}reevaluate.ts`, 'if (fresh.releaseAmountBaseUnits !== scheduled.releaseAmountBaseUnits.toString()) mismatches.push("AMOUNT");', ""],
  ["reeval-payee", `${K}reevaluate.ts`, 'if (fresh.payee !== scheduled.payee) mismatches.push("PAYEE");', ""],
  ["reeval-early", `${K}reevaluate.ts`, 'if (!times.ok || times.value[0] < times.value[1]) mismatches.push("EARLY");', 'if (!times.ok) mismatches.push("EARLY");'],
  ["reeval-ttl", `${K}reevaluate.ts`, "export const ATTESTATION_TTL_SECONDS = 600n;", "export const ATTESTATION_TTL_SECONDS = 601n;"],
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
