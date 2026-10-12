// The kernel's templated explanation (INV-20, RT-12, docs/03 §6; WP-05). Built ONLY from fixed phrases (phrases.ts)
// and formatted kernel facts: verdict, check ids, reason codes, amounts via formatBaseUnits, the signed payee address,
// the scheduled instant and a lowercase milestone slug (replaced by the milestone id if it reads as an instruction).
// It never quotes document, extractor or LLM text, it is at most EXPLAIN_MAX_WORDS words, and its first sentence is
// the verdict plus the single most important reason (most severe finding, then evaluation order), the second what
// the human should check. The LLM's optional advisory note is a different field, shown collapsed (WP-16/WP-19).
import { formatBaseUnits } from "@symbolon/schemas";
import type { Address, CheckResult, Hex32, ISODateTime, ReasonCode, Verdict } from "@symbolon/schemas";
import type { FindingRef } from "../context";
import { severity, verdictForOnFail } from "../verdict";
import { CHECK_PHRASES, REASON_PHRASES, SLUG_DENYLIST, TEMPLATE_WORDS, VERDICT_PHRASES } from "./phrases";

export const EXPLAIN_MAX_WORDS = 120;
const MAX_OTHER = 6;

export interface ExplainFacts {
  readonly verdict: Verdict;
  /** The gated checks of the evaluation, in evaluation order. */
  readonly checks: readonly CheckResult[];
  readonly amountBaseUnits: string | null;
  readonly releaseAmountBaseUnits: string | null;
  readonly decimals: number;
  readonly payee: Address | null;
  readonly milestoneId: Hex32 | null;
  readonly milestoneSlug: string | null;
  readonly payAt: ISODateTime | null;
  readonly timingFlags: readonly ReasonCode[];
  readonly resolvedByApproval: readonly FindingRef[];
}

interface Finding {
  readonly id: string;
  readonly code: ReasonCode;
  readonly rank: number;
}

const words = (s: string): number => s.split(/\s+/).filter((w) => w.length > 0).length;

function slugOrId(slug: string | null, id: Hex32 | null): string | null {
  if (slug !== null && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64 && !slug.split("-").some((w) => SLUG_DENYLIST.has(w))) return slug;
  return id === null ? null : id.slice(0, 10);
}

function amount(units: string | null, decimals: number): string | null {
  return units === null ? null : `${formatBaseUnits(units, decimals)} USDC`;
}

/** The templated explanation (see the module comment). Pure; never throws for kernel-produced facts. */
export function explain(f: ExplainFacts): string {
  const failing: Finding[] = f.checks
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.status === "FAIL" && c.onFail !== null && c.code !== null)
    .map(({ c, i }) => ({ id: c.id, code: c.code as ReasonCode, rank: severity(verdictForOnFail(c.onFail as NonNullable<CheckResult["onFail"]>)) * 1000 - i }));
  failing.sort((a, b) => b.rank - a.rank);
  const top = failing[0];

  const sentences: string[] = [];
  if (f.verdict === "REPLAY") {
    sentences.push(`${VERDICT_PHRASES.REPLAY}: this exact invoice was already decided; no new payment.`);
  } else if (top === undefined && f.verdict === "RELEASE") {
    sentences.push(`${VERDICT_PHRASES.RELEASE}: every check passed.`, "Nothing needs review.");
  } else if (top === undefined) {
    // not RELEASE without a failing check: the check set was incomplete (the algebra held it)
    sentences.push(`${VERDICT_PHRASES[f.verdict]}: ${REASON_PHRASES.KERNEL_ERROR} (KERNEL_ERROR).`, CHECK_PHRASES.KERNEL_ERROR);
  } else {
    sentences.push(`${VERDICT_PHRASES[f.verdict]}: ${REASON_PHRASES[top.code]} (${top.id} ${top.code}).`, CHECK_PHRASES[top.code]);
  }

  const gross = amount(f.amountBaseUnits, f.decimals);
  const release = amount(f.releaseAmountBaseUnits, f.decimals);
  const milestone = slugOrId(f.milestoneSlug, f.milestoneId);
  const facts = [
    gross === null ? null : `Invoice ${gross}`,
    release === null ? null : `release ${release}`,
    f.payee === null ? null : `to payee ${f.payee}`,
    milestone === null ? null : `for milestone ${milestone}`,
    f.payAt === null ? null : `at ${f.payAt}`,
  ].filter((s): s is string => s !== null);
  if (facts.length > 0) sentences.push(`${facts.join(" ")}.`);

  const others = failing.slice(1).map((x) => `${x.id} ${x.code}`);
  if (others.length > 0) {
    const shown = others.slice(0, MAX_OTHER);
    sentences.push(`Other findings: ${shown.join(", ")}${others.length > shown.length ? ` and ${others.length - shown.length} more` : ""}.`);
  }
  if (f.resolvedByApproval.length > 0) sentences.push(`Owner approval resolved: ${f.resolvedByApproval.map((r) => `${r.checkId} ${r.code}`).join(", ")}.`);
  if (f.timingFlags.length > 0) sentences.push(`Timing flags: ${f.timingFlags.join(", ")}.`);

  // Keep whole sentences in order while they fit; the first sentence (verdict + main reason) always fits.
  const out: string[] = [];
  let count = 0;
  for (const s of sentences) {
    if (count + words(s) > EXPLAIN_MAX_WORDS) continue;
    out.push(s);
    count += words(s);
  }
  return out.join(" ");
}

/** Every template word (lowercase, punctuation removed): the allow-list the explanation is tested against. */
export function explanationVocabulary(): ReadonlySet<string> {
  const text = [...Object.values(VERDICT_PHRASES), ...Object.values(REASON_PHRASES), ...Object.values(CHECK_PHRASES), TEMPLATE_WORDS].join(" ");
  return new Set(text.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 0));
}
