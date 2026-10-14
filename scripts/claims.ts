// `pnpm claims` (WP-28, INV-18, DEC-012): the only place a public number is produced.
// Reads committed result files, writes results/claims.json + results/claims.md, rewrites the README claims block and
// renders docs/claims-templates/*.tmpl.md ({{claim.id}} placeholders) into the public copy files.
// Nothing here calls a network; chain-derived claims (certificate, challenge stats) are NOT_COMPUTED unless a
// committed input exists. Money stays bigint (values are base-unit strings).
//
//   node --experimental-transform-types --import ./packages/blast-radius/scripts/register-ts.mjs scripts/claims.ts [--check]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ClaimLabel = "SIMULATED" | "RECORDED" | "LIVE" | "NOT_COMPUTED";

export interface Claim {
  id: string;
  label: ClaimLabel;
  /** Text that may be shown on a public surface. */
  display: string;
  /** Raw numbers behind the display (used by claims-lint to decide what is "sourced"). */
  numbers: string[];
  source: string;
  n?: number;
  k?: number;
  rule?: string;
  assumptions: string[];
  exclusions: string[];
}

export interface ClaimsDoc {
  schema: "claims/1";
  provenance: { gitSha: string; inputs: Record<string, string>; fixtureManifestSha256: string | null };
  claims: Record<string, Claim>;
  /** Flat set of every numeric token a public surface may print (claims-lint input). */
  allowedNumbers: string[];
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SIM_ASSUMPTIONS = [
  "unit mode: the real kernel-core pipeline in process; engagements are fixture templates with placeholder signatures",
  "no model was called; extraction reads are the fixtures' reference reads",
];
const SIM_EXCLUSIONS = [
  "no chain, service, or contract call is exercised; hold-out set not run; baselines B0 and B2 not built",
  "trials of one fixture are not independent",
];

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const nums = (...v: (number | string)[]): string[] => v.map(String);

export function computeClaims(root: string, gitSha: string): ClaimsDoc {
  const rd = (p: string): J => JSON.parse(readFileSync(join(root, p), "utf8")) as J;
  const matrix = rd("results/attack-matrix.json");
  const honest = rd("results/honest-corpus.json");
  const blast = rd("packages/blast-radius/results/blast-closed-form.json");
  const claims: Record<string, Claim> = {};
  const add = (c: Claim): void => {
    claims[c.id] = c;
  };
  const AM = "results/attack-matrix.json";
  const HC = "results/honest-corpus.json";

  const sym = (matrix.totals as J[]).find((t) => t.target === "symbolon")!;
  const b1 = (matrix.totals as J[]).find((t) => t.target === "b1")!;

  add({
    id: "atk.attacks",
    label: "SIMULATED",
    display: String(sym.attacks),
    numbers: nums(sym.attacks),
    source: AM,
    assumptions: SIM_ASSUMPTIONS,
    exclusions: SIM_EXCLUSIONS,
  });
  add({
    id: "atk.symbolon.loss_trials",
    label: "SIMULATED",
    display: `${sym.lossTrials} losses in ${sym.trials} trials`,
    numbers: nums(sym.lossTrials, sym.trials),
    source: AM,
    n: sym.trials,
    k: sym.lossTrials,
    rule: "oracle-v1",
    assumptions: SIM_ASSUMPTIONS,
    exclusions: SIM_EXCLUSIONS,
  });
  const upS = pct(sym.lossRate.upper95);
  add({
    id: "atk.symbolon.upper95",
    label: "SIMULATED",
    display: `${upS} (95% upper bound, ${sym.lossRate.upper95Method})`,
    numbers: nums(upS.replace("%", ""), upS),
    source: AM,
    n: sym.trials,
    k: sym.lossTrials,
    rule: sym.lossRate.upper95Method,
    assumptions: SIM_ASSUMPTIONS,
    exclusions: SIM_EXCLUSIONS,
  });
  const symLossAttacks = sym.oracleScored.loss + sym.signalScored.loss;
  add({
    id: "atk.symbolon.loss_attacks",
    label: "SIMULATED",
    display: `loss on ${symLossAttacks} of ${sym.applicable} applicable attacks`,
    numbers: nums(symLossAttacks, sym.applicable),
    source: AM,
    n: sym.applicable,
    k: symLossAttacks,
    assumptions: SIM_ASSUMPTIONS,
    exclusions: [...SIM_EXCLUSIONS, "attacks counted as loss on a failed stated criterion are included"],
  });
  add({
    id: "atk.b1.loss_attacks",
    label: "SIMULATED",
    display: `loss on ${b1.oracleScored.loss + b1.signalScored.loss} of ${b1.applicable} applicable attacks`,
    numbers: nums(b1.oracleScored.loss + b1.signalScored.loss, b1.applicable),
    source: AM,
    n: b1.applicable,
    k: b1.oracleScored.loss + b1.signalScored.loss,
    assumptions: ["B1 is a pattern reimplementation (ours), not Circle's code", "its validator is a deterministic SIMULATED stand-in for an LLM validator"],
    exclusions: SIM_EXCLUSIONS,
  });
  const upB = pct(b1.lossRate.upper95);
  add({
    id: "atk.b1.loss_trials",
    label: "SIMULATED",
    display: `${b1.lossTrials} losses in ${b1.trials} trials (95% upper bound ${upB}, ${b1.lossRate.upper95Method})`,
    numbers: nums(b1.lossTrials, b1.trials, upB.replace("%", ""), upB),
    source: AM,
    n: b1.trials,
    k: b1.lossTrials,
    rule: b1.lossRate.upper95Method,
    assumptions: ["B1 is a pattern reimplementation (ours), not Circle's code"],
    exclusions: SIM_EXCLUSIONS,
  });

  const hs = (honest.summaries as J[]).find((s) => s.target === "symbolon")!;
  const hb = (honest.summaries as J[]).find((s) => s.target === "b1")!;
  const HA = ["generated corpus of honest invoices written from our own templates (not real-world invoices)", ...SIM_ASSUMPTIONS];
  add({
    id: "honest.n",
    label: "SIMULATED",
    display: String(hs.n),
    numbers: nums(hs.n),
    source: HC,
    assumptions: HA,
    exclusions: ["says nothing about real pilot invoices"],
  });
  add({
    id: "honest.symbolon.auto_release",
    label: "SIMULATED",
    display: `${hs.autoRelease.k} of ${hs.autoRelease.n} auto-released`,
    numbers: nums(hs.autoRelease.k, hs.autoRelease.n),
    source: HC,
    n: hs.autoRelease.n,
    k: hs.autoRelease.k,
    assumptions: HA,
    exclusions: [`${hs.expectedHumanReview} invoices are expected to need a human by design`],
  });
  add({
    id: "honest.symbolon.escalation",
    label: "SIMULATED",
    display: `${hs.correctEscalation.k} of ${hs.correctEscalation.n} human-needed invoices correctly escalated`,
    numbers: nums(hs.correctEscalation.k, hs.correctEscalation.n),
    source: HC,
    n: hs.correctEscalation.n,
    k: hs.correctEscalation.k,
    assumptions: HA,
    exclusions: ["small n; the Wilson interval is wide"],
  });
  const wrU = pct(hs.wrongfulReject.wilsonUpper);
  add({
    id: "honest.symbolon.wrongful_reject",
    label: "SIMULATED",
    display: `${hs.wrongfulReject.k} of ${hs.wrongfulReject.n} wrongly rejected (95% Wilson upper bound ${wrU})`,
    numbers: nums(hs.wrongfulReject.k, hs.wrongfulReject.n, wrU.replace("%", ""), wrU),
    source: HC,
    n: hs.wrongfulReject.n,
    k: hs.wrongfulReject.k,
    rule: "wilson",
    assumptions: HA,
    exclusions: ["the cost of safety on real invoices is not measured here"],
  });
  add({
    id: "honest.b1.wrong_release",
    label: "SIMULATED",
    display: `${hb.wrongRelease.k} of ${hb.wrongRelease.n} wrong releases, ${hb.wrongfulReject.k} wrongful rejects`,
    numbers: nums(hb.wrongRelease.k, hb.wrongRelease.n, hb.wrongfulReject.k),
    source: HC,
    n: hb.wrongRelease.n,
    k: hb.wrongRelease.k,
    assumptions: ["B1 is a pattern reimplementation (ours)", ...HA],
    exclusions: [],
  });
  add({
    id: "llm.calls",
    label: "SIMULATED",
    display: `${honest.llm.calls} model calls`,
    numbers: nums(honest.llm.calls),
    source: HC,
    assumptions: ["no paid LLM run happened for any figure in this file"],
    exclusions: ["live model cost per invoice is NOT MEASURED"],
  });

  const c = blast.campaign as J;
  add({
    id: "blast.campaign",
    label: "SIMULATED",
    display: `closed form matched exhaustive enumeration: ${c.violations} violations in ${c.executedCases} executed cases (seed ${c.seed})`,
    numbers: nums(c.violations, c.executedCases, c.seed, c.runs, c.tightnessCases, c.tightnessMismatches),
    source: "packages/blast-radius/results/blast-closed-form.json",
    n: c.executedCases,
    k: c.violations,
    assumptions: (blast.limits as string[]).slice(),
    exclusions: ["does not execute the contract; validation against the real vault is the T3 simulator"],
  });

  add({
    id: "holdout",
    label: "NOT_COMPUTED",
    display: "hold-out not run",
    numbers: [],
    source: AM,
    assumptions: [],
    exclusions: [String(matrix.holdout?.reason ?? "not run")],
  });
  add({
    id: "certificate",
    label: "NOT_COMPUTED",
    display: "certificate not computed (no chain read in this build)",
    numbers: [],
    source: "none: needs an RPC and a deployed vault (pnpm lbc build)",
    assumptions: [],
    exclusions: ["no vault deployed from this repository state is certified"],
  });
  add({
    id: "challenge",
    label: "NOT_COMPUTED",
    display: "no challenge attempts recorded",
    numbers: [],
    source: "none: public_challenge_stats needs the deployed sandbox",
    assumptions: [],
    exclusions: ["challenge traffic is never traction (INV-17)"],
  });

  // Traction: rows of the committed pilot tracker only. Zero rows is a legitimate, honest answer.
  const trackerPath = join(root, "docs/pilots/pilot_tracker.csv");
  const lines = existsSync(trackerPath) ? readFileSync(trackerPath, "utf8").split(/\r?\n/).filter((l) => l.trim()) : [];
  const head = (lines[0] ?? "").split(",");
  const iPay = head.indexOf("real_payments");
  const iVal = head.indexOf("value_base_units");
  let payments = 0n;
  let value = 0n;
  const rows = lines.slice(1);
  for (const r of rows) {
    const f = r.split(",");
    if (iPay >= 0) payments += BigInt(f[iPay] || "0");
    if (iVal >= 0) value += BigInt(f[iVal] || "0");
  }
  add({
    id: "traction.pilot",
    label: "LIVE",
    display: `${rows.length} pilot rows, ${payments} real payments, ${value} base units moved`,
    numbers: nums(rows.length, String(payments), String(value)),
    source: "docs/pilots/pilot_tracker.csv",
    assumptions: ["tracker rows are Kevin-entered facts; demo and internal wallets are excluded by rule"],
    exclusions: ["attack and challenge traffic is not traction", "a zero is a zero: the project started at a spec and no users"],
  });

  const allowed = new Set<string>(["95"]); // the stated confidence level of the interval claims, not a result
  for (const cl of Object.values(claims)) for (const x of cl.numbers) allowed.add(x);
  return {
    schema: "claims/1",
    provenance: {
      gitSha,
      inputs: { attackMatrix: AM, honestCorpus: HC, blast: "packages/blast-radius/results/blast-closed-form.json", tracker: "docs/pilots/pilot_tracker.csv" },
      fixtureManifestSha256: (matrix.provenance?.fixtureManifestSha256 as string | undefined) ?? null,
    },
    claims,
    allowedNumbers: [...allowed].sort(),
  };
}

export function renderFragment(doc: ClaimsDoc): string {
  const g = (id: string): Claim => doc.claims[id]!;
  const row = (label: string, id: string, who: string): string => {
    const c = g(id);
    return `| ${who} | ${c.display} | ${c.label} |`;
  };
  void row;
  const out: string[] = [
    "| Measure | Result | Label |",
    "|---|---|---|",
    `| Warifu kernel, attack suite | ${g("atk.symbolon.loss_trials").display}; ${g("atk.symbolon.upper95").display}; ${g("atk.symbolon.loss_attacks").display} | SIMULATED |`,
    `| B1 naive pattern (ours) | ${g("atk.b1.loss_attacks").display}; ${g("atk.b1.loss_trials").display} | SIMULATED |`,
    `| Honest corpus, kernel | ${g("honest.symbolon.auto_release").display}; ${g("honest.symbolon.escalation").display}; ${g("honest.symbolon.wrongful_reject").display} | SIMULATED |`,
    `| Honest corpus, B1 | ${g("honest.b1.wrong_release").display} | SIMULATED |`,
    `| Closed form vs enumeration | ${g("blast.campaign").display} | SIMULATED |`,
    `| Hold-out | ${g("holdout").display} | NOT_COMPUTED |`,
    `| Loss Bound Certificate | ${g("certificate").display} | NOT_COMPUTED |`,
    `| Challenge | ${g("challenge").display} | NOT_COMPUTED |`,
    `| Traction | ${g("traction.pilot").display} | LIVE |`,
    `| Model calls behind any figure | ${g("llm.calls").display} | SIMULATED |`,
    "",
    "Assumptions: unit mode, the real kernel pipeline, fixture engagements with placeholder signatures, reference extraction reads (no model called). Exclusions: no chain or contract run, hold-out not run, B0 and B2 not built, trials of one fixture are not independent. Calculated from committed result files and empirically tested; not a proof. Source: `results/claims.json`.",
  ];
  return out.join("\n");
}

const BEGIN = "<!-- claims:begin -->";
const END = "<!-- claims:end -->";
export function replaceBlock(text: string, fragment: string): string {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error("README has no claims block");
  return `${text.slice(0, a + BEGIN.length)}\n${fragment}\n${text.slice(b)}`;
}

export function renderTemplate(tmpl: string, doc: ClaimsDoc): string {
  return tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, id: string) => {
    const c = doc.claims[id];
    if (!c) throw new Error(`template references unknown claim "${id}"`);
    return c.display;
  });
}

const TEMPLATES: Record<string, string> = {
  "video-script.tmpl.md": "docs/VIDEO_SCRIPT.md",
  "judge-copy.tmpl.md": "docs/JUDGE_COPY.md",
  "submission-form.tmpl.md": "docs/SUBMISSION_FORM_DRAFT.md",
};

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const doc = computeClaims(root, sha);
  writeFileSync(join(root, "results/claims.json"), JSON.stringify(doc, null, 2) + "\n");
  const frag = renderFragment(doc);
  writeFileSync(join(root, "results/claims.md"), `<!-- generated by scripts/claims.ts; do not edit -->\n${frag}\n`);
  const readme = join(root, "README.md");
  writeFileSync(readme, replaceBlock(readFileSync(readme, "utf8"), frag));
  const tdir = join(root, "docs/claims-templates");
  if (existsSync(tdir)) {
    for (const f of readdirSync(tdir)) {
      const out = TEMPLATES[f];
      if (!out) continue;
      const body = renderTemplate(readFileSync(join(tdir, f), "utf8"), doc);
      writeFileSync(join(root, out), `<!-- generated from docs/claims-templates/${f} by scripts/claims.ts; edit the template -->\n${body}`);
    }
  }
  console.log(`claims: ${Object.keys(doc.claims).length} claims written to results/claims.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
