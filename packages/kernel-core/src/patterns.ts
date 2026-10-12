// K-11 instruction/change-of-details patterns (docs/04 K-11; WP-05). Versioned: PATTERNS_VERSION is recorded in every
// Decision (`patternsVersion`); bump it on ANY change to a pattern, the normalization or a threshold, and re-run the
// adversarial corpus (test/k11-corpus.ts, results/k11-corpus.json).
//
// ONE canonical normalization runs before any pattern (foldForScan), on the KERNEL-STORED normalized document text
// (never on extractor output). Per code point, the hidden-character test comes FIRST (also before the ASCII fast
// path): hidden characters are counted and stripped (C0/C1 controls and DEL except TAB/LF/CR; format characters:
// zero-width, bidi controls, BOM, soft hyphen, Unicode tags U+E0000-E007F; variation selectors; combining grapheme
// joiner; Hangul fillers). Then compatibility folding (NFKC letters: full-width, ligature, mathematical forms become
// plain letters; implemented as NFKD with combining marks removed, which yields the same letters and removes accents),
// the Cyrillic/Greek/small-capital lookalike map on each DECOMPOSED base letter (so accented lookalikes such as
// Cyrillic yo or Greek omicron-tonos map too), lowercase, and whitespace runs collapse (a run containing a line break
// becomes "\n", any other run one space). Patterns are matched against these views:
//   folded   the canonical text, with word boundaries;
//   literal  only when hidden characters are present: the same text folded exactly as symbolon-patterns/1.0.0 did
//            (controls kept as non-letters), so stripping can never lose a match 1.0.0 had (k11-oracle.test.ts);
//   squashed only [a-z0-9] of the canonical text, so separators inside words cannot split a keyword ("i.g.n.o.r.e",
//            "i g n o r e", "ig-nore", "ign<NUL>ore"). Squashed patterns are the multi-word phrases without separators.
// Every match reports the UTF-16 offset of its start in the ORIGINAL text and a kernel-written label; the document's
// own words are never copied into the receipt (INV-15/20).
//
// Hidden characters: ANY hidden or bidi character (stored count plus any left in the text) is a K-11 finding (ST-01).
// Invoices do not need them, so there is no "a few are fine" threshold (SEC review, ORCH 2026-10-12).
//
// Departures from the literal docs/04 list are measured narrowings that keep the attack corpus at full recall while
// cutting honest-invoice false positives (docs/QUESTIONS.md "WP-05"):
//   CD-04 "please use/send to the following address" is suppressed when the next address in the text is a known
//         address (the engagement payee or owner, the vault or the token): that is how honest invoices say where to pay.
//   IN-01 "ignore all/any/previous/above" does not fire on "ignore (any) previous invoice(s)/reminder(s)/email(s)...".
//   IN-03/IN-04 "system:" / "assistant:" fire at a line start or after punctuation/markup, not inside prose
//         ("Operating system: Linux", "Virtual assistant: 10 h"); letters may be split by single separators.
//   IN-05 keeps 1.0.0 ("you are now", "you are a/the <AI role>", widened to roles/modes two words away) and only
//         excludes honest account language right after "you are now" ("on the Team plan", "subscribed", ...).
// No other pattern detects less than 1.0.0: test/k11-oracle.test.ts compares against the frozen 1.0.0 scan.
// K-11 is a heuristic and cannot be complete: bypasses beyond this normalization are an ACCEPTED RESIDUAL covered by
// the binding checks (amount, payee, terms; INV-8) and by the hold-out adversary (docs/QUESTIONS.md, owner SEC/WP-37).
export const PATTERNS_VERSION = "symbolon-patterns/1.2.0" as const;

export type PatternGroup = "CHANGE_OF_DETAILS" | "INSTRUCTION" | "STRUCTURE" | "EXTRACTOR";

export interface TextPattern {
  readonly id: string;
  readonly group: PatternGroup;
  /** Kernel-written description (safe to show in receipts and explanations). */
  readonly label: string;
  /** Global, applied to the folded view. */
  readonly re: RegExp;
  /** Global, applied to the squashed view ([a-z0-9] only); null when the pattern needs punctuation or boundaries. */
  readonly squashed: RegExp | null;
}

const S = String.raw`\s`;
// Exactly the 1.0.0 list: adding a noun here would exclude more and detect less than 1.0.0 (k11-oracle.test.ts).
const DOC_NOUN = String.raw`(?:invoices?|reminders?|emails?|e-mails?|statements?|versions?|copies|notices?|messages?)`;
const NOT_DOC_NOUN = String.raw`(?!${S}(?:previous${S}|prior${S}|earlier${S})?${DOC_NOUN}\b)`;
const NOT_DOC_NOUN_SQ = "(?!(?:previous|prior|earlier)?(?:invoice|reminder|email|statement|version|cop|notice|message))";
// Not inside prose: the role word is not preceded by a letter/digit (optionally followed by one space). A line break,
// punctuation, a bracket or markup before it all count as a start.
const LINE_START = String.raw`(?<![a-z0-9] ?)`;
const U = (cp: number): string => String.fromCodePoint(cp);
/** A word whose letters may be separated by single joiners ("s.y.s.t.e.m", "s y s t e m"); middle dot and bullet too. */
const split = (word: string): string => Array.from(word).join(`[ .\\-_*${U(0xb7)}${U(0x2022)}]?`);

export const TEXT_PATTERNS: readonly TextPattern[] = Object.freeze([
  // --- change of payment details ------------------------------------------------------------------------------
  {
    id: "CD-01",
    group: "CHANGE_OF_DETAILS",
    label: "new wallet",
    re: new RegExp(String.raw`\bnew${S}(?:usdc${S}|crypto${S}|payment${S}|receiving${S}|deposit${S})?wallet\b`, "g"),
    squashed: /new(?:usdc|crypto|payment|receiving|deposit)?wallet/g,
  },
  {
    id: "CD-02",
    group: "CHANGE_OF_DETAILS",
    label: "updated payment/wallet/bank details",
    re: new RegExp(String.raw`\bupdated${S}(?:payment|wallet|bank|banking|remittance|account|payout)${S}(?:details|information|info|address)\b`, "g"),
    squashed: /updated(?:payment|wallet|bank|banking|remittance|account|payout)(?:details|information|info|address)/g,
  },
  {
    id: "CD-03",
    group: "CHANGE_OF_DETAILS",
    label: "change of bank/wallet/address",
    re: new RegExp(String.raw`\bchange${S}(?:of|in)${S}(?:bank|wallet|address|account|payment${S}details|payout${S}address)\b`, "g"),
    squashed: /change(?:of|in)(?:bank|wallet|address|account|paymentdetails|payoutaddress)/g,
  },
  {
    id: "CD-04",
    group: "CHANGE_OF_DETAILS",
    label: "please use/send to the following address",
    re: new RegExp(String.raw`\bplease${S}(?:use|send${S}to)${S}the${S}following${S}(?:new${S})?(?:address|wallet)\b`, "g"),
    squashed: /please(?:use|sendto)thefollowing(?:new)?(?:address|wallet)/g,
  },
  {
    id: "CD-05",
    group: "CHANGE_OF_DETAILS",
    label: "payment details have changed",
    re: new RegExp(String.raw`\b(?:wallet|wallet${S}address|bank${S}account|bank${S}details|payment${S}details|receiving${S}address|payout${S}address)${S}(?:has|have)${S}(?:been${S})?changed\b`, "g"),
    squashed: /(?:wallet|walletaddress|bankaccount|bankdetails|paymentdetails|receivingaddress|payoutaddress)(?:has|have)(?:been)?changed/g,
  },
  {
    id: "CD-06",
    group: "CHANGE_OF_DETAILS",
    label: "we changed our wallet/bank",
    re: new RegExp(String.raw`\bwe${S}(?:have${S})?(?:changed|moved|switched|updated)${S}(?:our|the)${S}(?:wallet|bank${S}account|bank|account|payment${S}details|receiving${S}address|payout${S}address)\b`, "g"),
    squashed: /we(?:have)?(?:changed|moved|switched|updated)(?:our|the)(?:wallet|bankaccount|bank|account|paymentdetails|receivingaddress|payoutaddress)/g,
  },
  {
    id: "CD-07",
    group: "CHANGE_OF_DETAILS",
    label: "old wallet closed",
    re: new RegExp(String.raw`\b(?:old|previous|former)${S}(?:wallet|address|account)${S}(?:is|has${S}been|was)${S}(?:closed|deactivated|disabled|no${S}longer)\b`, "g"),
    squashed: /(?:old|previous|former)(?:wallet|address|account)(?:is|hasbeen|was)(?:closed|deactivated|disabled|nolonger)/g,
  },
  // --- instructions to the reader / an AI -----------------------------------------------------------------------
  {
    id: "IN-01",
    group: "INSTRUCTION",
    label: "ignore all/any/previous/above",
    re: new RegExp(String.raw`\b(?:ignore|disregard)${S}(?:the${S}|everything${S})?(?:all|any|previous|above|prior|preceding|before)\b${NOT_DOC_NOUN}`, "g"),
    squashed: new RegExp(`(?:ignore|disregard)(?:the|everything)?(?:all|any|previous|above|prior|preceding|before)${NOT_DOC_NOUN_SQ}`, "g"),
  },
  {
    id: "IN-02",
    group: "INSTRUCTION",
    label: "ignore the instructions",
    re: new RegExp(String.raw`\b(?:ignore|disregard|forget|override)${S}(?:the${S}|your${S}|all${S}|these${S}|those${S})?(?:above${S}|previous${S}|prior${S}|earlier${S}|original${S}|system${S})?(?:instructions?|rules|prompts?|guidelines|guardrails)\b`, "g"),
    squashed: /(?:ignore|disregard|forget|override)(?:the|your|all|these|those)?(?:above|previous|prior|earlier|original|system)?(?:instruction|rules|prompt|guideline|guardrail)/g,
  },
  { id: "IN-03", group: "INSTRUCTION", label: "system: role marker", re: new RegExp(`${LINE_START}${split("system")}${S}?:`, "g"), squashed: null },
  { id: "IN-04", group: "INSTRUCTION", label: "assistant: role marker", re: new RegExp(`${LINE_START}${split("assistant")}${S}?:`, "g"), squashed: null },
  {
    id: "IN-05",
    group: "INSTRUCTION",
    label: "you are now / you are an AI role",
    // 1.0.0 ("you are now", "you are a/the <AI role>") plus roles/modes up to two words away; the only narrowing is
    // honest account language right after "you are now" ("you are now on the Team plan", "...subscribed").
    re: new RegExp(
      String.raw`\byou${S}are${S}(?:now\b(?!${S}(?:on|subscribed|enrolled|registered|signed|eligible|part${S}of|a${S}(?:member|customer|subscriber))\b)|(?:now${S})?(?:an?${S}|the${S}|in${S})?(?:[a-z]+${S}){0,2}(?:ai|assistant|bot|chatbot|model|llm|agent|language${S}model|mode)\b)`,
      "g",
    ),
    squashed: null,
  },
  {
    id: "IN-06",
    group: "INSTRUCTION",
    label: "do not verify",
    re: new RegExp(String.raw`\b(?:(?:do${S}not|don't|dont|no${S}need${S}to)${S}(?:verify|check|validate|review|confirm)|without${S}(?:any${S})?(?:further${S})?(?:verification|verifying|checking|checks))\b`, "g"),
    squashed: /(?:donot|dont|noneedto)(?:verify|check|validate|review|confirm)|without(?:any)?(?:further)?(?:verification|verifying|checking)/g,
  },
  {
    id: "IN-07",
    group: "INSTRUCTION",
    label: "skip/bypass the check",
    re: new RegExp(String.raw`\b(?:skip|bypass|circumvent)${S}(?:the${S}|all${S}|any${S}|this${S})?(?:checks?|verification|validation|review|approval|controls?)\b`, "g"),
    squashed: /(?:skip|bypass|circumvent)(?:the|all|any|this)?(?:check|verification|validation|review|approval|control)/g,
  },
  {
    id: "IN-08",
    group: "INSTRUCTION",
    label: "approve/authorize this payment",
    re: new RegExp(String.raw`\b(?:approve|authori[sz]e)${S}(?:this|the)${S}(?:payment|invoice|transfer|transaction|request)\b`, "g"),
    squashed: /(?:approve|authori[sz]e)(?:this|the)(?:payment|invoice|transfer|transaction|request)/g,
  },
  {
    id: "IN-09",
    group: "INSTRUCTION",
    label: "mark as approved/verified",
    re: new RegExp(String.raw`\bmark${S}(?:this|it|the${S}invoice|this${S}invoice|the${S}payment|this${S}payment)${S}(?:as${S})?(?:approved|verified|pre-approved)\b`, "g"),
    squashed: /mark(?:this|it|theinvoice|thisinvoice|thepayment|thispayment)(?:as)?(?:approved|verified|preapproved)/g,
  },
  {
    id: "IN-10",
    group: "INSTRUCTION",
    label: "pay/transfer immediately",
    re: new RegExp(String.raw`\b(?:pay|transfer|send|wire|remit)${S}(?:(?:the|this)${S})?(?:(?:payment|funds|amount|money)${S})?(?:immediately|now|right${S}away|right${S}now|at${S}once|asap)\b`, "g"),
    squashed: /(?:pay|transfer|send|wire|remit)(?:the|this)?(?:payment|funds|amount|money)?(?:immediately|now|rightaway|atonce|asap)/g,
  },
  { id: "IN-11", group: "INSTRUCTION", label: "system prompt", re: new RegExp(String.raw`\bsystem${S}prompt\b`, "g"), squashed: /systemprompt/g },
  {
    id: "IN-12",
    group: "INSTRUCTION",
    label: "ignore/forget the instructions (other languages)",
    // the verb, up to three words (quantifier, article, adjective in any order), then the noun
    re: new RegExp(
      String.raw`\b(?:ignora|ignorar|ignorez|ignore|ignoriere|ignorieren|negeer|olvida|olvide|oubliez|oublie|vergiss|vergessen|dimentica)${S}(?:[a-z]+${S}){0,3}(?:instrucciones|instructions|anweisungen|instructies|instrucoes|istruzioni)\b`,
      "g",
    ),
    squashed: /(?:ignora|ignorar|ignorez|ignore|ignoriere|negeer|olvida|olvide|oubliez|oublie|vergiss|vergessen|dimentica)[a-z]{0,40}?(?:instrucciones|instructions|anweisungen|instructies|instrucoes|istruzioni)/g,
  },
  {
    id: "IN-13",
    group: "INSTRUCTION",
    label: "claims prior approval",
    re: new RegExp(String.raw`\b(?:(?:already|pre-?)${S}?approved${S}by${S}(?:the${S})?(?:owner|client|cfo|ceo|finance|management)|(?:owner|client|cfo)${S}(?:has${S})?already${S}approved)\b`, "g"),
    squashed: /(?:already|pre)approvedby(?:the)?(?:owner|client|cfo|ceo|finance|management)|(?:owner|client|cfo)(?:has)?alreadyapproved/g,
  },
  {
    id: "IN-14",
    group: "INSTRUCTION",
    label: "no further checks required",
    re: new RegExp(String.raw`\bno${S}(?:further${S}|additional${S})?(?:checks?|verification|approval|review)${S}(?:is${S}|are${S})?(?:required|needed|necessary)\b`, "g"),
    squashed: /no(?:further|additional)?(?:check|checks|verification|approval|review)(?:is|are)?(?:required|needed|necessary)/g,
  },
  // --- structure: prompt markup and hidden comments --------------------------------------------------------------
  {
    id: "ST-04",
    group: "STRUCTURE",
    label: "prompt or tool markup",
    re: /<\/?(?:document|instructions?|system|assistant|user|tool_result|tool_call)>|<\|im_(?:start|end)\|>|\[\/?(?:inst|tool_result|system)\]|\[\/\/\]:\s?#/g,
    squashed: null,
  },
  { id: "ST-05", group: "STRUCTURE", label: "HTML comment", re: /<!--/g, squashed: null },
]);

/** Structural thresholds (docs/04 K-11): ANY hidden character is a finding; base64-like runs over 200 characters. */
export const HIDDEN_CHAR_LIMIT = 0;
export const BASE64_RUN_LIMIT = 200;

// --- normalization ----------------------------------------------------------------------------------------------

/** Lookalike -> ASCII letter (applied after NFKC, before lowercasing). Built from code points: no lookalike in source. */
const HOMOGLYPHS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    (
      [
        // Cyrillic capitals and small letters
        [0x410, "a"], [0x430, "a"], [0x412, "b"], [0x421, "c"], [0x441, "c"], [0x415, "e"], [0x435, "e"], [0x41d, "h"], [0x4bb, "h"],
        [0x406, "i"], [0x456, "i"], [0x408, "j"], [0x458, "j"], [0x41a, "k"], [0x43a, "k"], [0x41c, "m"], [0x43c, "m"], [0x41e, "o"],
        [0x43e, "o"], [0x420, "p"], [0x440, "p"], [0x405, "s"], [0x455, "s"], [0x422, "t"], [0x442, "t"], [0x425, "x"], [0x445, "x"],
        [0x423, "y"], [0x443, "y"], [0x4ae, "y"], [0x4af, "y"], [0x51a, "q"], [0x51b, "q"], [0x51c, "w"], [0x51d, "w"], [0x4c0, "l"],
        [0x4cf, "l"], [0x500, "d"], [0x501, "d"],
        // Greek
        [0x391, "a"], [0x3b1, "a"], [0x392, "b"], [0x395, "e"], [0x3b5, "e"], [0x396, "z"], [0x397, "h"], [0x399, "i"], [0x3b9, "i"],
        [0x39a, "k"], [0x3ba, "k"], [0x39c, "m"], [0x39d, "n"], [0x3bd, "v"], [0x39f, "o"], [0x3bf, "o"], [0x3a1, "p"], [0x3c1, "p"],
        [0x3a4, "t"], [0x3c4, "t"], [0x3a5, "y"], [0x3c5, "u"], [0x3a7, "x"], [0x3c7, "x"], [0x3f2, "c"], [0x3f3, "j"],
        // Latin small capitals and other letters NFKC leaves alone
        [0x1d00, "a"], [0x299, "b"], [0x1d04, "c"], [0x1d05, "d"], [0x1d07, "e"], [0x262, "g"], [0x29c, "h"], [0x26a, "i"],
        [0x1d0a, "j"], [0x1d0b, "k"], [0x29f, "l"], [0x1d0d, "m"], [0x274, "n"], [0x1d0f, "o"], [0x1d18, "p"], [0x280, "r"],
        [0xa731, "s"], [0x1d1b, "t"], [0x1d1c, "u"], [0x1d20, "v"], [0x1d21, "w"], [0x28f, "y"], [0x1d22, "z"], [0x131, "i"], [0x261, "g"],
      ] as const
    ).map(([cp, ascii]) => [U(cp), ascii]),
  ),
);

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /\s/u;

/**
 * Hidden characters: invisible in a rendered document, never needed in an invoice. Control characters (every C0 and C1
 * control and DEL, except TAB, LF and CR), format characters (zero-width, bidi controls and marks, BOM, soft hyphen,
 * word joiner, Unicode tags), variation selectors, the combining grapheme joiner and the Hangul/half-width fillers.
 */
export function isHidden(ch: string): boolean {
  const cp = ch.codePointAt(0) as number;
  return (
    (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    FORMAT.test(ch) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp === 0x034f ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x3164 ||
    cp === 0xffa0
  );
}

export interface Folded {
  readonly text: string;
  /** offsets[k] = UTF-16 index in the original text of the code point that produced folded unit k. */
  readonly offsets: readonly number[];
  /** Hidden characters seen (counted in both modes). */
  readonly hidden: number;
}

/**
 * How hidden characters are treated. `canonical`: stripped (they can never split a keyword). `literal`: exactly as
 * symbolon-patterns/1.0.0 folded them (format characters and marks stripped, controls kept as non-letters, VT/FF as
 * spaces, fillers decomposed and kept). The scan uses the literal view as well whenever a hidden character is present,
 * so detection is never below 1.0.0 (test/k11-oracle.test.ts) while the canonical view closes the split-keyword gap.
 */
export type FoldMode = "canonical" | "literal";

/**
 * The canonical normalization (see the module comment). Letters: compatibility decomposition with marks removed
 * (the same letters NFKC + accent removal yields), the lookalike map on each decomposed base letter, lowercase.
 * Deterministic; no locale-dependent API.
 */
export function foldForScan(text: string, mode: FoldMode = "canonical"): Folded {
  let out = "";
  const offsets: number[] = [];
  let hidden = 0;
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
    i += ch.length;
    const at = i - ch.length;
    if (isHidden(ch)) {
      hidden++;
      if (mode === "canonical") continue;
    }
    if (cp < 0x80) {
      if (SPACE.test(ch)) space(ch === "\r" ? "\n" : ch, at);
      else emit(cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 32) : ch, at);
      continue;
    }
    for (const part of ch.normalize("NFKD")) {
      if (MARK.test(part) || FORMAT.test(part)) continue;
      for (const c of (HOMOGLYPHS[part] ?? part).toLowerCase().normalize("NFKD")) {
        if (MARK.test(c)) continue;
        if (SPACE.test(c)) space(c, at);
        else emit(c, at);
      }
    }
  }
  if (pending !== null) {
    out += pending;
    offsets.push(pendingAt);
  }
  return { text: out, offsets, hidden };
}

/** The squashed view of a folded text: only [a-z0-9] kept, offsets carried over. */
export function squash(folded: Folded): Omit<Folded, "hidden"> {
  let out = "";
  const offsets: number[] = [];
  for (let k = 0; k < folded.text.length; k++) {
    const c = folded.text.charCodeAt(k);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) {
      out += folded.text.charAt(k);
      offsets.push(folded.offsets[k] as number);
    }
  }
  return { text: out, offsets };
}

// --- scan -----------------------------------------------------------------------------------------------------

export interface PatternMatch {
  readonly id: string;
  readonly group: PatternGroup;
  readonly label: string;
  /** UTF-16 offset in the original text; -1 for document-level findings (hidden characters, extractor anomaly). */
  readonly offset: number;
}

const ADDRESS = /(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/g;
const NEXT_ADDRESS = /0x[0-9a-f]{40}/;
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${BASE64_RUN_LIMIT + 1},}`, "g");
/** How far after a CD-04 match (normalized characters) the address it introduces is looked for. */
const CD04_LOOKAHEAD = 160;

export interface ScanInput {
  readonly text: string;
  /** Hidden characters the kernel removed when it normalized the document (Document.zeroWidthCount; all categories). */
  readonly zeroWidthCount: number;
  /** Addresses that may appear without suspicion (engagement payee and owner, vault, token); compared lowercase. */
  readonly knownAddresses: readonly string[];
}

/** All K-11 findings in the text, sorted by offset (document-level findings first); one per (pattern, offset). */
export function scanDocument(input: ScanInput): readonly PatternMatch[] {
  const known = new Set(input.knownAddresses.map((a) => a.toLowerCase()));
  const folded = foldForScan(input.text);
  const squashed = squash(folded);
  const found = new Map<string, PatternMatch>();
  const add = (m: PatternMatch) => {
    const key = `${m.id}@${m.offset}`;
    if (!found.has(key)) found.set(key, m);
  };

  const hidden = input.zeroWidthCount + folded.hidden;
  if (hidden > HIDDEN_CHAR_LIMIT) add({ id: "ST-01", group: "STRUCTURE", label: "hidden or bidi characters", offset: -1 });

  // The literal view differs from the canonical one only where hidden characters are present.
  const literal = folded.hidden > 0 ? [foldForScan(input.text, "literal")] : [];
  const folds = [folded, ...literal];
  const views = [
    ...folds.map((view) => ({ view, pick: (p: TextPattern) => p.re })),
    { view: squashed, pick: (p: TextPattern) => p.squashed },
  ];
  for (const { view, pick } of views) {
    for (const p of TEXT_PATTERNS) {
      const re = pick(p);
      if (re === null) continue;
      for (const m of view.text.matchAll(re)) {
        if (p.id === "CD-04") {
          const next = NEXT_ADDRESS.exec(view.text.slice(m.index, m.index + m[0].length + CD04_LOOKAHEAD));
          if (next !== null && known.has(next[0])) continue;
        }
        add({ id: p.id, group: p.group, label: p.label, offset: view.offsets[m.index] as number });
      }
    }
  }
  for (const m of input.text.matchAll(BASE64_RUN)) {
    add({ id: "ST-02", group: "STRUCTURE", label: `base64-like run over ${BASE64_RUN_LIMIT} characters`, offset: m.index });
  }
  for (const view of folds) {
    for (const m of view.text.matchAll(ADDRESS)) {
      if (!known.has(m[0])) add({ id: "ST-03", group: "STRUCTURE", label: "an address that is not the engagement payee", offset: view.offsets[m.index] as number });
    }
  }
  return [...found.values()].sort((a, b) => a.offset - b.offset);
}
