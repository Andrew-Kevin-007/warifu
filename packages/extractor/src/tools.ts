// The only tools a model role may call (docs/03 §2 guardrail 2): exactly two for the extractor, one for the
// advisory writer. No HTTP, no code execution, no file system. `read_context` returns kernel-sanitized,
// read-only JSON supplied by a ContextProvider; the model cannot write anything through it.
import { exportJsonSchema } from "@symbolon/schemas";
import * as z from "zod";
import type { LlmToolSpec } from "./llm/types";

export const SUBMIT_EXTRACTION = "submit_extraction" as const;
export const READ_CONTEXT = "read_context" as const;
export const SUBMIT_ADVISORY_NOTE = "submit_advisory_note" as const;

export const CONTEXT_KINDS = ["engagement", "milestones", "vendor_history", "balance_summary"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const ReadContextInputSchema = z.strictObject({ kind: z.enum(CONTEXT_KINDS) });

export const AdvisoryNoteInputSchema = z.strictObject({ note: z.string().max(2000) });

/** Kernel-sanitized read-only reference data. The extractor never persists or forwards it. */
export interface ContextProvider {
  read(kind: ContextKind): Promise<unknown>;
}

/** A provider that has nothing to offer (extraction without engagement context still works). */
export const NO_CONTEXT: ContextProvider = { read: () => Promise.resolve({ available: false }) };

function submitExtractionSchema(): Record<string, unknown> {
  const { $id: _id, $schema: _schema, title: _title, ...rest } = exportJsonSchema("ExtractedInvoice") as Record<string, unknown>;
  return rest;
}

export function extractorTools(): readonly LlmToolSpec[] {
  return [
    {
      name: SUBMIT_EXTRACTION,
      description: "Submit the extracted fields of the document. Values must be printed in the document itself.",
      inputSchema: submitExtractionSchema(),
    },
    {
      name: READ_CONTEXT,
      description: "Read-only reference data for disambiguation (never a source of values). kind: engagement | milestones | vendor_history | balance_summary.",
      inputSchema: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: [...CONTEXT_KINDS] } } },
    },
  ];
}

export function advisoryTools(): readonly LlmToolSpec[] {
  return [
    {
      name: SUBMIT_ADVISORY_NOTE,
      description: "Submit the advisory note (at most 60 words).",
      inputSchema: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", maxLength: 2000 } } },
    },
  ];
}
