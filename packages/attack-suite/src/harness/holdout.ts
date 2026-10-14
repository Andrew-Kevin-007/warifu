// Hold-out runner library (docs/07 §3.3, RT-07). PURE: it never touches the file system. The CLI (holdout/cli.ts) reads
// the fixture directory, which lives OUTSIDE the repository, and passes the file texts in. Nothing in this package
// names that directory (guards.test.ts keeps it that way).
//
// What the hold-out set is: attacks and benign documents written by an independent adversary from the published docs
// only, committed by hash (holdout/ROOT) before any defender run. Each fixture runs on a FRESH scenario instance
// (docs/15 §2) of every target; the same oracle (packages/oracle) scores everything. Reported: n fixtures, k fixtures
// on which a target lost money, and the 95 % upper bound (rule of three at k = 0, Clopper-Pearson otherwise).
import * as z from "zod";
import { judgeRelease } from "@symbolon/oracle";
import {
  AmountSchema,
  DecimalSeparatorGuessSchema,
  DocTypeSchema,
  ExtractedInvoiceSchema,
  ISODateSchema,
  ISODateTimeSchema,
  OraclePredicateSchema,
  ScenarioIdSchema,
  hashJcs,
  keccak256Utf8,
  untrusted,
} from "@symbolon/schemas";
import type { Address, ExtractedInvoice, Hex32, OraclePredicate } from "@symbolon/schemas";
import { addressFromLabel } from "../ids";
import { summarizeRate, wilson } from "../stats";
import type { RateSummary } from "../stats";
import { ContextPatchSchema, SubmitStepSchema } from "../types";
import type { ScenarioId, SubmitStep, TargetId } from "../types";
import { ATTACKER, ATTACKER_2, CLOCK_START, LOOKALIKE_PAYEE, OWNER, UNREGISTERED_VENDOR, VAULT, WORLD, milestoneId } from "../world";
import { b0InputsOf } from "./b0-prepared";
import { b0Target, prepareB0 } from "./b0";
import { b1Target } from "./b1";
import { b2Target } from "./b2";
import { runSubmit } from "./run";
import type { Holder } from "./run";
import { freshState, applyPatch, recordRelease, toOracleInstance } from "./state";
import { makeSymbolonUnitTarget } from "./symbolon-unit";
import type { Target } from "./target";

export const HOLDOUT_FIXTURE_SCHEMA = "holdout-fixture/1" as const;
export const HOLDOUT_MANIFEST_SCHEMA = "holdout-manifest/1" as const;
export const HOLDOUT_RESULT_SCHEMA = "holdout-results/1" as const;

export const ROUNDS = ["H1", "H2"] as const;
export type Round = (typeof ROUNDS)[number];

// --- symbolic addresses (the adversary cannot know the derived addresses; it writes tokens) ---------------------------
const FIXED_TOKENS: Readonly<Record<string, Address>> = Object.freeze({
  PAYEE: WORLD["S-A"].payee, // replaced per scenario below
  ATTACKER,
  ATTACKER_2,
  LOOKALIKE: LOOKALIKE_PAYEE,
  UNREGISTERED: UNREGISTERED_VENDOR,
  OWNER,
  VAULT,
  "PAYEE_S-A": WORLD["S-A"].payee,
  "PAYEE_S-B": WORLD["S-B"].payee,
  "PAYEE_S-C": WORLD["S-C"].payee,
});

const TOKEN_RE = /\{\{([A-Za-z0-9_-]+|ADDR:[A-Za-z0-9_.-]+)\}\}/g;

/** Replace `{{PAYEE}}` (this scenario's registered payee), `{{ATTACKER}}`, ..., `{{ADDR:any-label}}` (a fresh unrelated address). */
export function expandTokens(text: string, scenario: ScenarioId): string {
  return text.replace(TOKEN_RE, (all, name: string) => {
    if (name.startsWith("ADDR:")) return addressFromLabel(`holdout/${name.slice(5)}`);
    if (name === "PAYEE") return WORLD[scenario].payee;
    const a = FIXED_TOKENS[name];
    if (a === undefined) throw new RangeError(`unknown token ${all}`);
    return a;
  });
}

// --- fixture format (documented for the adversary in holdout/FORMAT.md) ----------------------------------------------
const Str = (max: number) => z.string().max(max);

export const ReadSpecSchema = z.strictObject({
  docType: DocTypeSchema.exactOptional(),
  invoiceNumber: Str(128),
  issueDate: ISODateSchema.nullable().exactOptional(),
  dueDate: ISODateSchema.nullable().exactOptional(),
  payeeName: Str(256).nullable().exactOptional(),
  /** a 0x address, a {{TOKEN}}, or null (the document prints no wallet). Default {{PAYEE}}. */
  walletAddress: Str(64).nullable().exactOptional(),
  claimsAddressChange: z.boolean().exactOptional(),
  amountPrinted: Str(64),
  /** base units (6 decimals) as a decimal string; null = the reader refuses to parse. */
  parsedBaseUnits: AmountSchema.nullable(),
  currencyPrinted: Str(32).exactOptional(),
  decimalSeparatorGuess: DecimalSeparatorGuessSchema.exactOptional(),
  references: z.strictObject({ engagementId: Str(128).nullable().exactOptional(), milestoneId: Str(128).nullable().exactOptional(), poNumber: Str(128).nullable().exactOptional() }).exactOptional(),
  statedTerms: z
    .strictObject({
      raw: Str(256).nullable().exactOptional(),
      netDays: z.number().int().min(0).max(3650).nullable().exactOptional(),
      earlyPay: z.strictObject({ discountBps: z.number().int().min(0).max(10_000), withinDays: z.number().int().min(0).max(3650) }).nullable().exactOptional(),
      ambiguous: z.boolean().exactOptional(),
    })
    .exactOptional(),
  lineItems: z.array(z.strictObject({ description: Str(500), amountPrinted: Str(64).nullable().exactOptional() })).max(50).exactOptional(),
  anomalies: z.array(z.strictObject({ code: z.enum(["INSTRUCTION_IN_DOC", "ADDRESS_CHANGE", "AMOUNT_AMBIGUOUS", "MISSING_FIELD", "HIDDEN_CHARS", "TERMS_CLAIM", "OTHER"]), quote: Str(500) })).max(20).exactOptional(),
  confidence: z.number().min(0).max(1).exactOptional(),
});
export type ReadSpec = z.infer<typeof ReadSpecSchema>;

const ReadSchema = z.strictObject({
  label: z.string().min(1).max(64),
  a: ReadSpecSchema,
  /** "same" (default): the second model read the same thing; null: single extraction; or its own read. */
  b: z.union([z.literal("same"), z.null(), ReadSpecSchema]).exactOptional(),
});

const StepSchema = z.strictObject({
  stepId: z.string().min(1).max(64),
  /** milestone slug of the engagement the invoice is for; null = names no milestone of the engagement */
  milestone: z.string().min(1).max(64).nullable(),
  document: z.strictObject({ text: Str(4096), receivedAt: ISODateTimeSchema.exactOptional() }),
  context: ContextPatchSchema.exactOptional(),
  reads: z.array(ReadSchema).min(1).max(4),
});

const IntendedSchema = z.strictObject({
  stepId: z.string().min(1).max(64),
  /** the payee and amount a successful attacker gets; tokens allowed */
  payee: Str(64),
  amountBaseUnits: AmountSchema,
  milestone: z.string().min(1).max(64).nullable(),
  /** instant the money would move; default = the step's now */
  time: ISODateTimeSchema.exactOptional(),
  /** oracle-v1 predicates that must hold for this release (docs/15 §2). */
  predicates: z.array(OraclePredicateSchema).min(1).max(8),
});

export const FAMILIES = [
  "ATK-01", "ATK-02", "ATK-03", "ATK-04", "ATK-05", "ATK-06", "ATK-07", "ATK-08", "ATK-09", "ATK-10", "ATK-11", "ATK-12",
  "ATK-13", "ATK-14", "ATK-15", "ATK-16", "ATK-18", "ATK-19", "ATK-20", "ATK-21", "NOVEL", "BENIGN",
] as const;

export const HoldoutFixtureSchema = z.strictObject({
  schema: z.literal(HOLDOUT_FIXTURE_SCHEMA),
  id: z.string().regex(/^H[12]-[A-Za-z0-9._-]{1,48}$/),
  round: z.enum(ROUNDS),
  family: z.enum(FAMILIES),
  kind: z.enum(["attack", "benign"]),
  title: Str(160),
  /** why this should work, citing the published doc section it came from */
  rationale: Str(600),
  scenario: ScenarioIdSchema,
  steps: z.array(StepSchema).min(1).max(30),
  label: z.strictObject({
    /** attack: the releases a successful attacker is after (empty = no oracle-expressible loss, counted separately). */
    intended: z.array(IntendedSchema).max(30),
    mode: z.enum(["each", "cumulative"]).exactOptional(),
    /** benign: what a correct system pays, or null when a human is needed by design */
    correctRelease: z.strictObject({ stepId: z.string().min(1).max(64), payee: Str(64), amountBaseUnits: AmountSchema }).nullable().exactOptional(),
  }),
});
export type HoldoutFixture = z.infer<typeof HoldoutFixtureSchema>;

export function parseFixture(text: string): HoldoutFixture {
  return HoldoutFixtureSchema.parse(JSON.parse(text));
}

// --- manifest and ROOT (RT-07: committed before any defender run) -------------------------------------------------------
export const ManifestSchema = z.strictObject({
  schema: z.literal(HOLDOUT_MANIFEST_SCHEMA),
  round: z.enum(ROUNDS),
  /** keccak256 of the seed string; the seed itself is published at freeze so anyone can recompute this. */
  seedHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  count: z.number().int().min(0),
  fixtures: z.array(z.strictObject({ id: z.string(), hash: z.string().regex(/^0x[0-9a-f]{64}$/) })),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** keccak256(JCS(fixture JSON)): independent of whitespace and line endings. */
export function fixtureHash(text: string): Hex32 {
  return hashJcs(JSON.parse(text));
}

export function buildManifest(round: Round, seed: string, files: ReadonlyMap<string, string>): Manifest {
  const fixtures = [...files.entries()].map(([name, text]) => {
    const f = parseFixture(text);
    if (f.round !== round) throw new RangeError(`${name}: fixture ${f.id} is round ${f.round}, not ${round}`);
    return { id: f.id, hash: fixtureHash(text) };
  });
  const ids = fixtures.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new RangeError("duplicate fixture ids");
  fixtures.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { schema: HOLDOUT_MANIFEST_SCHEMA, round, seedHash: keccak256Utf8(seed), count: fixtures.length, fixtures };
}

export function rootOf(m: Manifest): Hex32 {
  return hashJcs(ManifestSchema.parse(m));
}

// --- fixture -> harness steps ------------------------------------------------------------------------------------------
function expandRead(spec: ReadSpec, scenario: ScenarioId): ExtractedInvoice {
  const x = (s: string): string => expandTokens(s, scenario);
  const xs = (s: string | null | undefined): ReturnType<typeof untrusted> | null => (s === null || s === undefined ? null : untrusted(x(s)));
  const wallet = spec.walletAddress === undefined ? WORLD[scenario].payee : spec.walletAddress === null ? null : x(spec.walletAddress);
  const parsed = spec.parsedBaseUnits;
  const raw = {
    docType: spec.docType ?? "INVOICE",
    invoiceNumber: untrusted(x(spec.invoiceNumber)),
    issueDate: spec.issueDate ?? null,
    dueDate: spec.dueDate ?? null,
    payee: { legalName: xs(spec.payeeName ?? null), walletAddress: wallet, claimsAddressChange: spec.claimsAddressChange ?? false },
    amount: {
      printed: untrusted(x(spec.amountPrinted)),
      currencyPrinted: untrusted(spec.currencyPrinted ?? "USDC"),
      decimalSeparatorGuess: spec.decimalSeparatorGuess ?? ".",
      parsedBaseUnits: parsed,
      decimals: parsed === null ? null : 6,
    },
    references: { engagementId: xs(spec.references?.engagementId), milestoneId: xs(spec.references?.milestoneId), poNumber: xs(spec.references?.poNumber) },
    statedTerms: {
      raw: xs(spec.statedTerms?.raw),
      netDays: spec.statedTerms?.netDays ?? null,
      earlyPay: spec.statedTerms?.earlyPay ?? null,
      ambiguous: spec.statedTerms?.ambiguous ?? false,
    },
    lineItems: (spec.lineItems ?? []).map((l) => ({ description: untrusted(x(l.description)), amountPrinted: xs(l.amountPrinted ?? null) })),
    anomalies: (spec.anomalies ?? []).map((a) => ({ code: a.code, quote: untrusted(x(a.quote)) })),
    confidence: spec.confidence ?? 0.9,
  };
  return ExtractedInvoiceSchema.parse(raw);
}

const PERMISSIVE = { verdictIn: ["RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY"] } as const;

export function toSubmitSteps(f: HoldoutFixture): SubmitStep[] {
  return f.steps.map((s) => {
    const context = s.context === undefined ? {} : { ...s.context, ...(s.context.priorReleases === undefined ? {} : { priorReleases: s.context.priorReleases.map((p) => ({ ...p, payee: expandTokens(p.payee, f.scenario) })) }) };
    return SubmitStepSchema.parse({
      kind: "submit",
      stepId: s.stepId,
      milestoneSlug: s.milestone,
      doc: { docLabel: `${f.id}/${s.stepId}`, origin: "freeform", mime: "text/plain", text: untrusted(expandTokens(s.document.text, f.scenario)), receivedAt: s.document.receivedAt ?? CLOCK_START },
      context,
      runs: s.reads.map((r) => ({
        label: r.label,
        a: expandRead(r.a, f.scenario),
        b: r.b === null ? null : r.b === undefined || r.b === "same" ? expandRead(r.a, f.scenario) : expandRead(r.b, f.scenario),
        agentRecommendation: null,
        expect: PERMISSIVE,
      })),
    });
  });
}

// --- running ------------------------------------------------------------------------------------------------------------
export interface HoldoutTarget {
  readonly id: TargetId;
  readonly target: Target;
}

export function defaultTargets(): HoldoutTarget[] {
  return [
    { id: "symbolon", target: makeSymbolonUnitTarget() },
    { id: "b0", target: b0Target },
    { id: "b1", target: b1Target },
    { id: "b2", target: b2Target },
  ];
}

export interface FixtureOutcome {
  readonly fixtureId: string;
  readonly family: string;
  readonly kind: "attack" | "benign";
  readonly target: TargetId;
  /** attack: at least one release of the fixture was judged LOSS by the oracle */
  readonly lost: boolean;
  readonly lossBaseUnits: string;
  readonly predicates: readonly OraclePredicate[];
  readonly releases: number;
  readonly actions: readonly string[];
  /** benign only */
  readonly benignClass: "AUTO_CORRECT" | "RELEASED_WRONG" | "WRONGFUL_REJECT" | "HUMAN_REVIEW" | "OTHER" | null;
  /** The fixture's expected oracle label held (attack: oracle reports the listed predicates). Informational. */
  readonly runs: number;
}

export interface LabelCheck {
  readonly fixtureId: string;
  readonly stepId: string;
  readonly intended: readonly OraclePredicate[];
  readonly reported: readonly OraclePredicate[];
  readonly missing: readonly OraclePredicate[];
}

/** Does the oracle agree with the adversary's label? Judged on a fresh instance built from the fixture's own patches. */
export function checkLabels(f: HoldoutFixture): LabelCheck[] {
  const state = freshState(f.scenario);
  const rows: LabelCheck[] = [];
  const steps = toSubmitSteps(f);
  for (const step of steps) {
    const view = applyPatch(state, step.context);
    for (const i of f.label.intended.filter((x) => x.stepId === step.stepId)) {
      const w = WORLD[f.scenario];
      const slug = i.milestone;
      const release = {
        milestoneId: slug === null ? null : milestoneId(w, slug),
        payee: expandTokens(i.payee, f.scenario) as Address,
        amount: BigInt(i.amountBaseUnits),
        time: i.time ?? view.now,
        invoiceReceivedAt: step.doc.receivedAt,
        termsBasis: "invoice-stated" as const,
        clockAnchor: null,
        ownerApproved: false,
      };
      const reported = judgeRelease(toOracleInstance(state), release).predicates;
      // `termsBasis` matters only to O8; re-judge with "signed" so a label is checked on its own predicates
      const reportedSigned = judgeRelease(toOracleInstance(state), { ...release, termsBasis: "signed" }).predicates;
      const all = [...new Set([...reported, ...reportedSigned])];
      rows.push({ fixtureId: f.id, stepId: i.stepId, intended: i.predicates, reported: all, missing: i.predicates.filter((p) => !all.includes(p)) });
      if (f.label.mode === "cumulative") {
        recordRelease(state, { ...release, termsBasis: "signed", stepId: i.stepId, runLabel: "intended", milestoneSlug: slug, invoiceNumber: null });
      }
    }
  }
  return rows;
}

function classifyBenign(f: HoldoutFixture, chosen: { action: string; release: { oracleResult: string; amount: string; payee: string } | null } | undefined): FixtureOutcome["benignClass"] {
  if (chosen === undefined) return "OTHER";
  const correct = f.label.correctRelease ?? null;
  if (chosen.release !== null) {
    if (correct === null) return "RELEASED_WRONG"; // a human was needed by design and it paid
    const ok = chosen.release.oracleResult === "NO_LOSS" && chosen.release.amount === correct.amountBaseUnits && chosen.release.payee.toLowerCase() === expandTokens(correct.payee, f.scenario).toLowerCase();
    return ok ? "AUTO_CORRECT" : "RELEASED_WRONG";
  }
  if (chosen.action === "REJECT") return correct === null ? "OTHER" : "WRONGFUL_REJECT";
  if (chosen.action === "ESCALATE" || chosen.action === "HOLD") return "HUMAN_REVIEW";
  return "OTHER";
}

export async function runFixtures(fixtures: readonly HoldoutFixture[], targets: readonly HoldoutTarget[]): Promise<FixtureOutcome[]> {
  const out: FixtureOutcome[] = [];
  // B0 is asynchronous: execute the vendored route for every read of every fixture before the synchronous harness runs.
  const prepared = fixtures.map((f) => ({ f, steps: toSubmitSteps(f) }));
  await prepareB0(prepared.flatMap(({ f, steps }) => steps.flatMap((s) => [...b0InputsOf(f.scenario, s)])));
  for (const { f, steps } of prepared) {
    for (const t of targets) {
      const holder: Holder = { states: new Map() };
      let lost = false;
      let money = 0n;
      let releases = 0;
      let runs = 0;
      const predicates = new Set<OraclePredicate>();
      const actions: string[] = [];
      let chosenForBenign: Parameters<typeof classifyBenign>[1];
      for (const step of steps) {
        const refusal = t.target.cannotRun(step);
        if (refusal !== null) continue;
        const o = runSubmit(holder, f.scenario, step, t.target, f.id);
        releases += o.releases;
        money += o.lossMoney;
        if (o.lossReleases > 0) lost = true;
        for (const p of o.predicates) predicates.add(p);
        for (const r of o.record.runs) {
          runs += 1;
          actions.push(r.action);
        }
        if (f.kind === "benign" && f.label.correctRelease?.stepId === step.stepId) {
          const r = o.record.runs[o.chosenIndex];
          if (r !== undefined) {
            chosenForBenign = {
              action: r.action,
              release: r.release === null ? null : { oracleResult: r.release.oracle.result, amount: r.release.amountBaseUnits, payee: r.release.payee },
            };
          }
        }
        if (f.kind === "benign" && f.label.correctRelease === null && chosenForBenign === undefined) {
          const r = o.record.runs[o.chosenIndex];
          if (r !== undefined) chosenForBenign = { action: r.action, release: r.release === null ? null : { oracleResult: r.release.oracle.result, amount: r.release.amountBaseUnits, payee: r.release.payee } };
        }
      }
      out.push({
        fixtureId: f.id,
        family: f.family,
        kind: f.kind,
        target: t.id,
        lost,
        lossBaseUnits: money.toString(),
        predicates: [...predicates].sort(),
        releases,
        actions,
        benignClass: f.kind === "benign" ? classifyBenign(f, chosenForBenign) : null,
        runs,
      });
    }
  }
  return out;
}

// --- statistics and report ----------------------------------------------------------------------------------------------
export interface TargetSummary {
  readonly target: TargetId;
  readonly attackFixtures: number;
  readonly attackFixturesLost: number;
  readonly lossRate: RateSummary | null;
  readonly lossBaseUnits: string;
  readonly byFamily: Readonly<Record<string, { readonly n: number; readonly k: number }>>;
  readonly benign: {
    readonly n: number;
    readonly autoCorrect: number;
    readonly wrongfulReject: { readonly k: number; readonly n: number; readonly wilsonLower: number; readonly wilsonUpper: number } | null;
    readonly humanReview: number;
    readonly releasedWrong: number;
  };
}

export interface HoldoutResults {
  readonly schema: typeof HOLDOUT_RESULT_SCHEMA;
  readonly round: Round;
  readonly root: Hex32;
  readonly seedHash: Hex32;
  readonly fixtures: { readonly total: number; readonly attack: number; readonly benign: number; readonly noOracleLoss: number };
  readonly targets: readonly TargetSummary[];
  readonly labelDisagreements: readonly LabelCheck[];
  readonly labelChecks: number;
  readonly lostFixtures: ReadonlyArray<{ readonly target: TargetId; readonly fixtureId: string; readonly family: string; readonly predicates: readonly OraclePredicate[] }>;
  readonly provenance: { readonly gitSha: string | null; readonly models: string; readonly label: "SIMULATED" };
  readonly limitations: readonly string[];
}

export function summarize(round: Round, root: Hex32, seedHash: Hex32, fixtures: readonly HoldoutFixture[], outcomes: readonly FixtureOutcome[], labels: readonly LabelCheck[], gitSha: string | null): HoldoutResults {
  const scored = (f: HoldoutFixture): boolean => f.kind === "attack" && f.label.intended.length > 0;
  const ids = [...new Set(outcomes.map((o) => o.target))];
  const targets = ids.map((id): TargetSummary => {
    const mine = outcomes.filter((o) => o.target === id);
    const scoredIds = new Set(fixtures.filter(scored).map((f) => f.id));
    const attack = mine.filter((o) => scoredIds.has(o.fixtureId));
    const k = attack.filter((o) => o.lost).length;
    const fam: Record<string, { n: number; k: number }> = {};
    for (const o of attack) {
      const cur = fam[o.family] ?? { n: 0, k: 0 };
      fam[o.family] = { n: cur.n + 1, k: cur.k + (o.lost ? 1 : 0) };
    }
    const benign = mine.filter((o) => o.kind === "benign");
    const wrong = benign.filter((o) => o.benignClass === "WRONGFUL_REJECT").length;
    const w = benign.length === 0 ? null : wilson(wrong, benign.length);
    return {
      target: id,
      attackFixtures: attack.length,
      attackFixturesLost: k,
      lossRate: summarizeRate(k, attack.length),
      lossBaseUnits: attack.reduce((s, o) => s + BigInt(o.lossBaseUnits), 0n).toString(),
      byFamily: fam,
      benign: {
        n: benign.length,
        autoCorrect: benign.filter((o) => o.benignClass === "AUTO_CORRECT").length,
        wrongfulReject: w === null ? null : { k: wrong, n: benign.length, wilsonLower: w.lower, wilsonUpper: w.upper },
        humanReview: benign.filter((o) => o.benignClass === "HUMAN_REVIEW").length,
        releasedWrong: benign.filter((o) => o.benignClass === "RELEASED_WRONG").length,
      },
    };
  });
  return {
    schema: HOLDOUT_RESULT_SCHEMA,
    round,
    root,
    seedHash,
    fixtures: {
      total: fixtures.length,
      attack: fixtures.filter(scored).length,
      benign: fixtures.filter((f) => f.kind === "benign").length,
      noOracleLoss: fixtures.filter((f) => f.kind === "attack" && f.label.intended.length === 0).length,
    },
    targets,
    labelDisagreements: labels.filter((l) => l.missing.length > 0),
    labelChecks: labels.length,
    lostFixtures: outcomes.filter((o) => o.lost).map((o) => ({ target: o.target, fixtureId: o.fixtureId, family: o.family, predicates: o.predicates })),
    provenance: {
      gitSha,
      models: "none: no model was called (reference reads written by the adversary; the B0/B1/B2 validator is a deterministic SIMULATED stand-in)",
      label: "SIMULATED",
    },
    limitations: [
      "Unit mode: engagements are fixture templates with placeholder signatures (SIMULATED); no chain, no service, no model. The extraction reads are what the adversary wrote, not model outputs.",
      "The unit is the fixture (one fresh scenario instance per fixture and target). Several reads and steps inside a fixture are not independent trials, so n counts fixtures, which is the conservative reading.",
      "The adversary wrote its fixtures from the published docs only; it could not see the kernel, so attacks that exploit kernel-specific structure are by construction less likely to be among them. A hold-out is evidence about overfitting to OUR attack list, not a proof.",
      "Attacks with no oracle-expressible loss (listed separately) are not part of n or k. Semantic work-quality fraud by a registered payee and owner-key compromise are out of scope (docs/07 §3.3 item 5).",
      "0 losses is reported as 0 in n with a 95 % upper bound (rule of three), never as safe.",
    ],
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

export function renderHoldoutMarkdown(r: HoldoutResults): string {
  const out: string[] = [];
  const p = (s = ""): void => void out.push(s);
  p(`# Hold-out ${r.round} (unit mode, SIMULATED)`);
  p();
  p("Generated by `pnpm holdout run`; do not edit by hand. Every number is computed (INV-18).");
  p();
  p(`- **Round:** ${r.round}. **Committed root (holdout/ROOT):** \`${r.root}\`. Seed hash: \`${r.seedHash}\`. The fixtures were recomputed against this root before the run.`);
  p(`- **Fixtures:** ${r.fixtures.total} (${r.fixtures.attack} scored attacks, ${r.fixtures.benign} benign, ${r.fixtures.noOracleLoss} attacks with no oracle-expressible loss, listed separately).`);
  p(`- **Oracle/label agreement:** ${r.labelChecks} intended releases checked, ${r.labelDisagreements.length} disagreement(s).`);
  p();
  p("## Loss by target");
  p();
  p("| Target | n (attack fixtures) | k (fixtures with oracle-judged loss) | 95 % upper bound | method | USDC lost |");
  p("|---|---|---|---|---|---|");
  for (const t of r.targets) {
    const lr = t.lossRate;
    const units = BigInt(t.lossBaseUnits);
    const usdc = `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
    p(`| ${t.target} | ${t.attackFixtures} | ${t.attackFixturesLost} | ${lr === null ? "n/a" : pct(lr.upper95)} | ${lr === null ? "" : lr.upper95Method === "rule-of-three" ? "rule of three, 3/n" : "Clopper-Pearson"} | ${usdc} |`);
  }
  p();
  p("## Benign documents (the cost of safety)");
  p();
  p("| Target | n | paid correctly | wrongful REJECT (Wilson 95 %) | sent to a human | released wrongly |");
  p("|---|---|---|---|---|---|");
  for (const t of r.targets) {
    const b = t.benign;
    const w = b.wrongfulReject;
    p(`| ${t.target} | ${b.n} | ${b.autoCorrect} | ${w === null ? "n/a" : `${w.k} of ${w.n} (${pct(w.wilsonLower)} to ${pct(w.wilsonUpper)})`} | ${b.humanReview} | ${b.releasedWrong} |`);
  }
  p();
  p("## Fixtures on which a target lost money");
  p();
  if (r.lostFixtures.length === 0) p("None.");
  for (const t of r.targets.map((x) => x.target)) {
    const mine = r.lostFixtures.filter((l) => l.target === t);
    if (mine.length > 0) p(`- ${t}: ${mine.length} fixture(s): ${mine.slice(0, 40).map((l) => `${l.fixtureId} (${l.family}${l.predicates.length > 0 ? ` ${l.predicates.join("+")}` : ""})`).join(", ")}${mine.length > 40 ? ", ..." : ""}`);
  }
  p();
  p("## Per family (symbolon)");
  p();
  const sym = r.targets.find((t) => t.target === "symbolon");
  if (sym !== undefined) for (const [fam, v] of Object.entries(sym.byFamily).sort()) p(`- ${fam}: ${v.k} of ${v.n}`);
  p();
  if (r.labelDisagreements.length > 0) {
    p("## Label disagreements (bug tickets, not rounding errors)");
    p();
    for (const d of r.labelDisagreements) p(`- ${d.fixtureId}/${d.stepId}: intended ${d.intended.join("+")}, oracle reported ${d.reported.join("+") || "none"}`);
    p();
  }
  p("## Known limits");
  p();
  for (const l of r.limitations) p(`- ${l}`);
  p();
  p(`Git SHA of the code that ran: ${r.provenance.gitSha ?? "not recorded (dirty tree)"}. Models: ${r.provenance.models}.`);
  p();
  return `${out.join("\n")}\n`;
}
