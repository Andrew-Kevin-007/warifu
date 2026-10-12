// K-10 EXTRACTION_CONSENSUS — ESCALATE — P0 (docs/04 K-10, docs/03 §4; targets ATK-18; WP-05).
// The kernel recomputes consensus(A, B) from the two extractions (packages/schemas) instead of trusting
// intent.consensus: DISAGREE => ESCALATE EXTRACTION_DISAGREE (the differing FIELD NAMES go in the receipt, never the
// values, which are document text). A claimed consensus that differs from the recomputed one is also
// EXTRACTION_DISAGREE (the submitter misreported). SINGLE => ESCALATE SINGLE_EXTRACTION unless
// policy.extraction.allowSingle. Reading fixed here: two runs of the same model, or the same prompt, are not
// independent (DEC-007: two different models, different prompt wording), so they count as SINGLE.
import { consensus, jcs } from "@symbolon/schemas";
import type { CheckResult, PaymentIntent } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { combine } from "../verdict";
import type { Issue } from "../verdict";

export function checkK10(intent: PaymentIntent, policy: LoadedPolicy): CheckResult {
  const x = intent.extraction;
  const recomputed = consensus(x.a, x.b);
  const issues: Issue[] = [];
  if (recomputed.status === "DISAGREE") {
    issues.push({ onFail: "ESCALATE", code: "EXTRACTION_DISAGREE", detail: `extractions disagree on: ${recomputed.diffs.map((d) => d.field).join(", ")}`, refs: recomputed.diffs.map((d) => `field:${d.field}`) });
  }
  if (intent.consensus.status !== recomputed.status || jcs(intent.consensus.diffs) !== jcs(recomputed.diffs)) {
    issues.push({ onFail: "ESCALATE", code: "EXTRACTION_DISAGREE", detail: `submitted consensus (${intent.consensus.status}) differs from the kernel's recomputation (${recomputed.status})` });
  }
  const degenerate = x.b !== null && (x.modelA === x.modelB || x.promptHashA === x.promptHashB);
  if ((recomputed.status === "SINGLE" || degenerate) && !policy.policy.extraction.allowSingle) {
    issues.push({ onFail: "ESCALATE", code: "SINGLE_EXTRACTION", detail: degenerate ? "both extractions used the same model or the same prompt (not independent)" : "only one extraction" });
  }
  return combine("K-10", issues, recomputed.status === "SINGLE" ? "single extraction allowed by policy" : "two independent extractions agree on every compared field");
}
