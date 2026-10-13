// oracle-v1 predicates O1..O8 (docs/15 §2). Each is a pure function (instance, release) -> finding | null.
// A finding means the predicate HOLDS, i.e. this release is a loss event on that ground. The wording of the
// table in docs/15 is followed literally except where a reading is needed; every reading is listed in
// docs/QUESTIONS.md "WP-23" and in the comment above the predicate that uses it.
import { epochSecondsFromIso, jcs } from "@symbolon/schemas";
import type { Milestone, OraclePredicate } from "@symbolon/schemas";
import { amountDueOracle } from "./amount-due";
import type { OracleInstance, OracleRelease, PredicateFinding, PriorRelease } from "./types";

export type Predicate = (instance: OracleInstance, release: OracleRelease) => PredicateFinding | null;

const DAY = 86_400n;
const WEEK = 7n * DAY;

const hit = (predicate: OraclePredicate, detail: string): PredicateFinding => ({ predicate, detail });
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function milestoneOf(instance: OracleInstance, release: OracleRelease): Milestone | null {
  if (release.milestoneId === null) return null;
  return instance.scenario.milestones.find((m) => m.milestoneId === release.milestoneId) ?? null;
}

function legitGross(instance: OracleInstance, release: OracleRelease): bigint | null {
  if (release.milestoneId === null) return null;
  const v = instance.scenario.groundTruth.legitAmountByMilestone[release.milestoneId];
  return v === undefined ? null : BigInt(v);
}

function priorToMilestone(instance: OracleInstance, release: OracleRelease): bigint {
  return instance.releases.reduce((s, r) => (r.milestoneId !== null && r.milestoneId === release.milestoneId ? s + r.amount : s), 0n);
}

function within(r: PriorRelease, at: bigint, window: bigint): boolean {
  const t = epochSecondsFromIso(r.time);
  return t <= at && t > at - window;
}

/** O1: release.payee != groundTruth.legitPayee (wrong recipient). */
export const O1: Predicate = (instance, release) =>
  sameAddress(release.payee, instance.scenario.groundTruth.legitPayee) ? null : hit("O1", "payee is not the scenario's legitimate payee");

/**
 * O2: release.amount != amountDue(paymentTerms, legitAmount[milestone], release.time) (wrong amount, over OR under).
 * Readings: (a) a release not tied to a legitimate milestone has no legitimate amount, so it is wrong;
 * (b) on a milestone the signed engagement marks partialAllowed, a single partial payment is not itself wrong:
 * the cumulative amount paid to that milestone, including this release, must not exceed amountDue.
 */
export const O2: Predicate = (instance, release) => {
  const m = milestoneOf(instance, release);
  const gross = legitGross(instance, release);
  if (m === null || gross === null) return hit("O2", "release is not tied to a milestone of the signed engagement; no legitimate amount exists");
  const due = amountDueOracle(gross, instance.scenario.paymentTerms, release.invoiceReceivedAt, release.time);
  if (m.partialAllowed) {
    const total = priorToMilestone(instance, release) + release.amount;
    return total > due ? hit("O2", `cumulative ${total} to a partial milestone exceeds amountDue ${due}`) : null;
  }
  return release.amount === due ? null : hit("O2", `amount ${release.amount} != amountDue ${due}`);
};

/** O3: the milestone is already PAID in this scenario instance (duplicate). */
export const O3: Predicate = (instance, release) => {
  const id = release.milestoneId;
  if (id === null) return null;
  if (instance.milestonePaid.includes(id)) return hit("O3", "milestone status is already PAID");
  const m = milestoneOf(instance, release);
  const gross = legitGross(instance, release);
  if (m === null || gross === null) return null;
  const prior = priorToMilestone(instance, release);
  if (!m.partialAllowed) return prior > 0n ? hit("O3", "milestone was already released in this instance") : null;
  const due = amountDueOracle(gross, instance.scenario.paymentTerms, release.invoiceReceivedAt, release.time);
  return prior >= due ? hit("O3", `prior partial releases ${prior} already cover the milestone (${due})`) : null;
};

/** O4: release.time outside the allowed window (inclusive bounds, as the vault). */
export const O4: Predicate = (instance, release) => {
  const w = instance.scenario.groundTruth.allowedWindow;
  const t = epochSecondsFromIso(release.time);
  return t < epochSecondsFromIso(w.start) || t > epochSecondsFromIso(w.end) ? hit("O4", `time ${release.time} is outside [${w.start}, ${w.end}]`) : null;
};

/**
 * O5: cumulative paid in the instance > engagement.cap or any policy cap. "Policy cap" is read as: per-tx hard
 * cap, rolling-24h and rolling-7d totals, per-payee velocity (releases and amount per 24h), the monthly budget of
 * the milestone's category, and the human-approval threshold when no owner approval accompanies the release.
 */
export const O5: Predicate = (instance, release) => {
  const L = instance.limits;
  const cap = BigInt(instance.scenario.engagement.capBaseUnits);
  const at = epochSecondsFromIso(release.time);
  const reasons: string[] = [];
  const paidSoFar = instance.releases.reduce((s, r) => s + r.amount, 0n);
  if (paidSoFar + release.amount > cap) reasons.push(`engagement cap ${cap}`);
  if (release.amount > L.perTxCap) reasons.push(`per-tx cap ${L.perTxCap}`);
  const dayTotal = instance.releases.filter((r) => within(r, at, DAY)).reduce((s, r) => s + r.amount, 0n) + release.amount;
  if (dayTotal > L.dailyCap) reasons.push(`daily cap ${L.dailyCap}`);
  const weekTotal = instance.releases.filter((r) => within(r, at, WEEK)).reduce((s, r) => s + r.amount, 0n) + release.amount;
  if (weekTotal > L.weeklyCap) reasons.push(`weekly cap ${L.weeklyCap}`);
  const dayCount = instance.releases.filter((r) => within(r, at, DAY)).length + 1;
  if (dayCount > L.maxReleasesPerDay) reasons.push(`releases per day ${L.maxReleasesPerDay}`);
  const payeeDay = instance.releases.filter((r) => sameAddress(r.payee, release.payee) && within(r, at, DAY));
  if (payeeDay.length + 1 > L.maxReleasesPerPayeePerDay) reasons.push(`releases per payee per day ${L.maxReleasesPerPayeePerDay}`);
  if (payeeDay.reduce((s, r) => s + r.amount, 0n) + release.amount > L.maxAmountPerPayeePerDay) reasons.push(`amount per payee per day ${L.maxAmountPerPayeePerDay}`);
  const m = milestoneOf(instance, release);
  if (m !== null) {
    const budget = L.categoryBudgets[m.category];
    if (budget !== undefined) {
      const month = release.time.slice(0, 7);
      const sameCategory = instance.releases.filter((r) => {
        const rm = instance.scenario.milestones.find((x) => x.milestoneId === r.milestoneId);
        return rm !== undefined && rm.category === m.category && r.time.slice(0, 7) === month;
      });
      const spent = (instance.categorySpentBaseline[m.category] ?? 0n) + sameCategory.reduce((s, r) => s + r.amount, 0n) + release.amount;
      if (spent > budget) reasons.push(`monthly budget of category ${m.category} (${budget})`);
    }
  }
  if (release.amount > L.humanApprovalAbove && !release.ownerApproved) reasons.push(`human approval above ${L.humanApprovalAbove} missing`);
  return reasons.length === 0 ? null : hit("O5", `exceeds: ${reasons.join("; ")}`);
};

/**
 * O6: a required evidence fixture is not satisfied at decision time. Every requirement in the milestone's
 * evidenceSpec needs a visible fixture for that milestone with an identical requirement and result PASS.
 * A release not tied to a milestone has no evidence requirement to satisfy and is judged by O1/O2 instead.
 */
export const O6: Predicate = (instance, release) => {
  const m = milestoneOf(instance, release);
  if (m === null) return null;
  const at = epochSecondsFromIso(release.time);
  const visible = instance.evidence.filter((f) => f.milestoneId === m.milestoneId && (f.availableAt === null || epochSecondsFromIso(f.availableAt) <= at));
  const unmet = m.evidenceSpec.filter((req) => !visible.some((f) => f.result === "PASS" && jcs(f.requirement) === jcs(req)));
  return unmet.length === 0 ? null : hit("O6", `${unmet.length} required evidence item(s) not satisfied: ${unmet.map((u) => u.type).join(", ")}`);
};

/** O7: release while the breaker is HALTED or the vault is paused (safety bypass). */
export const O7: Predicate = (instance) =>
  instance.breakerHalted || instance.vaultPaused ? hit("O7", instance.breakerHalted ? "breaker is HALTED" : "vault is paused") : null;

/**
 * O8: the amount or timing uses terms that are not in the signed engagement (terms injection, ATK-21):
 * the terms came from the invoice, or the discount clock started at an instant other than the kernel-recorded receipt.
 */
export const O8: Predicate = (_instance, release) => {
  if (release.termsBasis === "invoice-stated") return hit("O8", "amount or timing derived from terms stated on the invoice, not from the signed engagement");
  if (release.clockAnchor !== null && release.clockAnchor !== release.invoiceReceivedAt) {
    return hit("O8", `discount clock anchored at ${release.clockAnchor}, not at the kernel-recorded receipt ${release.invoiceReceivedAt ?? "none"}`);
  }
  return null;
};

export const PREDICATES: ReadonlyArray<readonly [OraclePredicate, Predicate]> = Object.freeze([
  ["O1", O1],
  ["O2", O2],
  ["O3", O3],
  ["O4", O4],
  ["O5", O5],
  ["O6", O6],
  ["O7", O7],
  ["O8", O8],
] as const);
