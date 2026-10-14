// Boundary and branch tests for verify.ts added after the verifier mutation check (docs/16 §10 test 6): freshness
// boundary, diffJson shape handling, policy hash comparison, T1 recomputation switches, inconsistent state at the stated block.
import { loadPolicy } from "@symbolon/policy";
import { computeCertHash } from "@symbolon/schemas";
import type { LossBoundCertificate } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { buildFromReader } from "../../src/lbc/build";
import { parseTermsDocument } from "../../src/lbc/terms";
import { diffJson, verifyCertificate } from "../../src/lbc/verify";
import type { FieldDiff } from "../../src/lbc/verify";
import { FakeChain, T0, VAULT, chainWith, engagement, exampleState, h32, headerAt, makeState } from "./helpers/fake-chain";
import { policyText } from "./helpers/policy";

const GIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = T0 + 1000n;
const built = async (chain: FakeChain, extra: Record<string, unknown> = {}) => (await buildFromReader(chain, VAULT, { block: "latest", gitSha: GIT, nowSeconds: NOW, ...extra })).cert;
const rehash = (c: LossBoundCertificate): LossBoundCertificate => ({ ...c, certHash: computeCertHash(c) });

describe("freshness boundary", () => {
  it("exactly freshnessSeconds old is still fresh; one second more is STALE", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    chain.next({}, 86_400n); // block timestamp = asOf + 86400 + 2*0? next() adds the delta to the previous timestamp
    const ts = chain.blocks.get(101n)!.header.timestamp;
    const age = ts - BigInt(cert.asOf.timestamp);
    const at = (fresh: bigint) => verifyCertificate(cert, chain, { nowSeconds: 0n, freshnessSeconds: Number(fresh) });
    expect((await at(age)).outcome).toBe("VALID");
    expect((await at(age - 1n)).reasons).toEqual(["FRESHNESS_EXCEEDED"]);
  });
  it("a verifier clock ahead of the chain counts too (nowSeconds is used when it is later than the latest block)", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const age = 100_000n;
    expect((await verifyCertificate(cert, chain, { nowSeconds: BigInt(cert.asOf.timestamp) + age, freshnessSeconds: 86_400 })).reasons).toEqual(["FRESHNESS_EXCEEDED"]);
    expect((await verifyCertificate(cert, chain, { nowSeconds: BigInt(cert.asOf.timestamp) + 86_400n, freshnessSeconds: 86_400 })).outcome).toBe("VALID");
  });
});

describe("diffJson", () => {
  const run = (a: unknown, b: unknown, path = ""): FieldDiff[] => {
    const out: FieldDiff[] = [];
    diffJson(path, a, b, out);
    return out;
  };
  it("reports arrays that are longer or shorter on either side, element by element", () => {
    expect(run({ x: [1, 2] }, { x: [1, 2, 3] })).toEqual([{ path: "x[2]", document: "(absent)", recomputed: "3" }]);
    expect(run({ x: [1, 2, 3] }, { x: [1, 2] })).toEqual([{ path: "x[2]", document: "3", recomputed: "(absent)" }]);
    expect(run({ x: [1, 9] }, { x: [1, 2] })).toEqual([{ path: "x[1]", document: "9", recomputed: "2" }]);
  });
  it("reports missing and extra keys, sorted, with a root path of ''", () => {
    expect(run({ b: 1, a: 1 }, { a: 1, c: 2 })).toEqual([
      { path: "b", document: "1", recomputed: "(absent)" },
      { path: "c", document: "(absent)", recomputed: "2" },
    ]);
    expect(run({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([{ path: "a.b", document: "1", recomputed: "2" }]);
    expect(run({ a: 1 }, { a: 1 }, "p")).toEqual([]);
    expect(run({ a: 1 }, { a: 2 }, "p")).toEqual([{ path: "p.a", document: "1", recomputed: "2" }]);
  });
  it("a null is a value, not an object", () => {
    expect(run({ a: null }, { a: {} })).toHaveLength(1);
  });
});

describe("policyHash", () => {
  it("is compared only when the verifier supplies a policy: a different policy is MISMATCH, the same one is VALID", async () => {
    const chain = chainWith(exampleState());
    const used = loadPolicy(policyText("50.000000", "100.000000", "50.000000"));
    const other = loadPolicy(policyText("40.000000", "100.000000", "50.000000"));
    const cert = await built(chain, { policy: used });
    expect(cert.inputs.policyHash).toBe(used.policyHash);
    expect((await verifyCertificate(cert, chain, { nowSeconds: NOW })).outcome).toBe("VALID");
    expect((await verifyCertificate(cert, chain, { nowSeconds: NOW, policy: used })).outcome).toBe("VALID");
    const r = await verifyCertificate(cert, chain, { nowSeconds: NOW, policy: other });
    expect(r.outcome).toBe("MISMATCH");
    expect(r.diffs.map((d) => d.path)).toEqual(["inputs.policyHash"]);
  });
});

describe("T1 weak-evidence recomputation switches", () => {
  const eng = engagement("t1", { cap: 100_000_000n });
  const termsFor = (amount: string) =>
    parseTermsDocument({
      engagementId: eng.id,
      owner: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      payee: eng.payee,
      payeeLabel: "p",
      currency: "USDC",
      currencyDecimals: 6,
      cap: "100000000",
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T00:00:00Z",
      sequential: false,
      milestones: [{ milestoneId: h32("m"), slug: "m", description: "d", amountBaseUnits: amount, partialAllowed: false, immediate: false, dueDate: null, category: "c", evidenceSpec: [] }],
      paymentTerms: null,
      nonce: "1",
    })!;
  // The on-chain termsHash must equal the terms' hash for the figure to be a number; align the chain to the document.
  const withHash = (amount: string) => {
    const t = termsFor(amount);
    return { t, state: makeState({ balance: 500_000_000n, engagements: [{ ...eng, termsHash: t.termsHash }] }) };
  };
  it("a document that claims a number is recomputed when terms are supplied (edited number -> MISMATCH) and left alone without them", async () => {
    const { t, state: s } = withHash("60000000");
    const chain = chainWith(s);
    const cert = await built(chain, { terms: [t] });
    expect(cert.bounds.T1.weakEvidenceExposure).toBe("60000000");
    expect((await verifyCertificate(cert, chain, { nowSeconds: NOW, terms: [t] })).outcome).toBe("VALID");
    const forged = rehash({ ...cert, bounds: { ...cert.bounds, T1: { ...cert.bounds.T1, weakEvidenceExposure: "1" } } });
    expect((await verifyCertificate(forged, chain, { nowSeconds: NOW, terms: [t] })).outcome).toBe("MISMATCH");
    const noTerms = await verifyCertificate(forged, chain, { nowSeconds: NOW });
    expect(noTerms.outcome).toBe("VALID");
    expect(noTerms.findings.join("\n")).toContain("weakEvidenceExposure was not recomputed");
  });
  it("a document that says NOT_COMPUTED is never failed for it, even when the verifier has terms", async () => {
    const { t, state: s } = withHash("60000000");
    const chain = chainWith(s);
    const cert = await built(chain);
    expect(cert.bounds.T1.weakEvidenceExposure).toBe("NOT_COMPUTED");
    const r = await verifyCertificate(cert, chain, { nowSeconds: NOW, terms: [t] });
    expect(r.outcome).toBe("VALID");
    expect(r.findings.join("\n")).not.toContain("not recomputed");
  });
});

describe("state at the stated block", () => {
  it("whose configHash view disagrees with its getters -> UNVERIFIED CONFIG_HASH_INCONSISTENT (not RPC_ERROR)", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    chain.next({});
    chain.blocks.set(100n, { ...chain.blocks.get(100n)!, state: { ...exampleState(), blockNumber: 100n, configHash: h32("lie") } });
    const r = await verifyCertificate(cert, chain, { nowSeconds: NOW });
    expect(r.outcome).toBe("UNVERIFIED");
    expect(r.reasons).toEqual(["CONFIG_HASH_INCONSISTENT"]);
  });
  it("whose block header is not the certificate's timestamp -> MISMATCH on asOf.timestamp", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const odd = new FakeChain().push(100n, exampleState(), { ...headerAt(100n), timestamp: headerAt(100n).timestamp });
    const forged = rehash({ ...cert, asOf: { ...cert.asOf, timestamp: cert.asOf.timestamp + 5 } });
    const r = await verifyCertificate(forged, odd, { nowSeconds: NOW });
    expect(r.outcome).toBe("MISMATCH");
    expect(r.diffs.map((d) => d.path)).toContain("asOf.timestamp");
  });
});
