// The model edge of the challenge (docs/15 section 5) with ONLY the HTTP call faked: the real dual-model extractor, the real
// Postgres budget ledger and the real service run on top of it. No key exists here; prices are the test's own numbers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHonest } from "@symbolon/attack-suite";
import { PgBudgetLedger } from "../../src/challenge/ledger";
import { makeExtractEdge, parsePrices } from "../../src/challenge/extract";
import { ChallengeService } from "../../src/challenge/service";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { openWorld } from "../helpers/world";
import type { World } from "../helpers/world";

const PRICES = parsePrices(JSON.stringify({ "claude-sonnet-5-5": { inPerMTok: "3000000", outPerMTok: "15000000" }, "claude-haiku-5-5": { inPerMTok: "1000000", outPerMTok: "5000000" } }));
const H = buildHonest().find((x) => x.id === "BC-1")!;
const DOC = String(H.step.doc.text);

/** A "provider" that reads the document the way a careful model would: it submits the fixture's reference reading. */
const honestProvider = (calls: { n: number }): typeof fetch =>
  (async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: `tu${String(calls.n)}`, name: "submit_extraction", input: H.step.runs[0]!.a }], usage: { input_tokens: 400, output_tokens: 150 } }), { status: 200 });
  }) as typeof fetch;

describe("parsePrices", () => {
  it("reads an operator price table and refuses anything malformed; absent = no prices (free-form stays off)", () => {
    expect(parsePrices(undefined)).toEqual({});
    expect(parsePrices("")).toEqual({});
    expect(parsePrices(JSON.stringify({ m: { inPerMTok: "1", outPerMTok: "2" } }))).toEqual({ m: { inPerMTok: 1n, outPerMTok: 2n } });
    expect(() => parsePrices("[]")).toThrow();
    expect(() => parsePrices(JSON.stringify({ m: { inPerMTok: 1, outPerMTok: "2" } }))).toThrow();
    expect(() => parsePrices(JSON.stringify({ m: { inPerMTok: "-1", outPerMTok: "2" } }))).toThrow();
    expect(() => parsePrices(JSON.stringify({ "bad model!": { inPerMTok: "1", outPerMTok: "2" } }))).toThrow();
  });
});

describe.skipIf(!dbSuiteEnabled("challenge-extract.local"))("local: the free-form path end to end with only the provider HTTP call faked", () => {
  let w: World;
  let ledger: PgBudgetLedger;
  beforeAll(async () => {
    w = await openWorld("sandbox");
    ledger = new PgBudgetLedger(w.t.db, { globalDailyMicroUsd: 5_000_000n, perPrincipalDailyMicroUsd: 1_000_000n });
  }, 120_000);
  afterAll(async () => {
    await w.close();
  }, 120_000);

  it("without a key, or with an unpriced model, there is no edge (free-form stays off)", () => {
    expect(makeExtractEdge({ apiKey: "", ledger, prices: PRICES })).toBeNull();
    expect(makeExtractEdge({ apiKey: "k-not-real-0123456789", ledger, prices: {} })).toBeNull();
  });

  it("reads the visitor's document through the budget ledger, the kernel decides, and the spend is booked", async () => {
    const calls = { n: 0 };
    const edge = makeExtractEdge({ apiKey: "k-not-real-0123456789", ledger, prices: PRICES, fetchImpl: honestProvider(calls) });
    expect(edge).not.toBeNull();
    const svc = new ChallengeService({ db: w.t.db, clock: () => Date.now(), logger: w.logger, ipSalt: "salt-for-tests-only-0123456789", enabled: true, dailyBudgetMicroUsd: 5_000_000n, ledger, extract: edge, onchain: null });
    const before = await ledger.spentTodayMicroUsd();
    const r = await svc.attempt({ kind: "freeform", scenarioId: H.scenarioId, milestoneSlug: H.step.milestoneSlug, text: DOC }, "203.0.113.5");
    expect(calls.n).toBe(2); // two models read it
    expect(r.extractionRefused).toBeNull();
    expect(r.result).toMatchObject({ kind: "freeform", oracleResult: "NO_LOSS", action: "RELEASE" });
    expect(r.result.runs[0]?.release?.amountBaseUnits).toBe(H.correctRelease.amountBaseUnits);
    expect(await ledger.spentTodayMicroUsd()).toBeGreaterThan(before);
    // the same document again is a cache hit: no new provider call, no new spend
    const spent = await ledger.spentTodayMicroUsd();
    await svc.attempt({ kind: "freeform", scenarioId: H.scenarioId, milestoneSlug: H.step.milestoneSlug, text: DOC }, "203.0.113.6");
    expect(calls.n).toBe(2);
    expect(await ledger.spentTodayMicroUsd()).toBe(spent);
  });

  it("a provider outage fails closed to an escalation with NO_LOSS and the failed attempt still counts against the budget", async () => {
    const down = (async () => new Response("upstream error", { status: 500 })) as typeof fetch;
    const edge = makeExtractEdge({ apiKey: "k-not-real-0123456789", ledger, prices: PRICES, fetchImpl: down });
    const svc = new ChallengeService({ db: w.t.db, clock: () => Date.now(), logger: w.logger, ipSalt: "salt-for-tests-only-0123456789", enabled: true, dailyBudgetMicroUsd: 5_000_000n, ledger, extract: edge, onchain: null });
    const before = await ledger.spentTodayMicroUsd();
    const r = await svc.attempt({ kind: "freeform", scenarioId: "S-A", milestoneSlug: H.step.milestoneSlug, text: `${DOC}\n(outage ${String(Date.now())})` }, "203.0.113.8");
    expect(r.result).toMatchObject({ releases: 0, oracleResult: "NO_LOSS" });
    expect(["ESCALATE", "HOLD"]).toContain(r.result.action);
    expect(r.extractionRefused).not.toBeNull();
    expect(await ledger.spentTodayMicroUsd()).toBeGreaterThan(before); // every attempt counts, even a failed one
  });

  it("an exhausted per-principal budget denies the call and nothing is released", async () => {
    const calls = { n: 0 };
    const tiny = new PgBudgetLedger(w.t.db, { globalDailyMicroUsd: 5_000_000n, perPrincipalDailyMicroUsd: 1n });
    const edge = makeExtractEdge({ apiKey: "k-not-real-0123456789", ledger: tiny, prices: PRICES, fetchImpl: honestProvider(calls) });
    const svc = new ChallengeService({ db: w.t.db, clock: () => Date.now(), logger: w.logger, ipSalt: "salt-for-tests-only-0123456789", enabled: true, dailyBudgetMicroUsd: 5_000_000n, ledger: tiny, extract: edge, onchain: null });
    const r = await svc.attempt({ kind: "freeform", scenarioId: "S-A", milestoneSlug: H.step.milestoneSlug, text: `${DOC}\n(budget ${String(Date.now())})` }, "203.0.113.9");
    expect(calls.n).toBe(0);
    expect(r.extractionRefused).toBe("BUDGET_EXHAUSTED");
    expect(r.result.releases).toBe(0);
  });
});
