// One entry point per fixture: buildAttack(id, seed). The committed fixtures use the base seed; any other seed
// is a deterministic variant (docs/07 §2 "seeded variant generators"): same facts, different surface.
import { atk02, atk03, atk04, atk05, atk06, atk07 } from "./attacks/documents-a";
import { atk11, atk12, atk13, atk14, atk15, atk16, atk18, atk20 } from "./attacks/documents-b";
import { BASE_SEED, type BuildCtx } from "./attacks/common";
import { atk22, atk23, atk24 } from "./attacks/human";
import { atk10 } from "./attacks/injection";
import { atk01, atk08, atk09, atk19 } from "./attacks/process";
import { atk17 } from "./attacks/signer";
import { atk21 } from "./attacks/terms";
import { Rng } from "./prng";
import { ATTACK_IDS, AttackFixtureSchema, type AttackFixture, type AttackId } from "./types";

const BUILDERS: Readonly<Record<AttackId, (ctx: BuildCtx) => AttackFixture>> = {
  "ATK-01": atk01,
  "ATK-02": atk02,
  "ATK-03": atk03,
  "ATK-04": atk04,
  "ATK-05": atk05,
  "ATK-06": atk06,
  "ATK-07": atk07,
  "ATK-08": atk08,
  "ATK-09": atk09,
  "ATK-10": atk10,
  "ATK-11": atk11,
  "ATK-12": atk12,
  "ATK-13": atk13,
  "ATK-14": atk14,
  "ATK-15": atk15,
  "ATK-16": atk16,
  "ATK-17": atk17,
  "ATK-18": atk18,
  "ATK-19": atk19,
  "ATK-20": atk20,
  "ATK-21": atk21,
  "ATK-22": atk22,
  "ATK-23": atk23,
  "ATK-24": atk24,
};

/** Build (and schema-validate) one attack fixture. Deterministic in (id, seed). */
export function buildAttack(id: AttackId, seed: string = BASE_SEED): AttackFixture {
  const build = BUILDERS[id];
  return AttackFixtureSchema.parse(build({ rng: new Rng(`${id}/${seed}`), seed }));
}

export function buildAllAttacks(seed: string = BASE_SEED): AttackFixture[] {
  return ATTACK_IDS.map((id) => buildAttack(id, seed));
}

/** `n` variants of one attack, seeds `v1..vn` (never the base seed). */
export function generateVariants(id: AttackId, n: number, prefix = "v"): AttackFixture[] {
  return Array.from({ length: n }, (_, i) => buildAttack(id, `${prefix}${i + 1}`));
}

export { BASE_SEED };
