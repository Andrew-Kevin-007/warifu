// K-02 PRECISION_EXACT — ESCALATE (ambiguity/mismatch) or REJECT (rounding required, non-ASCII digits,
// scientific notation) — P0 (docs/04 K-02). Targets the original-entry error class ("6.000000" read as "6.00")
// and locale confusion. The kernel parses the printed amount itself (parseMoney) and compares it with the
// extractor's parsedBaseUnits; it never adopts the extractor's number when its own reading disagrees.
import { inspectUntrusted } from "@symbolon/schemas";
import type { CheckResult, PaymentIntent, Untrusted } from "@symbolon/schemas";
import type { Facts } from "../facts";
import { parseMoney } from "../money";
import { fail, pass } from "../verdict";

export function checkK02(intent: PaymentIntent, facts: Facts): CheckResult {
  const amount = intent.extraction.a.amount;
  const total = facts.totalParse;
  switch (total.kind) {
    case "REJECT":
      return fail("K-02", "REJECT", total.code, `printed amount refused by parseMoney (${total.code})`);
    case "AMBIGUOUS":
      return fail("K-02", "ESCALATE", "AMOUNT_AMBIGUOUS", `printed amount is ambiguous (${total.reason})`);
    case "EXACT":
      break;
    default: {
      const unknown: never = total;
      void unknown;
      return fail("K-02", "ESCALATE", "AMOUNT_AMBIGUOUS", "unknown parse result");
    }
  }
  const value = total.baseUnits;
  if (facts.claimedGross === null) return fail("K-02", "ESCALATE", "AMOUNT_AMBIGUOUS", "extractor reported no parsedBaseUnits");
  if (amount.decimals !== null && amount.decimals !== facts.declaredDecimals) {
    return fail("K-02", "ESCALATE", "EXTRACTION_PARSE_MISMATCH", `extractor decimals ${amount.decimals} != declared ${facts.declaredDecimals}`);
  }
  if (facts.claimedGross !== value) {
    return fail("K-02", "ESCALATE", "EXTRACTION_PARSE_MISMATCH", `kernel parse ${value} != extractor parsedBaseUnits ${facts.claimedGross}`);
  }

  // Step 6: if every line item has a printed amount, their sum must equal the total. Line items are read with the
  // total's decimal separator as the document's convention; anything not exact is a mismatch (ESCALATE).
  const printed = intent.extraction.a.lineItems.map((li) => li.amountPrinted);
  if (printed.length > 0 && printed.every((p): p is Untrusted<string> => p !== null)) {
    const convention = total.decimalSeparator === null ? {} : { convention: total.decimalSeparator };
    let sum = 0n;
    for (const [i, li] of printed.entries()) {
      const p = parseMoney(inspectUntrusted(li), null, facts.declaredDecimals, convention);
      if (p.kind !== "EXACT") return fail("K-02", "ESCALATE", "LINEITEM_SUM_MISMATCH", `line item ${i} amount is not exact (${p.kind})`);
      sum += p.baseUnits;
    }
    if (sum !== value) return fail("K-02", "ESCALATE", "LINEITEM_SUM_MISMATCH", `line items sum to ${sum}, total is ${value}`);
  }
  return pass("K-02", `printed amount parses exactly to ${value} base units and matches the extraction`);
}
