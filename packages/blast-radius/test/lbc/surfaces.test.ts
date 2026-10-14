// Generated wording and optional inputs: headline sentence, view contract and claims lint (docs/16 §4.3, §10 test 7),
// T1 weak-evidence exposure and TERMS_UNVERIFIED (§2.3), validation block (§8), policy flag (docs/08 §4).
import { computeTermsHash, hashJcs } from "@symbolon/schemas";
import type { Engagement, EvidenceRequirement } from "@symbolon/schemas";
import { loadPolicy } from "@symbolon/policy";
import { describe, expect, it } from "vitest";
// The linter is a plain ESM script shared with CI (SEC/DOCS own it); we only call its exported functions.
// @ts-expect-error no declaration file for the .mjs linter
import { lintText } from "../../../../scripts/claims-lint.mjs";
import { assembleCertificate, buildFromReader } from "../../src/lbc/build";
import { ASSUMPTIONS, EXCLUSIONS, NOTE_BURST, NOTE_OWNER_APPROVALS, NOTE_POLICY_LOOSER, NOTE_TERMS_UNVERIFIED, NOTE_VALIDATION_NONE } from "../../src/lbc/texts";
import { classifyRequirement, computeWeakEvidenceExposure, parseTermsDocument } from "../../src/lbc/terms";
import { buildValidation, decimalCeil, decimalFloor, upper95 } from "../../src/lbc/validation";
import { VIEW_SECTION_ORDER, alarmedSentence, certificateView, headlineSentence, validationSentence } from "../../src/lbc/view";
import { LbcError } from "../../src/lbc/types";
import { OWNER, PAYEE, T0, USDC, VAULT, chainWith, engagement, exampleState, h32, headerAt, makeState } from "./helpers/fake-chain";

const GIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = T0 + 1000n;
const certOf = (state = exampleState(), extra: Record<string, unknown> = {}) =>
  assembleCertificate(state, headerAt(100n), { vault: VAULT, chainId: 31337n, gitSha: GIT, nowSeconds: NOW, ...extra }).cert;

describe("headline and view (generated, never typed)", () => {
  const cert = certOf();
  it("headline is the docs/16 §4.3 sentence with the computed 24 h bound and the block", () => {
    expect(headlineSentence(cert)).toBe(
      "If the AI and the kernel key are both compromised, at most $150.00 can leave in the first 24 h (calculated from on-chain state at block 100; assumptions and exclusions below).",
    );
  });
  it("the headline follows the numbers: change the state, the sentence changes", () => {
    const c2 = certOf(exampleState({ balance: 10n * USDC }));
    expect(headlineSentence(c2)).toContain("at most $10.00");
  });
  it("exclusions come first, then headline, status, horizons (with binding), assumptions, validation, verify command, diff", () => {
    expect(VIEW_SECTION_ORDER).toEqual(["exclusions", "headline", "status", "horizons", "assumptions", "validation", "verify", "diff"]);
    const v = certificateView(cert);
    expect(Object.keys(v).slice(0, 4)).toEqual(["order", "exclusions", "headline", "alarmed"]);
    expect(v.exclusions.length).toBe(EXCLUSIONS.length);
    expect(v.horizons[3]).toEqual({ label: "24h", seconds: 86400, valueBaseUnits: "150000000", valueDisplay: "$150.00", binding: ["engagements"] });
    expect(v.verifyCommand).toBe(`pnpm lbc verify ${VAULT} --rpc <your-own-rpc-url> --artifact <foundry-artifact.json>`);
    expect(v.diff).toEqual([]);
  });
  it("a STALE verification puts its diff in the panel; a VALID one does not", () => {
    const diffs = [{ path: "inputs.configHash", document: "a", recomputed: "b" }];
    expect(certificateView(cert, { outcome: "STALE", diffs }).diff).toEqual(diffs);
    expect(certificateView(cert, { outcome: "VALID", diffs }).diff).toEqual([]);
    expect(certificateView(cert, { outcome: "STALE", diffs }).status.label).toBe("STALE");
  });
  it("the alarmed figure is worded as conditional, never as the headline", () => {
    expect(alarmedSentence(cert)).toMatch(/^Assuming A-MON/);
    expect(headlineSentence(cert)).not.toMatch(/A-MON/);
  });
  it("without validation the certificate says it is not validated for this deployment", () => {
    expect(validationSentence(cert)).toMatch(/Not validated for this deployment/);
    expect(cert.notes).toContain(NOTE_VALIDATION_NONE);
  });
  it("the burst note appears exactly when there is no hourly cap and the 1 m bound equals the 24 h bound", () => {
    expect(cert.notes).toContain(NOTE_BURST);
    expect(certOf(exampleState({ hourlyCap: 10n * USDC })).notes).not.toContain(NOTE_BURST);
    expect(cert.notes).toContain(NOTE_OWNER_APPROVALS);
  });
});

describe("claims lint over every string the certificate emits (docs/16 §10 test 7)", () => {
  const cert = certOf();
  const validated = certOf(exampleState(), {
    validationResults: {
      schema: "symbolon-blast-validation/1",
      provenance: { gitSha: GIT, gitDirty: false, seeds: [1], modelIds: [], promptHashes: [], vaultRuntimeCodeHash: h32("code"), tools: {} },
      t3: { trials: 500, violations: 0, bestAttack24hBaseUnits: "150000000" },
      t1: { plans: 240, losses: 0 },
    },
  });
  const strings = (): string[] => {
    const v = certificateView(validated);
    return [
      v.headline,
      v.alarmed,
      v.validation.sentence,
      validationSentence(cert),
      ...ASSUMPTIONS.map((a) => a.text),
      ...EXCLUSIONS.map((e) => e.text),
      ...validated.notes,
      NOTE_POLICY_LOOSER,
      NOTE_TERMS_UNVERIFIED,
      NOTE_BURST,
    ];
  };
  it("passes the linter", () => {
    for (const s of strings()) expect(lintText(s), s).toEqual([]);
  });
  it("negative control: a seeded forbidden word fails it", () => {
    expect(lintText("The vault is provably safe").length).toBeGreaterThan(0);
    expect(lintText("fully audited and unhackable").length).toBeGreaterThan(0);
    expect(lintText(`${headlineSentence(cert)} This is guaranteed.`).length).toBeGreaterThan(0);
    expect(lintText("not audited; no guarantees").length).toBe(0);
  });
});

describe("validation block (docs/16 §3, §8)", () => {
  const prov = (hash: string | null) => ({ gitSha: GIT, gitDirty: false, seeds: [7], modelIds: [], promptHashes: [], vaultRuntimeCodeHash: hash, tools: {} });
  const file = (over: Record<string, unknown> = {}) => ({
    schema: "symbolon-blast-validation/1",
    provenance: prov(h32("code")),
    t3: { trials: 500, violations: 0, bestAttack24hBaseUnits: "150000000" },
    t1: { plans: 240, losses: 0 },
    ...over,
  });
  it("rule of three: 0 violations in 500 trials -> upper95 0.006; tightness best/bound = 1.0", () => {
    const b = buildValidation(file(), 150_000_000n, "NOT_CHECKED");
    expect(b.validation).toMatchObject({ t3Trials: 500, t3Violations: 0, upper95: "0.006", tightness: "1.0", t1Plans: 240, t1Losses: 0 });
    expect(b.validation?.codeMatch).toEqual({ status: "NOT_CHECKED", validatedCodeHash: h32("code"), gitSha: GIT });
  });
  it("rounding is conservative: upper95 rounds up, tightness rounds down", () => {
    expect(upper95(7, 0)).toBe("0.428571429");
    expect(decimalCeil(1n, 3n)).toBe("0.333333334");
    expect(decimalFloor(1n, 3n)).toBe("0.333333333");
    expect(decimalFloor(97n, 100n)).toBe("0.97");
  });
  it("violations observed or too few trials: no upper bound is claimed (1), never a smaller number", () => {
    expect(upper95(500, 2)).toBe("1");
    expect(upper95(3, 0)).toBe("1");
    expect(upper95(0, 0)).toBe("1");
  });
  it("results not attributed to bytecode -> validation null with a note (not validated for this deployment)", () => {
    const b = buildValidation(file({ provenance: prov(null) }), 150_000_000n, "NOT_CHECKED");
    expect(b.validation).toBeNull();
    expect(b.notes[0]).toMatch(/not validated for this deployment/);
  });
  it("a best attack above the bound refuses to build (the bound or the contract is wrong)", () => {
    expect(() => buildValidation(file({ t3: { trials: 500, violations: 0, bestAttack24hBaseUnits: "150000001" } }), 150_000_000n, "NOT_CHECKED")).toThrow(LbcError);
  });
  it("malformed results are refused, not partially used", () => {
    expect(() => buildValidation({ schema: "symbolon-blast-validation/1" }, 1n, "NOT_CHECKED")).toThrow(/VALIDATION_INVALID/);
    expect(() => buildValidation(file({ extra: 1 }), 1n, "NOT_CHECKED")).toThrow(/VALIDATION_INVALID/);
  });
  it("a bound of 0 with an attack of 0 is tightness 1.0", () => {
    expect(buildValidation(file({ t3: { trials: 10, violations: 0, bestAttack24hBaseUnits: "0" } }), 0n, "NOT_CHECKED").validation?.tightness).toBe("1.0");
  });
});

// --- T1 weak-evidence exposure --------------------------------------------------------------------------------------
const BASE_ENG = (milestones: { amount: string; spec: EvidenceRequirement[] }[], cap = "300000000"): Engagement => {
  const e: Engagement = {
    engagementId: h32("eng:wk"),
    tenantId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    owner: OWNER,
    payee: PAYEE,
    payeeLabel: "Acme",
    currency: "USDC",
    currencyDecimals: 6,
    capBaseUnits: cap,
    start: "2026-01-01T00:00:00Z",
    end: "2026-12-31T00:00:00Z",
    sequential: false,
    milestones: milestones.map((m, i) => ({ milestoneId: h32(`m${String(i)}`), slug: `m${String(i)}`, description: "d", amountBaseUnits: m.amount, partialAllowed: false, immediate: false, dueDate: null, category: "design", evidenceSpec: m.spec, status: "PENDING" })),
    paymentTerms: null,
    termsHash: h32("placeholder"),
    ownerSig: null,
    payeeSig: null,
    nonce: "1",
    status: "ACTIVE",
    registeredTx: null,
  };
  return { ...e, termsHash: computeTermsHash(e) };
};
const WEAK: EvidenceRequirement = { type: "URL_HEALTH", url: "https://example.com/ok", expectStatus: 200 };
const ACK: EvidenceRequirement = { type: "OWNER_ACK" };

describe("T1 weak-evidence exposure (docs/08 §4, docs/16 §2.3)", () => {
  it("classifies evidence strength", () => {
    expect(classifyRequirement(ACK)).toBe("STRONG");
    expect(classifyRequirement({ type: "CI_PASS", repo: "a/b", ref: "a".repeat(40) })).toBe("STRONG");
    expect(classifyRequirement({ type: "CI_PASS", repo: "a/b", ref: "main" })).toBe("MEDIUM");
    expect(classifyRequirement({ type: "ARTIFACT_HASH", sha256: h32("x") })).toBe("MEDIUM");
    expect(classifyRequirement(WEAK)).toBe("WEAK");
    expect(classifyRequirement({ ...WEAK, contentSha256: h32("body") } as EvidenceRequirement)).toBe("MEDIUM");
  });
  const eng = BASE_ENG([
    { amount: "100000000", spec: [WEAK] },
    { amount: "100000000", spec: [] },
    { amount: "100000000", spec: [WEAK, ACK] },
  ]);
  const onchain = (e: Engagement, over = {}) => engagement("wk", { id: e.engagementId, cap: BigInt(e.capBaseUnits), termsHash: e.termsHash, ...over });
  it("sums milestones whose evidence is only weak or empty; a weak requirement next to a strong one is not exposed", () => {
    const parsed = parseTermsDocument(eng)!;
    const r = computeWeakEvidenceExposure([onchain(eng)], [parsed]);
    expect(r.total).toBe(200_000_000n);
    expect(r.perEngagement[0]).toMatchObject({ status: "VERIFIED", exposure: 200_000_000n });
    expect(r.perEngagement[0]!.weakMilestones.map((m) => m.slug)).toEqual(["m0", "m1"]);
  });
  it("accepts the bare terms preimage too", () => {
    const pre = { engagementId: eng.engagementId, owner: eng.owner, payee: eng.payee, payeeLabel: eng.payeeLabel, currency: "USDC", currencyDecimals: 6, cap: eng.capBaseUnits, start: eng.start, end: eng.end, sequential: false, milestones: eng.milestones.map(({ status: _s, ...m }) => m), paymentTerms: null, nonce: "1" };
    const parsed = parseTermsDocument(pre)!;
    expect(parsed.termsHash).toBe(hashJcs(pre));
    expect(parsed.termsHash).toBe(eng.termsHash);
  });
  it("terms that do not hash to the on-chain termsHash are TERMS_UNVERIFIED and count as the FULL cap", () => {
    const parsed = parseTermsDocument(eng)!;
    const r = computeWeakEvidenceExposure([onchain(eng, { termsHash: h32("different") })], [parsed]);
    expect(r.perEngagement[0]).toMatchObject({ status: "TERMS_UNVERIFIED", exposure: 300_000_000n });
    expect(r.total).toBe(300_000_000n);
  });
  it("an engagement with no supplied terms is TERMS_UNVERIFIED (full cap); strangers are ignored", () => {
    const stranger = parseTermsDocument(BASE_ENG([{ amount: "1", spec: [WEAK] }], "1").milestones.length ? { ...BASE_ENG([{ amount: "1", spec: [WEAK] }], "1"), engagementId: h32("other") } : null);
    const r = computeWeakEvidenceExposure([onchain(eng)], stranger === null ? [] : [stranger]);
    expect(r.perEngagement[0]!.status).toBe("TERMS_UNVERIFIED");
  });
  it("exposure never exceeds the engagement cap", () => {
    const small = BASE_ENG([{ amount: "100000000", spec: [WEAK] }, { amount: "100000000", spec: [WEAK] }], "50000000");
    const r = computeWeakEvidenceExposure([onchain(small)], [parseTermsDocument(small)!]);
    expect(r.total).toBe(50_000_000n);
  });
  it("garbage is not a terms document", () => {
    expect(parseTermsDocument({ nope: 1 })).toBeNull();
    expect(parseTermsDocument(null)).toBeNull();
  });
  it("in a certificate: NOT_COMPUTED without terms, a number with them, never a lowered bound", () => {
    const state = makeState({ balance: 400n * USDC, engagements: [onchain(eng)] });
    const without = certOf(state);
    expect(without.bounds.T1.weakEvidenceExposure).toBe("NOT_COMPUTED");
    const withTerms = certOf(state, { terms: [parseTermsDocument(eng)!] });
    expect(withTerms.bounds.T1.weakEvidenceExposure).toBe("200000000");
    expect(withTerms.bounds.T3c).toEqual(without.bounds.T3c);
    const bad = certOf(state, { terms: [] });
    expect(bad.bounds.T1.weakEvidenceExposure).toBe("300000000");
    expect(bad.notes).toContain(NOTE_TERMS_UNVERIFIED);
  });
});

describe("policy flag (docs/08 §4)", () => {
  // docs/04 section 7 example with the three caps parameterised (the rest is the spec text).
  const policyText = (perTx: string, daily: string, human: string) => `version: 1
tenant: edith-studio
currency: { code: USDC, decimals: 6, treatUsdAsUsdc: true }
caps:
  perTxHardCap: "${perTx}"
  dailyCap: "${daily}"
  weeklyCap: "1400.000000"
  humanApprovalAbove: "${human}"
velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "150.000000" }
newPayee: { firstPaymentMax: "25.000000", alwaysHuman: true }
categories: { design: "150.000000", dev: "300.000000", tools: "100.000000" }
reserve: { floor: "10.000000", lookaheadDays: 14 }
timing: { disputeWindowHours: 0, payBeforeDueBufferHours: 24, allowImmediate: true, defaultNetDays: 30, windowSafetyMarginMinutes: 60 }
treasury: { costOfCapitalBps: 0 }
escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 }
limits: { maxDocChars: 20000 }
evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://*.vercel.app"] }
extraction: { allowSingle: false }
screening: { required: false, staleAfterHours: 24 }
reconciliation: { ackWindowHours: 72 }
`;
  it("is skipped silently when no policy is given (policyHash null)", () => {
    expect(certOf().inputs.policyHash).toBeNull();
  });
  it("a policy within the vault: policyHash recorded, no flag; looser than the vault: POLICY_LOOSER_THAN_VAULT note, never silently ignored", () => {
    const loaded = loadPolicy(policyText("50.000000", "100.000000", "50.000000"));
    const ok = certOf(exampleState(), { policy: loaded });
    expect(ok.inputs.policyHash).toBe(loaded.policyHash);
    const looser = loadPolicy(policyText("500.000000", "900.000000", "400.000000"));
    const flagged = certOf(exampleState(), { policy: looser });
    expect(flagged.notes.some((n) => n.startsWith("POLICY_LOOSER_THAN_VAULT"))).toBe(true);
    expect(flagged.bounds.T3c).toEqual(certOf().bounds.T3c);
  });
});

describe("built through a reader the same way (smoke)", () => {
  it("buildFromReader == assembleCertificate for the same state", async () => {
    const chain = chainWith(exampleState());
    const { cert } = await buildFromReader(chain, VAULT, { block: "latest", gitSha: GIT, nowSeconds: NOW });
    const direct = certOf();
    expect(cert.certHash).toBe(direct.certHash);
  });
});
