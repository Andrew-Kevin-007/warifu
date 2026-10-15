// B0 is asynchronous (the vendored route is an async handler) and the harness's Target.decide() is synchronous, so the
// route is executed ONCE per distinct (agreement, deliverable, read) before any matrix is built, with a top-level await.
// This module covers every committed fixture (attacks at the base seed, their controls, the 12 + 62 honest invoices).
// Anything else (the hold-out runner, other seeds) calls prepareB0() itself before it runs B0.
import { buildHonest } from "../honest";
import { buildHonestCorpus } from "../honest-corpus";
import { BASE_SEED, buildAllAttacks } from "../registry";
import type { ScenarioId, SubmitStep } from "../types";
import { inspectUntrusted } from "@symbolon/schemas";
import { prepareB0 } from "./b0";
import type { B0Input } from "./b0";

export function* b0InputsOf(scenarioId: ScenarioId, step: SubmitStep): Iterable<B0Input> {
  if (step.milestoneSlug === null) return;
  for (const run of step.runs) {
    yield { scenarioId: step.scenarioId ?? scenarioId, milestoneSlug: step.milestoneSlug, docLabel: step.doc.docLabel, docText: inspectUntrusted(step.doc.text), read: run.a };
  }
}

function* all(): Iterable<B0Input> {
  for (const f of buildAllAttacks(BASE_SEED)) {
    for (const s of f.steps) {
      if (s.kind === "submit") yield* b0InputsOf(f.scenarioId, s);
      else if (s.kind === "flood") for (const item of s.items) yield* b0InputsOf(f.scenarioId, item.step);
    }
    if (f.control.kind === "release") yield* b0InputsOf(f.scenarioId, f.control.step);
  }
  for (const h of [...buildHonest(BASE_SEED), ...buildHonestCorpus(BASE_SEED)]) yield* b0InputsOf(h.scenarioId, h.step);
}

await prepareB0(all());

export const B0_PREPARED = true as const;
