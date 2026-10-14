import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { symbolonDomain, type Address, type Hex32, type SignedReceipt } from "@symbolon/schemas";
import {
  MAX_RECEIPT_FILE_BYTES,
  SECP256K1_HALF_N,
  SECP256K1_N,
  buildReceipt,
  checkCanonicalSignature,
  findDuplicateKey,
  parseReceiptJson,
  receiptDigest,
  signReceipt,
  verifyReceipt,
  verifyReceiptJson,
  type ReceiptSigner,
  type VerifyOptions,
} from "../src/index";
import { DOMAIN, ESCALATION_DECISION, ESCALATION_RECEIPT, KERNEL, RELEASE_DECISION, RELEASE_RECEIPT, STRANGER, signed } from "./helpers";

const enc = new TextEncoder();
const pinned: VerifyOptions = { domain: DOMAIN, expectedSigner: KERNEL.address };
const statusOf = (r: Awaited<ReturnType<typeof verifyReceipt>>, id: string) => r.checks.find((c) => c.id === id)?.status;

/** The malleated twin of a signature: same r, s' = n - s, v flipped. It recovers to the same address. */
function twin(sig: string): `0x${string}` {
  const r = sig.slice(2, 66);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = sig.slice(130) === "1b" ? "1c" : "1b";
  return `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, "0")}${v}`;
}

describe("signReceipt", () => {
  it("signs a built receipt and the result verifies", async () => {
    const s = await signed();
    expect(s.signer).toBe(KERNEL.address);
    expect(checkCanonicalSignature(s.signature).ok).toBe(true);
    const report = await verifyReceipt(s, pinned);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual(["SCHEMA:PASS", "HASH:PASS", "SIGNATURE:PASS", "SIGNER:PASS", "ANCHOR:SKIP"]);
    expect(report.receipt).toEqual(s.receipt);
  });

  it("is deterministic (RFC 6979): signing twice gives the same bytes", async () => {
    expect((await signed()).signature).toBe((await signed()).signature);
  });

  it("signs the digest of the vault's domain: another chain or vault does not verify", async () => {
    const s = await signed();
    for (const other of [symbolonDomain(1, DOMAIN.verifyingContract), symbolonDomain(DOMAIN.chainId, STRANGER.address)]) {
      const r = await verifyReceipt(s, { ...pinned, domain: other });
      expect(r.ok).toBe(false);
      expect(statusOf(r, "SIGNATURE")).toBe("FAIL");
    }
  });

  describe("does not trust the signer it is handed", () => {
    const built = () => {
      const b = buildReceipt(RELEASE_DECISION, RELEASE_RECEIPT.inputs);
      if (!b.ok) throw new Error("build failed");
      return b.value;
    };
    const code = async (signer: ReceiptSigner, b = built()) => {
      const r = await signReceipt(b, signer, DOMAIN);
      return r.ok ? "OK" : r.error.code;
    };

    it("a signer that throws", async () => {
      expect(await code({ address: KERNEL.address, signDigest: async () => Promise.reject(new Error("boom: secret detail")) })).toBe("SIGNER_FAILED");
    });

    it("a signer that returns upper-case hex gets the canonical lower-case spelling back", async () => {
      const good = (await signed()).signature;
      const upper = `0x${good.slice(2).toUpperCase()}` as `0x${string}`;
      const r = await signReceipt(built(), { address: KERNEL.address, signDigest: async () => upper }, DOMAIN);
      expect(r.ok && r.value.signature).toBe(good);
    });

    it("a signer that returns junk, wrong length, v=0/1, or a malleated signature", async () => {
      const good = (await signed()).signature;
      const v01 = `${good.slice(0, 130)}${good.endsWith("1b") ? "00" : "01"}` as `0x${string}`;
      for (const bad of ["nope", "0x", `${good}00`, good.slice(0, -2), v01, twin(good)]) {
        expect(await code({ address: KERNEL.address, signDigest: async () => bad as `0x${string}` })).toBe("SIGNER_FAILED");
      }
    });

    it("a signature by another key than the one the signer claims", async () => {
      expect(await code({ address: KERNEL.address, signDigest: STRANGER.signDigest })).toBe("SIGNER_MISMATCH");
    });

    it("a signature over a different digest than the one it was given", async () => {
      const other = receiptDigest(ESCALATION_RECEIPT, "0x" + "11".repeat(32) as Hex32, DOMAIN);
      if (!other.ok) throw new Error("digest failed");
      expect(await code({ address: KERNEL.address, signDigest: () => KERNEL.signDigest(other.value) })).toBe("SIGNER_MISMATCH");
    });

    it("an address that is not EIP-55", async () => {
      expect(await code({ address: KERNEL.address.toLowerCase() as Address, signDigest: KERNEL.signDigest })).toBe("SIGNER_FAILED");
    });

    it("a receiptHash that is not the hash of the receipt", async () => {
      const b = built();
      expect(await code(KERNEL, { receipt: b.receipt, receiptHash: ("0x" + "22".repeat(32)) as Hex32 })).toBe("RECEIPT_INVALID");
    });
  });
});

describe("verifyReceipt", () => {
  it("an unpinned signer is not ok by default, and is reported as unpinned when allowed", async () => {
    const s = await signed();
    const strict = await verifyReceipt(s, { domain: DOMAIN });
    expect(strict.ok).toBe(false);
    expect(statusOf(strict, "SIGNER")).toBe("FAIL");
    const lax = await verifyReceipt(s, { domain: DOMAIN, allowUnpinnedSigner: true });
    expect(lax.ok).toBe(true);
    expect(lax.signerPinned).toBe(false);
    expect(statusOf(lax, "SIGNER")).toBe("SKIP");
  });

  it("a receipt signed by anyone else fails the signer pin even though its signature is valid", async () => {
    const s = await signed("RELEASE", STRANGER);
    const r = await verifyReceipt(s, pinned);
    expect(statusOf(r, "SIGNATURE")).toBe("PASS");
    expect(statusOf(r, "SIGNER")).toBe("FAIL");
    expect(r.ok).toBe(false);
    expect(r.receipt).toBeNull();
  });

  it("any change to the receipt content breaks the hash, and swapping in another valid signature does not rescue it", async () => {
    const s = await signed();
    const changed = structuredClone(s) as SignedReceipt & { receipt: { decision: { amountBaseUnits: string } } };
    changed.receipt.decision.amountBaseUnits = "1500000001";
    const r = await verifyReceipt(changed, pinned);
    expect(statusOf(r, "HASH")).toBe("FAIL");
    expect(r.ok).toBe(false);
    // Recompute the hash to match the edited content: now the signature no longer covers it.
    const rebuilt = buildReceipt({ ...RELEASE_DECISION, amountBaseUnits: "1500000001" }, RELEASE_RECEIPT.inputs);
    if (!rebuilt.ok) throw new Error("build failed");
    const forged = { ...s, receipt: rebuilt.value.receipt, receiptHash: rebuilt.value.receiptHash };
    const r2 = await verifyReceipt(forged, pinned);
    expect(statusOf(r2, "HASH")).toBe("PASS");
    expect(statusOf(r2, "SIGNATURE")).toBe("FAIL");
    expect(r2.ok).toBe(false);
  });

  it("the signature commits to the verdict: an ESCALATE signature cannot be moved onto a RELEASE receipt", async () => {
    const esc = await signed("ESCALATE");
    const rel = await signed("RELEASE");
    const r = await verifyReceipt({ ...rel, signature: esc.signature }, pinned);
    expect(statusOf(r, "SIGNATURE")).toBe("FAIL");
    expect(r.ok).toBe(false);
  });

  it("a requested receiptHash that differs from the content's is refused", async () => {
    const s = await signed();
    const r = await verifyReceipt(s, { ...pinned, expectedReceiptHash: ("0x" + "33".repeat(32)) as Hex32 });
    expect(statusOf(r, "HASH")).toBe("FAIL");
    expect(r.ok).toBe(false);
    expect((await verifyReceipt(s, { ...pinned, expectedReceiptHash: s.receiptHash })).ok).toBe(true);
  });

  it("the malleated twin of a valid signature, v spelled 0/1, and upper-case hex are all refused", async () => {
    const s = await signed();
    const v01 = `${s.signature.slice(0, 130)}${s.signature.endsWith("1b") ? "00" : "01"}`;
    for (const sig of [twin(s.signature), v01, `0x${s.signature.slice(2).toUpperCase()}`]) {
      const r = await verifyReceipt({ ...s, signature: sig }, pinned);
      expect(r.ok).toBe(false);
    }
  });

  it("the canonical-form rules themselves", () => {
    const good = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
    expect(checkCanonicalSignature(good).ok).toBe(true);
    expect(checkCanonicalSignature(`0x${"00".repeat(32)}${"22".repeat(32)}1b`).ok).toBe(false); // r = 0
    expect(checkCanonicalSignature(`0x${"ff".repeat(32)}${"22".repeat(32)}1b`).ok).toBe(false); // r >= n
    expect(checkCanonicalSignature(`0x${"11".repeat(32)}${"00".repeat(32)}1b`).ok).toBe(false); // s = 0
    expect(checkCanonicalSignature(`0x${"11".repeat(32)}${(SECP256K1_HALF_N + 1n).toString(16).padStart(64, "0")}1b`).ok).toBe(false); // high s
    expect(checkCanonicalSignature(`0x${"11".repeat(32)}${SECP256K1_HALF_N.toString(16).padStart(64, "0")}1b`).ok).toBe(true); // s = n/2
    expect(checkCanonicalSignature(`0x${"11".repeat(32)}${"22".repeat(32)}1d`).ok).toBe(false); // v
  });

  it("never throws, whatever it is given", async () => {
    for (const junk of [null, undefined, 0, "x", [], {}, { receipt: 1 }, () => 1, Symbol("s")]) {
      const r = await verifyReceipt(junk, pinned);
      expect(r.ok).toBe(false);
      expect(r.receipt).toBeNull();
      expect(r.checks.map((c) => c.id)).toEqual(["SCHEMA", "HASH", "SIGNATURE", "SIGNER", "ANCHOR"]);
    }
  });

  it("an unknown extra member makes the object not a SignedReceipt", async () => {
    const s = await signed();
    const r = await verifyReceipt({ ...s, extra: 1 }, pinned);
    expect(statusOf(r, "SCHEMA")).toBe("FAIL");
  });

  it("check details are fixed text and hex: nothing in them comes from receipt prose", async () => {
    const s = await signed("ESCALATE");
    const text = JSON.stringify((await verifyReceipt(s, pinned)).checks);
    for (const d of s.receipt.decision.checks) expect(text).not.toContain(d.detail as unknown as string);
  });

  describe("on-chain anchor hook", () => {
    it("runs only when the earlier checks passed; a FAIL, a throw, or a SKIP-worthy earlier failure all make the report not ok", async () => {
      const s = await signed();
      const calls: Hex32[] = [];
      const pass = async (_r: unknown, h: Hex32) => (calls.push(h), { status: "PASS" as const, detail: "matches" });
      const ok = await verifyReceipt(s, { ...pinned, checkAnchor: pass });
      expect(ok.ok).toBe(true);
      expect(calls).toEqual([s.receiptHash]);

      expect((await verifyReceipt(s, { ...pinned, checkAnchor: async () => ({ status: "FAIL", detail: "no event" }) })).ok).toBe(false);
      const thrown = await verifyReceipt(s, { ...pinned, checkAnchor: async () => Promise.reject(new Error("rpc down")) });
      expect(thrown.ok).toBe(false);
      expect(statusOf(thrown, "ANCHOR")).toBe("FAIL");

      const before = calls.length;
      const bad = await verifyReceipt({ ...s, signature: twin(s.signature) }, { ...pinned, checkAnchor: pass });
      expect(bad.ok).toBe(false);
      expect(statusOf(bad, "ANCHOR")).toBe("SKIP");
      expect(calls.length).toBe(before);
      const wrongSigner = await verifyReceipt(s, { domain: DOMAIN, expectedSigner: STRANGER.address, checkAnchor: pass });
      expect(statusOf(wrongSigner, "ANCHOR")).toBe("SKIP");
    });
  });
});

describe("tamper any byte of the receipt file: verification fails", () => {
  it("flipping the low bit of EVERY byte, and the case of every letter, never verifies", async () => {
    const s = await signed();
    const bytes = enc.encode(JSON.stringify(s));
    expect((await verifyReceiptJson(bytes, pinned)).ok).toBe(true);
    let tried = 0;
    for (let i = 0; i < bytes.length; i++) {
      for (const mask of [0x01, 0x20]) {
        const b = bytes[i] as number;
        if (mask === 0x20 && !((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) continue;
        const copy = bytes.slice();
        copy[i] = b ^ mask;
        tried++;
        const r = await verifyReceiptJson(copy, pinned);
        if (r.ok) throw new Error(`byte ${i} xor ${mask.toString(16)} still verified`);
      }
    }
    expect(tried).toBeGreaterThan(bytes.length);
  }, 120_000);

  it("deleting or inserting any single byte never verifies either", async () => {
    const s = await signed("ESCALATE");
    const bytes = enc.encode(JSON.stringify(s));
    for (let i = 0; i < bytes.length; i += 3) {
      const del = new Uint8Array([...bytes.slice(0, i), ...bytes.slice(i + 1)]);
      const ins = new Uint8Array([...bytes.slice(0, i), 0x20, ...bytes.slice(i)]);
      expect((await verifyReceiptJson(del, pinned)).ok).toBe(false);
      // an inserted space between tokens is harmless JSON whitespace; only content bytes must matter
      const r = await verifyReceiptJson(ins, pinned);
      const insideString = enc.encode(JSON.stringify(s)).slice(0, i).filter((c) => c === 0x22).length % 2 === 1;
      if (insideString) expect(r.ok).toBe(false);
    }
  }, 120_000);

  it("random multi-byte corruption (property)", async () => {
    const s = await signed();
    const bytes = enc.encode(JSON.stringify(s));
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(bytes.length - 1), fc.integer({ min: 1, max: 255 })), { minLength: 1, maxLength: 4 }), async (edits) => {
        const copy = bytes.slice();
        for (const [i, x] of edits) copy[i] = (copy[i] as number) ^ x;
        if (copy.every((v, k) => v === bytes[k])) return true;
        return !(await verifyReceiptJson(copy, pinned)).ok;
      }),
      { numRuns: 300 },
    );
  }, 120_000);
});

describe("reading a receipt file strictly", () => {
  it("rejects duplicate member names anywhere (the last-wins vs first-wins trap)", async () => {
    const s = await signed();
    const text = JSON.stringify(s);
    expect(findDuplicateKey(text)).toBeNull();
    const dupTop = text.replace(/^\{/, `{"signer":"${STRANGER.address}",`);
    expect(findDuplicateKey(dupTop)).toBe("signer");
    expect((await verifyReceiptJson(dupTop, pinned)).ok).toBe(false);
    const dupNested = text.replace('"receiptVersion":1', '"receiptVersion":1,"receiptVersion":1');
    expect(dupNested).not.toBe(text);
    expect((await verifyReceiptJson(dupNested, pinned)).ok).toBe(false);
  });

  it("the duplicate scanner understands strings, escapes and arrays", () => {
    expect(findDuplicateKey('{"a":"{\\"a\\":1}","b":[{"a":1},{"a":2}]}')).toBeNull();
    expect(findDuplicateKey('{"a":1,"b":{"a":1,"a":2}}')).toBe("a");
    expect(findDuplicateKey('[{"x":1},{"x":2}]')).toBeNull();
  });

  it("rejects a byte-order mark, ill-formed UTF-8, junk, and oversize input", async () => {
    const s = await signed();
    const body = enc.encode(JSON.stringify(s));
    expect((await verifyReceiptJson(new Uint8Array([0xef, 0xbb, 0xbf, ...body]), pinned)).ok).toBe(false);
    expect((await verifyReceiptJson(new Uint8Array([0xff, 0xfe, 0x7b]), pinned)).ok).toBe(false);
    expect((await verifyReceiptJson("not json", pinned)).ok).toBe(false);
    expect((await verifyReceiptJson(new Uint8Array(MAX_RECEIPT_FILE_BYTES + 1), pinned)).ok).toBe(false);
    expect(parseReceiptJson(new Uint8Array(MAX_RECEIPT_FILE_BYTES + 1)).ok).toBe(false);
    expect(parseReceiptJson("x".repeat(MAX_RECEIPT_FILE_BYTES + 1)).ok).toBe(false);
  });

  it("accepts the receipt as text or as bytes", async () => {
    const s = await signed();
    expect((await verifyReceiptJson(JSON.stringify(s), pinned)).ok).toBe(true);
    expect((await verifyReceiptJson(enc.encode(JSON.stringify(s, null, 2)), pinned)).ok).toBe(true);
  });
});

describe("digest", () => {
  it("is bound to receiptHash, intentId, verdict, policyHash and issuedAt", () => {
    const hashA = "0x" + "aa".repeat(32);
    const base = receiptDigest(RELEASE_RECEIPT, hashA as Hex32, DOMAIN);
    const alt = (mut: (r: typeof RELEASE_RECEIPT) => typeof RELEASE_RECEIPT, hash = hashA) => {
      const d = receiptDigest(mut(structuredClone(RELEASE_RECEIPT)), hash as Hex32, DOMAIN);
      return d.ok ? d.value : "ERR";
    };
    const b = base.ok ? base.value : "ERR";
    expect(b).not.toBe("ERR");
    expect(alt((r) => r)).toBe(b);
    expect(alt((r) => r, "0x" + "bb".repeat(32))).not.toBe(b);
    expect(alt((r) => ({ ...r, decision: { ...r.decision, verdict: "HOLD" } }))).not.toBe(b);
    expect(alt((r) => ({ ...r, decision: { ...r.decision, policyHash: ("0x" + "cc".repeat(32)) as Hex32 } }))).not.toBe(b);
    expect(alt((r) => ({ ...r, issuedAt: "2026-10-12T09:00:04Z" }))).not.toBe(b);
    expect(alt((r) => ({ ...r, decision: { ...r.decision, intentId: ("0x" + "dd".repeat(32)) as Hex32 } }))).not.toBe(b);
  });

  it("an escalation and a release for the same intent have different digests", () => {
    const a = receiptDigest(ESCALATION_RECEIPT, ("0x" + "aa".repeat(32)) as Hex32, DOMAIN);
    const b = receiptDigest(RELEASE_RECEIPT, ("0x" + "aa".repeat(32)) as Hex32, DOMAIN);
    expect(a.ok && b.ok && a.value !== b.value).toBe(true);
    expect(ESCALATION_DECISION.intentId).toBe(RELEASE_DECISION.intentId);
  });
});
