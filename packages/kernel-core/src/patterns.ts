// K-11 instruction/change-of-details patterns (docs/04 K-11; WP-05). Versioned: PATTERNS_VERSION is recorded in every
// Decision (`patternsVersion`); bump it on ANY change to a pattern, the folding or a threshold, and re-run the
// adversarial corpus (test/k11-corpus.ts, results/k11-corpus.json).
//
// The scan runs on the KERNEL-STORED normalized document text (never on extractor output) after folding:
// per code point NFKD, drop combining marks and format characters (zero-width, bidi, tags), map common Cyrillic,
// Greek and small-capital lookalikes to Latin, lowercase, and collapse whitespace runs (a run containing a line
// break becomes "\n", any other run one space). NFKD + mark stripping is a superset of the spec's NFKC step (it
// also undoes full-width, ligature, mathematical and accented spellings). Every match reports the UTF-16 offset of
// its start in the ORIGINAL normalized text, and a kernel-written label; the document's own words are never copied
// into the receipt (INV-15/20).
//
// Pattern list = the docs/04 K-11 list plus measured extensions; departures from the literal spec are narrowings
// that keep the attack corpus at full recall while cutting honest-invoice false positives (docs/QUESTIONS.md):
//   CD-04 "please use/send to the following address" is suppressed when the next address in the text is a known
//         address (the engagement payee or owner, the vault or the token): that is how honest invoices state where
//         to pay; a foreign or unparseable address keeps it.
//   IN-01 "ignore all/any/previous/above" does not fire on "ignore any previous invoice(s)/reminder(s)/email(s)".
//   IN-03/IN-04 "system:" / "assistant:" fire at a line start or after a bracket/quote/markup character, not inside
//         ordinary prose ("Operating system: Linux", "Virtual assistant: 10 h").
//   IN-05 "you are (now) a/an" is narrowed to "you are now" and "you are a/an/the <AI-role word>".
export const PATTERNS_VERSION = "symbolon-patterns/1.0.0" as const;

export type PatternGroup = "CHANGE_OF_DETAILS" | "INSTRUCTION" | "STRUCTURE" | "EXTRACTOR";

export interface TextPattern {
  readonly id: string;
  readonly group: PatternGroup;
  /** Kernel-written description (safe to show in receipts and explanations). */
  readonly label: string;
  /** Global, applied to the folded text. */
  readonly re: RegExp;
}

const S = String.raw`\s`;
const NOT_DOC_NOUN = String.raw`(?!${S}(?:previous${S}|prior${S}|earlier${S})?(?:invoices?|reminders?|emails?|e-mails?|statements?|versions?|copies|notices?|messages?)\b)`;
// Not inside prose: the role word is not preceded by a letter/digit (optionally followed by one space). A line break,
// punctuation, a bracket or markup before it all count as a start.
const LINE_START = String.raw`(?<![a-z0-9] ?)`;

export const TEXT_PATTERNS: readonly TextPattern[] = Object.freeze([
  // --- change of payment details ------------------------------------------------------------------------------
  { id: "CD-01", group: "CHANGE_OF_DETAILS", label: "new wallet", re: new RegExp(String.raw`\bnew${S}(?:usdc${S}|crypto${S}|payment${S}|receiving${S}|deposit${S})?wallet\b`, "g") },
  {
    id: "CD-02",
    group: "CHANGE_OF_DETAILS",
    label: "updated payment/wallet/bank details",
    re: new RegExp(String.raw`\bupdated${S}(?:payment|wallet|bank|banking|remittance|account|payout)${S}(?:details|information|info|address)\b`, "g"),
  },
  {
    id: "CD-03",
    group: "CHANGE_OF_DETAILS",
    label: "change of bank/wallet/address",
    re: new RegExp(String.raw`\bchange${S}(?:of|in)${S}(?:bank|wallet|address|account|payment${S}details|payout${S}address)\b`, "g"),
  },
  { id: "CD-04", group: "CHANGE_OF_DETAILS", label: "please use/send to the following address", re: new RegExp(String.raw`\bplease${S}(?:use|send${S}to)${S}the${S}following${S}(?:new${S})?(?:address|wallet)\b`, "g") },
  {
    id: "CD-05",
    group: "CHANGE_OF_DETAILS",
    label: "payment details have changed",
    re: new RegExp(String.raw`\b(?:wallet|wallet${S}address|bank${S}account|bank${S}details|payment${S}details|receiving${S}address|payout${S}address)${S}(?:has|have)${S}(?:been${S})?changed\b`, "g"),
  },
  {
    id: "CD-06",
    group: "CHANGE_OF_DETAILS",
    label: "we changed our wallet/bank",
    re: new RegExp(String.raw`\bwe${S}(?:have${S})?(?:changed|moved|switched|updated)${S}(?:our|the)${S}(?:wallet|bank${S}account|bank|account|payment${S}details|receiving${S}address|payout${S}address)\b`, "g"),
  },
  {
    id: "CD-07",
    group: "CHANGE_OF_DETAILS",
    label: "old wallet closed",
    re: new RegExp(String.raw`\b(?:old|previous|former)${S}(?:wallet|address|account)${S}(?:is|has${S}been|was)${S}(?:closed|deactivated|disabled|no${S}longer)\b`, "g"),
  },
  // --- instructions to the reader / an AI -----------------------------------------------------------------------
  { id: "IN-01", group: "INSTRUCTION", label: "ignore all/any/previous/above", re: new RegExp(String.raw`\b(?:ignore|disregard)${S}(?:all|any|previous|above|prior)\b${NOT_DOC_NOUN}`, "g") },
  {
    id: "IN-02",
    group: "INSTRUCTION",
    label: "ignore the instructions",
    re: new RegExp(String.raw`\b(?:ignore|disregard|forget)${S}(?:the${S}|your${S}|all${S}|these${S}|those${S})?(?:above${S}|previous${S}|prior${S}|earlier${S}|original${S}|system${S})?(?:instructions?|rules|prompts?|guidelines|guardrails)\b`, "g"),
  },
  { id: "IN-03", group: "INSTRUCTION", label: "system: role marker", re: new RegExp(String.raw`${LINE_START}system${S}?:`, "g") },
  { id: "IN-04", group: "INSTRUCTION", label: "assistant: role marker", re: new RegExp(String.raw`${LINE_START}assistant${S}?:`, "g") },
  {
    id: "IN-05",
    group: "INSTRUCTION",
    label: "you are now / you are an AI role",
    re: new RegExp(String.raw`\byou${S}are${S}(?:now\b|(?:an?|the)${S}(?:ai|assistant|bot|chatbot|model|language${S}model|llm|agent|payment${S}bot|approval${S}bot)\b)`, "g"),
  },
  { id: "IN-06", group: "INSTRUCTION", label: "do not verify", re: new RegExp(String.raw`\b(?:do${S}not|don't|dont)${S}(?:verify|check|validate|review)\b`, "g") },
  {
    id: "IN-07",
    group: "INSTRUCTION",
    label: "skip the check/verification",
    re: new RegExp(String.raw`\bskip${S}(?:the${S}|all${S}|any${S}|this${S})?(?:checks?|verification|validation|review|approval|controls?)\b`, "g"),
  },
  { id: "IN-08", group: "INSTRUCTION", label: "approve this payment/invoice", re: new RegExp(String.raw`\bapprove${S}(?:this|the)${S}(?:payment|invoice|transfer|transaction|request)\b`, "g") },
  {
    id: "IN-09",
    group: "INSTRUCTION",
    label: "mark as approved/verified",
    re: new RegExp(String.raw`\bmark${S}(?:this|it|the${S}invoice|this${S}invoice|the${S}payment|this${S}payment)${S}(?:as${S})?(?:approved|verified|pre-approved)\b`, "g"),
  },
  { id: "IN-10", group: "INSTRUCTION", label: "pay immediately/now", re: new RegExp(String.raw`\bpay${S}(?:immediately|now|right${S}away|right${S}now)\b`, "g") },
  { id: "IN-11", group: "INSTRUCTION", label: "system prompt", re: new RegExp(String.raw`\bsystem${S}prompt\b`, "g") },
  {
    id: "IN-12",
    group: "INSTRUCTION",
    label: "ignore previous instructions (other languages)",
    // the verb, up to three words (quantifier, article, adjective in any order), then the noun
    re: new RegExp(String.raw`\b(?:ignora|ignorar|ignorez|ignore|ignoriere|ignorieren|negeer)${S}(?:[a-z]+${S}){0,3}(?:instrucciones|instructions|anweisungen|instructies|instrucoes)\b`, "g"),
  },
  {
    id: "IN-13",
    group: "INSTRUCTION",
    label: "claims prior approval",
    re: new RegExp(String.raw`\b(?:(?:already|pre-?)${S}?approved${S}by${S}(?:the${S})?(?:owner|client|cfo|ceo|finance|management)|(?:owner|client|cfo)${S}(?:has${S})?already${S}approved)\b`, "g"),
  },
  {
    id: "IN-14",
    group: "INSTRUCTION",
    label: "no further checks required",
    re: new RegExp(String.raw`\bno${S}(?:further${S}|additional${S})?(?:checks?|verification|approval|review)${S}(?:is${S}|are${S})?(?:required|needed|necessary)\b`, "g"),
  },
  // --- structure: prompt markup and hidden comments --------------------------------------------------------------
  {
    id: "ST-04",
    group: "STRUCTURE",
    label: "prompt or tool markup",
    re: /<\/?(?:document|instructions?|system|assistant|user|tool_result|tool_call)>|<\|im_(?:start|end)\|>|\[\/?(?:inst|tool_result|system)\]|\[\/\/\]:\s?#/g,
  },
  { id: "ST-05", group: "STRUCTURE", label: "HTML comment", re: /<!--/g },
]);

/** Structural thresholds (docs/04 K-11). */
export const ZERO_WIDTH_LIMIT = 5;
export const BASE64_RUN_LIMIT = 200;

// --- folding --------------------------------------------------------------------------------------------------

const HOMOGLYPHS: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  "А": "a", "а": "a", "В": "b", "С": "c", "с": "c", "Е": "e", "е": "e", "Н": "h", "һ": "h", "І": "i", "і": "i",
  "Ј": "j", "ј": "j", "К": "k", "к": "k", "М": "m", "м": "m", "О": "o", "о": "o", "Р": "p", "р": "p", "Ѕ": "s",
  "ѕ": "s", "Т": "t", "т": "t", "Х": "x", "х": "x", "У": "y", "у": "y", "Ү": "y", "ү": "y", "Ԛ": "q", "ԛ": "q",
  "Ԝ": "w", "ԝ": "w", "Ӏ": "l", "ӏ": "l", "Ԁ": "d", "ԁ": "d",
  // Greek
  "Α": "a", "α": "a", "Β": "b", "Ε": "e", "ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "ι": "i", "Κ": "k", "κ": "k",
  "Μ": "m", "Ν": "n", "ν": "v", "Ο": "o", "ο": "o", "Ρ": "p", "ρ": "p", "Τ": "t", "τ": "t", "Υ": "y", "υ": "u",
  "Χ": "x", "χ": "x", "ϲ": "c", "ϳ": "j",
  // Latin small capitals and other lookalikes NFKD leaves alone
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l",
  "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y",
  "ᴢ": "z", "ı": "i", "ɡ": "g",
});

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /\s/u;

export interface Folded {
  readonly text: string;
  /** offsets[k] = UTF-16 index in the original text of the code point that produced folded unit k. */
  readonly offsets: readonly number[];
}

/** Fold `text` for scanning (see the module comment). Deterministic; no locale-dependent API. */
export function foldForScan(text: string): Folded {
  let out = "";
  const offsets: number[] = [];
  let pending: " " | "\n" | null = null;
  let pendingAt = 0;
  const emit = (unit: string, at: number) => {
    if (pending !== null) {
      out += pending;
      offsets.push(pendingAt);
      pending = null;
    }
    out += unit;
    for (let k = 0; k < unit.length; k++) offsets.push(at);
  };
  const space = (c: string, at: number) => {
    if (pending === null) {
      pending = c === "\n" ? "\n" : " ";
      pendingAt = at;
    } else if (c === "\n") {
      pending = "\n";
    }
  };
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    if (cp < 0x80) {
      if (SPACE.test(ch)) space(ch === "\r" ? "\n" : ch, i);
      else emit(cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 32) : ch, i);
    } else {
      for (const part of ch.normalize("NFKD")) {
        if (MARK.test(part) || FORMAT.test(part)) continue;
        for (const c of (HOMOGLYPHS[part] ?? part).toLowerCase().normalize("NFKD")) {
          if (MARK.test(c)) continue;
          if (SPACE.test(c)) space(c, i);
          else emit(c, i);
        }
      }
    }
    i += ch.length;
  }
  if (pending !== null) {
    out += pending;
    offsets.push(pendingAt);
  }
  return { text: out, offsets };
}

// --- scan -----------------------------------------------------------------------------------------------------

export interface PatternMatch {
  readonly id: string;
  readonly group: PatternGroup;
  readonly label: string;
  /** UTF-16 offset in the original text; -1 for document-level findings (zero-width count, extractor anomaly). */
  readonly offset: number;
}

const ADDRESS = /(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/g;
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${BASE64_RUN_LIMIT + 1},}`, "g");
/** How far after a CD-04 match (folded characters) the address it introduces is looked for. */
const CD04_LOOKAHEAD = 160;

export interface ScanInput {
  readonly text: string;
  /** Zero-width characters the kernel removed when it normalized the document (Document.zeroWidthCount). */
  readonly zeroWidthCount: number;
  /** Addresses that may appear without suspicion (engagement payee and owner, vault, token); compared lowercase. */
  readonly knownAddresses: readonly string[];
}

/** All K-11 findings in the text, in offset order (document-level findings first). */
export function scanDocument(input: ScanInput): readonly PatternMatch[] {
  const known = new Set(input.knownAddresses.map((a) => a.toLowerCase()));
  const folded = foldForScan(input.text);
  const at = (k: number): number => folded.offsets[k] as number;
  const found: PatternMatch[] = [];

  let hidden = input.zeroWidthCount;
  for (const ch of input.text) if (FORMAT.test(ch)) hidden++;
  if (hidden > ZERO_WIDTH_LIMIT) found.push({ id: "ST-01", group: "STRUCTURE", label: `more than ${ZERO_WIDTH_LIMIT} zero-width characters`, offset: -1 });

  for (const p of TEXT_PATTERNS) {
    for (const m of folded.text.matchAll(p.re)) {
      const start = m.index;
      if (p.id === "CD-04") {
        const next = /0x[0-9a-f]{40}(?![0-9a-f])/.exec(folded.text.slice(start, start + m[0].length + CD04_LOOKAHEAD));
        if (next !== null && known.has(next[0])) continue;
      }
      found.push({ id: p.id, group: p.group, label: p.label, offset: at(start) });
    }
  }
  for (const m of input.text.matchAll(BASE64_RUN)) {
    found.push({ id: "ST-02", group: "STRUCTURE", label: `base64-like run over ${BASE64_RUN_LIMIT} characters`, offset: m.index });
  }
  for (const m of folded.text.matchAll(ADDRESS)) {
    if (!known.has(m[0])) found.push({ id: "ST-03", group: "STRUCTURE", label: "an address that is not the engagement payee", offset: at(m.index) });
  }
  return found.sort((a, b) => a.offset - b.offset);
}
