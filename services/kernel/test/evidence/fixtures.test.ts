// Sandbox fixture store (EVIDENCE_MODE=fixtures): evidence exists only for the exact spec entry; nothing else resolves.
import { describe, expect, it } from "vitest";
import { hashJcs } from "@symbolon/schemas";
import type { EvidenceFixture, EvidenceRequirement } from "@symbolon/schemas";
import { createFixtureStore, emptyFixtureStore, fixtureToCollected } from "../../src/evidence/fixtures";

const M1 = hashJcs("milestone-1");
const M2 = hashJcs("milestone-2");
const url: EvidenceRequirement = { type: "URL_HEALTH", url: "https://site.example.com/health", expectStatus: 200 };
const ci: EvidenceRequirement = { type: "CI_PASS", repo: "acme/site", ref: "a".repeat(40), workflow: "ci.yml" };
const fx = (over: Partial<EvidenceFixture> = {}): EvidenceFixture => ({ fixtureId: "fx-1", milestoneId: M1, requirement: url, result: "PASS", payload: { status: 200 }, details: "scenario says healthy", availableAt: null, ...over });

describe("fixture store", () => {
  it("returns a fixture only for the exact requirement of the exact milestone", () => {
    const s = createFixtureStore([fx()]);
    const now = "2026-10-12T10:00:00Z";
    expect(s.find(M1, url, now)?.fixtureId).toBe("fx-1");
    expect(s.find(M2, url, now)).toBeNull(); // other milestone
    expect(s.find(M1, { ...url, url: "https://site.example.com/other" } as EvidenceRequirement, now)).toBeNull(); // other URL
    expect(s.find(M1, { ...url, expectStatus: 204 } as EvidenceRequirement, now)).toBeNull();
    expect(s.find(M1, { type: "URL_HEALTH", url: "https://site.example.com/health", expectStatus: 200, contentSha256: hashJcs("x") }, now)).toBeNull();
    expect(s.find(M1, ci, now)).toBeNull(); // other type
    expect(s.find(M1, { type: "OWNER_ACK" }, now)).toBeNull();
  });

  it("matching is by canonical JSON, so key order in the requirement is irrelevant", () => {
    const s = createFixtureStore([fx()]);
    const reordered = { expectStatus: 200, url: "https://site.example.com/health", type: "URL_HEALTH" } as EvidenceRequirement;
    expect(s.find(M1, reordered, "2026-10-12T10:00:00Z")).not.toBeNull();
  });

  it("honours availableAt on the scenario clock and picks the newest visible fixture", () => {
    const s = createFixtureStore([fx({ fixtureId: "early", result: "FAIL" }), fx({ fixtureId: "late", availableAt: "2026-10-12T12:00:00Z" })]);
    expect(s.find(M1, url, "2026-10-12T11:59:59Z")?.fixtureId).toBe("early");
    expect(s.find(M1, url, "2026-10-12T12:00:00Z")?.fixtureId).toBe("late");
    const onlyFuture = createFixtureStore([fx({ availableAt: "2026-10-12T12:00:00Z" })]);
    expect(onlyFuture.find(M1, url, "2026-10-12T11:00:00Z")).toBeNull();
  });

  it("an empty store resolves nothing", () => {
    expect(emptyFixtureStore.find(M1, url, "2026-10-12T10:00:00Z")).toBeNull();
  });

  it("rejects malformed or duplicate fixtures at construction", () => {
    expect(() => createFixtureStore([fx({ fixtureId: "bad id!" })])).toThrow();
    expect(() => createFixtureStore([fx(), fx()])).toThrow(/duplicate/);
    expect(() => createFixtureStore([{ ...fx(), extra: 1 } as unknown as EvidenceFixture])).toThrow();
  });

  it("turns a fixture into kernel evidence with source fixture:<id> and the requirement hash", () => {
    const c = fixtureToCollected(fx(), url);
    expect(c).toMatchObject({ source: "fixture:fx-1", result: "PASS", details: "scenario says healthy" });
    expect(c.payload).toEqual({ requirementHash: hashJcs(url), fixtureId: "fx-1", fixture: { status: 200 } });
  });
});
