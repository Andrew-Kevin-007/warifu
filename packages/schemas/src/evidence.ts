// Kernel-collected evidence (docs/05 §2), sandbox evidence fixtures (docs/15 §2, §5) and the
// kernel-stored document record (docs/05 §2, INV-23).
import * as z from "zod";
import { EvidenceRequirementSchema } from "./engagement";
import { EvidenceResultSchema, EvidenceTypeSchema } from "./enums";
import { Hex32Schema, ISODateTimeSchema, UUIDSchema, text } from "./primitives";
import { untrustedText } from "./untrusted";

/** Any JSON value. */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const EvidenceSchema = z.strictObject({
  evidenceId: UUIDSchema,
  milestoneId: Hex32Schema,
  type: EvidenceTypeSchema,
  /** Literal: anything else is ignored by K-09. */
  collectedBy: z.literal("kernel"),
  collectedAt: ISODateTimeSchema,
  /** e.g. "github:actions", "https://…", or "fixture:<id>" in the sandbox. */
  source: text(512),
  payload: JsonValueSchema,
  payloadHash: Hex32Schema,
  result: EvidenceResultSchema,
  /** Collector notes may quote fetched content: untrusted. */
  details: untrustedText(2000),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * A sandbox evidence record (docs/15 §2). The service injects it as `Evidence` with
 * `collectedBy:'kernel'` and `source:'fixture:<fixtureId>'` only when `requirement` equals the
 * milestone's spec entry exactly (K-09 sandbox mode). Shape defined by SCHEMAS (not spelled out in docs/15).
 */
export const EvidenceFixtureSchema = z.strictObject({
  fixtureId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  milestoneId: Hex32Schema,
  requirement: EvidenceRequirementSchema,
  result: EvidenceResultSchema,
  payload: JsonValueSchema,
  details: text(2000),
  /** When the fixture becomes visible on the scenario clock; null = from the start. */
  availableAt: ISODateTimeSchema.nullable(),
});
export type EvidenceFixture = z.infer<typeof EvidenceFixtureSchema>;

/** Hard cap = policy default `limits.maxDocChars` (docs/04 §7); policy may only tighten it. */
export const MAX_DOC_CHARS = 20_000;

export const DocumentSchema = z.strictObject({
  documentId: UUIDSchema,
  tenantId: UUIDSchema,
  /** hash of the original input bytes */
  rawHash: Hex32Schema,
  /** sha256 of the opaque blob (stored, never parsed: INV-23) */
  blobSha256: Hex32Schema.nullable(),
  mime: z.string().max(128).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, "expected a lowercase type/subtype"),
  storageKey: z.string().max(512).nullable(),
  normalizedText: untrustedText(MAX_DOC_CHARS),
  normalizedHash: Hex32Schema,
  zeroWidthCount: z.number().int().min(0),
  /** = invoiceReceivedAt, recorded by the kernel (INV-19) */
  receivedAt: ISODateTimeSchema,
  createdAt: ISODateTimeSchema,
});
export type Document = z.infer<typeof DocumentSchema>;
