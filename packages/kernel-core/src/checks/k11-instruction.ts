// K-11 INSTRUCTION_CHANGE_HEURISTIC — ESCALATE (never REJECT) — P0 (docs/04 K-11; targets ATK-10/11/24; WP-05).
// A deterministic scan of the KERNEL-STORED normalized document text with the versioned pattern list in
// patterns.ts (change-of-details phrases, instruction-like phrases, prompt markup, hidden comments, more than five
// zero-width characters, base64-like runs over 200 characters, addresses that are not the engagement payee), plus the
// extractor's own INSTRUCTION_IN_DOC / ADDRESS_CHANGE anomalies (LLM output may only ADD an escalation, INV-8).
// Never auto-REJECTs: false positives on honest invoices must be human-resolvable (an owner approval resolves it).
// The receipt lists pattern ids, kernel-written labels and offsets; it never quotes the document.
// Code: ADDRESS_CHANGE_CLAIMED when every finding is a change-of-details finding, else INSTRUCTION_IN_DOC.
import { inspectUntrusted } from "@symbolon/schemas";
import type { CheckResult, PaymentIntent } from "@symbolon/schemas";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import { PATTERNS_VERSION, scanDocument } from "../patterns";
import type { PatternMatch } from "../patterns";
import { combine, fail } from "../verdict";

const MAX_LISTED = 12;

export function checkK11(intent: PaymentIntent, ctx: KernelContext, facts: Facts): CheckResult {
  const known = [ctx.vaultAddress, ctx.chain.tokenAddress];
  if (facts.engagement !== null) known.push(facts.engagement.payee, facts.engagement.owner);
  const found: PatternMatch[] = [...scanDocument({ text: inspectUntrusted(ctx.doc.normalizedText), zeroWidthCount: ctx.doc.zeroWidthCount, knownAddresses: known })];
  const extractions = intent.extraction.b === null ? [intent.extraction.a] : [intent.extraction.a, intent.extraction.b];
  if (extractions.some((x) => x.anomalies.some((a) => a.code === "INSTRUCTION_IN_DOC"))) {
    found.push({ id: "EX-01", group: "EXTRACTOR", label: "extractor reported an instruction in the document", offset: -1 });
  }
  if (extractions.some((x) => x.anomalies.some((a) => a.code === "ADDRESS_CHANGE"))) {
    found.push({ id: "EX-02", group: "EXTRACTOR", label: "extractor reported an address change", offset: -1 });
  }
  if (found.length === 0) return combine("K-11", [], `no instruction or change-of-details pattern (${PATTERNS_VERSION})`, [`patterns:${PATTERNS_VERSION}`]);
  const changeOnly = found.every((f) => f.group === "CHANGE_OF_DETAILS" || f.id === "EX-02");
  const listed = found.slice(0, MAX_LISTED).map((f) => `${f.id} '${f.label}'${f.offset >= 0 ? ` @${f.offset}` : ""}`);
  const more = found.length > MAX_LISTED ? ` and ${found.length - MAX_LISTED} more` : "";
  const refs = [`patterns:${PATTERNS_VERSION}`, ...found.slice(0, 31).map((f) => `match:${f.id}${f.offset >= 0 ? `@${f.offset}` : ""}`)];
  return fail("K-11", "ESCALATE", changeOnly ? "ADDRESS_CHANGE_CLAIMED" : "INSTRUCTION_IN_DOC", `matched: ${listed.join(", ")}${more} (${PATTERNS_VERSION})`, refs);
}
