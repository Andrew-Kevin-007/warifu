// K-06 PAYEE_BINDING — REJECT (mismatch) / ESCALATE (change claimed) / HOLD (change pending) — P0 (docs/04 K-06).
// The payout address is ALWAYS engagement.payee (facts.payout); a document-provided address is only compared.
// Names never matter (only signature-bound addresses do). Both extractions are compared, and the on-chain payee
// (after any executed PayeeChange) must equal the loaded engagement payee.
import type { CheckResult, PaymentIntent } from "@symbolon/schemas";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import { combine, fail } from "../verdict";
import type { Issue } from "../verdict";

export function checkK06(intent: PaymentIntent, ctx: KernelContext, facts: Facts): CheckResult {
  const e = facts.engagement;
  if (e === null) return fail("K-06", "REJECT", "NO_ENGAGEMENT", "no engagement to bind the payee to");
  const payee = e.payee.toLowerCase();
  const issues: Issue[] = [];
  const extractions = intent.extraction.b === null ? [intent.extraction.a] : [intent.extraction.a, intent.extraction.b];
  for (const [i, x] of extractions.entries()) {
    const which = i === 0 ? "A" : "B";
    const wallet = x.payee.walletAddress;
    if (wallet !== null && wallet.toLowerCase() !== payee) {
      issues.push({ onFail: "REJECT", code: "PAYEE_MISMATCH", detail: `invoice address (extraction ${which}) ${wallet} != engagement payee ${e.payee}` });
    }
    if (x.payee.claimsAddressChange) {
      issues.push({ onFail: "ESCALATE", code: "ADDRESS_CHANGE_CLAIMED", detail: `extraction ${which}: the document claims an address change (only the on-chain PayeeChange path can change it)` });
    }
  }
  const chain = ctx.engagementOnChain;
  if (chain !== null && chain.payee.toLowerCase() !== payee) {
    issues.push({ onFail: "REJECT", code: "PAYEE_MISMATCH", detail: `on-chain payee ${chain.payee} != loaded engagement payee ${e.payee}` });
  }
  if (ctx.payeeChangePending) {
    issues.push({ onFail: "HOLD", code: "PAYEE_CHANGE_PENDING", detail: "an on-chain payee change is pending" });
  }
  return combine("K-06", issues, `payout address is the engagement payee ${e.payee}`, [e.payee]);
}
