// "Nice try" lines (docs/BRAND_AND_IDEA.md, Bound it). Pure and deterministic: the line is chosen from the receipt hash, so the
// same receipt always shows the same sentence. Copy is dry, never cruel, and is fixed text keyed by reason code: it never
// quotes or paraphrases invoice, vendor, filename, extractor or model text (INV-15/20). It is copy, not evidence; the
// evidence is the receipt and the reason code printed next to it. No figures are typed here (INV-18).
import { REASON_CODES } from "@symbolon/schemas";
import type { ReasonCode, Verdict } from "@symbolon/schemas";

export type PhraseBank = readonly [string, string, string, ...string[]];

export const NICE_TRY_PHRASES: Readonly<Record<ReasonCode, PhraseBank>> = {
  SCHEMA_INVALID: ["The request arrived in a shape the kernel does not read. Nice try.", "Malformed on arrival. The kernel is a strict reader.", "That did not parse, so it did not pay."],
  NON_ASCII_DIGITS: ["Those digits were not the digits the kernel counts in. Nice try.", "A number written in a foreign script is still not a number the kernel accepts.", "Creative numerals. The kernel only reads plain ones."],
  SCIENTIFIC: ["Scientific notation on an invoice. Nice try.", "An amount in exponent form did not get through.", "The kernel pays in plain numbers only."],
  REFUSE_ROUND: ["More decimals than the currency has. The kernel declined to round it in anyone's favour.", "Fractions of a unit are not a payment. Nice try.", "The kernel does not round. It asks."],
  AMOUNT_AMBIGUOUS: ["The amount could be read two ways, so it was read neither.", "An ambiguous total is not a total. Nice try.", "When the number is unclear, the answer is no."],
  EXTRACTION_PARSE_MISMATCH: ["The AI read one number and the kernel read another. The kernel's reading wins.", "Two readers, two answers. Nothing moved.", "The proposal and the document disagreed. The document is not up for negotiation."],
  LINEITEM_SUM_MISMATCH: ["The lines did not add up to the total. Nice try.", "The arithmetic did not survive a second look.", "A total that disagrees with its own lines is a total that waits."],
  CREDIT_NOTE: ["A credit note is not an invoice. Nice try.", "That document asks for nothing to be paid, so nothing was.", "Wrong kind of paper."],
  NOT_PAYABLE: ["That document is not something the treasurer pays. Nice try.", "Not a payable document. Not a payment.", "Official-looking is not the same as payable."],
  DUPLICATE_DOC: ["Seen this one. Already decided.", "The same document twice is still the same document. Nice try.", "A second copy gets the first copy's answer."],
  NEAR_DUPLICATE: ["That looks a lot like something decided recently. It waits for a human.", "Suspiciously similar to a recent payment. A person gets to look.", "Close enough to a recent payment to stop and ask."],
  MILESTONE_ALREADY_PAID: ["That milestone is already settled. Nice try.", "Paid once. The kernel remembers.", "Asking again does not make it owed again."],
  NO_ENGAGEMENT: ["No signed engagement, no payment. Nice try.", "The kernel looked for a signed agreement and found none.", "Without a signed engagement there is nothing to pay against."],
  ENGAGEMENT_INACTIVE: ["The agreement behind this invoice is not active. Nice try.", "That engagement is not in force, so neither is the invoice.", "The agreement is not live. Neither is the payment."],
  OUT_OF_WINDOW: ["Outside the dates the agreement allows. Nice try.", "The calendar said no.", "Right invoice, wrong time."],
  MILESTONE_ORDER: ["Milestones are paid in order. Nice try.", "Skipping ahead is not on the agreement.", "That step comes later. The queue is the queue."],
  UNKNOWN_MILESTONE: ["That milestone is not in the agreement. Nice try.", "The invoice mentioned a step nobody signed.", "An unknown milestone is an unpaid milestone."],
  PAYEE_MISMATCH: ["A different wallet asked to be paid. Nice try.", "The invoice named a payee the signed agreement does not. Nobody gets paid at the new address.", "The wallet did not match the signed one. The money stayed put."],
  ADDRESS_CHANGE_CLAIMED: ["A document announced a change of bank details. Documents do not get to do that. Nice try.", "New payout address, no signature. No payment.", "The change-of-address request did not come from the owner, so it changed nothing."],
  PAYEE_CHANGE_PENDING: ["A payee change is still waiting out its delay. Patience.", "The new address is in the waiting room. Payments wait with it.", "Changes to who gets paid take time on purpose."],
  CURRENCY_UNSUPPORTED: ["That is not a currency this vault pays in. Nice try.", "Unsupported currency, unsupported payment.", "The vault pays in one kind of money. This was another."],
  DECIMALS_MISMATCH: ["The token's decimals did not match what was declared. Nice try.", "Right currency, wrong precision. That is how a large number becomes a very large number.", "The units did not line up, so the payment did not go."],
  SCALE_ABSURD: ["That amount is off by orders of magnitude. Nice try.", "A number that large needs a person, and the person said no.", "The scale looked wrong, so the kernel treated it as wrong."],
  OVERPAY: ["More than was agreed. Nice try.", "The invoice asked for more than the agreement allows.", "The agreed amount is the ceiling."],
  UNDERPAY_PARTIAL: ["Less than the agreed amount. A person decides what to do about the rest.", "A partial amount is a question, not an answer.", "The invoice covers only part of the milestone, so it waits for a look."],
  EVIDENCE_MISSING: ["No evidence that the work happened. Nice try.", "The kernel asked for proof of delivery and got none.", "Delivered, says the invoice. Show me, says the kernel."],
  EVIDENCE_FAILED: ["The evidence did not back the invoice up. Nice try.", "The check came back negative. The payment did not.", "The invoice and the evidence disagreed."],
  EVIDENCE_HASH_MISMATCH: ["The evidence changed after it was recorded. Nice try.", "The fingerprint did not match. Neither did the story.", "Altered evidence is not evidence."],
  EXTRACTION_DISAGREE: ["Two readers disagreed about the document. A human settles it.", "The AI could not agree with itself, so the kernel did not pick a side.", "Two reads, two answers, no payment."],
  SINGLE_EXTRACTION: ["Only one reading of the document. The kernel wants two.", "One opinion is not a consensus. It waits.", "A single read is not enough to move money."],
  INSTRUCTION_IN_DOC: ["The document tried to give the treasurer orders. Nice try.", "Invoices do not get to issue instructions.", "Text inside a document is data. It was treated as data."],
  CAP_PER_TX: ["Over the limit for a single payment. Nice try.", "That is bigger than any one payment is allowed to be.", "The per-payment cap said no."],
  CAP_DAILY: ["Today's limit is used up. Try again tomorrow, politely.", "The daily cap closed the door.", "Enough for one day."],
  CAP_WEEKLY: ["The weekly limit is used up. Patience.", "This week's allowance is spent.", "The weekly cap has the final word."],
  CATEGORY_BUDGET: ["That budget line is empty. Nice try.", "The category ran out of room.", "No budget left in that category."],
  VELOCITY: ["Too many payments too fast. The kernel slowed down.", "A burst of requests is a reason to look twice.", "Rapid-fire is not how this works."],
  HUMAN_REQUIRED: ["This one needs a person. The treasurer asked.", "Above what the treasurer decides alone. Over to a human.", "Some decisions are not delegated."],
  FIRST_PAYMENT_LARGE: ["A big first payment to a new payee. A person gets to look first.", "New payee, large amount. That is how this works the first time.", "First payments are small or supervised."],
  SCREENING_PENDING: ["The screening check has not finished. The payment waits for it.", "No screening result yet, so no payment yet.", "Waiting on the screen. It will not be rushed."],
  SCREEN_HIT: ["The screening check flagged this payee. Nice try.", "A screening hit stops the payment cold.", "The payee did not clear screening."],
  SCREENING_DISABLED: ["Screening is switched off, so the treasurer asked a person.", "Without a screening result the kernel does not guess.", "No screen, no automatic payment."],
  LIQUIDITY: ["The vault does not have the funds right now. Nice try.", "Nothing to pay with. The invoice waits.", "An empty vault makes a short answer."],
  TIMING_CLAMPED: ["The payment time was moved to what the agreement says.", "The kernel keeps the clock, not the invoice.", "Timing comes from the signed terms."],
  LATE: ["Past the date the agreement allows. Nice try.", "The window closed.", "Too late is still too late."],
  BREAKER_HALTED: ["The circuit breaker is open. Nothing moves until a person closes it.", "Paused on purpose. Nothing is paying right now.", "The breaker tripped. The treasurer is holding still."],
  KERNEL_ERROR: ["The kernel hit an error and did what it does: it did not pay.", "Something went wrong inside, so nothing went out.", "When in doubt, no."],
  TERMS_NOT_SIGNED: ["Payment terms nobody signed. Nice try.", "The only terms that count are the signed ones.", "Terms stated on an invoice are a request, not a contract."],
  TERMS_MISMATCH: ["The invoice's terms did not match the signed ones. The signed ones won.", "Different terms than agreed. Nice try.", "The invoice proposed new terms. The agreement stayed as signed."],
  DISCOUNT_WINDOW_CLOSED: ["The early-payment window has closed. Nice try.", "The discount expired. The kernel kept the clock.", "Too late for the discount."],
  EVIDENCE_SOURCE_DENIED: ["The evidence came from somewhere the kernel does not look. Nice try.", "That source is not on the list, so it counts for nothing.", "The kernel fetches its own evidence, from places it chose."],
  ESCALATION_BUDGET_EXCEEDED: ["The review budget for this period is used up. It waits.", "Too many questions for one period. The rest queue.", "The escalation allowance is spent."],
  PLAN_OUT_OF_ENVELOPE: ["That payment plan stepped outside what the vault allows. Nice try.", "The plan was clever. The envelope did not care.", "Plans stay inside the envelope."],
};

export const GENERIC_PHRASES: Readonly<Record<"RELEASE" | "HOLD" | "ESCALATE" | "REJECT" | "REPLAY", PhraseBank>> = {
  RELEASE: ["This one fit. The halves matched and it was released.", "Nothing to see here: terms, payee and evidence all lined up.", "A boring payment, which is the goal."],
  HOLD: ["Held. Nothing moved.", "Paused until something changes.", "Waiting, on purpose."],
  ESCALATE: ["Over to a human.", "The treasurer asked a person.", "This one needs a second pair of eyes."],
  REJECT: ["Not today. Nice try.", "No.", "Declined, with a receipt."],
  REPLAY: ["Seen this one already; same answer.", "A repeat request gets the original answer.", "Nothing new here."],
};

function pick(bank: PhraseBank, receiptHash: string): string {
  const hex = /^0x[0-9a-fA-F]{64}$/.test(receiptHash) ? receiptHash.slice(2, 10) : "00000000";
  const n = Number.parseInt(hex, 16);
  return bank[n % bank.length] as string;
}

export interface NiceTry {
  readonly line: string;
  /** the reason code the line is keyed on, or null when the line is verdict-level */
  readonly reasonCode: ReasonCode | null;
}

/** The first reason code decides the line (the kernel orders reasons by check id), else a verdict-level line. */
export function niceTry(i: { verdict: Verdict; reasons: readonly ReasonCode[]; receiptHash: string }): NiceTry {
  const first = i.reasons.find((r) => Object.prototype.hasOwnProperty.call(NICE_TRY_PHRASES, r));
  if (i.verdict !== "RELEASE" && first !== undefined) return { line: pick(NICE_TRY_PHRASES[first], i.receiptHash), reasonCode: first };
  return { line: pick(GENERIC_PHRASES[i.verdict], i.receiptHash), reasonCode: null };
}

export const ALL_REASON_CODES: readonly ReasonCode[] = REASON_CODES;
