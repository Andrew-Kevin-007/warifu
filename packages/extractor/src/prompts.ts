// Versioned, hashed prompts (docs/03 §7). The hash covers id, version, system text, user template and the tool
// specs, and is what receipts record (promptHashA/B). Prompt text lives in packages/extractor/prompts/.
import { inspectUntrusted, jcs, sha256Bytes, sha256Utf8, type Hex32, type Untrusted } from "@symbolon/schemas";
import { ADVISORY_ID, ADVISORY_SYSTEM, ADVISORY_USER_TEMPLATE, ADVISORY_VERSION } from "../prompts/advisory.v1";
import { EXTRACTOR_A_ID, EXTRACTOR_A_SYSTEM, EXTRACTOR_A_USER_TEMPLATE, EXTRACTOR_A_VERSION } from "../prompts/extractor-a.v1";
import { EXTRACTOR_B_ID, EXTRACTOR_B_SYSTEM, EXTRACTOR_B_USER_TEMPLATE, EXTRACTOR_B_VERSION } from "../prompts/extractor-b.v1";
import type { LlmToolSpec } from "./llm/types";
import { advisoryTools, extractorTools } from "./tools";

export interface PromptSpec {
  readonly id: string;
  readonly version: number;
  readonly system: string;
  readonly userTemplate: string;
  readonly tools: readonly LlmToolSpec[];
  readonly hash: Hex32;
}

function spec(id: string, version: number, system: string, userTemplate: string, tools: readonly LlmToolSpec[]): PromptSpec {
  return { id, version, system, userTemplate, tools, hash: sha256Utf8(jcs({ id, version, system, userTemplate, tools })) };
}

export const PROMPT_A: PromptSpec = spec(EXTRACTOR_A_ID, EXTRACTOR_A_VERSION, EXTRACTOR_A_SYSTEM, EXTRACTOR_A_USER_TEMPLATE, extractorTools());
export const PROMPT_B: PromptSpec = spec(EXTRACTOR_B_ID, EXTRACTOR_B_VERSION, EXTRACTOR_B_SYSTEM, EXTRACTOR_B_USER_TEMPLATE, extractorTools());
export const PROMPT_ADVISORY: PromptSpec = spec(ADVISORY_ID, ADVISORY_VERSION, ADVISORY_SYSTEM, ADVISORY_USER_TEMPLATE, advisoryTools());

const encoder = new TextEncoder();

/**
 * Marker id for a document: the first 16 hex digits of sha256(normalized text). A document cannot contain its
 * own hash (a fixed point), so it cannot forge the closing marker; on top of that any literal "</document"
 * inside the text is defanged.
 */
export function documentMarker(normalized: Untrusted<string>): string {
  return sha256Bytes(encoder.encode(inspectUntrusted(normalized))).slice(2, 18);
}

function defang(text: string): string {
  return text.replace(/<(\/?\s*document)/gi, "‹$1"); // "<" -> U+2039: no longer a tag opener
}

/** The user turn for an extractor: delimiter-wrapped, defanged document text. */
export function renderExtractorUserTurn(prompt: PromptSpec, normalized: Untrusted<string>, decimals: number): string {
  return prompt.userTemplate
    .replace(/\{\{DOC_ID\}\}/g, documentMarker(normalized))
    .replace("{{DECIMALS}}", String(decimals))
    .replace("{{DOCUMENT}}", () => defang(inspectUntrusted(normalized)));
}

/** The user turn for the advisory writer: kernel facts only. */
export function renderAdvisoryUserTurn(factsJson: string): string {
  return PROMPT_ADVISORY.userTemplate.replace("{{FACTS}}", () => factsJson);
}
