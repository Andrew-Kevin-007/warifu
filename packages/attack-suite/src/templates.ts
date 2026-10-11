// Invoice templates (docs/07 §3.2: >= 6 styles) and the REFERENCE extraction that goes with each rendering.
//
// A template renders an InvoiceSpec to plain text, the way a text layer or an e-mail body would look. The
// kernel never parses binary (INV-23), so even the "pdf-text-layer" style is text with the typical artefacts
// of PDF text extraction (page markers and column padding), not a PDF.
//
// `referenceExtraction` builds the ExtractedInvoice a careful reader would produce for that exact rendering.
// It is derived from the spec the renderer was given, not from an LLM, so it is a ground-truth read; steered
// or mis-read variants are made by overriding fields (see build.ts). Honest renderings contain no hidden
// characters, so a hidden-character anomaly is never present on an honest document.
import {
  untrusted,
  type Address,
  type ExtractedInvoice,
  type ISODate,
  type StatedTerms,
} from "@symbolon/schemas";
import { classifyPrinted, printAmount, type NumberStyle } from "./money-format";
import type { TemplateStyle } from "./types";

export interface LineItem {
  readonly description: string;
  readonly amountBaseUnits: bigint;
}

export type SpecDocType = "INVOICE" | "CREDIT_NOTE" | "STATEMENT" | "OTHER";

export interface InvoiceSpec {
  readonly style: TemplateStyle;
  readonly docType: SpecDocType;
  readonly invoiceNumber: string;
  readonly issueDate: ISODate;
  readonly dueDate: ISODate | null;
  readonly payeeName: string;
  readonly payeeAddress: Address | null;
  readonly billTo: string;
  readonly amountBaseUnits: bigint;
  readonly decimals: number;
  readonly numberStyle: NumberStyle;
  readonly currencyLabel: string;
  /** null = a single line described by `description`. */
  readonly items: readonly LineItem[] | null;
  readonly description: string;
  readonly engagementRef: string | null;
  readonly milestoneRef: string | null;
  readonly poNumber: string | null;
  readonly termsLine: string | null;
  /** Paragraphs placed before the total (injection slot). */
  readonly bodyExtra: readonly string[];
  /** Lines placed after the total (injection slot). */
  readonly footer: readonly string[];
  /** Replaces the printed total verbatim (ambiguous or malformed prints). */
  readonly printedTotal?: string;
}

export interface RenderedInvoice {
  readonly text: string;
  readonly printedTotal: string;
  readonly itemPrints: readonly string[];
}

interface Labels {
  readonly heading: Record<SpecDocType, string>;
  readonly number: string;
  readonly date: string;
  readonly due: string;
  readonly from: string;
  readonly wallet: string;
  readonly to: string;
  readonly ref: string;
  readonly desc: string;
  readonly total: string;
  readonly terms: string;
}

const EN: Labels = {
  heading: { INVOICE: "INVOICE", CREDIT_NOTE: "CREDIT NOTE", STATEMENT: "STATEMENT OF ACCOUNT", OTHER: "DOCUMENT" },
  number: "Invoice no.",
  date: "Date",
  due: "Due",
  from: "From",
  wallet: "Wallet",
  to: "To",
  ref: "Reference",
  desc: "Description",
  total: "Total due",
  terms: "Terms",
};
const US: Labels = {
  heading: { INVOICE: "Invoice", CREDIT_NOTE: "Credit Memo", STATEMENT: "Account Statement", OTHER: "Document" },
  number: "Invoice #",
  date: "Invoice date",
  due: "Payment due",
  from: "Remit to",
  wallet: "USDC address",
  to: "Bill to",
  ref: "PO / Ref",
  desc: "Work performed",
  total: "Amount due",
  terms: "Terms",
};
const DE: Labels = {
  heading: { INVOICE: "RECHNUNG", CREDIT_NOTE: "GUTSCHRIFT", STATEMENT: "KONTOAUSZUG", OTHER: "DOKUMENT" },
  number: "Rechnungsnr.",
  date: "Rechnungsdatum",
  due: "Faellig am",
  from: "Von",
  wallet: "Wallet",
  to: "An",
  ref: "Referenz",
  desc: "Leistung",
  total: "Gesamtbetrag",
  terms: "Zahlungsbedingungen",
};
const CH: Labels = {
  heading: { INVOICE: "RECHNUNG / FACTURE", CREDIT_NOTE: "GUTSCHRIFT / NOTE DE CREDIT", STATEMENT: "KONTOAUSZUG", OTHER: "DOKUMENT" },
  number: "Rechnung Nr.",
  date: "Datum",
  due: "Zahlbar bis",
  from: "Aussteller",
  wallet: "Wallet",
  to: "Empfaenger",
  ref: "Referenz",
  desc: "Position",
  total: "Total",
  terms: "Konditionen",
};
const BI: Labels = {
  heading: { INVOICE: "INVOICE / FACTURE", CREDIT_NOTE: "CREDIT NOTE / AVOIR", STATEMENT: "STATEMENT / RELEVE", OTHER: "DOCUMENT" },
  number: "Invoice no. / N° de facture",
  date: "Date",
  due: "Due / Echeance",
  from: "From / De",
  wallet: "Wallet / Portefeuille",
  to: "To / A",
  ref: "Reference",
  desc: "Description / Libelle",
  total: "Total due / Total a payer",
  terms: "Terms / Conditions",
};

function printedTotalOf(spec: InvoiceSpec): string {
  if (spec.printedTotal !== undefined) return spec.printedTotal;
  const body = printAmount(spec.amountBaseUnits, spec.decimals, spec.numberStyle);
  return spec.docType === "CREDIT_NOTE" ? `-${body}` : body;
}

function refLine(spec: InvoiceSpec): string | null {
  const parts = [spec.engagementRef, spec.milestoneRef, spec.poNumber === null ? null : `PO ${spec.poNumber}`].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(" / ");
}

function itemPrintsOf(spec: InvoiceSpec): string[] {
  return (spec.items ?? []).map((it) => printAmount(it.amountBaseUnits, spec.decimals, spec.numberStyle));
}

function compact(lines: ReadonlyArray<string | null | false>): string {
  return lines.filter((l): l is string => typeof l === "string").join("\n");
}

function labelled(label: string, value: string | null): string | null {
  return value === null ? null : `${label}: ${value}`;
}

function renderLabelled(spec: InvoiceSpec, L: Labels, total: string, itemPrints: readonly string[]): string {
  const items = spec.items ?? [];
  return compact([
    L.heading[spec.docType],
    labelled(L.number, spec.invoiceNumber),
    labelled(L.date, spec.issueDate),
    labelled(L.due, spec.dueDate),
    labelled(L.from, spec.payeeName),
    labelled(L.wallet, spec.payeeAddress),
    labelled(L.to, spec.billTo),
    labelled(L.ref, refLine(spec)),
    items.length === 0 ? labelled(L.desc, spec.description) : `${L.desc}:`,
    ...items.map((it, i) => `  - ${it.description}  ${itemPrints[i] ?? ""} ${spec.currencyLabel}`),
    labelled(L.terms, spec.termsLine),
    ...spec.bodyExtra,
    `${L.total}: ${total} ${spec.currencyLabel}`,
    ...spec.footer,
  ]);
}

function renderHtml(spec: InvoiceSpec, total: string, itemPrints: readonly string[]): string {
  const items = spec.items ?? [];
  const rows =
    items.length === 0
      ? [`<tr><td>${spec.description}</td><td>${total}</td></tr>`]
      : items.map((it, i) => `<tr><td>${it.description}</td><td>${itemPrints[i] ?? ""}</td></tr>`);
  return compact([
    "<html><body>",
    `<h1>${EN.heading[spec.docType]} ${spec.invoiceNumber}</h1>`,
    `<p>Issued ${spec.issueDate}${spec.dueDate === null ? "" : `, due ${spec.dueDate}`}</p>`,
    `<p>From: ${spec.payeeName}</p>`,
    spec.payeeAddress === null ? null : `<p>Wallet: <code>${spec.payeeAddress}</code></p>`,
    `<p>Bill to: ${spec.billTo}</p>`,
    refLine(spec) === null ? null : `<p>Ref: ${refLine(spec) ?? ""}</p>`,
    "<table>",
    ...rows,
    "</table>",
    spec.termsLine === null ? null : `<p>Terms: ${spec.termsLine}</p>`,
    ...spec.bodyExtra.map((p) => `<p>${p}</p>`),
    `<p><b>Total due: ${total} ${spec.currencyLabel}</b></p>`,
    ...spec.footer.map((p) => `<p>${p}</p>`),
    "</body></html>",
  ]);
}

function renderPdfTextLayer(spec: InvoiceSpec, total: string, itemPrints: readonly string[]): string {
  const items = spec.items ?? [];
  const col = (a: string, b: string) => `${a.padEnd(42)}${b}`;
  return compact([
    `-- page 1 of 1 --`,
    col(spec.payeeName, EN.heading[spec.docType]),
    col(spec.payeeAddress ?? "", `No. ${spec.invoiceNumber}`),
    col(spec.billTo, `Date ${spec.issueDate}`),
    spec.dueDate === null ? null : col("", `Due ${spec.dueDate}`),
    refLine(spec) === null ? null : col("", `Ref ${refLine(spec) ?? ""}`),
    "",
    col("Description", "Amount"),
    ...(items.length === 0
      ? [col(spec.description, `${total}`)]
      : items.map((it, i) => col(it.description, itemPrints[i] ?? ""))),
    "",
    spec.termsLine === null ? null : `Payment terms: ${spec.termsLine}`,
    ...spec.bodyExtra,
    col("Total due", `${total} ${spec.currencyLabel}`),
    ...spec.footer,
    "-- end of page 1 --",
  ]);
}

function renderMultiLine(spec: InvoiceSpec, total: string, itemPrints: readonly string[]): string {
  const items = spec.items ?? [];
  const fallback = items.length === 0 ? [`  1. ${spec.description}  ${total} ${spec.currencyLabel}`] : [];
  return compact([
    `${EN.heading[spec.docType]} ${spec.invoiceNumber}`,
    `Issued: ${spec.issueDate}${spec.dueDate === null ? "" : `   Due: ${spec.dueDate}`}`,
    `Supplier: ${spec.payeeName}${spec.payeeAddress === null ? "" : ` (${spec.payeeAddress})`}`,
    `Customer: ${spec.billTo}`,
    refLine(spec) === null ? null : `Your ref: ${refLine(spec) ?? ""}`,
    "Items:",
    ...items.map((it, i) => `  ${i + 1}. ${it.description}  ${itemPrints[i] ?? ""} ${spec.currencyLabel}`),
    ...fallback,
    spec.termsLine === null ? null : `Terms: ${spec.termsLine}`,
    ...spec.bodyExtra,
    `Subtotal and total due: ${total} ${spec.currencyLabel}`,
    ...spec.footer,
  ]);
}

export function renderInvoice(spec: InvoiceSpec): RenderedInvoice {
  const total = printedTotalOf(spec);
  const itemPrints = itemPrintsOf(spec);
  let text: string;
  switch (spec.style) {
    case "plain":
      text = renderLabelled(spec, EN, total, itemPrints);
      break;
    case "us-letter":
      text = renderLabelled(spec, US, total, itemPrints);
      break;
    case "eu-formal":
      text = renderLabelled(spec, DE, total, itemPrints);
      break;
    case "swiss":
      text = renderLabelled(spec, CH, total, itemPrints);
      break;
    case "bilingual":
      text = renderLabelled(spec, BI, total, itemPrints);
      break;
    case "html":
      text = renderHtml(spec, total, itemPrints);
      break;
    case "pdf-text-layer":
      text = renderPdfTextLayer(spec, total, itemPrints);
      break;
    case "multi-line":
      text = renderMultiLine(spec, total, itemPrints);
      break;
    default: {
      const never: never = spec.style;
      throw new Error(`unhandled template style ${String(never)}`);
    }
  }
  return { text, printedTotal: total, itemPrints };
}

export interface ExtractionExtras {
  readonly statedTerms?: StatedTerms;
  readonly anomalies?: ExtractedInvoice["anomalies"];
  readonly claimsAddressChange?: boolean;
  readonly walletAddress?: Address | null;
  /** `null` = the reader refuses to parse (ambiguous); omitted = derived from the print. */
  readonly parsedBaseUnits?: bigint | null;
  readonly docType?: ExtractedInvoice["docType"];
  readonly invoiceNumber?: string;
  readonly legalName?: string | null;
  readonly printed?: string;
  /** What the reader claims about the separator (a mis-read can disagree with the print). */
  readonly decimalSeparatorGuess?: ExtractedInvoice["amount"]["decimalSeparatorGuess"];
  readonly confidence?: number;
}

export const NO_STATED_TERMS: StatedTerms = { raw: null, netDays: null, earlyPay: null, ambiguous: false };

/** The read a careful extractor would produce for this exact rendering. */
export function referenceExtraction(spec: InvoiceSpec, rendered: RenderedInvoice, extras: ExtractionExtras = {}): ExtractedInvoice {
  const printed = extras.printed ?? rendered.printedTotal;
  const guess = classifyPrinted(printed);
  const negative = printed.startsWith("-");
  const parsed: bigint | null =
    extras.parsedBaseUnits !== undefined ? extras.parsedBaseUnits : guess === "ambiguous" || negative ? null : spec.amountBaseUnits;
  const items = spec.items ?? [];
  return {
    docType: extras.docType ?? spec.docType,
    invoiceNumber: untrusted(extras.invoiceNumber ?? spec.invoiceNumber),
    issueDate: spec.issueDate,
    dueDate: spec.dueDate,
    payee: {
      legalName: (extras.legalName === undefined ? untrusted(spec.payeeName) : extras.legalName === null ? null : untrusted(extras.legalName)),
      walletAddress: extras.walletAddress === undefined ? spec.payeeAddress : extras.walletAddress,
      claimsAddressChange: extras.claimsAddressChange ?? false,
    },
    amount: {
      printed: untrusted(printed),
      currencyPrinted: untrusted(spec.currencyLabel),
      decimalSeparatorGuess: extras.decimalSeparatorGuess ?? guess,
      parsedBaseUnits: parsed === null ? null : parsed.toString(),
      decimals: parsed === null ? null : spec.decimals,
    },
    references: {
      engagementId: spec.engagementRef === null ? null : untrusted(spec.engagementRef),
      milestoneId: spec.milestoneRef === null ? null : untrusted(spec.milestoneRef),
      poNumber: spec.poNumber === null ? null : untrusted(spec.poNumber),
    },
    statedTerms: extras.statedTerms ?? NO_STATED_TERMS,
    lineItems:
      items.length === 0
        ? [{ description: untrusted(spec.description), amountPrinted: untrusted(printed) }]
        : items.map((it, i) => ({ description: untrusted(it.description), amountPrinted: untrusted(rendered.itemPrints[i] ?? "") })),
    anomalies: extras.anomalies ?? [],
    confidence: extras.confidence ?? 0.9,
  };
}
