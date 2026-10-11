// Verdict algebra (docs/04 §1). Severity REJECT > ESCALATE > HOLD > RELEASE; the verdict is the highest
// severity among FAILs, else RELEASE. REPLAY is produced only by K-04 and short-circuits (pipeline.ts).
//
// Fail-closed rules on top of the spec (all of them can only make a verdict stricter):
//   - a FAIL without an onFail, or without a reason code, counts as HOLD with KERNEL_ERROR;
//   - a SKIP is legal only for a check in SKIPPABLE_CHECKS (K-13 when screening is disabled); any other SKIP is a
//     HOLD with KERNEL_ERROR;
//   - an unknown status / onFail value (corrupted input) is a HOLD with KERNEL_ERROR;
//   - RELEASE additionally requires every required check to be present exactly once and nothing else.
import { CHECK_NAMES, VERDICT_SEVERITY, untrusted } from "@symbolon/schemas";
import type { CheckId, CheckResult, OnFail, ReasonCode, Verdict } from "@symbolon/schemas";

export type FinalVerdict = Exclude<Verdict, "REPLAY">;

/** docs/04 §3 evaluation order (K-15 runs post-settlement, outside evaluate()). */
export const EVALUATION_ORDER: readonly CheckId[] = Object.freeze([
  "K-16", "K-01", "K-02", "K-03", "K-04", "K-05", "K-06", "K-07", "K-08",
  "K-09", "K-10", "K-11", "K-12", "K-13", "K-14",
] as const);

/** Checks the policy may disable, which then report SKIP (docs/04 §1: "e.g., K-13 when screening is off"). */
export const SKIPPABLE_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>(["K-13"]);

const MAX_DETAIL = 2000;
const MAX_REF = 256;
const MAX_REFS = 32;

function truncateCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join("")}…`;
}

function boundedRefs(refs: readonly string[]): string[] {
  return refs.slice(0, MAX_REFS).map((r) => truncateCodePoints(r, MAX_REF));
}

function build(id: CheckId, status: CheckResult["status"], onFail: OnFail | null, code: ReasonCode | null, detail: string, refs: readonly string[]): CheckResult {
  return {
    id,
    name: CHECK_NAMES[id],
    status,
    onFail,
    code,
    // Kernel-written text, but it may quote identifiers from the intent: typed Untrusted like the schema says.
    detail: untrusted(truncateCodePoints(detail, MAX_DETAIL)),
    refs: boundedRefs(refs),
  };
}

export function pass(id: CheckId, detail: string, refs: readonly string[] = []): CheckResult {
  return build(id, "PASS", null, null, detail, refs);
}

export function fail(id: CheckId, onFail: OnFail, code: ReasonCode, detail: string, refs: readonly string[] = []): CheckResult {
  return build(id, "FAIL", onFail, code, detail, refs);
}

/** A required check that could not be evaluated: HOLD with KERNEL_ERROR (docs/04 §1). */
export function kernelError(id: CheckId, detail: string): CheckResult {
  return build(id, "FAIL", "HOLD", "KERNEL_ERROR", detail, []);
}

/** K-04's REPLAY marker: FAIL with no onFail and no reason code (the reason-code enum has no REPLAY member). */
export function replayResult(id: CheckId, detail: string, refs: readonly string[]): CheckResult {
  return build(id, "FAIL", null, null, detail, refs);
}

/** One finding inside a check; a check reports its most severe finding and lists the rest in `detail`. */
export interface Issue {
  readonly onFail: OnFail;
  readonly code: ReasonCode;
  readonly detail: string;
  readonly refs?: readonly string[];
}

export function verdictForOnFail(onFail: OnFail): FinalVerdict {
  switch (onFail) {
    case "REJECT":
      return "REJECT";
    case "ESCALATE":
      return "ESCALATE";
    case "HOLD":
      return "HOLD";
    default: {
      const unknown: never = onFail;
      void unknown;
      return "HOLD"; // corrupted value: fail closed
    }
  }
}

export function severity(v: FinalVerdict): number {
  return VERDICT_SEVERITY[v];
}

/**
 * Combine a check's issues into one CheckResult: none => PASS; otherwise the most severe issue (ties: the first)
 * becomes status/onFail/code, and every issue is listed in the detail in order.
 */
export function combine(id: CheckId, issues: readonly Issue[], passDetail: string, passRefs: readonly string[] = []): CheckResult {
  let worst: Issue | undefined;
  for (const issue of issues) {
    if (worst === undefined || severity(verdictForOnFail(issue.onFail)) > severity(verdictForOnFail(worst.onFail))) worst = issue;
  }
  if (worst === undefined) return pass(id, passDetail, passRefs);
  const detail = issues.length === 1 ? worst.detail : issues.map((i) => `${i.code}: ${i.detail}`).join(" | ");
  const refs = issues.flatMap((i) => i.refs ?? []);
  return fail(id, worst.onFail, worst.code, detail, refs);
}

export interface Aggregate {
  readonly verdict: FinalVerdict;
  readonly reasons: readonly ReasonCode[];
}

/**
 * Final verdict over the check results (docs/04 §1) plus the fail-closed rules listed at the top of this file.
 * `reasons` are the reason codes of the FAILs, in check order, without duplicates.
 */
export function aggregate(checks: readonly CheckResult[], required: readonly CheckId[]): Aggregate {
  let worst: FinalVerdict = "RELEASE";
  const reasons: ReasonCode[] = [];
  const add = (code: ReasonCode) => {
    if (!reasons.includes(code)) reasons.push(code);
  };
  const raise = (v: FinalVerdict) => {
    if (severity(v) > severity(worst)) worst = v;
  };
  for (const c of checks) {
    switch (c.status) {
      case "PASS":
        break;
      case "SKIP":
        if (!SKIPPABLE_CHECKS.has(c.id)) {
          raise("HOLD");
          add("KERNEL_ERROR");
        }
        break;
      case "FAIL":
        if (c.onFail === null || c.code === null) {
          raise("HOLD");
          add("KERNEL_ERROR");
        }
        if (c.onFail !== null) raise(verdictForOnFail(c.onFail));
        if (c.code !== null) add(c.code);
        break;
      default: {
        const unknown: never = c.status;
        void unknown;
        raise("HOLD");
        add("KERNEL_ERROR");
      }
    }
  }
  if (worst === "RELEASE" && !isComplete(checks, required)) {
    worst = "HOLD";
    add("KERNEL_ERROR");
  }
  return { verdict: worst, reasons };
}

/** Every required check appears exactly once and no other check appears. */
function isComplete(checks: readonly CheckResult[], required: readonly CheckId[]): boolean {
  if (checks.length === 0 || checks.length !== required.length) return false;
  const seen = new Set<string>();
  for (const c of checks) {
    if (seen.has(c.id) || !required.includes(c.id)) return false;
    seen.add(c.id);
  }
  return true;
}
