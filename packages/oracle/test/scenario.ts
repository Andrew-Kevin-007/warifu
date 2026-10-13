// Test scenario for the oracle: built from @symbolon/schemas only (the oracle may import nothing else).
// Two milestones: "design" (10.000000 USDC, exact, owner-ack evidence) and "build" (18.000000 USDC, partial
// allowed, CI evidence); optional 2/10 net 30 signed terms.
import { ChallengeScenarioSchema, computeTermsHash, deriveEntityId, deriveMilestoneId, keccak256Utf8 } from "@symbolon/schemas";
import type { Address, ChallengeScenario, EvidenceFixture, Hex32, Milestone, PaymentTerms } from "@symbolon/schemas";
import type { OracleInstance, OracleLimits, OracleRelease } from "../src/index";

function checksum(lower40: string): string {
  const h = keccak256Utf8(lower40).slice(2);
  return [...lower40].map((ch, i) => (parseInt(h.charAt(i), 16) >= 8 ? ch.toUpperCase() : ch)).join("");
}
export const addr = (label: string): Address => `0x${checksum(keccak256Utf8(`oracle-test/${label}`).slice(-40))}`;

export const USDC = (whole: number, cents = 0): bigint => BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n;

export const TENANT = "11111111-1111-4111-8111-111111111111";
export const PAYEE = addr("payee");
export const ATTACKER = addr("attacker");
export const OWNER = addr("owner");
export const START = "2026-10-01T00:00:00Z";
export const END = "2026-12-31T23:59:59Z";
export const NOW = "2026-11-02T09:00:00Z";
export const RECEIVED = "2026-11-02T08:00:00Z";
export const TERMS_2_10: PaymentTerms = { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 24, allowImmediate: true };
export const NO_TERMS: PaymentTerms = { netDays: 30, earlyPay: null, payBeforeDueBufferHours: 24, allowImmediate: true };

export const M_DESIGN: Hex32 = deriveMilestoneId({ tenantId: TENANT, uuid: "21111111-1111-4111-8111-111111111111" });
export const M_BUILD: Hex32 = deriveMilestoneId({ tenantId: TENANT, uuid: "22222222-2222-4222-8222-222222222222" });
const CI = { type: "CI_PASS", repo: "fixtures/site", ref: "a".repeat(40), workflow: "ci.yml" } as const;

export const LIMITS: OracleLimits = {
  perTxCap: USDC(25),
  dailyCap: USDC(60),
  weeklyCap: USDC(200),
  humanApprovalAbove: USDC(20),
  maxReleasesPerDay: 10,
  maxReleasesPerPayeePerDay: 3,
  maxAmountPerPayeePerDay: USDC(60),
  categoryBudgets: { design: USDC(150), dev: USDC(100) },
};

export function scenario(terms: PaymentTerms = NO_TERMS): ChallengeScenario {
  const milestones: Milestone[] = [
    { milestoneId: M_DESIGN, slug: "design", description: "design", amountBaseUnits: USDC(10).toString(), partialAllowed: false, immediate: false, dueDate: null, category: "design", evidenceSpec: [{ type: "OWNER_ACK" }], status: "PENDING" },
    { milestoneId: M_BUILD, slug: "build", description: "build", amountBaseUnits: USDC(18).toString(), partialAllowed: true, immediate: false, dueDate: null, category: "dev", evidenceSpec: [CI], status: "PENDING" },
  ];
  const base = {
    engagementId: deriveEntityId({ tenantId: TENANT, slug: "oracle-test" }),
    owner: OWNER,
    payee: PAYEE,
    payeeLabel: "Acme",
    currency: "USDC" as const,
    currencyDecimals: 6,
    capBaseUnits: USDC(28).toString(),
    start: START,
    end: END,
    sequential: false,
    milestones,
    paymentTerms: terms,
    nonce: "1",
  };
  return ChallengeScenarioSchema.parse({
    scenarioId: "S-A",
    title: "oracle test",
    engagement: { ...base, tenantId: TENANT, termsHash: computeTermsHash(base), ownerSig: null, payeeSig: null, status: "DRAFT", registeredTx: null },
    milestones,
    paymentTerms: terms,
    policy: {},
    clock: { mode: "fixed", start: NOW },
    evidenceFixtures: [],
    groundTruth: {
      legitPayee: PAYEE,
      legitAmountByMilestone: { [M_DESIGN]: USDC(10).toString(), [M_BUILD]: USDC(18).toString() },
      allowedWindow: { start: START, end: END },
    },
    oracleVersion: "oracle-v1",
  });
}

export function evidenceFor(milestoneId: Hex32, result: "PASS" | "FAIL" = "PASS"): EvidenceFixture[] {
  const req = milestoneId === M_DESIGN ? ({ type: "OWNER_ACK" } as const) : CI;
  return [{ fixtureId: `fx-${milestoneId.slice(2, 8)}`, milestoneId, requirement: req, result, payload: {}, details: "fixture", availableAt: null }];
}

export function instance(over: Partial<OracleInstance> = {}, terms: PaymentTerms = NO_TERMS): OracleInstance {
  return {
    scenario: scenario(terms),
    limits: LIMITS,
    releases: [],
    milestonePaid: [],
    categorySpentBaseline: {},
    evidence: [...evidenceFor(M_DESIGN), ...evidenceFor(M_BUILD)],
    breakerHalted: false,
    vaultPaused: false,
    ...over,
  };
}

/** A correct release of the design milestone (10 USDC at NOW, no discount: signed terms have none). */
export function honest(over: Partial<OracleRelease> = {}): OracleRelease {
  return {
    milestoneId: M_DESIGN,
    payee: PAYEE,
    amount: USDC(10),
    time: NOW,
    invoiceReceivedAt: RECEIVED,
    termsBasis: "signed",
    clockAnchor: RECEIVED,
    ownerApproved: false,
    ...over,
  };
}
