import { ExtractedInvoiceSchema, inspectUntrusted, normalizeUntrusted } from "@symbolon/schemas";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { baseSpec, renderDoc } from "../src/build";
import { classifyPrinted, NUMBER_STYLES } from "../src/money-format";
import { Rng } from "../src/prng";
import { referenceExtraction, renderInvoice } from "../src/templates";
import { TEMPLATE_STYLES } from "../src/types";
import { CLOCK_START, WORLD, SCENARIO_IDS_IN_ORDER, usdc } from "../src/world";
import { k11Reading, utf8Bytes } from "./helpers";

describe("invoice templates", () => {
  it("has at least six distinct styles", () => {
    expect(TEMPLATE_STYLES.length).toBeGreaterThanOrEqual(6);
    const w = WORLD["S-A"];
    const outputs = new Set(
      TEMPLATE_STYLES.map((style) => renderInvoice(baseSpec(new Rng("t"), w, "concept", CLOCK_START, { style })).text),
    );
    expect(outputs.size).toBe(TEMPLATE_STYLES.length);
  });

  it("every style prints the invoice number, payee address, milestone ref and the total, as exact substrings (property over seeds)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom(...TEMPLATE_STYLES), fc.constantFrom(...SCENARIO_IDS_IN_ORDER), (seed, style, sid) => {
        const w = WORLD[sid];
        const slug = (w.milestones[0] ?? { slug: "" }).slug;
        const spec = baseSpec(new Rng(seed), w, slug, CLOCK_START, { style });
        const r = renderInvoice(spec);
        expect(r.text).toContain(spec.invoiceNumber);
        expect(r.text).toContain(w.payee);
        expect(r.text).toContain(r.printedTotal);
        expect(r.text).toContain(slug);
        // The extractor contract: amount.printed is an EXACT substring of the normalized document.
        const ex = referenceExtraction(spec, r);
        expect(ExtractedInvoiceSchema.safeParse(ex).success).toBe(true);
        expect(r.text).toContain(inspectUntrusted(ex.amount.printed));
        expect(ex.payee.walletAddress).toBe(w.payee);
        expect(ex.amount.parsedBaseUnits).toBe(spec.amountBaseUnits.toString());
        expect(ex.amount.decimalSeparatorGuess).not.toBe("ambiguous");
      }),
      { numRuns: 200 },
    );
  });

  it("honest renderings are clean: no hidden characters, under the sandbox size limit, not flagged by the K-11 reading", () => {
    for (const style of TEMPLATE_STYLES) {
      for (const numberStyle of NUMBER_STYLES) {
        const w = WORLD["S-C"];
        const spec = baseSpec(new Rng(`${style}/${numberStyle}`), w, "annual-licence", CLOCK_START, { style, numberStyle, termsLine: "2/10 net 30" });
        const { doc } = renderDoc("t", spec, CLOCK_START);
        const text = inspectUntrusted(doc.text as never);
        expect(normalizeUntrusted(text).removedCount).toBe(0);
        expect(utf8Bytes(text)).toBeLessThan(4096);
        const k = k11Reading(text, w.payee);
        expect(k.patternHit || k.structureHit || k.foreignAddressHit).toBe(false);
      }
    }
  });

  it("line items are printed and the reference read carries them", () => {
    const w = WORLD["S-C"];
    const spec = baseSpec(new Rng("li"), w, "annual-licence", CLOCK_START, {
      style: "multi-line",
      items: [
        { description: "Licence", amountBaseUnits: usdc(12) },
        { description: "Support", amountBaseUnits: usdc(8) },
      ],
    });
    const r = renderInvoice(spec);
    const ex = referenceExtraction(spec, r);
    expect(ex.lineItems).toHaveLength(2);
    expect(r.itemPrints).toHaveLength(2);
    for (const p of r.itemPrints) expect(r.text).toContain(p);
  });

  it("a credit note prints a negative total and the careful reader refuses to parse it", () => {
    const w = WORLD["S-A"];
    const spec = baseSpec(new Rng("cn"), w, "concept", CLOCK_START, { docType: "CREDIT_NOTE", style: "plain" });
    const r = renderInvoice(spec);
    expect(r.printedTotal.startsWith("-")).toBe(true);
    const ex = referenceExtraction(spec, r);
    expect(ex.docType).toBe("CREDIT_NOTE");
    expect(ex.amount.parsedBaseUnits).toBeNull();
  });

  it("an ambiguous print makes the careful reader refuse (parsedBaseUnits null, guess ambiguous)", () => {
    const w = WORLD["S-A"];
    const spec = baseSpec(new Rng("amb"), w, "concept", CLOCK_START, { printedTotal: "8.000", style: "plain" });
    const r = renderInvoice(spec);
    expect(classifyPrinted(r.printedTotal)).toBe("ambiguous");
    const ex = referenceExtraction(spec, r);
    expect(ex.amount.parsedBaseUnits).toBeNull();
    expect(ex.amount.decimalSeparatorGuess).toBe("ambiguous");
    expect(r.text).toContain("8.000");
  });
});
