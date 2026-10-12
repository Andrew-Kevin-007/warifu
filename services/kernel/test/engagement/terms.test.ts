// WP-12 pure tests: the draft builder and the typed data the parties sign. No database, no chain.
import { computeTermsHash, deriveEntityId, eip712Digest, epochSecondsFromIso, symbolonDomain } from "@symbolon/schemas";
import { getAddress, hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CreateEngagementBodySchema, SignBodySchema, TermsError, buildDraft, engagementDigest, engagementTermsMessage, engagementTypedData } from "../../src/engagement/terms";
import type { CreateEngagementBody } from "../../src/engagement/terms";

const TENANT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OWNER = getAddress("0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB");
const PAYEE = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
const VAULT = getAddress("0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb");
const UUIDS = ["6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", "7a2d3e4f-5b6c-4d7e-9f80-1b2c3d4e5f60"];

const body = (over: Record<string, unknown> = {}): CreateEngagementBody =>
  CreateEngagementBodySchema.parse({
    slug: "edith-site",
    owner: OWNER,
    payee: PAYEE,
    payeeLabel: "Acme Design",
    capBaseUnits: "100000000",
    start: "2026-10-01T00:00:00Z",
    end: "2026-12-31T00:00:00Z",
    sequential: false,
    milestones: [
      { slug: "design", uuid: UUIDS[0], description: "Design", amountBaseUnits: "10000000", partialAllowed: false, immediate: false, dueDate: null, category: "design", evidenceSpec: [{ type: "OWNER_ACK" }] },
    ],
    paymentTerms: { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: false },
    ...over,
  });

let n = 0;
const ctx = { tenantId: TENANT, tenantOwner: OWNER, vault: VAULT, currencyDecimals: 6, newUuid: () => UUIDS[(n++) % 2] as string };

describe("buildDraft", () => {
  it("derives the engagement id and computes the termsHash itself", () => {
    const e = buildDraft(body(), ctx);
    expect(e.engagementId).toBe(deriveEntityId({ tenantId: TENANT, slug: "edith-site" }));
    expect(e.termsHash).toBe(computeTermsHash(e));
    expect(e.status).toBe("DRAFT");
    expect(e.ownerSig).toBeNull();
    expect(e.payeeSig).toBeNull();
    expect(e.registeredTx).toBeNull();
    expect(e.nonce).toBe("1");
    expect(e.currencyDecimals).toBe(6);
  });

  it("is deterministic for the same request (idempotent create)", () => {
    expect(buildDraft(body(), ctx)).toEqual(buildDraft(body(), ctx));
  });

  it("refuses a request that carries a termsHash, status or signature of its own (strict schema)", () => {
    for (const extra of [{ termsHash: `0x${"11".repeat(32)}` }, { status: "ACTIVE" }, { ownerSig: "0x11" }, { nonce: "9" }, { currencyDecimals: 18 }, { tenantId: TENANT }]) {
      expect(CreateEngagementBodySchema.safeParse({ ...body(), ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("requires exactly one of slug or uuid", () => {
    expect(CreateEngagementBodySchema.safeParse({ ...body(), slug: undefined }).success).toBe(false);
    expect(CreateEngagementBodySchema.safeParse({ ...body(), uuid: UUIDS[1] }).success).toBe(false);
    expect(buildDraft(body({ slug: undefined, uuid: UUIDS[1] }), ctx).engagementId).toBe(deriveEntityId({ tenantId: TENANT, uuid: UUIDS[1] as string }));
  });

  it("refuses an owner that is not the tenant's vault owner", () => {
    const other = getAddress("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
    expect(() => buildDraft(body({ owner: other }), ctx)).toThrow(TermsError);
  });

  it.each([
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["the owner", OWNER],
    ["the vault", VAULT],
  ])("refuses a payee that is %s", (_n, payee) => {
    expect(() => buildDraft(body({ payee }), ctx)).toThrow(/payee/);
  });

  it("refuses a zero cap and an inverted window", () => {
    expect(() => buildDraft(body({ capBaseUnits: "0" }), ctx)).toThrow(/cap/);
    expect(() => buildDraft(body({ start: "2026-12-31T00:00:00Z", end: "2026-10-01T00:00:00Z" }), ctx)).toThrow(/start/);
  });

  it("refuses a non-checksummed address (one spelling per address inside the hash)", () => {
    expect(CreateEngagementBodySchema.safeParse({ ...body(), payee: PAYEE.toLowerCase() }).success).toBe(false);
  });

  it("changing any signed term changes the termsHash", () => {
    const a = buildDraft(body(), ctx).termsHash;
    for (const over of [
      { payeeLabel: "Other" },
      { capBaseUnits: "100000001" },
      { sequential: true },
      { end: "2026-12-31T00:00:01Z" },
      { paymentTerms: null },
      { paymentTerms: { netDays: 31, earlyPay: null, payBeforeDueBufferHours: 0, allowImmediate: false } },
    ]) {
      expect(buildDraft(body(over), ctx).termsHash, JSON.stringify(over)).not.toBe(a);
    }
  });
});

describe("typed data", () => {
  const e = buildDraft(body(), ctx);

  it("is the EngagementTerms struct of docs/05 over the stored terms, in the vault's domain", () => {
    const td = engagementTypedData(e, 31337, VAULT);
    expect(td.domain).toEqual(symbolonDomain(31337, VAULT));
    expect(td.message).toEqual({
      engagementId: e.engagementId,
      owner: OWNER,
      payee: PAYEE,
      cap: "100000000",
      start: epochSecondsFromIso(e.start).toString(),
      end: epochSecondsFromIso(e.end).toString(),
      termsHash: e.termsHash,
      nonce: "1",
    });
    expect(engagementTermsMessage(e).termsHash).toBe(computeTermsHash(e));
  });

  it("digest equals an independent viem hashTypedData computation", () => {
    const m = engagementTermsMessage(e);
    const independent = hashTypedData({
      domain: { name: "SymbolonVault", version: "1", chainId: 31337n, verifyingContract: VAULT },
      types: {
        EngagementTerms: [
          { name: "engagementId", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "payee", type: "address" },
          { name: "cap", type: "uint256" },
          { name: "start", type: "uint64" },
          { name: "end", type: "uint64" },
          { name: "termsHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "EngagementTerms",
      message: { ...m, cap: BigInt(m.cap), start: BigInt(m.start), end: BigInt(m.end), nonce: BigInt(m.nonce) },
    });
    expect(engagementDigest(e, 31337, VAULT)).toBe(independent);
    expect(eip712Digest(engagementTypedData(e, 31337, VAULT))).toBe(independent);
  });

  it("a different chain id or verifying contract gives a different digest (a signature cannot be replayed across them)", () => {
    const d = engagementDigest(e, 31337, VAULT);
    expect(engagementDigest(e, 5042002, VAULT)).not.toBe(d);
    expect(engagementDigest(e, 31337, getAddress("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"))).not.toBe(d);
  });

  it("property: any change to a signed term changes the digest", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 20n }), fc.integer({ min: 1, max: 364 }), (cap, days) => {
        const a = buildDraft(body({ capBaseUnits: cap.toString() }), ctx);
        const b = buildDraft(body({ capBaseUnits: (cap + 1n).toString() }), ctx);
        const c = buildDraft(body({ capBaseUnits: cap.toString(), paymentTerms: { netDays: days + 1, earlyPay: null, payBeforeDueBufferHours: 0, allowImmediate: false } }), ctx);
        return engagementDigest(a, 31337, VAULT) !== engagementDigest(b, 31337, VAULT) && engagementDigest(a, 31337, VAULT) !== engagementDigest(c, 31337, VAULT);
      }),
      { numRuns: 40 },
    );
  });
});

describe("sign body", () => {
  it("accepts a role and hex signature, rejects other roles, non-hex and unknown fields", () => {
    expect(SignBodySchema.safeParse({ role: "owner", signature: "0x" + "ab".repeat(65) }).success).toBe(true);
    expect(SignBodySchema.safeParse({ role: "kernel", signature: "0xab" }).success).toBe(false);
    expect(SignBodySchema.safeParse({ role: "owner", signature: "ab" }).success).toBe(false);
    expect(SignBodySchema.safeParse({ role: "owner", signature: "0x" }).success).toBe(false);
    expect(SignBodySchema.safeParse({ role: "owner", signature: "0xab", status: "ACTIVE" }).success).toBe(false);
  });
});
