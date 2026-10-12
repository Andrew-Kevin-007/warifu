// The engagement service (WP-12; docs/05 section 4): typed-data creation, signature collection (owner, payee), the
// registerEngagement relay and the payee-change flow. Authority comes ONLY from EIP-712 signatures that this module verifies
// against the stored signed terms; the web session proves nothing here (docs/05 s4).
//
// Invariants (each has a test):
//  - an engagement is ACTIVE only after the indexer has read a confirmed EngagementRegistered that matches the stored terms;
//    this module never writes ACTIVE, and submitting a transaction is not registration (apply.ts / indexer.ts);
//  - the typed data is rebuilt from the stored terms every time, with the stored termsHash recomputed first: a stored row
//    that no longer hashes, or a signer who saw another termsHash, is TERMS_MISMATCH and nothing is stored or relayed;
//  - a signature is stored only if it verifies for the right signer under the vault's own domain (chain id + verifying
//    contract) - the same rule the vault applies (ECDSA for an EOA, ERC-1271 for a contract);
//  - the relayer only ever submits what the parties signed, after a simulation; no relayer configured = signatures are kept
//    and the engagement simply stays REGISTERING;
//  - payee changes use strictly increasing nonces (QUESTIONS WP-07 item 5) and the kernel never submits an execution before
//    the vault's eta.
import { randomUUID } from "node:crypto";
import { ChainError } from "@symbolon/chain";
import { AddressSchema, computeTermsHash, eip712Digest, eip712DomainSeparator, epochSecondsFromIso, symbolonDomain } from "@symbolon/schemas";
import type { Address, Engagement, Hex32 } from "@symbolon/schemas";
import * as z from "zod";
import type { Hex } from "viem";
import type { ChainReader } from "../chain/reader";
import type { EngagementChain } from "../chain/engagement-chain";
import { RelayError } from "../chain/relayer";
import type { VaultRelayer } from "../chain/relayer";
import { ContextError, resolveTenantVault } from "../context/build";
import type { Db, Queryable } from "../db/pool";
import * as base from "../db/repo";
import { ApiError } from "../errors";
import { errorFields } from "../log";
import type { Logger } from "../log";
import { contextFailure } from "../service/intents";
import * as repo from "./repo";
import type { PayeeChangeRow } from "./repo";
import { CreateEngagementBodySchema, SignBodySchema, TermsError, buildDraft, engagementTypedData, payeeChangeTypedData } from "./terms";

export interface EngagementServiceDeps {
  readonly db: Db;
  /** The context reader (engagement / payeeChangeLive on chain). */
  readonly chain: ChainReader;
  readonly engagementChain: EngagementChain;
  /** null = no relayer configured: signatures are collected, nothing is submitted. */
  readonly relayer: VaultRelayer | null;
  readonly logger: Logger;
  readonly newUuid?: () => string;
}

const FLOW_STATUSES = ["DRAFT", "AWAITING_PAYEE", "REGISTERING"] as const;

/** What a failed read means to the caller: the kernel could not see enough; nothing was changed. */
function unavailable(e: unknown, logger: Logger): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ContextError) return contextFailure(e, logger);
  if (e instanceof ChainError || e instanceof TypeError) {
    logger.warn("engagement.chain_unavailable", { ...errorFields(e) });
    return new ApiError("UNAVAILABLE", "the chain could not be read; nothing was changed", {}, { "Retry-After": "5" });
  }
  logger.error("engagement.failed", { ...errorFields(e) });
  return new ApiError("INTERNAL", "internal error; the request was not processed");
}

async function tenantOwner(q: Queryable, tenantId: string): Promise<string> {
  const r = await q.query<{ owner_address: string }>("select owner_address from tenants where id = $1", [tenantId]);
  const v = r.rows[0]?.owner_address;
  if (v === undefined) throw new ApiError("FORBIDDEN", "unknown tenant");
  return v;
}

interface Bound {
  readonly vault: Address;
  readonly chainId: number;
}

/**
 * The tenant's vault, plus proof that our typed-data domain is the vault's own: the vault's domainSeparator() must equal
 * the one computed from (name, version, chainId, vault). A wrong chain id or verifying contract can never produce a
 * signature the vault accepts, so it is refused before anyone signs.
 */
async function boundVault(s: EngagementServiceDeps, tenantId: string): Promise<Bound> {
  const tv = await resolveTenantVault(s.db, tenantId, s.chain);
  if (s.engagementChain.chainId !== tv.chainId) throw new ContextError("CHAIN_MISMATCH", "tenant chain differs from the configured RPC chain");
  const onChain = await s.engagementChain.domainSeparator(tv.vault);
  if (onChain !== eip712DomainSeparator(symbolonDomain(tv.chainId, tv.vault))) throw new ContextError("CHAIN_MISMATCH", "the vault's EIP-712 domain differs from the one derived for it");
  return tv;
}

const lower = (s: string): string => s.toLowerCase();
const asHex = (s: string): Hex => lower(s) as Hex;

function toTermsArgs(e: Engagement) {
  return {
    engagementId: e.engagementId,
    owner: e.owner,
    payee: e.payee,
    cap: BigInt(e.capBaseUnits),
    start: epochSecondsFromIso(e.start),
    end: epochSecondsFromIso(e.end),
    termsHash: e.termsHash,
    nonce: BigInt(e.nonce),
  };
}

// --- views ---------------------------------------------------------------------------------------------------------------------

export interface EngagementView {
  readonly engagementId: Hex32;
  readonly status: string;
  readonly termsHash: Hex32;
  readonly ownerSigned: boolean;
  readonly payeeSigned: boolean;
  readonly submittedTx: string | null;
  readonly registeredTx: string | null;
  readonly registrationError: string | null;
  /** present while signatures are still being collected */
  readonly typedData: unknown;
  readonly digest: Hex32 | null;
}

function view(e: Engagement, meta: repo.EngagementMeta, b: Bound): EngagementView {
  const open = meta.status === "DRAFT" || meta.status === "AWAITING_PAYEE" || meta.status === "REGISTERING";
  return {
    engagementId: e.engagementId,
    status: meta.status,
    termsHash: e.termsHash,
    ownerSigned: meta.ownerSig !== null,
    payeeSigned: meta.payeeSig !== null,
    submittedTx: meta.submittedTx,
    registeredTx: meta.registeredTx,
    registrationError: meta.registrationError,
    typedData: open ? engagementTypedData(e, b.chainId, b.vault) : null,
    digest: open ? eip712Digest(engagementTypedData(e, b.chainId, b.vault)) : null,
  };
}

// --- POST /engagements -----------------------------------------------------------------------------------------------------------

export async function createEngagement(s: EngagementServiceDeps, tenantId: string, raw: unknown): Promise<{ created: boolean; engagement: EngagementView }> {
  const parsed = CreateEngagementBodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("BAD_REQUEST", "not a valid engagement", { issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".").slice(0, 60)) });
  try {
    const b = await boundVault(s, tenantId);
    const owner = await tenantOwner(s.db, tenantId);
    const decimals = await s.engagementChain.verifiedDecimals(b.vault);
    let draft: Engagement;
    try {
      draft = buildDraft(parsed.data, { tenantId, tenantOwner: owner, vault: b.vault, currencyDecimals: decimals, newUuid: s.newUuid ?? randomUUID });
    } catch (e) {
      if (e instanceof TermsError) throw new ApiError("UNPROCESSABLE", "the terms are not acceptable", { code: e.code });
      throw e;
    }
    return await s.db.tx(async (q) => {
      await repo.lockEngagementFlow(q, draft.engagementId);
      const existing = await repo.getMeta(q, tenantId, draft.engagementId, true);
      if (existing !== null) {
        const same = existing.termsHash === draft.termsHash && (existing.status === "DRAFT" || existing.status === "AWAITING_PAYEE");
        if (!same) throw new ApiError("CONFLICT", "an engagement with this id already exists with different terms or state", { status: existing.status });
        return { created: false, engagement: view(draft, existing, b) };
      }
      try {
        await repo.insertDraft(q, draft);
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505") throw new ApiError("CONFLICT", "an engagement with this id already exists");
        throw e;
      }
      s.logger.info("engagement.created", { tenantId, engagementId: draft.engagementId });
      const meta = await repo.getMeta(q, tenantId, draft.engagementId);
      if (meta === null) throw new Error("engagement vanished after insert");
      return { created: true, engagement: view(draft, meta, b) };
    });
  } catch (e) {
    throw unavailable(e, s.logger);
  }
}

// --- GET /engagements/:id --------------------------------------------------------------------------------------------------------

export async function getEngagementView(s: EngagementServiceDeps, tenantId: string, engagementId: string): Promise<{ engagement: EngagementView; payeeChanges: ReturnType<typeof payeeChangeView>[] }> {
  try {
    const b = await boundVault(s, tenantId);
    const e = await base.loadEngagement(s.db, tenantId, engagementId);
    const meta = await repo.getMeta(s.db, tenantId, engagementId);
    if (e === null || meta === null) throw new ApiError("NOT_FOUND", "not found");
    const changes = await repo.listPayeeChanges(s.db, tenantId, engagementId);
    return { engagement: view(e, meta, b), payeeChanges: changes.map((c) => payeeChangeView(c, b)) };
  } catch (e) {
    throw unavailable(e, s.logger);
  }
}

// --- POST /engagements/:id/sign --------------------------------------------------------------------------------------------------

export async function signEngagement(s: EngagementServiceDeps, tenantId: string, engagementId: string, raw: unknown): Promise<EngagementView> {
  const parsed = SignBodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("BAD_REQUEST", "not a valid signature submission");
  const { role, termsHash: seenHash } = parsed.data;
  const signature = lower(parsed.data.signature);
  try {
    const b = await boundVault(s, tenantId);
    const e = await base.loadEngagement(s.db, tenantId, engagementId);
    if (e === null) throw new ApiError("NOT_FOUND", "not found");
    // 1. the terms we would have the party sign must still be the terms that were hashed
    if (computeTermsHash(e) !== e.termsHash) {
      s.logger.error("engagement.terms_row_inconsistent", { tenantId, engagementId });
      throw new ApiError("TERMS_MISMATCH", "the stored terms do not match their termsHash; refusing");
    }
    if (seenHash !== undefined && lower(seenHash) !== e.termsHash) throw new ApiError("TERMS_MISMATCH", "the signer saw a different termsHash than the stored terms");
    // 2. the signature must verify for the right signer under the vault's domain
    const signer = role === "owner" ? e.owner : e.payee;
    const digest = eip712Digest(engagementTypedData(e, b.chainId, b.vault));
    if (!(await s.engagementChain.isValidSignature(signer, digest, asHex(signature)))) {
      throw new ApiError("BAD_SIGNATURE", "the signature does not verify for this signer over these terms", { role });
    }
    // 3. store it (first signature per role wins; the same signature again is a no-op)
    const status = await s.db.tx(async (q) => {
      await repo.lockEngagementFlow(q, engagementId);
      const meta = await repo.getMeta(q, tenantId, engagementId, true);
      if (meta === null) throw new ApiError("NOT_FOUND", "not found");
      if (meta.termsHash !== e.termsHash) throw new ApiError("CONFLICT", "the engagement changed while signing");
      const have = role === "owner" ? meta.ownerSig : meta.payeeSig;
      if (have !== null) {
        if (have === signature) return meta.status;
        throw new ApiError("ALREADY_SIGNED", "this role has already signed these terms", { role });
      }
      if (!(FLOW_STATUSES as readonly string[]).includes(meta.status)) throw new ApiError("CONFLICT", "the engagement is not collecting signatures", { status: meta.status });
      const ownerSig = role === "owner" ? signature : meta.ownerSig;
      const payeeSig = role === "payee" ? signature : meta.payeeSig;
      const next = ownerSig !== null && payeeSig !== null ? "REGISTERING" : ownerSig !== null ? "AWAITING_PAYEE" : meta.status;
      await repo.storeSignature(q, tenantId, engagementId, role, signature, next);
      s.logger.info("engagement.signed", { tenantId, engagementId });
      return next;
    });
    if (status === "REGISTERING") await relayRegistration(s, tenantId, engagementId, b);
    const meta = await repo.getMeta(s.db, tenantId, engagementId);
    if (meta === null) throw new ApiError("NOT_FOUND", "not found");
    return view(e, meta, b);
  } catch (e) {
    throw unavailable(e, s.logger);
  }
}

/**
 * Submit registerEngagement for an engagement that holds both signatures. Exactly-once per submission: the flow lock is held
 * across the call, a stored submitted_tx blocks a second submission, and the vault itself refuses a second registration
 * (EngagementExists). A reverted submission clears submitted_tx (indexer) so signing again retries. Never sets ACTIVE.
 */
async function relayRegistration(s: EngagementServiceDeps, tenantId: string, engagementId: string, b: Bound): Promise<void> {
  if (s.relayer === null) {
    s.logger.warn("engagement.no_relayer", { tenantId, engagementId });
    return;
  }
  const relayer = s.relayer;
  await s.db.tx(async (q) => {
    await repo.lockEngagementFlow(q, engagementId);
    const meta = await repo.getMeta(q, tenantId, engagementId, true);
    if (meta === null || meta.status !== "REGISTERING" || meta.submittedTx !== null || meta.ownerSig === null || meta.payeeSig === null) return;
    const e = await base.loadEngagement(q, tenantId, engagementId);
    if (e === null || computeTermsHash(e) !== e.termsHash) {
      await repo.markRelayFailed(q, tenantId, engagementId, "TERMS_MISMATCH");
      return;
    }
    try {
      const { txHash } = await relayer.registerEngagement({ vault: b.vault, terms: toTermsArgs(e), ownerSig: asHex(meta.ownerSig), payeeSig: asHex(meta.payeeSig) });
      await repo.markSubmitted(q, tenantId, engagementId, txHash);
      s.logger.info("engagement.registration_submitted", { tenantId, engagementId, txHash });
    } catch (err) {
      if (!(err instanceof RelayError)) throw err;
      const code = err.revertName ?? "RELAY_FAILED";
      await repo.markRelayFailed(q, tenantId, engagementId, code);
      s.logger.warn("engagement.registration_refused", { tenantId, engagementId, reasonCode: code });
    }
  });
}

// --- payee change ---------------------------------------------------------------------------------------------------------------

const PayeeChangeBodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("initiate"), newPayee: AddressSchema }),
  z.strictObject({
    action: z.literal("sign"),
    changeId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    role: z.enum(["owner", "oldPayee", "newPayee"]),
    signature: z.string().max(2 + 8192).regex(/^0x(?:[0-9a-fA-F]{2})+$/),
  }),
  z.strictObject({ action: z.literal("execute"), changeId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }),
]);

export function payeeChangeView(c: PayeeChangeRow, b: Bound) {
  const collecting = c.status === "COLLECTING";
  const td = payeeChangeTypedData({ engagementId: c.engagementId as Hex32, oldPayee: c.oldPayee as Address, newPayee: c.newPayee as Address, nonce: c.nonce }, b.chainId, b.vault);
  return {
    changeId: c.id,
    engagementId: c.engagementId,
    status: c.status,
    oldPayee: c.oldPayee,
    newPayee: c.newPayee,
    nonce: c.nonce,
    signed: { owner: c.ownerSig !== null, oldPayee: c.oldSig !== null, newPayee: c.newSig !== null },
    submittedTx: c.submittedTx,
    proposedTx: c.proposedTx,
    executedTx: c.executedTx,
    etaEpoch: c.etaEpoch === null ? null : c.etaEpoch.toString(),
    error: c.error,
    typedData: collecting ? td : null,
    digest: collecting ? eip712Digest(td) : null,
  };
}

type PayeeChangeResult = ReturnType<typeof payeeChangeView>;

export async function payeeChangeFlow(s: EngagementServiceDeps, tenantId: string, engagementId: string, raw: unknown): Promise<{ created: boolean; change: PayeeChangeResult }> {
  const parsed = PayeeChangeBodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("BAD_REQUEST", "not a valid payee-change request");
  const body = parsed.data;
  try {
    const b = await boundVault(s, tenantId);
    switch (body.action) {
      case "initiate":
        return { created: true, change: await initiate(s, tenantId, engagementId, body.newPayee, b) };
      case "sign":
        return { created: false, change: await signChange(s, tenantId, engagementId, body.changeId, body.role, lower(body.signature), b) };
      case "execute":
        return { created: false, change: await executeChange(s, tenantId, engagementId, body.changeId, b) };
      default: {
        const unknown: never = body;
        void unknown;
        throw new ApiError("BAD_REQUEST", "unknown action");
      }
    }
  } catch (e) {
    throw unavailable(e, s.logger);
  }
}

async function initiate(s: EngagementServiceDeps, tenantId: string, engagementId: string, newPayee: Address, b: Bound): Promise<PayeeChangeResult> {
  const e = await base.loadEngagement(s.db, tenantId, engagementId);
  if (e === null) throw new ApiError("NOT_FOUND", "not found");
  if (e.status !== "ACTIVE") throw new ApiError("CONFLICT", "only an ACTIVE engagement can change payee", { status: e.status });
  const onChain = await s.chain.engagement(b.vault, engagementId as Hex32);
  if (onChain === null || !onChain.active) throw new ApiError("CONFLICT", "the engagement is not active on chain");
  if (lower(onChain.payee) !== lower(e.payee)) throw new ApiError("CONFLICT", "the on-chain payee differs from the stored payee; resolve before changing it");
  if (await s.chain.payeeChangeLive(b.vault, engagementId as Hex32)) throw new ApiError("CONFLICT", "a payee change is already pending on chain");
  const zero = "0x0000000000000000000000000000000000000000";
  if (lower(newPayee) === zero || lower(newPayee) === lower(e.payee) || lower(newPayee) === lower(e.owner) || lower(newPayee) === lower(b.vault)) {
    throw new ApiError("UNPROCESSABLE", "the new payee is not acceptable");
  }
  const chainNonce = await s.engagementChain.engagementNonce(b.vault, engagementId as Hex32);
  return s.db.tx(async (q) => {
    await repo.lockEngagementFlow(q, engagementId);
    if ((await repo.openPayeeChange(q, tenantId, engagementId)) !== null) throw new ApiError("CONFLICT", "a payee change is already in progress");
    const dbNonce = await repo.maxPayeeChangeNonce(q, engagementId);
    const nonce = (chainNonce > dbNonce ? chainNonce : dbNonce) + 1n; // strictly increasing, above everything the vault has seen
    const id = await repo.insertPayeeChange(q, { tenantId, engagementId, oldPayee: onChain.payee, newPayee, nonce: nonce.toString() });
    s.logger.info("payee_change.initiated", { tenantId, engagementId, changeId: id });
    const row = await repo.getPayeeChange(q, tenantId, id);
    if (row === null) throw new Error("payee change vanished after insert");
    return payeeChangeView(row, b);
  });
}

async function signChange(s: EngagementServiceDeps, tenantId: string, engagementId: string, changeId: string, role: "owner" | "oldPayee" | "newPayee", signature: string, b: Bound): Promise<PayeeChangeResult> {
  const c0 = await repo.getPayeeChange(s.db, tenantId, changeId);
  if (c0 === null || c0.engagementId !== engagementId) throw new ApiError("NOT_FOUND", "not found");
  const e = await base.loadEngagement(s.db, tenantId, engagementId);
  if (e === null) throw new ApiError("NOT_FOUND", "not found");
  const td = payeeChangeTypedData({ engagementId: c0.engagementId as Hex32, oldPayee: c0.oldPayee as Address, newPayee: c0.newPayee as Address, nonce: c0.nonce }, b.chainId, b.vault);
  const signer = role === "owner" ? e.owner : role === "oldPayee" ? c0.oldPayee : c0.newPayee;
  if (!(await s.engagementChain.isValidSignature(signer as Address, eip712Digest(td), asHex(signature)))) {
    throw new ApiError("BAD_SIGNATURE", "the signature does not verify for this signer over this payee change", { role });
  }
  const ready = await s.db.tx(async (q) => {
    await repo.lockEngagementFlow(q, engagementId);
    const c = await repo.getPayeeChange(q, tenantId, changeId, true);
    if (c === null) throw new ApiError("NOT_FOUND", "not found");
    if (c.status !== "COLLECTING") throw new ApiError("CONFLICT", "this payee change is not collecting signatures", { status: c.status });
    const have = role === "owner" ? c.ownerSig : role === "oldPayee" ? c.oldSig : c.newSig;
    if (have !== null && have !== signature) throw new ApiError("ALREADY_SIGNED", "this role has already signed", { role });
    if (have === null) await repo.storePayeeChangeSig(q, changeId, role, signature);
    const after = await repo.getPayeeChange(q, tenantId, changeId, true);
    return after !== null && after.ownerSig !== null && after.oldSig !== null && after.newSig !== null;
  });
  if (ready) await relayProposal(s, tenantId, engagementId, changeId, b);
  const row = await repo.getPayeeChange(s.db, tenantId, changeId);
  if (row === null) throw new ApiError("NOT_FOUND", "not found");
  return payeeChangeView(row, b);
}

async function relayProposal(s: EngagementServiceDeps, tenantId: string, engagementId: string, changeId: string, b: Bound): Promise<void> {
  if (s.relayer === null) {
    s.logger.warn("engagement.no_relayer", { tenantId, engagementId });
    return;
  }
  const relayer = s.relayer;
  await s.db.tx(async (q) => {
    await repo.lockEngagementFlow(q, engagementId);
    const c = await repo.getPayeeChange(q, tenantId, changeId, true);
    if (c === null || c.status !== "COLLECTING" || c.ownerSig === null || c.oldSig === null || c.newSig === null) return;
    try {
      const { txHash } = await relayer.proposePayeeChange({
        vault: b.vault,
        change: { engagementId: c.engagementId as Hex32, oldPayee: c.oldPayee as Address, newPayee: c.newPayee as Address, nonce: BigInt(c.nonce) },
        ownerSig: asHex(c.ownerSig), oldSig: asHex(c.oldSig), newSig: asHex(c.newSig),
      });
      await repo.setPayeeChangeStatus(q, c.id, "SUBMITTED", { submittedTx: txHash, error: null });
      s.logger.info("payee_change.submitted", { tenantId, engagementId, changeId, txHash });
    } catch (err) {
      if (!(err instanceof RelayError)) throw err;
      // The vault refused (paused, nonce used, bad signature...). Stay COLLECTING so the same signatures can be retried or replaced.
      await repo.setPayeeChangeStatus(q, c.id, "COLLECTING", { error: err.revertName ?? "RELAY_FAILED" });
      s.logger.warn("payee_change.refused", { tenantId, engagementId, changeId, reasonCode: err.revertName ?? "RELAY_FAILED" });
    }
  });
}

async function executeChange(s: EngagementServiceDeps, tenantId: string, engagementId: string, changeId: string, b: Bound): Promise<PayeeChangeResult> {
  const c0 = await repo.getPayeeChange(s.db, tenantId, changeId);
  if (c0 === null || c0.engagementId !== engagementId) throw new ApiError("NOT_FOUND", "not found");
  if (c0.status !== "PROPOSED") throw new ApiError("CONFLICT", "only a payee change the vault has proposed (and the indexer has read) can be executed", { status: c0.status });
  // The vault's own state decides: it must hold this exact pending change, live (a pause cancels it), and its delay must have passed.
  const pending = await s.engagementChain.pendingPayee(b.vault, engagementId as Hex32);
  if (pending === null || !pending.live || lower(pending.newPayee) !== lower(c0.newPayee)) throw new ApiError("CONFLICT", "the vault holds no live pending change for this payee");
  const block = await s.engagementChain.latestBlock();
  if (block.timestamp < pending.eta) {
    throw new ApiError("TOO_EARLY", "the vault's payee-change delay has not passed", { etaEpoch: pending.eta.toString(), chainTimeEpoch: block.timestamp.toString() });
  }
  if (s.relayer === null) throw new ApiError("UNAVAILABLE", "no relayer is configured", {}, { "Retry-After": "30" });
  const relayer = s.relayer;
  await s.db.tx(async (q) => {
    await repo.lockEngagementFlow(q, engagementId);
    const c = await repo.getPayeeChange(q, tenantId, changeId, true);
    if (c === null || c.status !== "PROPOSED") throw new ApiError("CONFLICT", "this payee change is no longer waiting to execute");
    try {
      const { txHash } = await relayer.executePayeeChange({ vault: b.vault, engagementId: engagementId as Hex32 });
      await repo.setPayeeChangeStatus(q, c.id, "EXECUTING", { executedTx: txHash, error: null });
      s.logger.info("payee_change.executing", { tenantId, engagementId, changeId, txHash });
    } catch (err) {
      if (!(err instanceof RelayError)) throw err;
      await repo.setPayeeChangeStatus(q, c.id, "PROPOSED", { error: err.revertName ?? "RELAY_FAILED" });
    }
  });
  const row = await repo.getPayeeChange(s.db, tenantId, changeId);
  if (row === null) throw new ApiError("NOT_FOUND", "not found");
  return payeeChangeView(row, b);
}
