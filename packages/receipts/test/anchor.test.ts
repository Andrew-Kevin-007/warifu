import { describe, expect, it } from "vitest";
import type { RawLog } from "@symbolon/chain";
import type { Address, Hex32, Receipt } from "@symbolon/schemas";
import { buildReceipt, verifyReceipt } from "../src/index";
import { checkReleasedAnchor } from "../src/anchor";
import { encodeVaultLog } from "../../chain/test/helpers/encode-log";
import { DOMAIN, ESCALATION_DECISION, ESCALATION_RECEIPT, KERNEL, RELEASE_DECISION, RELEASE_RECEIPT, STRANGER, signed } from "./helpers";

const VAULT = DOMAIN.verifyingContract as Address;
const OPTS = { vault: VAULT, decimals: 6 };
const hashOf = (r: typeof RELEASE_RECEIPT): Hex32 => {
  const b = buildReceipt(r.decision.verdict === "RELEASE" ? RELEASE_DECISION : ESCALATION_DECISION, r.inputs);
  if (!b.ok) throw new Error("build failed");
  return b.value.receiptHash;
};
const RELEASE_HASH = hashOf(RELEASE_RECEIPT);
const d = RELEASE_RECEIPT.decision;

function released(over: Partial<Record<"intentId" | "engagementId" | "payee" | "amount" | "receiptHash", unknown>> = {}, address: Address = VAULT, logIndex = 0): RawLog {
  const { topics, data } = encodeVaultLog("Released", {
    intentId: d.intentId,
    engagementId: d.engagementId,
    payee: d.payee,
    amount: BigInt(d.releaseAmountBaseUnits as string),
    receiptHash: RELEASE_HASH,
    ...over,
  });
  return { address, topics, data, blockNumber: 12n, transactionHash: ("0x" + "ab".repeat(32)) as `0x${string}`, logIndex, removed: false };
}
const check = (r: Receipt, hash: Hex32, logs: RawLog[]) => checkReleasedAnchor(r, hash, logs, OPTS);

describe("checkReleasedAnchor: a RELEASE receipt", () => {
  it("passes when exactly one Released event matches receiptHash, payee, engagement and the discounted amount", () => {
    const r = check(RELEASE_RECEIPT, RELEASE_HASH, [released()]);
    expect(r.status).toBe("PASS");
    expect(r.detail).toContain(String(d.releaseAmountBaseUnits));
  });

  it("is the release amount (discounted), not the gross invoice amount, that must have moved", () => {
    expect(d.amountBaseUnits).not.toBe(d.releaseAmountBaseUnits);
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [released({ amount: BigInt(d.amountBaseUnits as string) })]).status).toBe("FAIL");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [released({ amount: BigInt(d.releaseAmountBaseUnits as string) + 1n })]).status).toBe("FAIL");
  });

  it.each([
    ["receiptHash", { receiptHash: "0x" + "99".repeat(32) }],
    ["payee", { payee: STRANGER.address }],
    ["engagementId", { engagementId: "0x" + "77".repeat(32) }],
  ])("fails when the event disagrees on %s", (field, over) => {
    const r = check(RELEASE_RECEIPT, RELEASE_HASH, [released(over)]);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain(field);
  });

  it("fails when there is no Released event for the intent, or only one for another intent", () => {
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, []).status).toBe("FAIL");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [released({ intentId: "0x" + "55".repeat(32) })]).status).toBe("FAIL");
  });

  it("fails on two Released events for one intent (a vault releases an intent once)", () => {
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [released(), released({}, VAULT, 1)]).status).toBe("FAIL");
  });

  it("ignores a look-alike event from another contract, so it can neither anchor nor break the check", () => {
    const fake = released({}, STRANGER.address);
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [fake]).status).toBe("FAIL");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [fake, released()]).status).toBe("PASS");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [released({ amount: 1n }, STRANGER.address), released()]).status).toBe("PASS");
  });

  it("fails closed on a log of the vault that does not decode (garbage data, pending, or removed)", () => {
    const good = released();
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [{ ...good, data: "0x1234" }, good]).status).toBe("FAIL");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [{ ...good, blockNumber: null }]).status).toBe("FAIL");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [{ ...good, removed: true }]).status).toBe("FAIL");
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [{ ...good, topics: [] }]).status).toBe("FAIL");
  });

  it("compares the address case-insensitively but decodes only the expected vault", () => {
    const lower = released({}, VAULT.toLowerCase() as Address);
    expect(check(RELEASE_RECEIPT, RELEASE_HASH, [lower]).status).toBe("PASS");
  });
});

describe("checkReleasedAnchor: a receipt that is not a RELEASE", () => {
  const escHash = hashOf(ESCALATION_RECEIPT);

  it("passes when the vault never anchored it as a release", () => {
    expect(check(ESCALATION_RECEIPT, escHash, []).status).toBe("PASS");
  });

  it("passes when a LATER release of the same intent carries a different receipt hash", () => {
    expect(check(ESCALATION_RECEIPT, escHash, [released()]).status).toBe("PASS");
  });

  it("fails when a Released event carries this very receipt's hash (a HOLD/ESCALATE receipt anchored as a release)", () => {
    const r = check(ESCALATION_RECEIPT, escHash, [released({ receiptHash: escHash })]);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain("ESCALATE");
  });
});

describe("anchor + verifyReceipt together", () => {
  it("a verified receipt with a matching event is ok; the same receipt with a mismatched event is not", async () => {
    const s = await signed();
    const opts = { domain: DOMAIN, expectedSigner: KERNEL.address };
    const good = await verifyReceipt(s, { ...opts, checkAnchor: async (rc, h) => check(rc, h, [released({ receiptHash: s.receiptHash })]) });
    expect(good.ok).toBe(true);
    const bad = await verifyReceipt(s, { ...opts, checkAnchor: async (rc, h) => check(rc, h, [released({ receiptHash: s.receiptHash, payee: STRANGER.address })]) });
    expect(bad.ok).toBe(false);
    expect(bad.receipt).toBeNull();
  });
});
