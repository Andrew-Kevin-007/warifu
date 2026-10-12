// K-09 EVIDENCE_MATCH — HOLD (missing/failed/denied) / REJECT (tampered) — P0 (docs/04 K-09; WP-05).
// Pure evaluation of the kernel-collected Evidence[] in the context against the SIGNED milestone evidenceSpec
// (all_of). Nothing is fetched here. Evidence supplied by the LLM, the payee or the web app has no way in: the intent
// has no evidence field, and only EvidenceSchema-valid records with collectedBy 'kernel' are read (src/evidence.ts).
//   missing / stale / collector error                          => HOLD EVIDENCE_MISSING (re-evaluated on arrival)
//   failed or contradicting (red CI, wrong status or commit)   => HOLD EVIDENCE_FAILED
//   a source not accepted (fixture outside the sandbox, anything
//   but a matching fixture in the sandbox, an un-allowlisted URL) => HOLD EVIDENCE_SOURCE_DENIED
//   pinned hash mismatch (URL body or artifact)                 => REJECT EVIDENCE_HASH_MISMATCH
// Within one severity the reported code prefers DENIED, then FAILED, then MISSING (the most actionable reason).
import type { CheckResult } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "../context";
import type { EvidenceAssessment, RequirementState } from "../evidence";
import type { Facts } from "../facts";
import type { Result } from "../result";
import { combine, fail, kernelError } from "../verdict";
import type { Issue } from "../verdict";

const PRIORITY: Readonly<Record<Exclude<RequirementState, "SATISFIED">, number>> = { TAMPERED: 0, DENIED: 1, FAILED: 2, MISSING: 3 };

function issueFor(state: Exclude<RequirementState, "SATISFIED">, detail: string): Issue {
  if (state === "TAMPERED") return { onFail: "REJECT", code: "EVIDENCE_HASH_MISMATCH", detail };
  if (state === "DENIED") return { onFail: "HOLD", code: "EVIDENCE_SOURCE_DENIED", detail };
  return state === "FAILED" ? { onFail: "HOLD", code: "EVIDENCE_FAILED", detail } : { onFail: "HOLD", code: "EVIDENCE_MISSING", detail };
}

export function checkK09(ctx: KernelContext, _policy: LoadedPolicy, facts: Facts, assessment: Result<EvidenceAssessment>): CheckResult {
  if (facts.engagement === null) return fail("K-09", "REJECT", "NO_ENGAGEMENT", "no engagement whose evidence spec could be checked");
  if (facts.milestoneTerms === null) return fail("K-09", "REJECT", "UNKNOWN_MILESTONE", "no signed milestone whose evidence spec could be checked");
  if (!assessment.ok) return kernelError("K-09", `evidence could not be assessed: ${assessment.error.message}`);
  const a = assessment.value;
  const open = a.requirements.filter((r) => r.state !== "SATISFIED");
  open.sort((x, y) => PRIORITY[x.state as Exclude<RequirementState, "SATISFIED">] - PRIORITY[y.state as Exclude<RequirementState, "SATISFIED">] || x.index - y.index);
  const issues = open.map((r) => issueFor(r.state as Exclude<RequirementState, "SATISFIED">, `requirement ${r.index} (${r.type}): ${r.detail}`));
  const refs = a.requirements.flatMap((r) => (r.evidenceId === null ? [] : [`evidence:${r.evidenceId}`]));
  const suffix = `${ctx.profile} profile${a.ignored > 0 ? `; ${a.ignored} record(s) ignored` : ""}${a.overrideBy === null ? "" : "; owner override"}`;
  if (issues.length === 0) return combine("K-09", [], `all ${a.requirements.length} evidence requirement(s) satisfied (${suffix})`, refs);
  const [first, ...rest] = issues as [Issue, ...Issue[]];
  return combine("K-09", [{ ...first, refs }, ...rest], "");
}
