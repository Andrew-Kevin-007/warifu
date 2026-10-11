// ATK-21: terms injection. One group of steps per entry of the terms-injection library (12 at the base seed).
import { honestControl } from "../build";
import { TERMS_INJECTIONS } from "../terms-injections";
import type { AttackFixture, IntendedRelease, SubmitStep } from "../types";
import { CLOCK_START, WORLD } from "../world";
import { assemble, BASE_SEED, type BuildCtx } from "./common";

const T0 = CLOCK_START;

export function atk21({ rng, seed }: BuildCtx): AttackFixture {
  const cases = seed === BASE_SEED ? TERMS_INJECTIONS : rng.child("subset").sample(TERMS_INJECTIONS, 10);
  const steps: SubmitStep[] = [];
  const intended: IntendedRelease[] = [];
  for (const ti of cases) {
    const built = ti.build(rng.child(ti.id), T0);
    for (const s of built.steps) steps.push(ti.scenarioId === "S-C" ? s : { ...s, scenarioId: ti.scenarioId });
    intended.push(...built.intended);
  }
  return assemble({
    attackId: "ATK-21",
    seed,
    scenarioId: "S-C",
    steps,
    intendedLoss: { mode: "each", releases: intended },
    // The control is an honest invoice whose stated terms EQUAL the signed ones (docs/07 §6): it must pay amountDue.
    control: honestControl(rng, WORLD["S-C"], "annual-licence", T0, "ATK-21/control"),
    tags: ["terms", "INV-19", "K-14", "K-08", "O8"],
  });
}
