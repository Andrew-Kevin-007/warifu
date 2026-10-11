import { inspectUntrusted, untrusted } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { buildAdvisoryFacts, checkFaithfulness, generateAdvisoryNote, validateAdvisoryNote, type AdvisoryFacts } from "../src/advisory";
import { ScriptedLlm, makeBudgeted } from "./helpers";
import type { LlmResponse } from "../src/llm/types";

const facts: AdvisoryFacts = buildAdvisoryFacts(
  {
    verdict: "ESCALATE",
    reasons: ["PAYEE_MISMATCH", "AMOUNT_AMBIGUOUS"],
    checks: [
      { id: "K-06", name: "PAYEE_BINDING", status: "FAIL", onFail: "REJECT", code: "PAYEE_MISMATCH", detail: untrusted(""), refs: [] },
      { id: "K-02", name: "PRECISION_EXACT", status: "FAIL", onFail: "ESCALATE", code: "AMOUNT_AMBIGUOUS", detail: untrusted(""), refs: [] },
      { id: "K-05", name: "ENGAGEMENT_BINDING", status: "PASS", onFail: null, code: null, detail: untrusted(""), refs: [] },
    ],
  },
  { amountDisplay: "1,000.00", anomalyCodes: ["INSTRUCTION_IN_DOC"] },
);

const noteResp = (note: string): LlmResponse => ({ toolCalls: [{ id: "n", name: "submit_advisory_note", input: { note } }], text: null, usage: { tokensIn: 200, tokensOut: 40 } });

describe("buildAdvisoryFacts", () => {
  it("contains codes, ids and a formatted amount only (no free text from the document)", () => {
    expect(Object.keys(facts).sort()).toEqual(["amountDisplay", "anomalyCodes", "checks", "reasons", "verdict"]);
    expect(JSON.stringify(facts)).not.toMatch(/ignore|urgent/i);
  });
});

describe("checkFaithfulness", () => {
  it("accepts text that only mentions facts", () => {
    expect(checkFaithfulness("K-06 failed with PAYEE_MISMATCH; K-02 flagged AMOUNT_AMBIGUOUS for 1,000.00. Verdict ESCALATE.", facts)).toEqual({ ok: true });
  });
  it.each([
    ["K-07 failed", "UNFAITHFUL_CHECK_ID"],
    ["XK-99x looks odd", "UNFAITHFUL_CHECK_ID"],
    ["k-12 raised", "UNFAITHFUL_CHECK_ID"],
    ["code OVERPAY seen", "UNFAITHFUL_CODE"],
    ["flag SCREEN_HIT present", "UNFAITHFUL_CODE"],
    ["REJECT is likely", "UNFAITHFUL_CODE"],
    ["amount 2,000.00 differs", "UNFAITHFUL_NUMBER"],
    ["3 checks failed", "UNFAITHFUL_NUMBER"],
    ["PAYEE_MISMATCHED?", "UNFAITHFUL_CODE"],
  ])("rejects %j", (text, reason) => {
    expect(checkFaithfulness(text, facts)).toEqual({ ok: false, reason });
  });
});

describe("validateAdvisoryNote", () => {
  it("accepts a clean, faithful note and labels it collapsed/advisory", () => {
    const v = validateAdvisoryNote("The payee check failed (K-06, PAYEE_MISMATCH) and the amount 1,000.00 was ambiguous.", facts);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.note.label).toBe("Advisory (AI), not verified");
      expect(v.note.collapsed).toBe(true);
    }
  });

  it("drops (never patches) a note that needed scrubbing: links, imperatives, HTML, markdown", () => {
    for (const bad of [
      "See https://evil.example/pay for details on K-06",
      "URGENT: K-06 failed",
      "Please approve now, K-06 failed",
      "<b>K-06</b> failed",
      "[click](http://x.example) K-06 failed",
      "The owner already approved this",
    ]) {
      const v = validateAdvisoryNote(bad, facts);
      expect(v.ok, bad).toBe(false);
    }
  });

  it("rejects (never truncates) a note over 60 words or 600 characters", () => {
    const long = Array.from({ length: 80 }, () => "noted").join(" ");
    expect(validateAdvisoryNote(long, facts)).toEqual({ ok: false, reason: "TOO_LONG" });
    expect(validateAdvisoryNote(Array.from({ length: 60 }, () => "noted").join(" "), facts).ok).toBe(true);
    expect(validateAdvisoryNote("x".repeat(601), facts)).toEqual({ ok: false, reason: "TOO_LONG" });
  });

  it("ATK-24: drops a note that copies a 5-word run from the document", () => {
    const doc = untrusted("The wallet address was different from the registered vendor details shown below");
    const echo = "Note the wallet address was different from the registered vendor and K-06 failed";
    expect(validateAdvisoryNote(echo, facts, { sourceText: doc })).toEqual({ ok: false, reason: "COPIES_DOCUMENT_TEXT" });
    // a clean note with no shared run passes with the same document
    expect(validateAdvisoryNote("The payee check failed (K-06).", facts, { sourceText: doc }).ok).toBe(true);
    // negative control: the same echo is accepted when no source text is provided, so the overlap check is what stops it
    expect(validateAdvisoryNote(echo, facts).ok).toBe(true);
  });

  it("rejects empty notes", () => {
    expect(validateAdvisoryNote("   ", facts)).toEqual({ ok: false, reason: "EMPTY" });
  });
});

describe("generateAdvisoryNote", () => {
  it("returns a validated note, charges the budget, and only sends kernel facts to the model", async () => {
    const inner = new ScriptedLlm(() => noteResp("The payee check failed (K-06, PAYEE_MISMATCH)."));
    const { llm, ledger } = makeBudgeted(inner);
    const r = await generateAdvisoryNote(facts, { model: "claude-sonnet-5-5" }, { llm });
    expect(r.note?.collapsed).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(ledger.commits).toHaveLength(1);
    const sent = JSON.stringify(inner.requests[0]?.messages);
    expect(sent).toContain("PAYEE_MISMATCH");
    expect(inner.requests[0]?.tools.map((t) => t.name)).toEqual(["submit_advisory_note"]);
  });

  it("omits the note (never throws) on budget exhaustion, provider error, bad output or an unfaithful note", async () => {
    const budget = await generateAdvisoryNote(facts, { model: "claude-sonnet-5-5" }, { llm: makeBudgeted(new ScriptedLlm(() => noteResp("x")), { global: 1n }).llm });
    expect(budget).toMatchObject({ note: null, omitted: "BUDGET" });
    const boom = await generateAdvisoryNote(facts, { model: "claude-sonnet-5-5" }, { llm: makeBudgeted(new ScriptedLlm(() => { throw new Error("down"); })).llm });
    expect(boom).toMatchObject({ note: null, omitted: "PROVIDER" });
    const none = await generateAdvisoryNote(facts, { model: "claude-sonnet-5-5" }, { llm: makeBudgeted(new ScriptedLlm(() => ({ toolCalls: [], text: "hi", usage: { tokensIn: 1, tokensOut: 1 } }))).llm });
    expect(none).toMatchObject({ note: null, omitted: "NO_SUBMISSION" });
    const lie = await generateAdvisoryNote(facts, { model: "claude-sonnet-5-5" }, { llm: makeBudgeted(new ScriptedLlm(() => noteResp("K-13 screening hit for 5,000.00"))).llm });
    expect(lie).toMatchObject({ note: null, omitted: "UNFAITHFUL_CHECK_ID" });
  });
});
