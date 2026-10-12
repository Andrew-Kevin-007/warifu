// K-07 CURRENCY_DECIMALS — REJECT — P0 (docs/04 K-07).
// Currency must be USDC (P0): the printed currency "USDC" always, "USD" or "$" only if
// policy.currency.treatUsdAsUsdc; anything else (EUR, other symbols, an absent currency) => CURRENCY_UNSUPPORTED.
// Token decimals (ERC-20), vault-stored decimals, policy decimals and engagement decimals must all agree =>
// else DECIMALS_MISMATCH. Scale sanity (Arc native 18 vs ERC-20 6): any amount above 10^(decimals+9) base
// units (more than 1e9 whole units) => SCALE_ABSURD. Amounts are never in native 18-decimal units here.
import { inspectUntrusted } from "@symbolon/schemas";
import type { CheckResult, PaymentIntent } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import { combine } from "../verdict";
import type { Issue } from "../verdict";

/** Whole-unit ceiling exponent above `decimals` (docs/04 K-07: > 1e9 whole units is absurd). */
export const SCALE_ABSURD_WHOLE_UNITS_EXPONENT = 9;

function currencyAccepted(printed: string, treatUsdAsUsdc: boolean): boolean {
  const c = printed.normalize("NFKC").trim().toUpperCase();
  if (c === "USDC") return true;
  return treatUsdAsUsdc && (c === "USD" || c === "$");
}

export function checkK07(intent: PaymentIntent, ctx: KernelContext, policy: LoadedPolicy, facts: Facts): CheckResult {
  const issues: Issue[] = [];
  const treatUsd = policy.policy.currency.treatUsdAsUsdc;
  const extractions = intent.extraction.b === null ? [intent.extraction.a] : [intent.extraction.a, intent.extraction.b];
  for (const [i, x] of extractions.entries()) {
    if (!currencyAccepted(inspectUntrusted(x.amount.currencyPrinted), treatUsd)) {
      issues.push({ onFail: "REJECT", code: "CURRENCY_UNSUPPORTED", detail: `extraction ${i === 0 ? "A" : "B"}: printed currency is not USDC${treatUsd ? "/USD/$" : ""}` });
    }
  }

  const decimals: Array<[string, number]> = [
    ["token", ctx.chain.tokenDecimals],
    ["vault", ctx.chain.vaultTokenDecimals],
    ["policy", policy.decimals],
  ];
  if (facts.engagement !== null) decimals.push(["engagement", facts.engagement.currencyDecimals]);
  if (decimals.some(([, d]) => d !== facts.declaredDecimals)) {
    issues.push({ onFail: "REJECT", code: "DECIMALS_MISMATCH", detail: decimals.map(([k, d]) => `${k}=${d}`).join(", ") });
  }

  const limit = 10n ** BigInt(facts.declaredDecimals + SCALE_ABSURD_WHOLE_UNITS_EXPONENT);
  const candidates = [facts.totalParse.kind === "EXACT" ? facts.totalParse.baseUnits : null, facts.claimedGross];
  if (candidates.some((v) => v !== null && v > limit)) {
    issues.push({ onFail: "REJECT", code: "SCALE_ABSURD", detail: `an amount exceeds 10^${facts.declaredDecimals + SCALE_ABSURD_WHOLE_UNITS_EXPONENT} base units` });
  }
  return combine("K-07", issues, `USDC with ${facts.declaredDecimals} decimals everywhere; amount within scale`);
}
