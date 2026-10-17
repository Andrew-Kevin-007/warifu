// SEC-01 (RT-01, INV-15): the XSS corpus renders inert. Attacker text reaches a public page only through <UntrustedText> as a TEXT NODE. The
// REAL components are rendered to markup with each hostile string in the one place attacker text can appear (an attempt's excerpt), and the
// result must have exactly the tag structure of the same render with benign text: a payload can add no element, no attribute and no handler.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { untrusted } from "@symbolon/schemas";
import { LiveAttemptResult } from "../src/components/challenge/AttemptResult";
import type { AttemptView } from "../src/components/challenge/types";
import { UntrustedText } from "../src/components/safety/UntrustedText";
import { XSS_CORPUS } from "../../../packages/sec-suite/src/xss-corpus";

const attempt = (excerpt: string): AttemptView => ({
  attemptId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  createdAt: "2026-10-17 17:14:39+00",
  source: "human",
  extractionRefused: null,
  receipts: [{ label: "visitor-document", verdict: "REJECT", receiptHash: `0x${"cd".repeat(32)}` }],
  text: { excerpt, length: excerpt.length, hash: `0x${"ab".repeat(32)}` },
  result: {
    engine: "challenge-engine/1", mode: "UNIT", kind: "freeform", attackId: null, benignId: null, scenarioId: "S-A", action: "REJECT",
    checksFired: ["K-06"], reasons: ["PAYEE_MISMATCH"], releases: 0, lossReleases: 0, lossBaseUnits: "0", predicates: [], oracleResult: "NO_LOSS",
    outcome: null, benign: null, runs: [{ label: "visitor-document", action: "REJECT", checksFired: ["K-06"], reasons: ["PAYEE_MISMATCH"], release: null }], notRun: [], steps: 1,
  },
});

/** Only the markup (text nodes are escaped content, where `src=x` is just characters). */
const tagsOnly = (html: string): string => (html.match(/<[^>]*>/g) ?? []).join("");
const tagSequence =(html: string): string[] => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[0].toLowerCase());
const attributeNames = (html: string): string[] => [...tagsOnly(html).matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)=/g)].map((m) => m[1]?.toLowerCase() ?? "");
// (the panel's own decorative glyph is an <svg>, which the benign baseline contains too; the structural equality below is what proves a payload adds none)
const FORBIDDEN_TAGS = /<\/?(script|img|iframe|object|embed|form|input|meta|base|link|style|math|details|body|html|video|audio|source|template|textarea|select|button)\b/i;
/** Every href in the markup: the panel has exactly the receipt links it renders itself, and a payload must add none. */
const hrefs = (html: string): string[] => [...tagsOnly(html).matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("SEC-01: XSS corpus renders inert", () => {
  it("the corpus has at least 40 cases across every family", () => {
    expect(XSS_CORPUS.length).toBeGreaterThanOrEqual(40);
    const families = new Set(XSS_CORPUS.map((c) => c.family));
    for (const f of ["tag", "attribute", "event", "url", "markdown", "svg", "css", "bidi", "entity", "template", "control"]) expect(families.has(f as never), f).toBe(true);
    expect(new Set(XSS_CORPUS.map((c) => c.id)).size).toBe(XSS_CORPUS.length);
  });

  const baseline = renderToStaticMarkup(createElement(LiveAttemptResult, { attempt: attempt("a harmless invoice line"), title: "Your document" }));
  const baseTags = tagSequence(baseline);
  const baseAttrs = attributeNames(baseline).join(",");

  it.each(XSS_CORPUS.map((c) => [c.id, c.payload] as const))("%s: adds no element, no attribute, no handler", (_id, payload) => {
    const html = renderToStaticMarkup(createElement(LiveAttemptResult, { attempt: attempt(payload), title: "Your document" }));
    expect(tagSequence(html)).toEqual(baseTags); // identical element structure to the benign render
    expect(attributeNames(html).join(",")).toBe(baseAttrs); // and identical attributes: nothing the payload could add (on*, href, src, style)
    expect(tagsOnly(html)).not.toMatch(FORBIDDEN_TAGS);
    expect(tagsOnly(html)).not.toMatch(/\son[a-z]+=/i);
    expect(hrefs(html)).toEqual(hrefs(baseline)); // the only links are the panel's own receipt links: a payload adds none
    expect(hrefs(html).every((h) => /^\/audit\/0x[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(tagsOnly(html)).not.toMatch(/\s(src|action|formaction|srcdoc|xlink:href|data)=/i); // and no other URL-bearing attribute exists at all
  });

  it.each(XSS_CORPUS.map((c) => [c.id, c.payload] as const))("%s: <UntrustedText> emits one span holding only escaped text", (_id, payload) => {
    const html = renderToStaticMarkup(createElement(UntrustedText, { value: untrusted(payload) }));
    expect(html.startsWith("<span ")).toBe(true);
    expect(html.endsWith("</span>")).toBe(true);
    expect(tagSequence(html)).toEqual(["<span", "</span"]);
    expect(html).not.toMatch(/<[^>]*>[^<]*<(?!\/span)/); // the only markup is the wrapper
  });

  it("an attacker string is never interpolated into the panel outside the text node", () => {
    const marker = "ZZ-ATTACKER-MARKER-ZZ";
    const html = renderToStaticMarkup(createElement(LiveAttemptResult, { attempt: attempt(marker), title: "Your document" }));
    expect(html.split(marker).length - 1).toBe(1); // exactly once: inside the one UntrustedText span
    const span = /<span[^>]*data-untrusted="true"[^>]*>([^<]*)<\/span>/.exec(html);
    expect(span?.[1]).toBe(marker);
  });
});
