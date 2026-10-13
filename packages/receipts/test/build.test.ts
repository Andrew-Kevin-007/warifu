import { describe, expect, it } from "vitest";
import { computeReceiptHash, keccak256Utf8 } from "@symbolon/schemas";
import type { Decision } from "@symbolon/schemas";
import { buildReceipt } from "../src/index";
import { ESCALATION_DECISION, ESCALATION_RECEIPT, RELEASE_DECISION, RELEASE_RECEIPT } from "./helpers";
import { ESCALATION_RECEIPT_HASH, HUMAN_EXPLANATION, RELEASE_RECEIPT_HASH } from "../../schemas/test/fixtures";

describe("buildReceipt", () => {
  it("reproduces the schema package's reference receipts and hashes (vectors match)", () => {
    const esc = buildReceipt(ESCALATION_DECISION, ESCALATION_RECEIPT.inputs);
    expect(esc.ok && esc.value.receipt).toEqual(ESCALATION_RECEIPT);
    expect(esc.ok && esc.value.receiptHash).toBe(ESCALATION_RECEIPT_HASH);
    const rel = buildReceipt(RELEASE_DECISION, RELEASE_RECEIPT.inputs);
    expect(rel.ok && rel.value.receipt).toEqual(RELEASE_RECEIPT);
    expect(rel.ok && rel.value.receiptHash).toBe(RELEASE_RECEIPT_HASH);
  });

  it("receiptHash is the hash of the receipt it returns", () => {
    const r = buildReceipt(ESCALATION_DECISION, ESCALATION_RECEIPT.inputs);
    if (!r.ok) throw new Error("build failed");
    expect(computeReceiptHash(r.value.receipt)).toBe(r.value.receiptHash);
  });

  it("keeps the explanation text out of the receipt and commits to it by hash", () => {
    const r = buildReceipt(ESCALATION_DECISION, ESCALATION_RECEIPT.inputs);
    if (!r.ok) throw new Error("build failed");
    expect(JSON.stringify(r.value.receipt)).not.toContain(HUMAN_EXPLANATION);
    expect("humanExplanation" in r.value.receipt.decision).toBe(false);
    expect(r.value.receipt.humanExplanationHash).toBe(keccak256Utf8(HUMAN_EXPLANATION));
  });

  it("a different explanation changes the hash; no explanation gives null", () => {
    const a = buildReceipt({ ...ESCALATION_DECISION, humanExplanation: `${HUMAN_EXPLANATION} Extra.` }, ESCALATION_RECEIPT.inputs);
    const b = buildReceipt({ ...ESCALATION_DECISION, humanExplanation: null }, ESCALATION_RECEIPT.inputs);
    expect(a.ok && a.value.receiptHash).not.toBe(ESCALATION_RECEIPT_HASH);
    expect(b.ok && b.value.receipt.humanExplanationHash).toBeNull();
  });

  it("issuedAt defaults to the decision's createdAt and never reads a clock; an explicit value is used as given", () => {
    const d = buildReceipt(ESCALATION_DECISION, ESCALATION_RECEIPT.inputs);
    expect(d.ok && d.value.receipt.issuedAt).toBe(ESCALATION_DECISION.createdAt);
    const e = buildReceipt(ESCALATION_DECISION, ESCALATION_RECEIPT.inputs, { issuedAt: "2026-10-05T10:16:00Z" });
    expect(e.ok && e.value.receipt.issuedAt).toBe("2026-10-05T10:16:00Z");
    expect(e.ok && e.value.receiptHash).not.toBe(ESCALATION_RECEIPT_HASH);
  });

  it("is deterministic: same inputs, same bytes", () => {
    const a = buildReceipt(RELEASE_DECISION, RELEASE_RECEIPT.inputs);
    const b = buildReceipt(structuredClone(RELEASE_DECISION), structuredClone(RELEASE_RECEIPT.inputs));
    expect(a).toEqual(b);
  });

  describe("fails closed", () => {
    const fails = (d: unknown, inputs: unknown = RELEASE_RECEIPT.inputs) => buildReceipt(d as Decision, inputs as never);

    it("a RELEASE with a failed check", () => {
      const bad = { ...RELEASE_DECISION, checks: ESCALATION_DECISION.checks };
      const r = fails(bad);
      expect(r.ok).toBe(false);
    });

    it.each(["payee", "engagementId", "milestoneId", "amountBaseUnits", "releaseAmountBaseUnits"] as const)("a RELEASE without %s", (field) => {
      const r = fails({ ...RELEASE_DECISION, [field]: null });
      expect(r.ok).toBe(false);
    });

    it("a decision that is not a Decision, and inputs that are not receipt inputs", () => {
      expect(fails({ nope: true }).ok).toBe(false);
      expect(fails(null).ok).toBe(false);
      expect(fails(RELEASE_DECISION, { docHash: "0x00" }).ok).toBe(false);
    });

    it("never echoes input text in the error", () => {
      const r = fails({ ...RELEASE_DECISION, verdict: "<script>alert(1)</script>" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).not.toContain("<script>");
    });

    it("an explanation that would not fit the schema still yields a typed error, not a throw", () => {
      expect(() => fails({ ...ESCALATION_DECISION, humanExplanation: 42 })).not.toThrow();
      expect(fails({ ...ESCALATION_DECISION, humanExplanation: 42 }).ok).toBe(false);
    });
  });
});
