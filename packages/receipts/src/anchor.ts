// The on-chain anchor of a receipt: the vault's `Released(intentId, engagementId, payee, amount, receiptHash)` event
// (docs/05 §6, DEC-009). Pure: the caller fetches the raw logs (the CLI / the audit page), this decides.
//
//   RELEASE receipt   there must be exactly one `Released` log for the receipt's intentId, emitted by the expected
//                     vault, and its receiptHash, payee, engagement and amount must equal the receipt's decision
//                     (amount = releaseAmountBaseUnits, the discounted amount that actually moved);
//   any other verdict no `Released` log may carry THIS receipt's hash (a HOLD/ESCALATE/REJECT receipt that the vault
//                     anchored as a release would be a contradiction). A later release of the same intent carries a
//                     different (final) receipt hash and is not this receipt's business.
//
// Logs are decoded by @symbolon/chain's decodeVaultLog, which refuses logs from other contracts, pending or removed
// logs, and anything that is not the canonical encoding of its arguments. Logs of OTHER contracts are ignored (they can
// never anchor anything); a log of the vault that fails to decode fails the check (fail closed).
import { decodeVaultLog, type DecodedVaultLog, type RawLog } from "@symbolon/chain";
import type { Address, Hex32, Receipt } from "@symbolon/schemas";
import type { AnchorOutcome } from "./verify";

export interface AnchorOptions {
  /** The vault that must have emitted the logs. */
  readonly vault: Address;
  /** Settlement-token decimals read from the vault (`tokenDecimals()`); amounts are compared in base units. */
  readonly decimals: number;
}

interface ReleasedFields {
  readonly engagementId: string;
  readonly payee: string;
  readonly units: bigint;
  readonly receiptHash: string;
}

function fail(detail: string): AnchorOutcome {
  return { status: "FAIL", detail };
}

function tryDecode(log: RawLog, options: AnchorOptions): DecodedVaultLog | null {
  try {
    return decodeVaultLog(log, { vault: options.vault, decimals: options.decimals });
  } catch {
    return null;
  }
}

export function checkReleasedAnchor(receipt: Receipt, receiptHash: Hex32, logs: readonly RawLog[], options: AnchorOptions): AnchorOutcome {
  const d = receipt.decision;
  const released: ReleasedFields[] = [];
  for (const log of logs) {
    // A look-alike event from another contract can never count as this vault's anchor: it is ignored, not trusted.
    if (log.address.toLowerCase() !== options.vault.toLowerCase()) continue;
    const decoded = tryDecode(log, options);
    if (decoded === null) return fail("a log did not decode as a canonical event of the expected vault");
    const e = decoded.event;
    if (e.name === "Released" && e.intentId === d.intentId) {
      released.push({ engagementId: e.engagementId, payee: e.payee, units: e.amount.units, receiptHash: e.receiptHash });
    }
  }

  if (d.verdict !== "RELEASE") {
    return released.some((r) => r.receiptHash === receiptHash)
      ? fail(`a ${d.verdict} receipt is anchored by a Released event`)
      : { status: "PASS", detail: `${d.verdict} receipt: the vault did not anchor it as a release (none expected)` };
  }

  const [only, ...extra] = released;
  if (only === undefined) return fail("no Released event for this intent");
  if (extra.length > 0) return fail(`${released.length} Released events for one intent (a vault releases an intent once)`);

  const wrong: string[] = [];
  if (only.receiptHash !== receiptHash) wrong.push("receiptHash");
  if (only.payee !== d.payee) wrong.push("payee");
  if (only.engagementId !== d.engagementId) wrong.push("engagementId");
  if (d.releaseAmountBaseUnits === null || only.units !== BigInt(d.releaseAmountBaseUnits)) wrong.push("amount");
  if (wrong.length > 0) return fail(`the Released event disagrees with the receipt on: ${wrong.join(", ")}`);
  return { status: "PASS", detail: `Released event matches receiptHash, payee, engagement and amount ${only.units.toString()} base units` };
}
