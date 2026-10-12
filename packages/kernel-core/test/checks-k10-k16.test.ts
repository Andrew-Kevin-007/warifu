// K-10 consensus, K-12 authority envelope (caps ±1 base unit, velocity, category, human gate, first payment), K-13
// screening, K-16 breaker pre-check and the breaker state logic (docs/04 K-10/K-12/K-13/K-16; docs/13 §4.1 K-12).
import { describe, expect, it } from "vitest";
import { consensus, isoFromEpochSeconds, PaymentIntentSchema } from "@symbolon/schemas";
import { breakerTrip, evaluate, nextBreakerState } from "../src/index";
import type { BreakerRecord, BreakerSignal, KernelContext } from "../src/index";
import { checkK12 } from "../src/checks/k12-authority";
import { deriveFacts } from "../src/facts";
import { GROSS, H, M1, M2, OWNER, approvalFor, context, engagement, expectCheck, extraction, intent, milestone, policy, single } from "./helpers";
import type { RawIntent } from "./helpers";

const run = (raw: RawIntent = intent(), ctx: KernelContext = context(), p = policy()) => evaluate(raw, ctx, p);
const released = (over: Partial<KernelContext["released"]>) => context({ released: { ...context().released, ...over } });

describe("K-10 EXTRACTION_CONSENSUS", () => {
  it("two independent agreeing extractions pass", () => expectCheck(run(), "K-10", null, null));

  it("a disagreement is recomputed by the kernel (field names in refs, never values); a misreported AGREE adds a finding", () => {
    const raw = intent();
    raw.extraction.b = extraction({ payee: { legalName: "Acme Design", walletAddress: null, claimsAddressChange: false } });
    const e = run(raw);
    expectCheck(e, "K-10", "ESCALATE", "EXTRACTION_DISAGREE");
    const k10 = e.checks.find((c) => c.id === "K-10");
    expect(k10?.refs).toEqual(["field:payee.walletAddress"]);
    expect(String(k10?.detail)).toContain("submitted consensus (AGREE) differs");
  });

  it("an honest DISAGREE report that matches the recomputation is one finding; a false DISAGREE claim is a finding too", () => {
    const raw = intent();
    raw.extraction.b = extraction({ invoiceNumber: "INV-0043" });
    const parsed = PaymentIntentSchema.parse({ ...raw, consensus: { status: "AGREE", diffs: [] } });
    const honest = { ...raw, consensus: consensus(parsed.extraction.a, parsed.extraction.b) };
    const e = run(honest as unknown as RawIntent);
    expectCheck(e, "K-10", "ESCALATE", "EXTRACTION_DISAGREE");
    expect(String(e.checks.find((c) => c.id === "K-10")?.detail)).not.toContain("submitted");
    const liar = { ...intent(), consensus: { status: "DISAGREE", diffs: [{ field: "docType", a: '"INVOICE"', b: '"OTHER"' }] } };
    expectCheck(run(liar), "K-10", "ESCALATE", "EXTRACTION_DISAGREE");
  });

  it("a single extraction escalates unless the policy allows it; the same model or prompt twice counts as single", () => {
    expectCheck(run(single(intent())), "K-10", "ESCALATE", "SINGLE_EXTRACTION");
    const allow = policy({ extraction: { allowSingle: true } });
    expectCheck(run(single(intent()), context(), allow), "K-10", null, null);
    const sameModel = { ...intent(), extraction: { ...intent().extraction, modelB: "claude-sonnet-5-5" } };
    expectCheck(run(sameModel), "K-10", "ESCALATE", "SINGLE_EXTRACTION");
    const samePrompt = { ...intent(), extraction: { ...intent().extraction, promptHashB: intent().extraction.promptHashA } };
    expectCheck(run(samePrompt), "K-10", "ESCALATE", "SINGLE_EXTRACTION");
    expectCheck(run(samePrompt, context(), allow), "K-10", null, null);
  });
});

describe("K-12 AUTHORITY_ENVELOPE (boundaries at caps ±1 base unit)", () => {
  it("the base world is within every limit", () => expectCheck(run(), "K-12", null, null));

  it.each([
    ["per-tx cap", policy({ caps: { perTxHardCap: "1000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1500" } }), policy({ caps: { perTxHardCap: "999.999999", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1500" } }), "CAP_PER_TX"],
  ])("%s: at the cap passes, one base unit over rejects", (_l, atCap, overCap, code) => {
    expectCheck(run(intent(), context(), atCap), "K-12", null, null);
    expectCheck(run(intent(), context(), overCap), "K-12", "REJECT", code);
  });

  it.each([
    ["daily", { tenantDay: 4_000_000_000n }, { tenantDay: 4_000_000_001n }, "CAP_DAILY"],
    ["weekly", { tenantWeek: 9_000_000_000n }, { tenantWeek: 9_000_000_001n }, "CAP_WEEKLY"],
    ["payee amount per day", { payeeDay: 4_000_000_000n }, { payeeDay: 4_000_000_001n }, "VELOCITY"],
    ["payee count per day", { payeeCountDay: 2 }, { payeeCountDay: 3 }, "VELOCITY"],
    ["tenant count per day", { tenantCountDay: 9 }, { tenantCountDay: 10 }, "VELOCITY"],
  ] as const)("%s window (rolling totals incl. pending)", (_l, ok, over, code) => {
    expectCheck(run(intent(), released(ok)), "K-12", null, null);
    expectCheck(run(intent(), released(over)), "K-12", "REJECT", code);
  });

  it("category budget: at the budget passes, one unit over or no budget for the category escalates", () => {
    expectCheck(run(intent(), released({ categoryMonth: { design: 4_000_000_000n } })), "K-12", null, null);
    expectCheck(run(intent(), released({ categoryMonth: { design: 4_000_000_001n } })), "K-12", "ESCALATE", "CATEGORY_BUDGET");
    expectCheck(run(intent(), released({ categoryMonth: { dev: 9_000_000_000_000n } })), "K-12", null, null);
    const tools = engagement({ milestones: [milestone(M1, "design", { category: "tools" }), milestone(M2, "build")] });
    expectCheck(run(intent(), context({ engagement: tools, milestone: tools.milestones[0] ?? null })), "K-12", "ESCALATE", "CATEGORY_BUDGET");
    const proto = engagement({ milestones: [milestone(M1, "design", { category: "constructor" }), milestone(M2, "build")] });
    expectCheck(run(intent(), context({ engagement: proto, milestone: proto.milestones[0] ?? null })), "K-12", "ESCALATE", "CATEGORY_BUDGET");
  });

  it("human gate above humanApprovalAbove (at the threshold passes); the approval state is named in the detail", () => {
    const at = policy({ caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1000" } });
    expectCheck(run(intent(), context(), at), "K-12", null, null);
    const below = policy({ caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "999.999999" } });
    const e = run(intent(), context(), below);
    expectCheck(e, "K-12", "ESCALATE", "HUMAN_REQUIRED");
    const withBadApproval = run(intent(), context({ ownerApproval: approvalFor(H("other"), GROSS) }), below);
    expect(String(withBadApproval.checks.find((c) => c.id === "K-12")?.detail)).toContain("approved escalation");
  });

  it("first payment to a payee: over firstPaymentMax and alwaysHuman both escalate; within the limit with alwaysHuman off passes", () => {
    const first = context({ payeeHistory: { priorPayments: 0, onTime: 0, disputes: 0 } });
    const e = run(intent(), first);
    expectCheck(e, "K-12", "ESCALATE", "FIRST_PAYMENT_LARGE");
    expect(String(e.checks.find((c) => c.id === "K-12")?.detail)).toContain("HUMAN_REQUIRED");
    const relaxed = policy({ newPayee: { firstPaymentMax: "1000", alwaysHuman: false } });
    expectCheck(run(intent(), first, relaxed), "K-12", null, null);
    const tight = policy({ newPayee: { firstPaymentMax: "999.999999", alwaysHuman: false } });
    expectCheck(run(intent(), first, tight), "K-12", "ESCALATE", "FIRST_PAYMENT_LARGE");
  });

  it("no determinable amount => ESCALATE AMOUNT_AMBIGUOUS; a REJECT outranks the escalations", () => {
    const raw = intent();
    raw.extraction.a.amount.printed = "1,000";
    raw.extraction.a.amount.parsedBaseUnits = null;
    expectCheck(run(raw), "K-12", "ESCALATE", "AMOUNT_AMBIGUOUS");
    const both = run(intent(), { ...released({ tenantDay: 4_500_000_000n }), payeeHistory: { priorPayments: 0, onTime: 0, disputes: 0 } });
    expectCheck(both, "K-12", "REJECT", "CAP_DAILY");
  });

  it.each([
    ["a negative total", released({ tenantDay: -1n })],
    ["a non-integer count", released({ payeeCountDay: 1.5 })],
    ["a category total that is not a bigint", released({ categoryMonth: { design: 5 as unknown as bigint } })],
    ["a negative payee history", context({ payeeHistory: { priorPayments: -1, onTime: 0, disputes: 0 } })],
  ])("malformed context (%s) => HOLD KERNEL_ERROR", (_l, ctx) => {
    expectCheck(run(intent(), ctx), "K-12", "HOLD", "KERNEL_ERROR");
  });

  it("checkK12 without a signed milestone skips the category budget (K-05 rejects that intent anyway)", () => {
    const parsed = PaymentIntentSchema.parse(intent());
    const facts = { ...deriveFacts(parsed, context(), policy()), milestoneTerms: null };
    expect(checkK12(context(), policy(), facts, { present: false, valid: false, reason: "", approved: new Set() }).status).toBe("PASS");
  });
});

describe("K-13 COUNTERPARTY_SCREEN", () => {
  const on = policy({ screening: { required: true, staleAfterHours: 24 } });
  const scr = (status: "CLEAR" | "HIT" | "UNKNOWN", checkedAt = "2026-10-05T11:00:00Z") => context({ screening: { status, checkedAt, provider: "test-screen" } });

  it("disabled by policy => SKIP SCREENING_DISABLED (visible) and the verdict is unaffected; a known HIT still rejects", () => {
    const e = run();
    expect(e.checks.find((c) => c.id === "K-13")).toMatchObject({ status: "SKIP", code: "SCREENING_DISABLED" });
    expect(e.verdict).toBe("RELEASE");
    expectCheck(run(intent(), scr("HIT")), "K-13", "REJECT", "SCREEN_HIT");
  });

  it("required: CLEAR and fresh passes (boundary 24 h); missing, UNKNOWN, stale or future-dated records hold", () => {
    expectCheck(run(intent(), scr("CLEAR"), on), "K-13", null, null);
    expectCheck(run(intent(), scr("CLEAR", "2026-10-04T12:00:00Z"), on), "K-13", null, null);
    expectCheck(run(intent(), scr("CLEAR", "2026-10-04T11:59:59Z"), on), "K-13", "HOLD", "SCREENING_PENDING");
    expectCheck(run(intent(), scr("CLEAR", "2026-10-05T12:00:01Z"), on), "K-13", "HOLD", "SCREENING_PENDING");
    expectCheck(run(intent(), scr("UNKNOWN"), on), "K-13", "HOLD", "SCREENING_PENDING");
    expectCheck(run(intent(), context(), on), "K-13", "HOLD", "SCREENING_PENDING");
    expectCheck(run(intent(), scr("HIT"), on), "K-13", "REJECT", "SCREEN_HIT");
  });
});

describe("K-16 CIRCUIT_BREAKER pre-check", () => {
  it("HALTED => HOLD BREAKER_HALTED on an otherwise clean intent; a more severe finding still wins", () => {
    const halted = context({ breaker: { halted: true, reason: "HIGH reconciliation finding" } });
    const e = run(intent(), halted);
    expect([e.verdict, e.reasons]).toEqual(["HOLD", ["BREAKER_HALTED"]]);
    expect(run({ ...intent(), engagementId: null }, halted).verdict).toBe("REJECT");
    expect(run({ nonsense: true }, halted).reasons).toEqual(["BREAKER_HALTED", "SCHEMA_INVALID"]);
  });

  it("a malformed breaker state fails closed", () => {
    expectCheck(run(intent(), context({ breaker: null as unknown as KernelContext["breaker"] })), "K-16", "HOLD", "KERNEL_ERROR");
    expectCheck(run(intent(), context({ breaker: { halted: "no" as unknown as boolean, reason: null } })), "K-16", "HOLD", "KERNEL_ERROR");
  });
});

describe("breaker state logic", () => {
  const NOW = "2026-10-05T12:00:00Z";
  const at = (secondsAgo: number) => isoFromEpochSeconds(1791201600n - BigInt(secondsAgo)); // NOW = 1791201600
  const exc = (secondsAgo: number): BreakerSignal => ({ kind: "KERNEL_EXCEPTION", at: at(secondsAgo) });

  it("trips on a HIGH finding, an unknown release, a screen hit on a paid payee, or more than 5 kernel exceptions in 10 minutes", () => {
    expect(breakerTrip([], NOW)).toEqual({ ok: true, value: { trip: false, reasons: [] } });
    expect(breakerTrip([{ kind: "RECONCILIATION_FINDING", severity: "MEDIUM", at: NOW }, { kind: "RECONCILIATION_FINDING", severity: "LOW", at: NOW }], NOW)).toEqual({ ok: true, value: { trip: false, reasons: [] } });
    const all: BreakerSignal[] = [{ kind: "SCREEN_HIT_PAID_PAYEE", at: NOW }, { kind: "UNKNOWN_RELEASE", at: NOW }, { kind: "RECONCILIATION_FINDING", severity: "HIGH", at: NOW }, ...[0, 1, 2, 3, 4, 600].map(exc)];
    expect(breakerTrip(all, NOW)).toEqual({ ok: true, value: { trip: true, reasons: ["HIGH_RECONCILIATION_FINDING", "UNKNOWN_RELEASE", "SCREEN_HIT_PAID_PAYEE", "KERNEL_EXCEPTION_RATE"] } });
  });

  it("the exception window is the last 600 s inclusive; 5 is not more than 5; future-dated exceptions do not count", () => {
    expect(breakerTrip([0, 1, 2, 3, 4].map(exc), NOW).ok && breakerTrip([0, 1, 2, 3, 4].map(exc), NOW)).toMatchObject({ value: { trip: false } });
    expect(breakerTrip([0, 1, 2, 3, 4, 601].map(exc), NOW)).toMatchObject({ value: { trip: false } });
    expect(breakerTrip([0, 1, 2, 3, 4, -1].map(exc), NOW)).toMatchObject({ value: { trip: false } });
    expect(breakerTrip([0, 1, 2, 3, 4, 600].map(exc), NOW)).toMatchObject({ value: { trip: true, reasons: ["KERNEL_EXCEPTION_RATE"] } });
  });

  it("malformed input is refused (the service then trips by policy)", () => {
    expect(breakerTrip([], "now").ok).toBe(false);
    expect(breakerTrip([null as unknown as BreakerSignal], NOW).ok).toBe(false);
    expect(breakerTrip([{ kind: "UNKNOWN_RELEASE", at: "yesterday" }], NOW).ok).toBe(false);
  });

  it("OK -> HALTED on a trip (a second trip keeps the first reason); unfreeze is owner-signed with a reason, and only when halted", () => {
    const ok: BreakerRecord = { halted: false, reason: null, since: null, resolvedBy: null };
    const halted = nextBreakerState(ok, { kind: "TRIP", reason: "UNKNOWN_RELEASE", at: NOW });
    expect(halted).toEqual({ ok: true, value: { halted: true, reason: "UNKNOWN_RELEASE", since: NOW, resolvedBy: null } });
    if (!halted.ok) throw new Error("fixture");
    expect(nextBreakerState(halted.value, { kind: "TRIP", reason: "other", at: "2026-10-05T13:00:00Z" })).toEqual(halted);
    expect(nextBreakerState(ok, { kind: "TRIP", reason: "  ", at: NOW })).toMatchObject({ value: { reason: "unspecified" } });
    expect(nextBreakerState(halted.value, { kind: "UNFREEZE", ownerSigned: false, by: OWNER, reason: "checked", at: NOW }).ok).toBe(false);
    expect(nextBreakerState(halted.value, { kind: "UNFREEZE", ownerSigned: true, by: OWNER, reason: " ", at: NOW }).ok).toBe(false);
    expect(nextBreakerState(ok, { kind: "UNFREEZE", ownerSigned: true, by: OWNER, reason: "checked", at: NOW }).ok).toBe(false);
    expect(nextBreakerState(halted.value, { kind: "UNFREEZE", ownerSigned: true, by: OWNER, reason: "reconciled", at: NOW })).toEqual({ ok: true, value: { halted: false, reason: null, since: null, resolvedBy: OWNER } });
    expect(nextBreakerState(ok, { kind: "TRIP", reason: "x", at: "later" }).ok).toBe(false);
  });
});
