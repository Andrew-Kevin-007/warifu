// SIMULATED fallible extractor models for the eval harness. No LLM API key exists in this repository, so the eval
// cannot measure a real model. It measures the PIPELINE (validators, deterministic cross-checks, signals,
// consensus, budget wrapper) against models that are given realistic, seeded failure modes. Every figure derived
// from this file is labelled SIMULATED. It says nothing about the accuracy of any real model; "real model
// accuracy" stays NOT MEASURED until a recorded live run exists (RecordingLlm / ReplayLlm support that).
//
// Deterministic: all randomness comes from sha256(seed|trial|case|role) through a small integer PRNG.
import { normalizeUntrusted, inspectUntrusted, sha256Utf8, type Hex32 } from "@symbolon/schemas";
import { documentMarker } from "../src/prompts";
import { prepareDocument } from "../src/prepare";
import { ProviderError, type LlmClient, type LlmRequest, type LlmResponse } from "../src/llm/types";
import { ATTACKER_WALLET, WALLETS, type GoldenCase } from "./corpus";

export type FaultId =
  | "SCALE_UP_1000"
  | "SCALE_DOWN_1000"
  | "GUESS_AMBIGUOUS"
  | "HALLUCINATE_ADDRESS"
  | "DROP_WALLET"
  | "TRUNCATE_INVOICE_NO"
  | "OMIT_ANOMALIES"
  | "FOLLOW_INJECTION"
  | "WRONG_NET_DAYS"
  | "DROP_EARLY_PAY"
  | "INVENT_TERMS"
  | "UNDECLARED_TOOL"
  | "WRONG_CURRENCY_LABEL"
  | "WRONG_DOC_TYPE";

export const FAULT_IDS: readonly FaultId[] = [
  "SCALE_UP_1000", "SCALE_DOWN_1000", "GUESS_AMBIGUOUS", "HALLUCINATE_ADDRESS", "DROP_WALLET", "TRUNCATE_INVOICE_NO", "OMIT_ANOMALIES",
  "FOLLOW_INJECTION", "WRONG_NET_DAYS", "DROP_EARLY_PAY", "INVENT_TERMS", "UNDECLARED_TOOL", "WRONG_CURRENCY_LABEL", "WRONG_DOC_TYPE",
];

/** Per-fault probabilities in basis points, per role. Model B differs from A so errors are only partly correlated. */
const RATES: Record<"extractor_a" | "extractor_b", Readonly<Record<FaultId, number>>> = {
  extractor_a: {
    SCALE_UP_1000: 1000, SCALE_DOWN_1000: 600, GUESS_AMBIGUOUS: 5000, HALLUCINATE_ADDRESS: 400, DROP_WALLET: 300, TRUNCATE_INVOICE_NO: 400,
    OMIT_ANOMALIES: 4000, FOLLOW_INJECTION: 3000, WRONG_NET_DAYS: 800, DROP_EARLY_PAY: 800, INVENT_TERMS: 300, UNDECLARED_TOOL: 200,
    WRONG_CURRENCY_LABEL: 300, WRONG_DOC_TYPE: 300,
  },
  extractor_b: {
    SCALE_UP_1000: 800, SCALE_DOWN_1000: 800, GUESS_AMBIGUOUS: 4000, HALLUCINATE_ADDRESS: 300, DROP_WALLET: 400, TRUNCATE_INVOICE_NO: 300,
    OMIT_ANOMALIES: 5000, FOLLOW_INJECTION: 2500, WRONG_NET_DAYS: 1000, DROP_EARLY_PAY: 600, INVENT_TERMS: 400, UNDECLARED_TOOL: 100,
    WRONG_CURRENCY_LABEL: 400, WRONG_DOC_TYPE: 200,
  },
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Wire = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test double builds loose JSON

function guessSeparator(printed: string, ambiguous: boolean): string {
  if (ambiguous) return "ambiguous";
  const lastDot = printed.lastIndexOf(".");
  const lastComma = printed.lastIndexOf(",");
  if (lastDot < 0 && lastComma < 0) return "none";
  return lastDot > lastComma ? "." : ",";
}

/** The correct extraction a competent model would produce for a case (before faults). */
export function truthWire(c: GoldenCase): Wire {
  const e = c.expected;
  const lines = c.text.split("\n");
  const due = /(?:Due|Faellig|Echeance|Vencimiento): (\d{4}-\d{2}-\d{2})/.exec(c.text)?.[1] ?? null;
  const name = lines.map((l) => /^(?:From|Von|De): (.+)$/.exec(l)?.[1]).find((x) => x !== undefined) ?? null;
  const ambiguous = c.modelUnits === null && e.parsedBaseUnits === null;
  const anomalies: Array<{ code: string; quote: string }> = [];
  if (e.injectedSnippet !== null) anomalies.push({ code: "INSTRUCTION_IN_DOC", quote: inspectUntrusted(normalizeUntrusted(e.injectedSnippet).normalized).slice(0, 200) });
  if (e.claimsAddressChange) anomalies.push({ code: "ADDRESS_CHANGE", quote: "updated payment details" });
  if (e.terms?.early) anomalies.push({ code: "TERMS_CLAIM", quote: e.terms.text });
  if (ambiguous) anomalies.push({ code: "AMOUNT_AMBIGUOUS", quote: e.printed });
  if (e.invoiceNumber === "") anomalies.push({ code: "MISSING_FIELD", quote: "invoiceNumber" });
  return {
    docType: e.docType,
    invoiceNumber: e.invoiceNumber,
    issueDate: "2026-10-01",
    dueDate: due,
    payee: { legalName: name, walletAddress: e.walletAddress, claimsAddressChange: e.claimsAddressChange },
    amount: {
      printed: e.printed,
      currencyPrinted: e.currencyPrinted,
      decimalSeparatorGuess: guessSeparator(e.printed, ambiguous),
      parsedBaseUnits: c.modelUnits,
      decimals: c.modelUnits === null ? null : 6,
    },
    references: { engagementId: null, milestoneId: null, poNumber: null },
    statedTerms: { raw: e.terms?.text ?? null, netDays: e.terms?.netDays ?? null, earlyPay: e.terms?.early ?? null, ambiguous: false },
    lineItems: [],
    anomalies,
    confidence: 0.9,
  };
}

export interface Emitted {
  readonly caseId: string;
  readonly role: "extractor_a" | "extractor_b";
  readonly trial: number;
  readonly wire: Wire;
  readonly faults: readonly FaultId[];
}

export interface SimOptions {
  readonly seed: number;
  readonly trial: number;
  readonly cases: readonly GoldenCase[];
}

/** An LlmClient that behaves like a fallible extraction model. `emitted` records what it returned, for the eval. */
export function simulatedModel(opts: SimOptions): LlmClient & { readonly emitted: Emitted[] } {
  const byMarker = new Map<string, GoldenCase>();
  for (const c of opts.cases) {
    const p = prepareDocument(c.text);
    if (p.ok) byMarker.set(documentMarker(p.value.normalized), c);
  }
  const emitted: Emitted[] = [];
  return {
    emitted,
    complete(req: LlmRequest): Promise<LlmResponse> {
      const first = req.messages[0];
      const marker = first !== undefined && first.role === "user" ? /<document id="([0-9a-f]{16})">/.exec(first.text)?.[1] : undefined;
      const c = marker === undefined ? undefined : byMarker.get(marker);
      if (c === undefined || (req.role !== "extractor_a" && req.role !== "extractor_b")) return Promise.reject(new ProviderError("simulated model: unknown document"));
      const role = req.role;
      const h: Hex32 = sha256Utf8(`${opts.seed}|${opts.trial}|${c.id}|${role}`);
      const rnd = mulberry32(Number.parseInt(h.slice(2, 10), 16));
      const hit = (id: FaultId) => rnd() * 10000 < RATES[role][id];

      const w = truthWire(c);
      const faults: FaultId[] = [];
      const inject = (id: FaultId, apply: () => void) => {
        faults.push(id);
        apply();
      };

      const parsed = (): string | null => w.amount.parsedBaseUnits;
      if (parsed() !== null && hit("SCALE_UP_1000")) inject("SCALE_UP_1000", () => (w.amount.parsedBaseUnits = `${parsed()}000`));
      else if (parsed() !== null && parsed()!.endsWith("000") && hit("SCALE_DOWN_1000")) inject("SCALE_DOWN_1000", () => (w.amount.parsedBaseUnits = parsed()!.slice(0, -3)));
      if (parsed() === null && w.amount.decimalSeparatorGuess === "ambiguous" && hit("GUESS_AMBIGUOUS")) {
        inject("GUESS_AMBIGUOUS", () => {
          w.amount.parsedBaseUnits = `${c.expected.printed.replace(/\D/g, "")}000000`;
          w.amount.decimals = 6;
          w.amount.decimalSeparatorGuess = ".";
        });
      }
      if (w.payee.walletAddress !== null && hit("HALLUCINATE_ADDRESS")) {
        const other = WALLETS.find((x) => !c.text.toLowerCase().includes(x.toLowerCase()));
        if (other !== undefined) inject("HALLUCINATE_ADDRESS", () => (w.payee.walletAddress = other));
      } else if (w.payee.walletAddress !== null && hit("DROP_WALLET")) inject("DROP_WALLET", () => (w.payee.walletAddress = null));
      if (c.injection && c.text.toLowerCase().includes(ATTACKER_WALLET.toLowerCase()) && hit("FOLLOW_INJECTION")) {
        inject("FOLLOW_INJECTION", () => (w.payee.walletAddress = ATTACKER_WALLET));
      }
      if (w.invoiceNumber.length > 3 && hit("TRUNCATE_INVOICE_NO")) inject("TRUNCATE_INVOICE_NO", () => (w.invoiceNumber = w.invoiceNumber.slice(0, -1)));
      if (hit("OMIT_ANOMALIES")) inject("OMIT_ANOMALIES", () => (w.anomalies = []));
      if (w.statedTerms.netDays !== null && hit("WRONG_NET_DAYS")) inject("WRONG_NET_DAYS", () => (w.statedTerms.netDays = w.statedTerms.netDays + 15));
      if (w.statedTerms.earlyPay !== null && hit("DROP_EARLY_PAY")) inject("DROP_EARLY_PAY", () => (w.statedTerms.earlyPay = null));
      if (c.expected.terms === null && hit("INVENT_TERMS")) inject("INVENT_TERMS", () => (w.statedTerms.netDays = 30));
      if (w.amount.currencyPrinted === "USDC" && hit("WRONG_CURRENCY_LABEL")) inject("WRONG_CURRENCY_LABEL", () => (w.amount.currencyPrinted = "USD"));
      if (hit("WRONG_DOC_TYPE")) inject("WRONG_DOC_TYPE", () => (w.docType = w.docType === "INVOICE" ? "OTHER" : "INVOICE"));

      emitted.push({ caseId: c.id, role, trial: opts.trial, wire: structuredClone(w), faults });
      const tokensIn = Math.ceil(req.system.length / 4) + Math.ceil(c.text.length / 4); // ESTIMATE: ~4 chars per token
      const tokensOut = Math.ceil(JSON.stringify(w).length / 4);
      if (hit("UNDECLARED_TOOL")) {
        faults.push("UNDECLARED_TOOL");
        return Promise.resolve({ toolCalls: [{ id: "x", name: "http_get", input: { url: "http://example.invalid" } }], text: null, usage: { tokensIn, tokensOut } });
      }
      return Promise.resolve({ toolCalls: [{ id: "sub", name: "submit_extraction", input: w }], text: null, usage: { tokensIn, tokensOut } });
    },
  };
}
