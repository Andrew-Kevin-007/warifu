// POST /v1/breaker/unfreeze (docs/05 s4, docs/04 K-16: "unpause is owner-only and requires a recorded reason"; WP-15).
//
// The owner signs, with their wallet, an EIP-712 `BreakerUnfreeze(bytes32 reasonHash, uint64 haltedSince, uint64 deadline)`
// under the tenant vault's domain:
//   reasonHash   keccak256 of the reason text the owner typed (the text itself is stored with the audit trail)
//   haltedSince  the start (epoch seconds) of the halt being cleared: a signature for one halt cannot clear a later one
//   deadline     epoch seconds, at most UNFREEZE_TTL_SECONDS in the future
// Verified by the same rule the vault applies to the owner (EOA ecrecover, or ERC-1271 for a Safe). A signature from anybody
// else, an empty or over-long reason, a stale `haltedSince` or an expired deadline clears nothing.
//
// Clearing the kernel's breaker does NOT unpause the vault: `unpause()` is an owner transaction on chain (the guardian cannot
// do it and neither can this service). Until the owner sends it, K-16 still sees the pause and every evaluate() still returns
// HOLD BREAKER_HALTED. All open findings are marked resolved by the owner; a NEW finding trips the breaker again.
import { keccak256Utf8 } from "@symbolon/schemas";
import type { Address, Hex32 } from "@symbolon/schemas";
import { hashTypedData } from "viem";
import { z } from "zod";
import type { EngagementChain } from "../chain/engagement-chain";
import type { ChainReader } from "../chain/reader";
import type { Db } from "../db/pool";
import * as base from "../db/repo";
import { ApiError } from "../errors";
import type { Logger } from "../log";
import type { Clock } from "../time";
import * as repo from "./repo";

export const UNFREEZE_TTL_SECONDS = 600;
export const MAX_REASON_CHARS = 200;

export const BREAKER_UNFREEZE_TYPES = {
  BreakerUnfreeze: [
    { name: "reasonHash", type: "bytes32" },
    { name: "haltedSince", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function breakerUnfreezeDigest(i: { chainId: number; vault: Address; reasonHash: Hex32; haltedSince: bigint; deadline: bigint }): Hex32 {
  return hashTypedData({
    domain: { name: "SymbolonVault", version: "1", chainId: i.chainId, verifyingContract: i.vault },
    types: BREAKER_UNFREEZE_TYPES,
    primaryType: "BreakerUnfreeze",
    message: { reasonHash: i.reasonHash, haltedSince: i.haltedSince, deadline: i.deadline },
  }) as Hex32;
}

export interface UnfreezeDeps {
  readonly db: Db;
  readonly chain: ChainReader;
  readonly engagementChain: Pick<EngagementChain, "isValidSignature">;
  readonly clock: Clock;
  readonly logger: Logger;
}

const BodySchema = z.strictObject({
  reason: z.string().min(1).max(MAX_REASON_CHARS),
  haltedSince: z.string().regex(/^[0-9]{1,15}$/),
  deadline: z.string().regex(/^[0-9]{1,15}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{2,8192}$/),
});

export interface UnfreezeResult {
  readonly halted: false;
  /** true when the vault is still paused on chain: the owner must send unpause() from their wallet. */
  readonly vaultStillPaused: boolean;
  readonly findingsResolved: number;
}

export async function unfreeze(d: UnfreezeDeps, tenantId: string, rawBody: unknown): Promise<UnfreezeResult> {
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) throw new ApiError("BAD_REQUEST", "not a valid unfreeze request");
  const b = parsed.data;
  if (b.reason.trim() === "" || [...b.reason].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) throw new ApiError("BAD_REQUEST", "a plain-text reason is required");
  const tenant = await base.getTenant(d.db, tenantId);
  if (tenant === null || tenant.vaultAddress === null) throw new ApiError("NOT_FOUND", "not found");
  const owner = await d.db.query<{ owner_address: string }>("select owner_address from tenants where id = $1", [tenantId]);
  const ownerAddress = owner.rows[0]?.owner_address;
  if (ownerAddress === undefined) throw new ApiError("NOT_FOUND", "not found");

  const breaker = await repo.loadBreakerRow(d.db, tenantId);
  if (!breaker.halted || breaker.since === null) throw new ApiError("CONFLICT", "the breaker is not halted");
  if (BigInt(b.haltedSince) !== breaker.since) throw new ApiError("CONFLICT", "the signature is for a different halt");
  const nowSec = BigInt(Math.floor(d.clock() / 1000));
  const deadline = BigInt(b.deadline);
  if (deadline <= nowSec) throw new ApiError("CONFLICT", "the unfreeze request has expired");
  if (deadline > nowSec + BigInt(UNFREEZE_TTL_SECONDS)) throw new ApiError("BAD_REQUEST", "the unfreeze deadline is later than it may be");

  const digest = breakerUnfreezeDigest({ chainId: tenant.chainId, vault: tenant.vaultAddress as Address, reasonHash: keccak256Utf8(b.reason), haltedSince: breaker.since, deadline });
  const ok = await d.engagementChain.isValidSignature(ownerAddress as Address, digest, b.signature as `0x${string}`).catch(() => false); // an unreadable ERC-1271 wallet is a refusal, never a pass
  if (!ok) throw new ApiError("BAD_SIGNATURE", "the signature is not the owner's unfreeze for this halt");

  const resolved = await d.db.tx(async (q) => {
    await base.lockTenantForDecisions(q, tenantId);
    const again = await repo.loadBreakerRow(q, tenantId);
    if (!again.halted || again.since !== breaker.since) throw new ApiError("CONFLICT", "the breaker changed; sign again");
    const n = await repo.resolveOpenFindings(q, tenantId, `owner:${ownerAddress.toLowerCase().slice(0, 42)}`);
    await repo.clearBreakerRow(q, tenantId, `owner:${ownerAddress.toLowerCase()}`, b.reason);
    await base.writeAudit(q, `owner:${ownerAddress.toLowerCase()}`, "breaker.unfrozen", { tenantId, haltedSince: b.haltedSince, reasonHash: keccak256Utf8(b.reason), reason: b.reason, findingsResolved: n });
    return n;
  });
  // unknown (read failed) is reported as still paused: tell the owner to check rather than claim the vault is live
  const paused = await d.chain.snapshot(tenant.vaultAddress as Address).then((x) => x.paused, () => true);
  d.logger.info("breaker.unfrozen", { tenantId });
  return { halted: false, vaultStillPaused: paused, findingsResolved: resolved };
}
