// results/honest-corpus.{json,md} (docs/07 §4-§5, docs/13 §3 "result files"; WP-24). Generated, never typed (INV-18):
// `claims.ts` reads these numbers; nothing in a README or a badge may be hand-written.
//
// Deterministic apart from `latency`, which is a wall-clock measurement taken by the writer script. The freshness test
// rebuilds everything with a counting clock and compares every field except `latency`.
import { epochSecondsFromIso, sha256Utf8 } from "@symbolon/schemas";
import { asciiJson, buildFixtureFiles, GENERATOR_VERSION } from "./files";
import { b1Target, B1_PROVENANCE } from "./harness/b1";
import { makeSymbolonUnitTarget } from "./harness/symbolon-unit";
import type { Target } from "./harness/target";
import { checkParsers, type ParserSummary } from "./honest-parser";
import { expectationOf, buildHonestCorpus, GENERAL_COUNT, UGLY_COUNT } from "./honest-corpus";
import {
  HONEST_EVAL_VERSION,
  evaluateHonestCorpus,
  summarizeHonest,
  summarizeLatency,
  type Clock,
  type HonestCorpusItem,
  type HonestCorpusSummary,
  type LatencySummary,
} from "./honest-eval";
import { BASE_SEED } from "./registry";
import type { HonestFixture, HonestGroup } from "./types";

export const HONEST_RESULTS_SCHEMA = "honest-corpus/1" as const;

/** Triage notes for wrongful rejects, keyed by the first reason code (docs/07 §4: each wrongful REJECT gets a root-cause ticket). */
export const ROOT_CAUSES: Readonly<Record<string, string>> = Object.freeze({
  MILESTONE_ALREADY_PAID:
    "K-04 rejects any second intent on a milestone that already has a RELEASE, including a later instalment of a partialAllowed milestone (docs/04 K-04 vs K-08/K-05 read together; docs/QUESTIONS.md WP-24). Open: spec decision, then kernel-core change (KERNEL-CORE).",
  B1_VALIDATOR_DECLINED: "B1's stand-in validator declines a print it cannot read (V5); a baseline behaviour, not a Symbolon defect.",
});

export interface HonestCoverage {
  readonly templateStyles: number;
  readonly numberFormats: number;
  readonly currencyLabels: number;
  readonly scenarios: number;
  readonly milestones: number;
  readonly categories: number;
  readonly decisionDelayDays: readonly number[];
  readonly receiptDays: number;
  readonly withLineItems: number;
  readonly withPoNumber: number;
  readonly statingTerms: number;
  readonly discountApplied: number;
  readonly note: string;
}

export interface HonestCorpusResults {
  readonly schema: typeof HONEST_RESULTS_SCHEMA;
  readonly mode: "unit";
  readonly evalVersion: typeof HONEST_EVAL_VERSION;
  readonly oracleVersion: "oracle-v1";
  readonly provenance: {
    readonly gitSha: string | null;
    readonly seed: string;
    readonly fixtureGenerator: string;
    readonly fixtureManifestSha256: string;
    readonly models: string;
    readonly recordedOutputs: false;
    readonly label: "SIMULATED";
    readonly anvilForkBlock: null;
  };
  readonly corpus: {
    readonly n: number;
    readonly groups: Readonly<Record<HonestGroup, number>>;
    readonly expectedAutoRelease: number;
    readonly expectedHumanReview: number;
    readonly requirements: { readonly general: number; readonly ugly: number; readonly generalMeets40: boolean; readonly uglyIs10: boolean };
    readonly coverage: HonestCoverage;
  };
  readonly targets: readonly {
    readonly id: string;
    readonly label: string;
    readonly provenance: string;
    readonly unimplementedChecks: readonly string[];
    readonly releasePathAvailable: boolean;
  }[];
  readonly summaries: readonly HonestCorpusSummary[];
  readonly items: Readonly<Record<string, readonly HonestCorpusItem[]>>;
  readonly wrongfulRejects: readonly { readonly target: string; readonly id: string; readonly caption: string; readonly reasons: readonly string[]; readonly checksFired: readonly string[]; readonly rootCause: string }[];
  readonly parser: ParserSummary;
  readonly llm: { readonly calls: 0; readonly costMicroUsd: "0"; readonly note: string };
  /** Wall clock; the only non-deterministic block. Symbolon target only. */
  readonly latency: { readonly symbolon: LatencySummary | null; readonly note: string };
  readonly limitations: readonly string[];
}

function coverageOf(fixtures: readonly HonestFixture[]): HonestCoverage {
  const tagValues = (prefix: string): Set<string> => new Set(fixtures.flatMap((f) => (f.tags ?? []).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length))));
  const hasTag = (tag: string): number => fixtures.filter((f) => (f.tags ?? []).includes(tag)).length;
  const signature = (p: string): string => p.replace(/[0-9]/g, "9");
  const delayDays = new Set<number>();
  for (const f of fixtures) {
    const recv = epochSecondsFromIso(f.step.doc.receivedAt);
    const now = epochSecondsFromIso(f.step.context.now ?? f.step.doc.receivedAt);
    delayDays.add(Number((now - recv) / 86_400n));
  }
  return {
    templateStyles: tagValues("style:").size,
    numberFormats: new Set(fixtures.map((f) => signature(String(f.step.runs[0]?.a.amount.printed)))).size,
    currencyLabels: new Set(fixtures.map((f) => String(f.step.runs[0]?.a.amount.currencyPrinted))).size,
    scenarios: new Set(fixtures.map((f) => f.scenarioId)).size,
    milestones: new Set(fixtures.map((f) => `${f.scenarioId}/${f.step.milestoneSlug ?? "none"}`)).size,
    categories: tagValues("category:").size,
    decisionDelayDays: [...delayDays].sort((a, b) => a - b),
    receiptDays: new Set(fixtures.map((f) => f.step.doc.receivedAt.slice(0, 10))).size,
    withLineItems: hasTag("multi-line-items"),
    withPoNumber: hasTag("po-number"),
    statingTerms: hasTag("states-terms"),
    discountApplied: hasTag("early-pay-discount-applied"),
    note: "Variety is bounded by the three canonical scenarios (5 milestones, 3 categories, 3 payees). The 12 WP-22 fixtures carry no tags, so tag-derived counts cover the 50 WP-24 invoices only.",
  };
}

const LIMITATIONS = (unimplemented: readonly string[]): string[] => {
  const l: string[] = [];
  if (unimplemented.length > 0) {
    l.push(
      `The Symbolon target runs the kernel-core build as merged: ${unimplemented.join(", ")} are fail-closed placeholders. A HOLD that exists only because of them is PENDING_CHECKS (inconclusive); no invoice can be released, so the auto-release and wrong-release gates are INCONCLUSIVE, not MET. They are meant to be re-run when the checks land (pnpm --filter @symbolon/attack-suite honest:unit).`,
    );
  }
  l.push("Every invoice is honest by construction and the corpus is generated: it measures false refusals on documents shaped like our own templates, not on real-world invoices. Real pilot invoices are the evidence for that (WP-27).");
  l.push("Expected outcomes are written from docs/04, before and independent of any run. Where the spec itself is ambiguous the fixture keeps the reading of docs/07 §4 and the disagreement is logged in docs/QUESTIONS.md.");
  l.push("Extraction reads are the fixtures' REFERENCE reads; no model was called, so the LLM cost is zero by construction and says nothing about a live model. Nothing here is labelled RECORDED.");
  l.push("Engagements are fixture templates activated with placeholder signatures (SIMULATED), as in the attack matrix. Each invoice runs on a fresh scenario instance; there is no cross-invoice state beyond a fixture's own context patch.");
  l.push("The parser block checks packages/extractor's deterministic readers (the zero-LLM path) against the same reference reads. It does not measure any LLM extractor; those figures are in packages/extractor/eval/results/extractor-eval.json and are SIMULATED.");
  l.push("Latency is the wall-clock time of one in-process kernel-core evaluate() on the machine that wrote the file. It is not a service latency and not comparable across machines.");
  return l;
};

export interface BuildOptions {
  readonly gitSha: string | null;
  readonly clock: Clock;
  /** Times each Symbolon decision is repeated for the latency sample (>= 1). */
  readonly repeats?: number;
}

export function buildHonestCorpusResults(opts: BuildOptions): HonestCorpusResults {
  const fixtures = buildHonestCorpus(BASE_SEED);
  const symbolon = makeSymbolonUnitTarget();
  const runs: Array<{ target: Target; label: string; provenance: string }> = [
    { target: symbolon, label: symbolon.label, provenance: symbolon.provenance },
    { target: b1Target, label: b1Target.label, provenance: B1_PROVENANCE },
  ];
  const itemsByTarget: Record<string, HonestCorpusItem[]> = {};
  const samples: number[] = [];
  const repeats = Math.max(1, opts.repeats ?? 1);
  for (const { target } of runs) {
    // First pass is the one reported; further passes (Symbolon only) add latency samples.
    const first = evaluateHonestCorpus(fixtures, target, opts.clock);
    itemsByTarget[target.id] = first.map((e) => e.item);
    if (target.id === "symbolon") {
      samples.push(...first.map((e) => e.latencyMs));
      for (let r = 1; r < repeats; r++) samples.push(...evaluateHonestCorpus(fixtures, makeSymbolonUnitTarget(), opts.clock).map((e) => e.latencyMs));
    }
  }
  const unimplemented = symbolon.observedUnimplemented();
  const summaries = runs.map(({ target }) => summarizeHonest(target.id, itemsByTarget[target.id] ?? [], target.id === "symbolon" ? unimplemented.length === 0 : true));
  const manifest = buildFixtureFiles().get("MANIFEST.json");
  if (manifest === undefined) throw new RangeError("fixture manifest missing");
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const wrongfulRejects = runs.flatMap(({ target }) =>
    (itemsByTarget[target.id] ?? [])
      .filter((i) => i.class === "WRONGFUL_REJECT")
      .map((i) => ({
        target: target.id,
        id: i.id,
        caption: byId.get(i.id)?.caption ?? "",
        reasons: i.reasons,
        checksFired: i.checksFired as readonly string[],
        rootCause: ROOT_CAUSES[i.reasons.find((r) => ROOT_CAUSES[r] !== undefined) ?? ""] ?? "UNTRIAGED: add a root-cause note",
      })),
  );
  const groups = Object.fromEntries((["benign-control", "discount-honest", "general", "ugly"] as const).map((g) => [g, fixtures.filter((f) => f.group === g).length])) as Record<HonestGroup, number>;
  return {
    schema: HONEST_RESULTS_SCHEMA,
    mode: "unit",
    evalVersion: HONEST_EVAL_VERSION,
    oracleVersion: "oracle-v1",
    provenance: {
      gitSha: opts.gitSha,
      seed: BASE_SEED,
      fixtureGenerator: GENERATOR_VERSION,
      fixtureManifestSha256: sha256Utf8(manifest),
      models: "none: no model was called (reference extraction reads; B1 validator is a deterministic SIMULATED stand-in)",
      recordedOutputs: false,
      label: "SIMULATED",
      anvilForkBlock: null,
    },
    corpus: {
      n: fixtures.length,
      groups,
      expectedAutoRelease: fixtures.filter((f) => expectationOf(f).outcome === "AUTO_RELEASE").length,
      expectedHumanReview: fixtures.filter((f) => expectationOf(f).outcome === "HUMAN_REVIEW").length,
      requirements: { general: groups.general, ugly: groups.ugly, generalMeets40: groups.general >= GENERAL_COUNT, uglyIs10: groups.ugly === UGLY_COUNT },
      coverage: coverageOf(fixtures),
    },
    targets: runs.map(({ target, label, provenance }) => ({
      id: target.id,
      label,
      provenance,
      unimplementedChecks: target.id === "symbolon" ? unimplemented : [],
      releasePathAvailable: target.id === "symbolon" ? unimplemented.length === 0 : true,
    })),
    summaries,
    items: itemsByTarget,
    wrongfulRejects,
    parser: checkParsers(fixtures),
    llm: { calls: 0, costMicroUsd: "0", note: "No model was called: extraction reads are the fixtures' reference reads, so this is zero by construction. A live-model cost per invoice is NOT MEASURED." },
    latency: {
      symbolon: summarizeLatency(samples),
      note: `Wall-clock milliseconds for one in-process kernel-core evaluate() (unit mode), ${repeats} pass(es) over the corpus; machine-dependent and the only non-deterministic block in this file.`,
    },
    limitations: LIMITATIONS(unimplemented),
  };
}

// --- rendering ------------------------------------------------------------------------------------------------------
const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
const rateText = (r: { k: number; n: number; rate: number | null; wilsonLower: number | null; wilsonUpper: number | null }): string =>
  `${r.k} of ${r.n} (${pct(r.rate)}; Wilson 95%: ${pct(r.wilsonLower)} to ${pct(r.wilsonUpper)})`;

export function renderHonestJson(r: HonestCorpusResults): string {
  return asciiJson(r);
}

export function renderHonestMarkdown(r: HonestCorpusResults): string {
  const out: string[] = [];
  const p = (s = ""): void => void out.push(s);
  const sym = r.summaries.find((s) => s.target === "symbolon");
  const b1 = r.summaries.find((s) => s.target === "b1");
  if (sym === undefined || b1 === undefined) throw new RangeError("summaries missing");
  p("# Honest corpus (unit mode)");
  p();
  p("Generated by `pnpm --filter @symbolon/attack-suite honest:unit` from the committed fixtures; do not edit by hand. Every number below is computed (INV-18). All figures are **SIMULATED**: reference extraction reads, no model, placeholder-signed engagements.");
  p();
  p("## Headline");
  p();
  p(`- **Corpus:** ${r.corpus.n} legitimate invoices (${r.corpus.groups["benign-control"]} benign controls, ${r.corpus.groups["discount-honest"]} discount-honest, ${r.corpus.groups.general} general, ${r.corpus.groups.ugly} "legit but ugly"). ${r.corpus.expectedAutoRelease} are expected to pay without a human; ${r.corpus.expectedHumanReview} need a human by design.`);
  p(`- **Release path in this kernel build:** ${sym.releasePathAvailable ? "yes" : `**no** (checks not implemented: ${r.targets.find((t) => t.id === "symbolon")?.unimplementedChecks.join(", ") ?? ""}); they fail closed to HOLD`}.`);
  p(`- **Auto-release rate (Symbolon):** ${rateText(sym.autoRelease)}${sym.releasePathAvailable ? "" : "; INCONCLUSIVE, no invoice can be released in this build"}.`);
  p(`- **Correctly sent to a human (Symbolon):** ${rateText(sym.correctEscalation)} of the ${sym.expectedHumanReview} that need one; with the spec's reason code present: ${rateText(sym.correctEscalationWithSpecReason)}.`);
  p(`- **Wrongful REJECT (Symbolon):** ${rateText(sym.wrongfulReject)}.`);
  p(`- **Wrong releases (Symbolon):** ${rateText(sym.wrongRelease)}${sym.releasePathAvailable ? "" : "; no release was possible, so 0 is not evidence"}.`);
  p(`- **Held only because checks are missing (inconclusive):** ${sym.pendingChecks} of ${sym.n}.`);
  p(`- **B1 for comparison (SIMULATED baseline):** auto-released ${rateText(b1.autoRelease)}; wrong releases ${rateText(b1.wrongRelease)} (it overpays early-pay discounts it does not model); wrongful reject ${rateText(b1.wrongfulReject)}.`);
  p(`- **LLM cost:** ${r.llm.calls} calls, ${r.llm.costMicroUsd} micro-USD (${r.llm.note})`);
  const lat = r.latency.symbolon;
  p(`- **Decision latency (Symbolon, in-process, this machine):** ${lat === null ? "n/a" : `p50 ${lat.p50} ms, p95 ${lat.p95} ms, max ${lat.max} ms over ${lat.samples} decisions`}.`);
  p();
  p("## Gates (docs/07 §4, §7)");
  p();
  p("| Target | Gate | Threshold | Value | Status | Note |");
  p("|---|---|---|---|---|---|");
  for (const s of r.summaries) for (const g of s.gates) p(`| ${s.target} | ${g.name} | ${g.threshold} | ${g.value} | ${g.status} | ${g.note} |`);
  p();
  p("## Outcome classes");
  p();
  const classes = Object.keys(sym.classes) as Array<keyof typeof sym.classes>;
  p(`| Target | ${classes.join(" | ")} |`);
  p(`|---|${classes.map(() => "---").join("|")}|`);
  for (const s of r.summaries) p(`| ${s.target} | ${classes.map((c) => s.classes[c]).join(" | ")} |`);
  p();
  p("## Wrongful REJECTs and their root causes");
  p();
  if (r.wrongfulRejects.length === 0) p("None.");
  for (const w of r.wrongfulRejects) p(`- ${w.target} ${w.id} (${w.caption}): reasons ${w.reasons.join(", ") || "none"}; checks ${w.checksFired.join(", ") || "none"}. Root cause: ${w.rootCause}`);
  p();
  p("## Coverage");
  p();
  const c = r.corpus.coverage;
  p(`${c.templateStyles} template styles, ${c.numberFormats} printed-number formats, ${c.currencyLabels} currency labels, ${c.scenarios} scenarios, ${c.milestones} milestones, ${c.categories} categories, ${c.receiptDays} receipt days, decision delays (days) ${c.decisionDelayDays.join(", ")}; ${c.withLineItems} with line items, ${c.withPoNumber} with a PO number, ${c.statingTerms} stating terms, ${c.discountApplied} paid at the early-pay discount. ${c.note}`);
  p();
  p("## Extractor-side check (deterministic readers, zero-LLM path)");
  p();
  p(`Amount reader on ${r.parser.n} honest documents: ${Object.entries(r.parser.amount).map(([k, v]) => `${k} ${v}`).join(", ")}. Terms reader: ${Object.entries(r.parser.terms).map(([k, v]) => `${k} ${v}`).join(", ")}. WRONG (a confident wrong amount) must be 0 (docs/03 §8).`);
  if (r.parser.disagreements.length > 0) for (const d of r.parser.disagreements) p(`- ${d.id} ${d.field}: ${d.outcome}`);
  p();
  p("## Known limits");
  p();
  for (const l of r.limitations) p(`- ${l}`);
  p();
  p("## Provenance");
  p();
  p(`Oracle ${r.oracleVersion}; evaluator ${r.evalVersion}; fixtures ${r.provenance.fixtureGenerator}, seed \`${r.provenance.seed}\`, manifest sha256 \`${r.provenance.fixtureManifestSha256}\`. Git SHA of the code that ran: ${r.provenance.gitSha ?? "not recorded (dirty tree)"}. Models: ${r.provenance.models}.`);
  p();
  p("## Reproduce");
  p();
  p("```");
  p("pnpm install --frozen-lockfile");
  p("pnpm --filter @symbolon/attack-suite honest:unit      # rewrites results/honest-corpus.json and .md");
  p("pnpm exec vitest run packages/attack-suite");
  p("```");
  p();
  return `${out.join("\n")}\n`;
}
