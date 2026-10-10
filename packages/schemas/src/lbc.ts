// Loss Bound Certificate `lbc/1` (docs/16 §3). certHash = keccak256(JCS(cert minus certHash, publisher, validity)).
// `validity` is a verification result recomputed by every verifier, so it is outside the hash.
import * as z from "zod";
import {
  AssumptionIdSchema,
  CodeMatchStatusSchema,
  LbcHorizonLabelSchema,
  LbcTermSchema,
  LbcValidityReasonSchema,
  LbcValidityStatusSchema,
} from "./enums";
import { hashJcs } from "./hash";
import {
  AddressSchema,
  BaseUnitsSchema,
  ChainIdSchema,
  DecimalsSchema,
  DecimalStringSchema,
  GitShaSchema,
  Hex32Schema,
  HexBytesSchema,
  SafeUintSchema,
  text,
  type Hex32,
} from "./primitives";

const BindingSchema = z.array(LbcTermSchema).min(1).max(4);

export const LbcHorizonSchema = z.strictObject({
  label: LbcHorizonLabelSchema,
  seconds: SafeUintSchema,
  value: BaseUnitsSchema,
  binding: BindingSchema,
});
export type LbcHorizon = z.infer<typeof LbcHorizonSchema>;

export const LossBoundCertificateSchema = z.strictObject({
  schema: z.literal("lbc/1"),
  algorithm: z.strictObject({
    id: z.literal("symbolon-bounds"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected semver x.y.z"),
    gitSha: GitShaSchema,
    detectionLatencySeconds: SafeUintSchema,
  }),
  subject: z.strictObject({ vault: AddressSchema, chainId: ChainIdSchema, token: AddressSchema, tokenDecimals: DecimalsSchema }),
  asOf: z.strictObject({ blockNumber: SafeUintSchema, blockHash: Hex32Schema, timestamp: SafeUintSchema }),
  inputs: z.strictObject({
    configHash: Hex32Schema,
    /** keccak256(JCS(sorted by id: {id,payee,cap,start,end,termsHash,active})); excludes released */
    engagementsDigest: Hex32Schema,
    policyHash: Hex32Schema.nullable(),
    balanceBaseUnits: BaseUnitsSchema,
    limits: z.strictObject({
      perTxCap: BaseUnitsSchema,
      dailyCap: BaseUnitsSchema,
      hourlyCap: BaseUnitsSchema,
      humanThreshold: BaseUnitsSchema,
      ringSize: SafeUintSchema,
    }),
    sumRemainingBaseUnits: BaseUnitsSchema,
    activeEngagements: SafeUintSchema,
  }),
  bounds: z.strictObject({
    T1: z.strictObject({
      unauthorizedLoss: BaseUnitsSchema,
      assumes: z.array(AssumptionIdSchema).max(6),
      weakEvidenceExposure: z.union([BaseUnitsSchema, z.literal("NOT_COMPUTED")]),
    }),
    T2: z.strictObject({ loss: BaseUnitsSchema, liveness: z.literal("censorable") }),
    T3c: z.strictObject({
      perReleaseUnapproved: BaseUnitsSchema,
      perDay: BaseUnitsSchema,
      horizons: z.array(LbcHorizonSchema).min(1).max(16),
      timeToEmpty: z.strictObject({ days: SafeUintSchema.nullable(), limitedBy: LbcTermSchema }),
      alarmed: z.strictObject({ seconds: SafeUintSchema, value: BaseUnitsSchema, assumes: z.array(AssumptionIdSchema).max(6) }),
    }),
    /** same numbers as T3c.horizons (owner-exposed wording; docs/08 §4) */
    T3_ownerExposed: z.array(LbcHorizonSchema).min(1).max(16),
  }),
  assumptions: z.array(z.strictObject({ id: AssumptionIdSchema, text: text(1000) })).min(1).max(16),
  exclusions: z.array(z.strictObject({ id: z.string().regex(/^X-[A-Z0-9-]{1,40}$/), text: text(1000) })).max(32),
  notes: z.array(text(1000)).max(32),
  /** null = not validated for this deployment (docs/16 §8) */
  validation: z
    .strictObject({
      t3Trials: SafeUintSchema,
      t3Violations: SafeUintSchema,
      upper95: DecimalStringSchema,
      t3BestAttack24h: BaseUnitsSchema,
      tightness: DecimalStringSchema,
      t1Plans: SafeUintSchema,
      t1Losses: SafeUintSchema,
      codeMatch: z.strictObject({ status: CodeMatchStatusSchema, validatedCodeHash: Hex32Schema, gitSha: GitShaSchema }),
    })
    .nullable(),
  validity: z.strictObject({
    status: LbcValidityStatusSchema,
    reasons: z.array(LbcValidityReasonSchema).max(16),
    checkedAt: SafeUintSchema,
    freshnessSeconds: SafeUintSchema,
  }),
  certHash: Hex32Schema,
  /** OPTIONAL EIP-191 signature over certHash; a convenience, never the evidence (RT-20) */
  publisher: z.strictObject({ address: AddressSchema, sig: HexBytesSchema }).exactOptional(),
});
export type LossBoundCertificate = z.infer<typeof LossBoundCertificateSchema>;

/** The certHash preimage: the certificate without certHash, publisher and validity. */
export function lbcHashPreimage(cert: LossBoundCertificate): Omit<LossBoundCertificate, "certHash" | "publisher" | "validity"> {
  const { certHash: _certHash, publisher: _publisher, validity: _validity, ...rest } = cert;
  return rest;
}

export function computeCertHash(cert: LossBoundCertificate): Hex32 {
  return hashJcs(lbcHashPreimage(cert));
}
