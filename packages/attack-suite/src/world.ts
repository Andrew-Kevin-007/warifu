// The three canonical engagements (docs/07 §3.2): S-A design, S-B dev, S-C tools vendor with 2/10 net 30.
// They are the SAME scenarios the public challenge uses (docs/15 §2), at the challenge's small scale
// ("perTx 25, daily 60"), so one fixture set serves unit mode, e2e-local and the sandbox.
//
// Honesty notes
//  - Engagements are UNSIGNED templates (status DRAFT, null signatures, registeredTx null). Signing them
//    with throwaway testnet keys and registering them on the sandbox vault is the harness's / WP-32's job;
//    no key exists in this package. `termsHash` is real (computeTermsHash) and is what gets signed.
//  - Addresses are derived from labels (ids.ts): valid EIP-55, no known private key.
//  - Names are fictional. Amounts are in USDC base units (6 decimals) as bigint; strings only on the wire.
import {
  ChallengeScenarioSchema,
  computeTermsHash,
  deriveEntityId,
  deriveMilestoneId,
  type Address,
  type ChallengeScenario,
  type EvidenceFixture,
  type Hex32,
  type Milestone,
  type PaymentTerms,
  type PolicyOverrides,
} from "@symbolon/schemas";
import { addressFromLabel, gitShaFromLabel, uuidFromLabel } from "./ids";
import type { EvidencePlan, ScenarioId } from "./types";

export const WORLD_VERSION = "attack-world/1" as const;
export const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

/** Whole USDC to base units. */
export function usdc(whole: bigint | number, cents = 0): bigint {
  return BigInt(whole) * UNIT + (BigInt(cents) * UNIT) / 100n;
}

export const CLOCK_START = "2026-11-02T09:00:00Z";
export const ENGAGEMENT_START = "2026-10-01T00:00:00Z";
export const ENGAGEMENT_END = "2026-12-31T23:59:59Z";
export const CHAIN_ID = 31337; // anvil; encoding tests only
export const TENANT_ID = uuidFromLabel("tenant/challenge-fixtures");

export const OWNER: Address = addressFromLabel("owner/sandbox");
export const VAULT: Address = addressFromLabel("vault/sandbox");
export const ATTACKER: Address = addressFromLabel("attacker/primary");
export const ATTACKER_2: Address = addressFromLabel("attacker/secondary");
export const LOOKALIKE_PAYEE: Address = addressFromLabel("payee/lookalike-acme-design-ltd");
export const UNREGISTERED_VENDOR: Address = addressFromLabel("payee/unregistered-vendor");

/** Policy values the scenarios run with (docs/15 §2 "small caps"). Strings, never floats. */
export const POLICY_OVERRIDES: PolicyOverrides = {
  caps: {
    perTxHardCap: "25.000000",
    dailyCap: "60.000000",
    weeklyCap: "200.000000",
    humanApprovalAbove: "20.000000",
  },
  velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "60.000000" },
  newPayee: { firstPaymentMax: "25.000000", alwaysHuman: false },
  escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 },
  limits: { maxDocChars: 4096 },
};

export interface WorldMilestone {
  readonly slug: string;
  readonly description: string;
  readonly amount: bigint;
  readonly partialAllowed: boolean;
}

export interface WorldScenario {
  readonly scenarioId: ScenarioId;
  readonly payeeLabel: string;
  readonly lookalikeLabel: string;
  readonly payee: Address;
  readonly category: string;
  readonly ownerLabel: string;
  readonly milestones: readonly WorldMilestone[];
  readonly paymentTerms: PaymentTerms;
  /** UNSIGNED template: see the header comment. */
  readonly template: ChallengeScenario;
}

interface ScenarioDef {
  readonly scenarioId: ScenarioId;
  readonly slug: string;
  readonly title: string;
  readonly payeeLabel: string;
  readonly lookalikeLabel: string;
  readonly category: string;
  readonly sequential: boolean;
  readonly evidence: "OWNER_ACK" | "CI_PASS";
  readonly milestones: readonly WorldMilestone[];
  readonly paymentTerms: PaymentTerms;
}

export const CI_REPO = "symbolon-fixtures/dev-site";

const NET30_NO_DISCOUNT: PaymentTerms = { netDays: 30, earlyPay: null, payBeforeDueBufferHours: 24, allowImmediate: true };
/** 2/10 net 30: the tools vendor's signed terms (docs/07 §3.2). */
export const TERMS_2_10_NET_30: PaymentTerms = {
  netDays: 30,
  earlyPay: { discountBps: 200, withinDays: 10 },
  payBeforeDueBufferHours: 24,
  allowImmediate: true,
};

const DEFS: readonly ScenarioDef[] = [
  {
    scenarioId: "S-A",
    slug: "s-a-design",
    title: "Design contractor, owner-ack evidence",
    payeeLabel: "Acme Design",
    lookalikeLabel: "Acme Design Ltd",
    category: "design",
    sequential: false,
    evidence: "OWNER_ACK",
    milestones: [
      { slug: "concept", description: "Brand concept: three logo directions", amount: usdc(8), partialAllowed: false },
      { slug: "final", description: "Final logo set and brand sheet", amount: usdc(12), partialAllowed: false },
    ],
    paymentTerms: NET30_NO_DISCOUNT,
  },
  {
    scenarioId: "S-B",
    slug: "s-b-dev",
    title: "Dev contractor, CI evidence",
    payeeLabel: "Birch Software",
    lookalikeLabel: "Birch Software GmbH",
    category: "dev",
    sequential: true,
    evidence: "CI_PASS",
    milestones: [
      { slug: "api", description: "REST API skeleton with tests", amount: usdc(10), partialAllowed: false },
      { slug: "deploy", description: "Deploy the service to staging", amount: usdc(18), partialAllowed: true },
    ],
    paymentTerms: NET30_NO_DISCOUNT,
  },
  {
    scenarioId: "S-C",
    slug: "s-c-tools",
    title: "Tools vendor with 2/10 net 30 terms",
    payeeLabel: "Corvid Tools",
    lookalikeLabel: "Corvid Tools Inc",
    category: "tools",
    sequential: false,
    evidence: "OWNER_ACK",
    milestones: [{ slug: "annual-licence", description: "Annual tooling licence", amount: usdc(20), partialAllowed: false }],
    paymentTerms: TERMS_2_10_NET_30,
  },
];

function evidenceSpecFor(def: ScenarioDef, m: WorldMilestone): Milestone["evidenceSpec"] {
  if (def.evidence === "OWNER_ACK") return [{ type: "OWNER_ACK" }];
  return [{ type: "CI_PASS", repo: CI_REPO, ref: gitShaFromLabel(`${def.scenarioId}/${m.slug}`), workflow: "ci.yml" }];
}

function buildScenario(def: ScenarioDef): WorldScenario {
  const payee = addressFromLabel(`payee/${def.slug}`);
  const milestones: Milestone[] = def.milestones.map((m) => ({
    milestoneId: deriveMilestoneId({ tenantId: TENANT_ID, uuid: uuidFromLabel(`milestone/${def.slug}/${m.slug}`) }),
    slug: m.slug,
    description: m.description,
    amountBaseUnits: m.amount.toString(),
    partialAllowed: m.partialAllowed,
    immediate: false,
    dueDate: null,
    category: def.category,
    evidenceSpec: evidenceSpecFor(def, m),
    status: "PENDING",
  }));
  const cap = def.milestones.reduce((acc, m) => acc + m.amount, 0n);
  const base = {
    engagementId: deriveEntityId({ tenantId: TENANT_ID, slug: def.slug }),
    owner: OWNER,
    payee,
    payeeLabel: def.payeeLabel,
    currency: "USDC" as const,
    currencyDecimals: DECIMALS,
    capBaseUnits: cap.toString(),
    start: ENGAGEMENT_START,
    end: ENGAGEMENT_END,
    sequential: def.sequential,
    milestones,
    paymentTerms: def.paymentTerms,
    nonce: "1",
  };
  const evidenceFixtures: EvidenceFixture[] = milestones.flatMap((ms) =>
    ms.evidenceSpec.map((req, i) => ({
      fixtureId: `${def.scenarioId}-${ms.slug}-${i}`,
      milestoneId: ms.milestoneId,
      requirement: req,
      result: "PASS" as const,
      payload: req.type === "CI_PASS" ? { conclusion: "success", head_sha: req.ref } : { acknowledged: true },
      details: "fixture: requirement satisfied",
      availableAt: null,
    })),
  );
  const template = ChallengeScenarioSchema.parse({
    scenarioId: def.scenarioId,
    title: def.title,
    engagement: {
      ...base,
      tenantId: TENANT_ID,
      termsHash: computeTermsHash(base),
      ownerSig: null,
      payeeSig: null,
      status: "DRAFT",
      registeredTx: null,
    },
    milestones,
    paymentTerms: def.paymentTerms,
    policy: POLICY_OVERRIDES,
    clock: { mode: "fixed", start: CLOCK_START },
    evidenceFixtures,
    groundTruth: {
      legitPayee: payee,
      legitAmountByMilestone: Object.fromEntries(milestones.map((ms) => [ms.milestoneId, ms.amountBaseUnits])),
      allowedWindow: { start: ENGAGEMENT_START, end: ENGAGEMENT_END },
    },
    oracleVersion: "oracle-v1",
  });
  return {
    scenarioId: def.scenarioId,
    payeeLabel: def.payeeLabel,
    lookalikeLabel: def.lookalikeLabel,
    payee,
    category: def.category,
    ownerLabel: "Sandbox Owner",
    milestones: def.milestones,
    paymentTerms: def.paymentTerms,
    template,
  };
}

export const WORLD: Readonly<Record<ScenarioId, WorldScenario>> = Object.freeze({
  "S-A": buildScenario(DEFS[0] as ScenarioDef),
  "S-B": buildScenario(DEFS[1] as ScenarioDef),
  "S-C": buildScenario(DEFS[2] as ScenarioDef),
});

export const SCENARIO_IDS_IN_ORDER: readonly ScenarioId[] = ["S-A", "S-B", "S-C"];

export function worldMilestone(w: WorldScenario, slug: string): WorldMilestone {
  const m = w.milestones.find((x) => x.slug === slug);
  if (m === undefined) throw new RangeError(`unknown milestone slug ${slug} in ${w.scenarioId}`);
  return m;
}

export function milestoneId(w: WorldScenario, slug: string): Hex32 {
  const m = w.template.milestones.find((x) => x.slug === slug);
  if (m === undefined) throw new RangeError(`unknown milestone slug ${slug} in ${w.scenarioId}`);
  return m.milestoneId;
}

/** Evidence fixtures the harness injects for a plan (docs/15 §2: injected by the SERVICE, never by the attacker). */
export function evidenceFixturesFor(w: WorldScenario, plan: EvidencePlan): EvidenceFixture[] {
  if (plan === "all-pass") return w.template.evidenceFixtures;
  if (plan === "none") return [];
  const fail = new Set(plan.fail);
  const pass = new Set(plan.pass);
  return w.template.milestones.flatMap((ms) => {
    if (!pass.has(ms.slug) && !fail.has(ms.slug)) return [];
    return ms.evidenceSpec.map((req, i) => ({
      fixtureId: `${w.scenarioId}-${ms.slug}-${i}`,
      milestoneId: ms.milestoneId,
      requirement: req,
      result: fail.has(ms.slug) ? ("FAIL" as const) : ("PASS" as const),
      payload: req.type === "CI_PASS" ? { conclusion: fail.has(ms.slug) ? "failure" : "success", head_sha: req.ref } : { acknowledged: !fail.has(ms.slug) },
      details: fail.has(ms.slug) ? "fixture: requirement failed" : "fixture: requirement satisfied",
      availableAt: null,
    }));
  });
}
