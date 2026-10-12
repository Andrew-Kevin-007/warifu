// K-03 DOC_TYPE_SIGN — REJECT / ESCALATE — P0 (docs/04 K-03). Targets complete reversal.
// INVOICE is payable; CREDIT_NOTE => ESCALATE CREDIT_NOTE (never an outbound payment); STATEMENT|OTHER =>
// REJECT NOT_PAYABLE; the gross amount must be > 0. Both extractions are read and the stricter outcome wins
// (a single model calling the document non-payable is enough to stop it; K-10 reports the disagreement).
import type { CheckResult, PaymentIntent } from "@symbolon/schemas";
import type { Facts } from "../facts";
import { combine } from "../verdict";
import type { Issue } from "../verdict";

type DocType = PaymentIntent["extraction"]["a"]["docType"];

function docTypeIssue(docType: DocType, which: string): Issue | null {
  switch (docType) {
    case "INVOICE":
      return null;
    case "CREDIT_NOTE":
      return { onFail: "ESCALATE", code: "CREDIT_NOTE", detail: `extraction ${which} reads a credit note (never an outbound payment)` };
    case "STATEMENT":
    case "OTHER":
      return { onFail: "REJECT", code: "NOT_PAYABLE", detail: `extraction ${which} reads docType ${docType}` };
    default: {
      const unknown: never = docType;
      void unknown;
      return { onFail: "REJECT", code: "NOT_PAYABLE", detail: `extraction ${which} has an unknown docType` };
    }
  }
}

export function checkK03(intent: PaymentIntent, facts: Facts): CheckResult {
  const issues: Issue[] = [];
  const a = docTypeIssue(intent.extraction.a.docType, "A");
  if (a !== null) issues.push(a);
  const extractionB = intent.extraction.b;
  if (extractionB !== null) {
    const b = docTypeIssue(extractionB.docType, "B");
    if (b !== null) issues.push(b);
  }
  if (facts.gross === 0n) issues.push({ onFail: "REJECT", code: "NOT_PAYABLE", detail: "amount must be > 0" });
  return combine("K-03", issues, "document is an invoice with a positive amount");
}
