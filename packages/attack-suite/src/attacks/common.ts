import { ATTACK_META } from "../attack-meta";
import type { Rng } from "../prng";
import type { AttackFixture, AttackId, AttackStep, Control, IntendedLoss, ScenarioId } from "../types";

/** The seed of the committed fixtures; other seeds produce variants (docs/07 §2). */
export const BASE_SEED = "base";

/** Everything a builder needs; `rng` is already seeded per (attack, seed). */
export interface BuildCtx {
  readonly rng: Rng;
  readonly seed: string;
}

export function assemble(args: {
  readonly attackId: AttackId;
  readonly seed: string;
  readonly scenarioId: ScenarioId;
  readonly steps: AttackStep[];
  readonly intendedLoss: IntendedLoss | null;
  readonly intendedLossNote?: string;
  readonly control: Control;
  readonly tags: string[];
}): AttackFixture {
  const m = ATTACK_META[args.attackId];
  if (args.intendedLoss === null && args.intendedLossNote === undefined) {
    throw new RangeError(`${args.attackId}: a fixture without an intended loss must say why`);
  }
  return {
    schema: "attack-fixture/1",
    attackId: args.attackId,
    title: m.title,
    errorClass: m.errorClass,
    caption: m.caption,
    kind: m.kind,
    scenarioId: args.scenarioId,
    seed: args.seed,
    steps: args.steps,
    intendedLoss: args.intendedLoss,
    ...(args.intendedLossNote === undefined ? {} : { intendedLossNote: args.intendedLossNote }),
    naiveHypothesis: m.naiveHypothesis,
    symbolonDefence: m.symbolonDefence,
    onChainBackstop: m.onChainBackstop,
    control: args.control,
    tags: args.tags,
  };
}
