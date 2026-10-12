// Engagement terms: the request schema, the deterministic draft, and the EIP-712 messages the parties sign (docs/05 s2).
// Pure: no clock, no randomness (ids come in), no I/O. The signed `termsHash` is computed here by @symbolon/schemas
// (computeTermsHash), never taken from the request, and every typed-data object is rebuilt from the STORED terms, so what
// the owner and the payee sign is exactly what the kernel later checks (INV-20 in spirit) and what the vault receives.
import {
  AddressSchema,
  AmountSchema,
  EIP712_MESSAGE_SCHEMAS,
  EngagementSchema,
  EvidenceRequirementSchema,
  ISODateTimeSchema,
  PaymentTermsSchema,
  PositiveAmountSchema,
  UUIDSchema,
  computeTermsHash,
  deriveEntityId,
  deriveMilestoneId,
  eip712Digest,
  epochSecondsFromIso,
  symbolonDomain,
  text,
  toTypedDataJson,
} from "@symbolon/schemas";
import type { Address, Engagement, Hex32, TypedDataJson } from "@symbolon/schemas";
import * as z from "zod";

/** The registration nonce. An engagement id can be registered exactly once, ever (QUESTIONS WP-07 item 5), so it is fixed. */
export const REGISTRATION_NONCE = "1";

const MilestoneInputSchema = z.strictObject({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "expected a lowercase slug"),
  // Client-chosen so that POST /engagements is idempotent; the kernel generates one when absent.
  uuid: UUIDSchema.optional(),
  description: text(2000),
  amountBaseUnits: PositiveAmountSchema,
  partialAllowed: z.boolean(),
  immediate: z.boolean(),
  dueDate: ISODateTimeSchema.nullable(),
  category: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, "expected a lowercase category key"),
  evidenceSpec: z.array(EvidenceRequirementSchema).max(16),
});

export const CreateEngagementBodySchema = z
  .strictObject({
    // Exactly one of slug | uuid derives the engagementId = keccak256(JCS({tenantId, slug|uuid})) (docs/05 s1).
    slug: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/, "expected a lowercase slug").optional(),
    uuid: UUIDSchema.optional(),
    owner: AddressSchema,
    payee: AddressSchema,
    payeeLabel: text(200),
    capBaseUnits: AmountSchema,
    start: ISODateTimeSchema,
    end: ISODateTimeSchema,
    sequential: z.boolean(),
    milestones: z.array(MilestoneInputSchema).min(1).max(64),
    paymentTerms: PaymentTermsSchema.nullable(),
  })
  .superRefine((b, ctx) => {
    if ((b.slug === undefined) === (b.uuid === undefined)) ctx.addIssue({ code: "custom", message: "give exactly one of slug or uuid" });
  });
export type CreateEngagementBody = z.infer<typeof CreateEngagementBodySchema>;

export const SignBodySchema = z.strictObject({
  role: z.enum(["owner", "payee"]),
  signature: z.string().max(2 + 8192).regex(/^0x(?:[0-9a-fA-F]{2})+$/, "expected hex bytes"),
  // What the signer saw. Optional, but when given it must equal the stored termsHash (a mismatch is refused, not "fixed").
  termsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
export type SignBody = z.infer<typeof SignBodySchema>;

export class TermsError extends Error {
  readonly code: "OWNER_MISMATCH" | "BAD_PAYEE" | "BAD_CAP" | "BAD_WINDOW";
  constructor(code: TermsError["code"], message: string) {
    super(message);
    this.name = "TermsError";
    this.code = code;
  }
}

export interface DraftContext {
  readonly tenantId: string;
  /** tenants.owner_address: the vault owner. The vault rejects any other owner (OwnerMismatch), so the kernel does first. */
  readonly tenantOwner: string;
  readonly vault: Address;
  readonly currencyDecimals: number;
  readonly newUuid: () => string;
}

/** The DRAFT engagement for a validated request, with its termsHash computed here. */
export function buildDraft(body: CreateEngagementBody, c: DraftContext): Engagement {
  if (body.owner.toLowerCase() !== c.tenantOwner.toLowerCase()) throw new TermsError("OWNER_MISMATCH", "owner is not the vault owner of this tenant");
  const zero = "0x0000000000000000000000000000000000000000";
  const payee = body.payee.toLowerCase();
  if (payee === zero || payee === body.owner.toLowerCase() || payee === c.vault.toLowerCase()) {
    throw new TermsError("BAD_PAYEE", "payee must not be the zero address, the owner or the vault");
  }
  if (BigInt(body.capBaseUnits) === 0n) throw new TermsError("BAD_CAP", "cap must be greater than zero");
  if (epochSecondsFromIso(body.start) > epochSecondsFromIso(body.end)) throw new TermsError("BAD_WINDOW", "start must not be after end");
  const engagementId = deriveEntityId(body.slug !== undefined ? { tenantId: c.tenantId, slug: body.slug } : { tenantId: c.tenantId, uuid: body.uuid as string });
  const base: Engagement = {
    engagementId,
    tenantId: c.tenantId,
    owner: body.owner,
    payee: body.payee,
    payeeLabel: body.payeeLabel,
    currency: "USDC",
    currencyDecimals: c.currencyDecimals,
    capBaseUnits: body.capBaseUnits,
    start: body.start,
    end: body.end,
    sequential: body.sequential,
    milestones: body.milestones.map((m) => ({
      milestoneId: deriveMilestoneId({ tenantId: c.tenantId, uuid: m.uuid ?? c.newUuid() }),
      slug: m.slug,
      description: m.description,
      amountBaseUnits: m.amountBaseUnits,
      partialAllowed: m.partialAllowed,
      immediate: m.immediate,
      dueDate: m.dueDate,
      category: m.category,
      evidenceSpec: m.evidenceSpec,
      status: "PENDING" as const,
    })),
    paymentTerms: body.paymentTerms,
    termsHash: `0x${"00".repeat(32)}`,
    ownerSig: null,
    payeeSig: null,
    nonce: REGISTRATION_NONCE,
    status: "DRAFT",
    registeredTx: null,
  };
  return EngagementSchema.parse({ ...base, termsHash: computeTermsHash(base) });
}

// --- the messages the parties sign ----------------------------------------------------------------------------------------

/** EngagementTerms message from the stored terms. `termsHash` is the stored one: callers verify it equals computeTermsHash first. */
export function engagementTermsMessage(e: Engagement) {
  return EIP712_MESSAGE_SCHEMAS.EngagementTerms.parse({
    engagementId: e.engagementId,
    owner: e.owner,
    payee: e.payee,
    cap: e.capBaseUnits,
    start: epochSecondsFromIso(e.start).toString(),
    end: epochSecondsFromIso(e.end).toString(),
    termsHash: e.termsHash,
    nonce: e.nonce,
  });
}

export function engagementTypedData(e: Engagement, chainId: number, vault: Address): TypedDataJson<"EngagementTerms"> {
  return toTypedDataJson("EngagementTerms", symbolonDomain(chainId, vault), engagementTermsMessage(e));
}

export function engagementDigest(e: Engagement, chainId: number, vault: Address): Hex32 {
  return eip712Digest(engagementTypedData(e, chainId, vault));
}

export function payeeChangeTypedData(m: { engagementId: Hex32; oldPayee: Address; newPayee: Address; nonce: string }, chainId: number, vault: Address): TypedDataJson<"PayeeChange"> {
  return toTypedDataJson("PayeeChange", symbolonDomain(chainId, vault), EIP712_MESSAGE_SCHEMAS.PayeeChange.parse(m));
}
