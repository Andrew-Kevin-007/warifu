// The sandbox evidence store (docs/04 K-09 "sandbox profile", docs/15 s5, RT-02): EVIDENCE_MODE=fixtures. There is no network
// code on this path at all: evidence exists only if the scenario holds a record for the EXACT spec entry of the milestone.
// A claim inside an attacker's document ("CI passed", "see https://...") never reaches this module, and a URL is never fetched.
import { jcs, EvidenceFixtureSchema } from "@symbolon/schemas";
import type { EvidenceFixture, EvidenceRequirement, Hex32, ISODateTime } from "@symbolon/schemas";
import { requirementHash } from "./collectors";
import type { Collected } from "./collectors";

export interface FixtureStore {
  /**
   * The fixture for `requirement` of `milestoneId` that is visible at `now`, or null. "Exact" means the requirement equals the
   * fixture's requirement under RFC 8785 canonical JSON; a different URL, repo, ref, hash or type matches nothing.
   */
  find(milestoneId: Hex32, requirement: EvidenceRequirement, now: ISODateTime): EvidenceFixture | null;
}

/** Whole-second UTC strings compare correctly as text (schemas enforce `YYYY-MM-DDTHH:MM:SSZ`). */
const visible = (f: EvidenceFixture, now: ISODateTime): boolean => f.availableAt === null || f.availableAt <= now;

export function createFixtureStore(fixtures: readonly EvidenceFixture[]): FixtureStore {
  const parsed = fixtures.map((f) => EvidenceFixtureSchema.parse(f)); // a malformed scenario fixture is a programming error: fail at construction
  const ids = new Set<string>();
  for (const f of parsed) {
    if (ids.has(f.fixtureId)) throw new Error("duplicate fixtureId in the scenario");
    ids.add(f.fixtureId);
  }
  return {
    find(milestoneId, requirement, now) {
      const want = jcs(requirement);
      const hits = parsed.filter((f) => f.milestoneId === milestoneId && visible(f, now) && jcs(f.requirement) === want);
      // the newest visible fixture wins (null availableAt = from the start); ties keep scenario order
      let best: EvidenceFixture | null = null;
      for (const f of hits) if (best === null || (f.availableAt ?? "") >= (best.availableAt ?? "")) best = f;
      return best;
    },
  };
}

/** A store that holds nothing: every reference is EVIDENCE_SOURCE_DENIED. */
export const emptyFixtureStore: FixtureStore = { find: () => null };

export function fixtureToCollected(f: EvidenceFixture, requirement: EvidenceRequirement): Collected {
  return {
    source: `fixture:${f.fixtureId}`,
    payload: { requirementHash: requirementHash(requirement), fixtureId: f.fixtureId, fixture: f.payload },
    result: f.result,
    details: f.details,
  };
}
