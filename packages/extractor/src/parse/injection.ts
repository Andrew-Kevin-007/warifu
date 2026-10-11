// Deterministic backstop for the model's anomaly reporting (docs/03 §3, §8; ATK-10/11/24).
//
// A model that is fooled by an injected instruction is also the model that would fail to report it, so the
// extractor does not rely on the model alone: it scans the normalized document with fixed patterns (a subset
// of the kernel's K-11 lists) and unions the findings into `anomalies[]`. This is advisory like everything in
// this package: K-11 re-scans the kernel-stored text and the kernel decides. Findings can only ADD anomalies
// (more escalations), never remove one.
import type { Untrusted } from "@symbolon/schemas";
import { inspectUntrusted, untrusted } from "@symbolon/schemas";

export type ScanCode = "INSTRUCTION_IN_DOC" | "ADDRESS_CHANGE" | "OTHER";

export interface ScanFinding {
  readonly code: ScanCode;
  /** Short excerpt of the folded text around the match (NFKC, lowercase, homoglyphs folded). Untrusted. */
  readonly quote: Untrusted<string>;
  readonly pattern: string;
}

/** Common Cyrillic/Greek lookalikes folded to Latin (K-11 homoglyph map; extend only in the kernel first). */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  а: "a", в: "b", с: "c", е: "e", н: "h", к: "k", м: "m", о: "o", р: "p", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  α: "a", ε: "e", ι: "i", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ν: "v", κ: "k",
};

/** NFKC + lowercase + homoglyph fold + whitespace collapse. */
export function foldForScan(text: string): string {
  const lowered = text.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of lowered) out += HOMOGLYPHS[ch] ?? ch;
  return out.replace(/[ \t\r\n ]+/g, " ");
}

interface Rule {
  readonly id: string;
  readonly code: ScanCode;
  readonly re: RegExp;
}

const RULES: readonly Rule[] = [
  // Instruction-like (K-11)
  { id: "ignore-previous", code: "INSTRUCTION_IN_DOC", re: /\bignore (?:all|any|previous|prior|above|earlier|the above|your)\b/ },
  { id: "disregard", code: "INSTRUCTION_IN_DOC", re: /\bdisregard (?:all|any|previous|prior|the|your)\b/ },
  { id: "role-prefix", code: "INSTRUCTION_IN_DOC", re: /(?:^|[\s>\]*"'(])(?:system|assistant|developer|instruction|instructions) ?:/ },
  { id: "role-tag", code: "INSTRUCTION_IN_DOC", re: /<\/?(?:system|assistant|instructions?|prompt)\b|\[\/?inst\]|<\|(?:im_start|im_end|system)\|>/ },
  { id: "you-are", code: "INSTRUCTION_IN_DOC", re: /\byou are (?:now )?an? (?!valued|customer|client|member)\w+/ },
  { id: "new-instructions", code: "INSTRUCTION_IN_DOC", re: /\b(?:new|updated|additional|special) instructions?\b/ },
  { id: "do-not-verify", code: "INSTRUCTION_IN_DOC", re: /\b(?:do not|don'?t|never) (?:verify|check|validate|flag|report|escalate|question)\b/ },
  { id: "skip-check", code: "INSTRUCTION_IN_DOC", re: /\bskip (?:the )?(?:check|checks|verification|review|validation)\b/ },
  { id: "approve-this", code: "INSTRUCTION_IN_DOC", re: /\b(?:approve|release|authori[sz]e|mark(?: it| this)?(?: as)?) (?:this|the|it|as)?\s?(?:payment|invoice|funds?|approved|paid|verified)\b/ },
  { id: "pay-now", code: "INSTRUCTION_IN_DOC", re: /\bpay (?:immediately|now|asap|today)\b/ },
  { id: "already-approved", code: "INSTRUCTION_IN_DOC", re: /\balready (?:been )?(?:approved|verified|authori[sz]ed|signed off|confirmed)\b/ },
  { id: "tell-the-owner", code: "INSTRUCTION_IN_DOC", re: /\btell (?:the )?(?:owner|user|approver|reviewer|human)\b|\bexplain to (?:the )?(?:owner|user|approver)\b/ },
  { id: "click-approve", code: "INSTRUCTION_IN_DOC", re: /\b(?:click|press|tap)(?: on)?(?: the)? (?:approve|confirm|sign|release)\b/ },
  { id: "ai-addressed", code: "INSTRUCTION_IN_DOC", re: /\b(?:ai|llm|language model|assistant|model|extractor|chatbot)[ ,:;-]{1,3}(?:please |you )?(?:must|should|need to|shall|will|do|set|output|return|respond|reply|write|change|use)\b/ },
  { id: "override", code: "INSTRUCTION_IN_DOC", re: /\b(?:override|bypass|circumvent) (?:the |all |any )?(?:policy|policies|check|checks|limit|limits|kernel|rules?)\b/ },
  { id: "set-field", code: "INSTRUCTION_IN_DOC", re: /\b(?:set|change|update) (?:the )?(?:payee|wallet|address|amount|currency|recipient)(?: to| =|:)/ },
  // Change of payment details (K-11, K-06)
  { id: "new-wallet", code: "ADDRESS_CHANGE", re: /\bnew (?:wallet|payment address|bank (?:account|details)|payment details|account)\b/ },
  { id: "updated-details", code: "ADDRESS_CHANGE", re: /\bupdated? (?:payment|wallet|bank|account|remittance) (?:details|information|address)\b/ },
  { id: "change-of", code: "ADDRESS_CHANGE", re: /\bchange of (?:bank|wallet|address|account|payment)\b/ },
  { id: "use-following", code: "ADDRESS_CHANGE", re: /\bplease (?:use|send (?:to|payment to)|remit to) the following (?:address|wallet|account|details)\b/ },
  { id: "details-changed", code: "ADDRESS_CHANGE", re: /\b(?:our|my|the) (?:wallet|bank|payment|account|remittance) (?:details|address|information)? ?(?:have|has|has been|have been) (?:changed|moved|updated)\b/ },
  { id: "moved-wallet", code: "ADDRESS_CHANGE", re: /\b(?:moved|migrated|switched) to a new (?:wallet|address|account|bank)\b/ },
];

function excerptAround(folded: string, start: number, end: number): string {
  const from = Math.max(0, start - 40);
  const to = Math.min(folded.length, end + 80);
  return `${from > 0 ? "…" : ""}${folded.slice(from, to)}${to < folded.length ? "…" : ""}`;
}

/** Scan normalized document text. One finding per rule (first match), in rule order. Pure. */
export function scanInjection(normalizedText: Untrusted<string> | string): ScanFinding[] {
  const folded = foldForScan(typeof normalizedText === "string" ? normalizedText : inspectUntrusted(normalizedText));
  const findings: ScanFinding[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(folded);
    if (m) findings.push({ code: rule.code, pattern: rule.id, quote: untrusted(excerptAround(folded, m.index, m.index + m[0].length).slice(0, 400)) });
  }
  // Structure: long base64-like runs hide payloads (K-11).
  const b64 = /[a-z0-9+/=]{200,}/i.exec(folded);
  if (b64) findings.push({ code: "OTHER", pattern: "base64-run", quote: untrusted(`long encoded-looking run (${b64[0].length} chars)`) });
  return findings;
}
