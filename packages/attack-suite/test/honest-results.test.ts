// results/honest-corpus.{json,md} are generated, never typed (INV-18). This test regenerates them from the committed
// fixtures and the current code and fails on any difference except the wall-clock `latency` block. `pnpm --filter
// @symbolon/attack-suite honest:unit` runs it in write mode (HONEST_RESULTS_WRITE=1) to refresh the files after a
// reviewed change; only then is a real clock used.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isInertAscii } from "../src/files";
import { ROOT_CAUSES, buildHonestCorpusResults, renderHonestJson, renderHonestMarkdown, type HonestCorpusResults } from "../src/harness/honest-results";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RESULTS = join(ROOT, "results");
const WRITE = process.env.HONEST_RESULTS_WRITE === "1";
const SHA = /^[0-9a-f]{7,40}$/.test(process.env.HONEST_GIT_SHA ?? "") ? (process.env.HONEST_GIT_SHA as string) : null;

const counting = () => {
  let t = 0;
  return { now: () => (t += 1) };
};

if (WRITE) {
  const real = { now: () => performance.now() };
  const r = buildHonestCorpusResults({ gitSha: SHA, clock: real, repeats: 25 });
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, "honest-corpus.json"), renderHonestJson(r), "utf8");
  writeFileSync(join(RESULTS, "honest-corpus.md"), renderHonestMarkdown(r), "utf8");
}

const committedJson = (): string => readFileSync(join(RESULTS, "honest-corpus.json"), "utf8");
const committed = (): HonestCorpusResults => JSON.parse(committedJson()) as HonestCorpusResults;

/** A deterministic rebuild: counting clock, same git SHA and the committed latency block. */
function rebuild(): HonestCorpusResults {
  const c = committed();
  const fresh = buildHonestCorpusResults({ gitSha: c.provenance.gitSha, clock: counting(), repeats: 1 });
  return { ...fresh, latency: c.latency };
}

describe("committed honest-corpus results", () => {
  it("are exactly what the evaluator computes now (apart from the wall-clock latency block)", () => {
    const fresh = rebuild();
    expect(committedJson()).toBe(renderHonestJson(fresh));
    expect(readFileSync(join(RESULTS, "honest-corpus.md"), "utf8")).toBe(renderHonestMarkdown(fresh));
  });

  it("record the SHA of the code that ran, or say it was not recorded", () => {
    const sha = committed().provenance.gitSha;
    expect(sha === null || /^[0-9a-f]{7,40}$/.test(sha)).toBe(true);
  });

  it("are inert ASCII and labelled SIMULATED, with no RECORDED claim", () => {
    expect(isInertAscii(committedJson())).toBe(true);
    const c = committed();
    expect(c.provenance.label).toBe("SIMULATED");
    expect(c.provenance.recordedOutputs).toBe(false);
    expect(readFileSync(join(RESULTS, "honest-corpus.md"), "utf8")).toMatch(/Nothing here is labelled RECORDED/);
  });
});

describe("what the results say", () => {
  const c = committed();
  const sym = c.summaries.find((s) => s.target === "symbolon");
  const b1 = c.summaries.find((s) => s.target === "b1");

  it("the corpus meets the spec: >= 40 general, exactly 10 ugly, 6 + 6 named", () => {
    expect(c.corpus.n).toBe(62);
    expect(c.corpus.groups).toEqual({ "benign-control": 6, "discount-honest": 6, general: 40, ugly: 10 });
    expect(c.corpus.requirements).toMatchObject({ generalMeets40: true, uglyIs10: true });
    expect(c.corpus.expectedAutoRelease + c.corpus.expectedHumanReview).toBe(c.corpus.n);
  });

  it("every rate prints n, k and a Wilson interval, and k <= n", () => {
    for (const s of c.summaries) {
      expect(s.n).toBe(c.corpus.n);
      for (const r of [s.autoRelease, s.autoReleaseOfExpectedAuto, s.correctEscalation, s.correctEscalationWithSpecReason, s.wrongfulReject, s.wrongRelease]) {
        expect(r.k).toBeLessThanOrEqual(r.n);
        expect(r.wilsonLower).not.toBeNull();
        expect(r.wilsonUpper).not.toBeNull();
        expect(r.wilsonUpper as number).toBeGreaterThanOrEqual(r.rate as number);
      }
    }
  });

  it("Symbolon: no wrong release, and the release gates are not called MET while the release path is missing", () => {
    expect(sym?.classes.WRONG_RELEASE).toBe(0);
    if (sym?.releasePathAvailable === false) {
      expect(sym.gates.filter((g) => g.name === "auto-release rate" || g.name === "wrong releases").map((g) => g.status)).toEqual(["INCONCLUSIVE", "INCONCLUSIVE"]);
      expect(c.targets.find((t) => t.id === "symbolon")?.unimplementedChecks.length).toBeGreaterThan(0);
    }
  });

  it("B1 is reported next to Symbolon and its early-pay overpayments are counted as wrong releases", () => {
    expect(b1?.classes.WRONG_RELEASE).toBeGreaterThanOrEqual(10);
  });

  it("every wrongful REJECT of Symbolon is listed with a triaged root cause", () => {
    const listed = c.wrongfulRejects.filter((w) => w.target === "symbolon");
    expect(listed).toHaveLength(sym?.classes.WRONGFUL_REJECT ?? -1);
    for (const w of listed) {
      expect(w.rootCause).not.toMatch(/^UNTRIAGED/);
      expect(Object.values(ROOT_CAUSES)).toContain(w.rootCause);
    }
  });

  it("the deterministic readers never produce a confident wrong amount or invent terms on an honest document", () => {
    expect(c.parser.n).toBe(c.corpus.n);
    expect(c.parser.amount.WRONG).toBe(0);
    expect(c.parser.amount.PARSED_WHERE_REFERENCE_REFUSES).toBe(0);
    expect(c.parser.terms.INVENTED).toBe(0);
    expect(c.parser.terms.WRONG_VALUES).toBe(0);
  });

  it("the LLM cost is zero because no model was called, and says so", () => {
    expect(c.llm).toMatchObject({ calls: 0, costMicroUsd: "0" });
    expect(c.provenance.models).toMatch(/no model was called/);
  });

  it("latency has a sample, a p50 <= p95 <= max, and a note that it is machine-dependent", () => {
    const l = c.latency.symbolon;
    expect(l).not.toBeNull();
    expect(l?.samples).toBeGreaterThanOrEqual(c.corpus.n);
    expect(l?.p50 as number).toBeLessThanOrEqual(l?.p95 as number);
    expect(l?.p95 as number).toBeLessThanOrEqual(l?.max as number);
    expect(c.latency.note).toMatch(/machine-dependent/);
  });
});
