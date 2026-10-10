// EIP-712 typed data for every Symbolon struct (docs/05 §2 "EIP-712 typed data").
// Domain: name "SymbolonVault", version "1", chainId, verifyingContract = vault.
//
// JSON form ("typed data JSON"): the eth_signTypedData_v4 payload with `types.EIP712Domain` included,
// uintN values as canonical decimal strings, bytes32 as lowercase hex, addresses EIP-55. That object is
// what gets JCS-hashed (ApprovalView.typedDataHash) and what wallets sign; eip712Digest() hashes it
// per EIP-712 via viem. ethers' TypedDataEncoder reproduces every digest in vectors/eip712.json (xcheck).
import { hashDomain, hashStruct, hashTypedData } from "viem";
import * as z from "zod";
import { VERDICT_CODE, type Verdict } from "./enums";
import { keccak256Utf8 } from "./hash";
import { AddressSchema, ChainIdSchema, Hex32Schema, Uint256StringSchema, Uint64StringSchema, type Address, type Hex32 } from "./primitives";

export const EIP712_DOMAIN_NAME = "SymbolonVault";
export const EIP712_DOMAIN_VERSION = "1";

export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Field order is part of the type hash: never reorder. */
export const EIP712_TYPES = {
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
  Attestation: [
    { name: "intentId", type: "bytes32" },
    { name: "engagementId", type: "bytes32" },
    { name: "milestoneId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "receiptHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
  OwnerApproval: [
    { name: "intentId", type: "bytes32" },
    { name: "receiptHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  PayeeChange: [
    { name: "engagementId", type: "bytes32" },
    { name: "oldPayee", type: "address" },
    { name: "newPayee", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
  // Off-chain only (owner). `override` is a Solidity keyword, so this struct never exists in Solidity.
  MilestoneAck: [
    { name: "milestoneId", type: "bytes32" },
    { name: "artifactHash", type: "bytes32" },
    { name: "override", type: "bool" },
    { name: "deadline", type: "uint64" },
  ],
  // Off-chain only (payee, P1).
  ReceiptAck: [
    { name: "receiptHash", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "signedAt", type: "uint64" },
  ],
  // Kernel, off-chain / verifier. `verdict` is VERDICT_CODE (RELEASE=1 … REPLAY=5).
  Receipt: [
    { name: "receiptHash", type: "bytes32" },
    { name: "intentId", type: "bytes32" },
    { name: "verdict", type: "uint8" },
    { name: "policyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export type Eip712PrimaryType = keyof typeof EIP712_TYPES;
export const EIP712_PRIMARY_TYPES = Object.keys(EIP712_TYPES) as Eip712PrimaryType[];

/** The EIP-712 `encodeType` string, e.g. "OwnerApproval(bytes32 intentId,bytes32 receiptHash,uint256 amount,uint64 deadline)". */
export function eip712TypeString(primaryType: Eip712PrimaryType): string {
  return `${primaryType}(${EIP712_TYPES[primaryType].map((f) => `${f.type} ${f.name}`).join(",")})`;
}

// --- Domain and messages (JSON form) ---------------------------------------------------------------
export const Eip712DomainSchema = z.strictObject({
  name: z.literal(EIP712_DOMAIN_NAME),
  version: z.literal(EIP712_DOMAIN_VERSION),
  chainId: ChainIdSchema,
  verifyingContract: AddressSchema,
});
export type Eip712Domain = z.infer<typeof Eip712DomainSchema>;

export function symbolonDomain(chainId: number, verifyingContract: Address): Eip712Domain {
  return Eip712DomainSchema.parse({ name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId, verifyingContract });
}

const Uint8StringSchema = z.string().regex(/^(0|[1-9][0-9]{0,2})$/).refine((s) => BigInt(s) <= 255n, "exceeds uint8");

export const EIP712_MESSAGE_SCHEMAS = {
  EngagementTerms: z.strictObject({
    engagementId: Hex32Schema,
    owner: AddressSchema,
    payee: AddressSchema,
    cap: Uint256StringSchema,
    start: Uint64StringSchema,
    end: Uint64StringSchema,
    termsHash: Hex32Schema,
    nonce: Uint256StringSchema,
  }),
  Attestation: z.strictObject({
    intentId: Hex32Schema,
    engagementId: Hex32Schema,
    milestoneId: Hex32Schema,
    payee: AddressSchema,
    amount: Uint256StringSchema,
    receiptHash: Hex32Schema,
    deadline: Uint64StringSchema,
  }),
  OwnerApproval: z.strictObject({
    intentId: Hex32Schema,
    receiptHash: Hex32Schema,
    amount: Uint256StringSchema,
    deadline: Uint64StringSchema,
  }),
  PayeeChange: z.strictObject({
    engagementId: Hex32Schema,
    oldPayee: AddressSchema,
    newPayee: AddressSchema,
    nonce: Uint256StringSchema,
  }),
  MilestoneAck: z.strictObject({
    milestoneId: Hex32Schema,
    artifactHash: Hex32Schema,
    override: z.boolean(),
    deadline: Uint64StringSchema,
  }),
  ReceiptAck: z.strictObject({
    receiptHash: Hex32Schema,
    payee: AddressSchema,
    signedAt: Uint64StringSchema,
  }),
  Receipt: z.strictObject({
    receiptHash: Hex32Schema,
    intentId: Hex32Schema,
    verdict: Uint8StringSchema.refine((s) => Object.values(VERDICT_CODE).includes(parseInt(s, 10)), "unknown verdict code"),
    policyHash: Hex32Schema,
    issuedAt: Uint64StringSchema,
  }),
} as const;

export type Eip712Message<P extends Eip712PrimaryType> = z.infer<(typeof EIP712_MESSAGE_SCHEMAS)[P]>;

function typedDataSchemaFor<P extends Eip712PrimaryType>(primaryType: P) {
  const fieldSchema = z.strictObject({ name: z.string(), type: z.string() });
  return z
    .strictObject({
      domain: Eip712DomainSchema,
      types: z.strictObject({
        EIP712Domain: z.array(fieldSchema),
        [primaryType]: z.array(fieldSchema),
      } as Record<"EIP712Domain" | P, z.ZodArray<typeof fieldSchema>>),
      primaryType: z.literal(primaryType),
      message: EIP712_MESSAGE_SCHEMAS[primaryType] as (typeof EIP712_MESSAGE_SCHEMAS)[P],
    })
    .superRefine((td, ctx) => {
      // The type arrays must be exactly the canonical ones: a typed-data object cannot redefine a struct.
      const types = td.types as Record<string, Array<{ name: string; type: string }> | undefined>;
      if (!sameFields(types.EIP712Domain, EIP712_DOMAIN_TYPE)) {
        ctx.addIssue({ code: "custom", path: ["types", "EIP712Domain"], message: "non-canonical EIP712Domain type" });
      }
      if (!sameFields(types[primaryType], EIP712_TYPES[primaryType])) {
        ctx.addIssue({ code: "custom", path: ["types", primaryType], message: `non-canonical ${primaryType} type` });
      }
    });
}

function sameFields(
  actual: ReadonlyArray<{ name: string; type: string }> | undefined,
  expected: ReadonlyArray<{ readonly name: string; readonly type: string }>,
): boolean {
  return actual !== undefined && actual.length === expected.length && actual.every((f, i) => f.name === expected[i]?.name && f.type === expected[i]?.type);
}

export const TYPED_DATA_SCHEMAS = {
  EngagementTerms: typedDataSchemaFor("EngagementTerms"),
  Attestation: typedDataSchemaFor("Attestation"),
  OwnerApproval: typedDataSchemaFor("OwnerApproval"),
  PayeeChange: typedDataSchemaFor("PayeeChange"),
  MilestoneAck: typedDataSchemaFor("MilestoneAck"),
  ReceiptAck: typedDataSchemaFor("ReceiptAck"),
  Receipt: typedDataSchemaFor("Receipt"),
} as const;

export const OwnerApprovalTypedDataSchema = TYPED_DATA_SCHEMAS.OwnerApproval;
export type OwnerApprovalTypedData = z.infer<typeof OwnerApprovalTypedDataSchema>;

export interface TypedDataJson<P extends Eip712PrimaryType = Eip712PrimaryType> {
  domain: Eip712Domain;
  types: { EIP712Domain: Array<{ name: string; type: string }> } & { [K in P]: Array<{ name: string; type: string }> };
  primaryType: P;
  message: Eip712Message<P>;
}

/**
 * Low-level constructor of the canonical typed-data JSON for any struct (validates the message).
 * For OwnerApproval, the approval screen must obtain typed data ONLY from
 * packages/receipts buildApprovalTypedData(view) (INV-20), which is built on this function.
 */
export function toTypedDataJson<P extends Eip712PrimaryType>(primaryType: P, domain: Eip712Domain, message: Eip712Message<P>): TypedDataJson<P> {
  const td = {
    domain: Eip712DomainSchema.parse(domain),
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE.map((f) => ({ name: f.name, type: f.type })),
      [primaryType]: EIP712_TYPES[primaryType].map((f) => ({ name: f.name, type: f.type })),
    },
    primaryType,
    message: EIP712_MESSAGE_SCHEMAS[primaryType].parse(message),
  };
  return td as unknown as TypedDataJson<P>;
}

function toViemValue(type: string, v: unknown): unknown {
  if (/^uint\d+$/.test(type)) {
    if (typeof v !== "string") throw new TypeError(`expected decimal string for ${type}`);
    return BigInt(v);
  }
  return v;
}

function toViemArgs<P extends Eip712PrimaryType>(td: TypedDataJson<P>) {
  const primaryType: Eip712PrimaryType = td.primaryType;
  const parsed = TYPED_DATA_SCHEMAS[primaryType].parse(td) as unknown as TypedDataJson<P>;
  const fields = EIP712_TYPES[primaryType].map((f) => ({ name: f.name, type: f.type }));
  const message: Record<string, unknown> = {};
  const raw = parsed.message as Record<string, unknown>;
  for (const f of fields) message[f.name] = toViemValue(f.type, raw[f.name]);
  return { domain: { ...parsed.domain, chainId: BigInt(parsed.domain.chainId) }, fields, primaryType, message };
}

/** EIP-712 digest (`\x19\x01 ‖ domainSeparator ‖ hashStruct(message)`) of a typed-data JSON object. */
export function eip712Digest<P extends Eip712PrimaryType>(td: TypedDataJson<P>): Hex32 {
  const { domain, fields, primaryType, message } = toViemArgs(td);
  return hashTypedData({ domain, types: { [primaryType]: fields }, primaryType, message });
}

/** keccak256(encodeType(primaryType)): the constant a Solidity `*_TYPEHASH` must equal. */
export function eip712TypeHash(primaryType: Eip712PrimaryType): Hex32 {
  return keccak256Utf8(eip712TypeString(primaryType));
}

/** hashStruct(EIP712Domain, domain): what OZ `EIP712._domainSeparatorV4()` returns for the vault. */
export function eip712DomainSeparator(domain: Eip712Domain): Hex32 {
  const d = Eip712DomainSchema.parse(domain);
  return hashDomain({
    domain: { ...d, chainId: BigInt(d.chainId) },
    types: { EIP712Domain: EIP712_DOMAIN_TYPE.map((f) => ({ name: f.name, type: f.type })) },
  });
}

/** hashStruct(primaryType, message) of a typed-data JSON object (the digest without the domain). */
export function eip712StructHash<P extends Eip712PrimaryType>(td: TypedDataJson<P>): Hex32 {
  const { fields, primaryType, message } = toViemArgs(td);
  return hashStruct({ data: message, primaryType, types: { [primaryType]: fields } });
}

/** Convenience: the EIP-712 Receipt message for a receipt hash (verdict → uint8 code; issuedAt in epoch seconds). */
export function receiptEip712Message(input: {
  receiptHash: Hex32;
  intentId: Hex32;
  verdict: Verdict;
  policyHash: Hex32;
  issuedAtEpochSeconds: bigint;
}): Eip712Message<"Receipt"> {
  return EIP712_MESSAGE_SCHEMAS.Receipt.parse({
    receiptHash: input.receiptHash,
    intentId: input.intentId,
    verdict: String(VERDICT_CODE[input.verdict]),
    policyHash: input.policyHash,
    issuedAt: input.issuedAtEpochSeconds.toString(),
  });
}
