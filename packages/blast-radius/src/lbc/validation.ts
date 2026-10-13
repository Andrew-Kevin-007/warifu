// The `validation` block of a certificate (docs/16 §3, §8). Populated ONLY from a Blast Radius results file that names
// the bytecode it was produced against (`vaultRuntimeCodeHash`) and the code revision (`gitSha`); anything else is
// "not validated for this deployment" and the certificate says so by carrying `validation: null`. Pure.
//
// Results file format `symbolon-blast-validation/1` (WP-26 produces it; QUESTIONS WP-34 records the contract):
//   { schema, provenance: <ResultProvenance, docs/08 §5.2.7>, t3: { trials, violations, bestAttack24hBaseUnits },
//     t1: { plans, losses } }
import { BaseUnitsSchema } from "@symbolon/schemas";
import type { LossBoundCertificate } from "@symbolon/schemas";
import * as z from "zod";
import { ProvenanceSchema } from "../provenance";
import type { ResultProvenance } from "../provenance";
import { LbcError } from "./types";
import type { Hex } from "./types";

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ValidationResultsSchema = z.strictObject({
  schema: z.literal("symbolon-blast-validation/1"),
  provenance: ProvenanceSchema,
  t3: z.strictObject({ trials: Count, violations: Count, bestAttack24hBaseUnits: BaseUnitsSchema }),
  t1: z.strictObject({ plans: Count, losses: Count }),
});
export type ValidationResults = z.infer<typeof ValidationResultsSchema>;

type Validation = NonNullable<LossBoundCertificate["validation"]>;

const SCALE = 1_000_000_000n;

/** "0.006" style decimal from a rational, rounded UP at 9 fractional digits (never understates a bound). */
export function decimalCeil(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n || numerator < 0n) throw new LbcError("VALIDATION_INVALID", "decimalCeil needs numerator >= 0 and denominator > 0");
  const scaled = (numerator * SCALE + denominator - 1n) / denominator;
  return fmt(scaled, 9);
}

/** Same, rounded DOWN (used for tightness, which must not be overstated). */
export function decimalFloor(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n || numerator < 0n) throw new LbcError("VALIDATION_INVALID", "decimalFloor needs numerator >= 0 and denominator > 0");
  return fmt((numerator * SCALE) / denominator, 9);
}

function fmt(scaled: bigint, digits: number): string {
  const whole = scaled / 10n ** BigInt(digits);
  const frac = (scaled % 10n ** BigInt(digits)).toString().padStart(digits, "0").replace(/0+$/, "");
  return frac === "" ? `${whole.toString()}.0` : `${whole.toString()}.${frac}`;
}

/** Rule of three (docs/16 §6): with 0 violations in n trials the 95 % upper bound on the violation rate is about 3/n. */
export function upper95(trials: number, violations: number): string {
  if (violations === 0 && trials > 3) return decimalCeil(3n, BigInt(trials)).replace(/\.0$/, "");
  return "1"; // violations observed or no trials: no upper bound is claimed
}

export interface ValidationBuild {
  readonly validation: Validation | null;
  readonly notes: readonly string[];
}

/**
 * @param bound24h this certificate's own 24 h T3c bound
 * @param codeMatchStatus result of the build-time artifact check ("NOT_CHECKED" when no artifact was given); a
 *        validated code hash that differs from the artifact's is downgraded to MISMATCH by the caller.
 */
export function buildValidation(results: unknown, bound24h: bigint, codeMatchStatus: Validation["codeMatch"]["status"]): ValidationBuild {
  const p = ValidationResultsSchema.safeParse(results);
  if (!p.success) throw new LbcError("VALIDATION_INVALID", `validation results rejected: ${p.error.issues.map((i) => `${i.path.map(String).join(".") || "$"}: ${i.message}`).join("; ")}`);
  const r = p.data;
  const prov: ResultProvenance = r.provenance;
  if (prov.vaultRuntimeCodeHash === null) {
    return { validation: null, notes: ["Validation results were supplied but are not attributed to any deployed bytecode (vaultRuntimeCodeHash is null): shown as not validated for this deployment."] };
  }
  const best = BigInt(r.t3.bestAttack24hBaseUnits);
  if (best > bound24h) {
    throw new LbcError("VALIDATION_INVALID", "the best attack in the results file exceeds this certificate's 24 h bound: the bound or the contract is wrong (docs/08 §5.1); refusing to publish");
  }
  const tightness = bound24h === 0n ? "1.0" : decimalFloor(best, bound24h);
  return {
    validation: {
      t3Trials: r.t3.trials,
      t3Violations: r.t3.violations,
      upper95: upper95(r.t3.trials, r.t3.violations),
      t3BestAttack24h: r.t3.bestAttack24hBaseUnits,
      tightness,
      t1Plans: r.t1.plans,
      t1Losses: r.t1.losses,
      codeMatch: { status: codeMatchStatus, validatedCodeHash: prov.vaultRuntimeCodeHash as Hex, gitSha: prov.gitSha },
    },
    notes: [],
  };
}
