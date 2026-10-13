// verifyReceipt: anyone can check a signed receipt without trusting our server (DEC-009; /audit verifies client-side).
//
// Checks, always reported in this order (a check that could not run because an earlier one failed is SKIP, and the
// report is then not ok):
//   SCHEMA     the object is exactly a SignedReceipt (strict schemas; canonical hex/addresses/timestamps);
//   HASH       keccak256(UTF-8(JCS(receipt))) equals the claimed receiptHash (and the requested one, if given);
//   SIGNATURE  the signature is in canonical form and recovers, over the EIP-712 `Receipt` digest of the vault
//              domain, to the signer named in the file;
//   SIGNER     that signer is the expected kernel signer (read from the vault by the caller). Without an expected
//              signer the report is NOT ok unless the caller explicitly allows an unpinned signer, because anyone
//              can sign a receipt with their own key;
//   ANCHOR     optional: the caller's on-chain check that the vault's `Released` event matches (see anchor.ts).
//
// verifyReceipt never throws and never prints: it returns data. Check details are written by this module from
// fixed text and hex values, never from receipt prose.
import {
  SignedReceiptSchema,
  computeReceiptHash,
  type Address,
  type Eip712Domain,
  type Hex32,
  type Receipt,
  type SignedReceipt,
} from "@symbolon/schemas";
import { parseReceiptJson } from "./json";
import { describeIssues } from "./result";
import { receiptDigest } from "./sign";
import { checkCanonicalSignature, recoverSigner } from "./signature";

export const VERIFY_CHECK_IDS = ["SCHEMA", "HASH", "SIGNATURE", "SIGNER", "ANCHOR"] as const;
export type VerifyCheckId = (typeof VERIFY_CHECK_IDS)[number];
export type VerifyStatus = "PASS" | "FAIL" | "SKIP";

export interface VerifyCheck {
  readonly id: VerifyCheckId;
  readonly status: VerifyStatus;
  readonly detail: string;
}

export interface VerifyReport {
  /** True iff no check failed and every check the caller required passed. */
  readonly ok: boolean;
  /** The hash recomputed from the receipt content (null when the object was not a SignedReceipt). */
  readonly receiptHash: Hex32 | null;
  /** The signer named in the file (null when the object was not a SignedReceipt). */
  readonly signer: Address | null;
  /** True iff the signer was compared with an expected kernel signer. */
  readonly signerPinned: boolean;
  readonly checks: readonly VerifyCheck[];
  /** The receipt, only when `ok` (never hand out content of a receipt that did not verify). */
  readonly receipt: Receipt | null;
}

export interface AnchorOutcome {
  readonly status: "PASS" | "FAIL";
  readonly detail: string;
}

export interface VerifyOptions {
  /** The EIP-712 domain of the vault the receipt was signed for: (name, version, chainId, vault). */
  readonly domain: Eip712Domain;
  /** The kernel signer the receipt must be signed by (e.g. `kernelSigner()` read from the vault). */
  readonly expectedSigner?: Address;
  /** Accept a receipt whose signer was not pinned (the SIGNER check is then SKIP and `signerPinned` false). */
  readonly allowUnpinnedSigner?: boolean;
  /** If given, the receipt's hash must also equal this (a receipt fetched by hash). */
  readonly expectedReceiptHash?: Hex32;
  /** If given, runs the on-chain anchor check; a throw is a FAIL. Called only after SCHEMA, HASH and SIGNATURE passed. */
  readonly checkAnchor?: (receipt: Receipt, receiptHash: Hex32) => Promise<AnchorOutcome>;
}

const NOT_RUN = "not evaluated: an earlier check failed";

function check(id: VerifyCheckId, status: VerifyStatus, detail: string): VerifyCheck {
  return { id, status, detail };
}

function skipRest(checks: VerifyCheck[]): VerifyReport {
  for (const id of VERIFY_CHECK_IDS) {
    if (!checks.some((c) => c.id === id)) checks.push(check(id, "SKIP", NOT_RUN));
  }
  return { ok: false, receiptHash: null, signer: null, signerPinned: false, checks, receipt: null };
}

/** Verify a parsed value (typically `JSON.parse` of a receipt file or an API response). */
export async function verifyReceipt(input: unknown, options: VerifyOptions): Promise<VerifyReport> {
  try {
    return await run(input, options);
  } catch {
    return {
      ok: false,
      receiptHash: null,
      signer: null,
      signerPinned: false,
      checks: VERIFY_CHECK_IDS.map((id) => check(id, id === "SCHEMA" ? "FAIL" : "SKIP", id === "SCHEMA" ? "unexpected error while verifying" : NOT_RUN)),
      receipt: null,
    };
  }
}

/** Verify the bytes (or text) of a receipt file: strict UTF-8, strict JSON (no duplicate members), then `verifyReceipt`. */
export async function verifyReceiptJson(input: string | Uint8Array, options: VerifyOptions): Promise<VerifyReport> {
  const parsed = parseReceiptJson(input);
  if (!parsed.ok) return skipRest([check("SCHEMA", "FAIL", parsed.error.message)]);
  return verifyReceipt(parsed.value, options);
}

async function run(input: unknown, options: VerifyOptions): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];

  // --- SCHEMA -----------------------------------------------------------------------------------------------
  const parsed = SignedReceiptSchema.safeParse(input);
  if (!parsed.success) {
    checks.push(check("SCHEMA", "FAIL", `not a SignedReceipt: ${describeIssues(parsed.error.issues)}`));
    return skipRest(checks);
  }
  const signed: SignedReceipt = parsed.data;
  checks.push(check("SCHEMA", "PASS", "strict SignedReceipt"));

  // --- HASH -------------------------------------------------------------------------------------------------
  const recomputed = computeReceiptHash(signed.receipt);
  if (recomputed !== signed.receiptHash) {
    checks.push(check("HASH", "FAIL", `recomputed receiptHash ${recomputed} differs from the claimed ${signed.receiptHash}`));
  } else if (options.expectedReceiptHash !== undefined && options.expectedReceiptHash !== recomputed) {
    checks.push(check("HASH", "FAIL", `receiptHash ${recomputed} is not the requested ${options.expectedReceiptHash}`));
  } else {
    checks.push(check("HASH", "PASS", `receiptHash ${recomputed} recomputed from the receipt content`));
  }

  // --- SIGNATURE ----------------------------------------------------------------------------------------------
  checks.push(await signatureCheck(signed, recomputed, options.domain));

  // --- SIGNER -------------------------------------------------------------------------------------------------
  const expected = options.expectedSigner;
  let signerCheck: VerifyCheck;
  if (expected !== undefined) {
    signerCheck =
      expected === signed.signer
        ? check("SIGNER", "PASS", `signed by the expected kernel signer ${signed.signer}`)
        : check("SIGNER", "FAIL", `signed by ${signed.signer}, not by the expected kernel signer ${expected}`);
  } else if (options.allowUnpinnedSigner === true) {
    signerCheck = check("SIGNER", "SKIP", `signer ${signed.signer} was not compared with the vault's kernel signer`);
  } else {
    signerCheck = check("SIGNER", "FAIL", "no expected kernel signer given: anyone can sign a receipt with their own key");
  }
  checks.push(signerCheck);

  // --- ANCHOR (optional) --------------------------------------------------------------------------------------
  const coreOk = checks.every((c) => c.id === "SIGNER" || c.status === "PASS");
  let anchorCheck: VerifyCheck;
  if (options.checkAnchor === undefined) {
    anchorCheck = check("ANCHOR", "SKIP", "on-chain anchor check not requested");
  } else if (!coreOk || signerCheck.status === "FAIL") {
    anchorCheck = check("ANCHOR", "SKIP", NOT_RUN);
  } else {
    try {
      const outcome = await options.checkAnchor(signed.receipt, recomputed);
      anchorCheck = check("ANCHOR", outcome.status, outcome.detail);
    } catch {
      anchorCheck = check("ANCHOR", "FAIL", "the on-chain anchor check threw");
    }
  }
  checks.push(anchorCheck);

  // A SKIP is acceptable only where the caller said so: an unpinned signer, or an anchor check nobody asked for.
  const ok = coreOk && signerCheck.status !== "FAIL" && anchorCheck.status !== "FAIL" && (options.checkAnchor === undefined || anchorCheck.status === "PASS");
  return { ok, receiptHash: recomputed, signer: signed.signer, signerPinned: expected !== undefined, checks, receipt: ok ? signed.receipt : null };
}

async function signatureCheck(signed: SignedReceipt, hash: Hex32, domain: Eip712Domain): Promise<VerifyCheck> {
  const form = checkCanonicalSignature(signed.signature);
  if (!form.ok) return check("SIGNATURE", "FAIL", form.reason);
  const digest = receiptDigest(signed.receipt, hash, domain);
  if (!digest.ok) return check("SIGNATURE", "FAIL", "cannot compute the EIP-712 Receipt digest (bad domain or timestamp)");
  const recovered = await recoverSigner(digest.value, signed.signature);
  if (recovered === null) return check("SIGNATURE", "FAIL", "the signature does not recover to an address");
  if (recovered !== signed.signer) {
    return check("SIGNATURE", "FAIL", `the signature recovers to ${recovered}, not to the named signer ${signed.signer} (wrong key, tampered content, or another chain/vault domain)`);
  }
  return check("SIGNATURE", "PASS", `valid EIP-712 Receipt signature by ${signed.signer}`);
}
