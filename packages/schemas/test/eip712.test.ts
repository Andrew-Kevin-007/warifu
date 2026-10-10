// EIP-712 structs and enum constants, checked against the docs (the human-readable contract) rather than
// against the code that defines them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EIP712_PRIMARY_TYPES,
  EIP712_TYPES,
  REASON_CODES,
  TYPED_DATA_SCHEMAS,
  V2_REASON_CODES,
  VERDICTS,
  VERDICT_CODE,
  eip712Digest,
  eip712DomainSeparator,
  eip712TypeString,
  receiptEip712Message,
  symbolonDomain,
  toTypedDataJson,
} from "../src/index";
import { APPROVAL_VIEW, CHAIN_ID, DOMAIN, INTENT_ID, NEW_PAYEE, PAYEE, POLICY_HASH, RELEASE_RECEIPT_HASH, VAULT } from "./fixtures";

const doc = (name: string) => readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8");

describe("struct definitions match docs/05 §2 'EIP-712 typed data'", () => {
  const section = doc("05_DATA_MODELS_AND_API.md").split("### EIP-712 typed data")[1] ?? "";
  const documented = [...section.matchAll(/^([A-Z][A-Za-z]+)\(([^)]*)\)/gm)].map((m) => `${m[1]}(${m[2]})`);

  it("documents exactly our seven structs", () => {
    expect(documented.map((s) => s.split("(")[0]).sort()).toEqual([...EIP712_PRIMARY_TYPES].sort());
  });

  it.each(EIP712_PRIMARY_TYPES)("%s encodeType equals the documented signature", (p) => {
    expect(documented).toContain(eip712TypeString(p));
  });
});

describe("digests", () => {
  const td = APPROVAL_VIEW.typedData;

  it("every signed field changes the digest", () => {
    const base = eip712Digest(td);
    const patches: Record<string, string> = {
      intentId: `0x${"01".repeat(32)}`,
      receiptHash: `0x${"02".repeat(32)}`,
      amount: (BigInt(td.message.amount) + 1n).toString(),
      deadline: (BigInt(td.message.deadline) + 1n).toString(),
    };
    for (const f of EIP712_TYPES.OwnerApproval) {
      const message = { ...td.message, [f.name]: patches[f.name] };
      expect(eip712Digest(toTypedDataJson("OwnerApproval", DOMAIN, message)), f.name).not.toBe(base);
    }
  });

  it("the domain separates chains and vaults", () => {
    const other = toTypedDataJson("OwnerApproval", symbolonDomain(1, VAULT), td.message);
    const otherVault = toTypedDataJson("OwnerApproval", symbolonDomain(CHAIN_ID, NEW_PAYEE), td.message);
    expect(eip712Digest(other)).not.toBe(eip712Digest(td));
    expect(eip712Digest(otherVault)).not.toBe(eip712Digest(td));
    expect(eip712DomainSeparator(symbolonDomain(1, VAULT))).not.toBe(eip712DomainSeparator(DOMAIN));
  });

  it("refuses typed data whose struct definition was tampered with", () => {
    const tampered = { ...td, types: { ...td.types, OwnerApproval: td.types.OwnerApproval.filter((f) => f.name !== "amount") } };
    expect(() => eip712Digest(tampered)).toThrow();
    expect(TYPED_DATA_SCHEMAS.OwnerApproval.safeParse(tampered).success).toBe(false);
  });
});

describe("message validation (canonical spellings only)", () => {
  const msg = { intentId: INTENT_ID, receiptHash: RELEASE_RECEIPT_HASH, amount: "1", deadline: "1" };
  it.each([
    ["negative amount", { amount: "-1" }],
    ["leading zero", { amount: "01" }],
    ["hex amount", { amount: "0x1" }],
    ["uint64 overflow", { deadline: (1n << 64n).toString() }],
    ["uppercase hash", { intentId: INTENT_ID.toUpperCase().replace("0X", "0x") }],
    ["number instead of string", { amount: 1 }],
  ])("rejects %s", (_name, patch) => {
    expect(() => toTypedDataJson("OwnerApproval", DOMAIN, { ...msg, ...patch } as typeof msg)).toThrow();
  });

  it("addresses must be checksummed", () => {
    expect(() =>
      toTypedDataJson("PayeeChange", DOMAIN, { engagementId: INTENT_ID, oldPayee: PAYEE.toLowerCase() as `0x${string}`, newPayee: NEW_PAYEE, nonce: "1" }),
    ).toThrow();
  });

  it("Receipt.verdict is a known uint8 code", () => {
    const base = { receiptHash: RELEASE_RECEIPT_HASH, intentId: INTENT_ID, policyHash: POLICY_HASH, issuedAt: "1" };
    expect(() => toTypedDataJson("Receipt", DOMAIN, { ...base, verdict: "6" })).toThrow();
    expect(() => toTypedDataJson("Receipt", DOMAIN, { ...base, verdict: "01" })).toThrow();
    expect(receiptEip712Message({ ...base, verdict: "REPLAY", issuedAtEpochSeconds: 7n }).verdict).toBe("5");
  });
});

describe("enums match the docs", () => {
  it("verdict codes: RELEASE=1, HOLD=2, ESCALATE=3, REJECT=4, REPLAY=5 (docs/05 §1)", () => {
    const line = doc("05_DATA_MODELS_AND_API.md").match(/RELEASE=1, HOLD=2, ESCALATE=3, REJECT=4, REPLAY=5/);
    expect(line).not.toBeNull();
    expect(VERDICTS.map((v) => `${v}=${VERDICT_CODE[v]}`).join(", ")).toBe(line![0]);
  });

  it("reason codes are exactly the docs/04 §6 list, v2 additions last", () => {
    const section = doc("04_KERNEL_SPEC.md").split("## 6. Reason codes")[1]?.split("## 7.")[0] ?? "";
    const list = section.split("\n").find((l) => l.startsWith("`SCHEMA_INVALID"));
    const documented = (list ?? "").replace(/[`.]/g, "").split(",").map((s) => s.trim());
    expect([...REASON_CODES]).toEqual(documented);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    expect(V2_REASON_CODES).toHaveLength(6);
  });
});
