// K-05..K-08 unit tests: one guard broken per case, with controls.
import { describe, expect, it } from "vitest";
import { computeTermsHash, inspectUntrusted } from "@symbolon/schemas";
import type { CheckResult, Engagement, Milestone } from "@symbolon/schemas";
import type { KernelContext } from "../src/index";
import { milestoneStatusIssue } from "../src/checks/k05-engagement";
import {
  ATTACKER,
  CAP,
  END,
  ENGAGEMENT_ID,
  GROSS,
  M1,
  M2,
  OTHER_TENANT,
  PAYEE,
  START,
  TWO_TEN_NET_30,
  clone,
  context,
  engagement,
  expectCheck,
  intent,
  milestone,
  phaseA,
  policy,
  single,
  summary,
} from "./helpers";
import type { RawExtraction, RawIntent } from "./helpers";

const detail = (c: CheckResult | undefined) => inspectUntrusted((c as CheckResult).detail);

function both(i: RawIntent, f: (x: RawExtraction) => void): RawIntent {
  const out = clone(i);
  f(out.extraction.a);
  if (out.extraction.b !== null) f(out.extraction.b);
  return out;
}

/** Context for engagement `e`, with ctx.milestone set to e's entry for `mid` (M1 by default). */
function ctxFor(e: Engagement, over: Partial<KernelContext> = {}, mid = M1): KernelContext {
  return context({ engagement: e, milestone: e.milestones.find((m) => m.milestoneId === mid) ?? null, ...over });
}

describe("K-05 ENGAGEMENT_BINDING", () => {
  it("no engagement referenced, none loaded, another engagement, or another tenant's => REJECT NO_ENGAGEMENT", () => {
    expectCheck(phaseA({ ...intent(), engagementId: null }), "K-05", "REJECT", "NO_ENGAGEMENT");
    expectCheck(phaseA(intent(), context({ engagement: null })), "K-05", "REJECT", "NO_ENGAGEMENT");
    expectCheck(phaseA({ ...intent(), engagementId: `0x${"cd".repeat(32)}` }), "K-05", "REJECT", "NO_ENGAGEMENT");
    expectCheck(phaseA(intent(), ctxFor(engagement({ tenantId: OTHER_TENANT }))), "K-05", "REJECT", "NO_ENGAGEMENT");
  });

  it("a malformed engagement object is a context fault: HOLD KERNEL_ERROR", () => {
    expectCheck(phaseA(intent(), ctxFor(engagement({ currencyDecimals: 300 }))), "K-05", "HOLD", "KERNEL_ERROR");
  });

  it.each<[string, Partial<Engagement>]>([
    ["status DRAFT", { status: "DRAFT" }],
    ["status AWAITING_PAYEE", { status: "AWAITING_PAYEE" }],
    ["status CLOSED", { status: "CLOSED" }],
    ["owner signature missing (null sig = not active)", { ownerSig: null }],
    ["payee signature missing (null sig = not active)", { payeeSig: null }],
    ["not registered on chain", { registeredTx: null }],
  ])("%s => REJECT ENGAGEMENT_INACTIVE", (_label, over) => {
    expectCheck(phaseA(intent(), ctxFor(engagement(over))), "K-05", "REJECT", "ENGAGEMENT_INACTIVE");
  });

  it("terms edited after signing (paymentTerms swapped in the DB, termsHash stale) => REJECT ENGAGEMENT_INACTIVE", () => {
    const tampered: Engagement = { ...engagement(), paymentTerms: TWO_TEN_NET_30 };
    expect(computeTermsHash(tampered)).not.toBe(tampered.termsHash);
    const e = phaseA(intent(), ctxFor(tampered));
    expectCheck(e, "K-05", "REJECT", "ENGAGEMENT_INACTIVE");
    expect(detail(e.checks[4])).toContain("termsHash");
  });

  describe("on-chain registration", () => {
    const chain = (over: Partial<NonNullable<KernelContext["engagementOnChain"]>>) => {
      const base = context();
      return { ...base, engagementOnChain: { ...(base.engagementOnChain as NonNullable<KernelContext["engagementOnChain"]>), ...over } };
    };
    it.each<[string, Partial<NonNullable<KernelContext["engagementOnChain"]>>]>([
      ["closed on chain", { active: false }],
      ["another termsHash", { termsHash: `0x${"ee".repeat(32)}` }],
      ["another cap", { capBaseUnits: CAP + 1n }],
      ["another start", { start: "2026-10-02T00:00:00Z" }],
      ["another end", { end: "2027-01-01T00:00:00Z" }],
      ["another engagement", { engagementId: `0x${"cd".repeat(32)}` }],
    ])("%s => REJECT ENGAGEMENT_INACTIVE", (_label, over) => {
      expectCheck(phaseA(intent(), chain(over)), "K-05", "REJECT", "ENGAGEMENT_INACTIVE");
    });

    it("no on-chain record => REJECT ENGAGEMENT_INACTIVE", () => {
      expectCheck(phaseA(intent(), context({ engagementOnChain: null })), "K-05", "REJECT", "ENGAGEMENT_INACTIVE");
    });
  });

  describe("time window [start, end], inclusive like the vault (ATK-16)", () => {
    it.each([
      ["2026-09-30T23:59:59Z", "2026-09-30T00:00:00Z", "OUT_OF_WINDOW"],
      [START, START, null],
      [END, "2026-12-31T00:00:00Z", null],
      ["2027-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "OUT_OF_WINDOW"],
    ])("now %s -> %s", (now, received, code) => {
      expectCheck(phaseA(intent(), context({ now, invoiceReceivedAt: received })), "K-05", code === null ? null : "REJECT", code);
    });
  });

  describe("milestone", () => {
    it("intent.milestoneId null or not a milestone of this engagement => REJECT UNKNOWN_MILESTONE", () => {
      expectCheck(phaseA({ ...intent(), milestoneId: null }), "K-05", "REJECT", "UNKNOWN_MILESTONE");
      expectCheck(phaseA({ ...intent(), milestoneId: `0x${"ab".repeat(32)}` }), "K-05", "REJECT", "UNKNOWN_MILESTONE");
    });

    it("ctx.milestone missing or different from the signed entry => HOLD KERNEL_ERROR", () => {
      expectCheck(phaseA(intent(), context({ milestone: null })), "K-05", "HOLD", "KERNEL_ERROR");
      expectCheck(phaseA(intent(), context({ milestone: milestone(M1, "design", { amountBaseUnits: "1" }) })), "K-05", "HOLD", "KERNEL_ERROR");
    });

    it.each<[Milestone["status"], string | null]>([
      ["PENDING", null],
      ["EVIDENCE_OK", null],
      ["PAID", "MILESTONE_ALREADY_PAID"],
      ["DISPUTED", "ENGAGEMENT_INACTIVE"],
      ["CANCELLED", "ENGAGEMENT_INACTIVE"],
    ])("status %s -> %s", (status, code) => {
      const e = engagement({ milestones: [milestone(M1, "design", { status }), milestone(M2, "build")] });
      expectCheck(phaseA(intent(), ctxFor(e)), "K-05", code === null ? null : "REJECT", code);
    });

    it("an unknown milestone status fails closed", () => {
      expect(milestoneStatusIssue({ ...milestone(M1, "x"), status: "LOST" as Milestone["status"] })).toMatchObject({ onFail: "REJECT", code: "ENGAGEMENT_INACTIVE" });
    });

    it("sequential engagements require every earlier milestone to be PAID", () => {
      const seq = (s1: Milestone["status"]) => engagement({ sequential: true, milestones: [milestone(M1, "design", { status: s1 }), milestone(M2, "build")] });
      const toM2 = { ...intent(), milestoneId: M2 };
      expectCheck(phaseA(toM2, ctxFor(seq("PENDING"), {}, M2)), "K-05", "REJECT", "MILESTONE_ORDER");
      expectCheck(phaseA(toM2, ctxFor(seq("CANCELLED"), {}, M2)), "K-05", "REJECT", "MILESTONE_ORDER");
      expectCheck(phaseA(toM2, ctxFor(seq("PAID"), {}, M2)), "K-05", null, null);
      expectCheck(phaseA(intent(), ctxFor(seq("PENDING"))), "K-05", null, null); // first milestone
    });
  });

  it("collects every finding and reports the most severe", () => {
    const e = phaseA(intent(), { ...ctxFor(engagement({ status: "CLOSED" })), now: "2027-01-02T00:00:00Z", invoiceReceivedAt: "2027-01-01T00:00:00Z" });
    expectCheck(e, "K-05", "REJECT", "ENGAGEMENT_INACTIVE");
    expect(detail(e.checks[4])).toContain("OUT_OF_WINDOW");
  });
});

describe("K-06 PAYEE_BINDING", () => {
  const wallet = (a: string | null, b: string | null) => {
    const i = clone(intent());
    i.extraction.a.payee.walletAddress = a;
    if (i.extraction.b !== null) i.extraction.b.payee.walletAddress = b;
    return i;
  };

  it("the payout address is always the engagement payee", () => {
    expect(phaseA(intent()).payee).toBe(PAYEE);
    expect(phaseA(wallet(null, null)).payee).toBe(PAYEE);
    expectCheck(phaseA(wallet(null, null)), "K-06", null, null);
  });

  it("an invoice address that differs from the engagement payee => REJECT PAYEE_MISMATCH (either extraction; ATK-02/10/11)", () => {
    expectCheck(phaseA(wallet(ATTACKER, ATTACKER)), "K-06", "REJECT", "PAYEE_MISMATCH");
    expectCheck(phaseA(wallet(PAYEE, ATTACKER)), "K-06", "REJECT", "PAYEE_MISMATCH");
    expectCheck(phaseA(single(wallet(ATTACKER, null))), "K-06", "REJECT", "PAYEE_MISMATCH");
  });

  it("names never matter: a near-collision name with the right address passes, the right name with another address fails", () => {
    const ltd = both(intent(), (x) => (x.payee.legalName = "Acme Design Ltd"));
    expectCheck(phaseA(ltd), "K-06", null, null);
    const swapped = both(intent(), (x) => (x.payee.walletAddress = ATTACKER));
    expectCheck(phaseA(swapped), "K-06", "REJECT", "PAYEE_MISMATCH");
  });

  it("an address-change claim => at least ESCALATE ADDRESS_CHANGE_CLAIMED (either extraction)", () => {
    expectCheck(phaseA(both(intent(), (x) => (x.payee.claimsAddressChange = true))), "K-06", "ESCALATE", "ADDRESS_CHANGE_CLAIMED");
    const onlyB = clone(intent());
    if (onlyB.extraction.b !== null) onlyB.extraction.b.payee.claimsAddressChange = true;
    expectCheck(phaseA(onlyB), "K-06", "ESCALATE", "ADDRESS_CHANGE_CLAIMED");
  });

  it("an on-chain payee different from the loaded engagement payee => REJECT PAYEE_MISMATCH", () => {
    const ctx = context();
    expectCheck(phaseA(intent(), { ...ctx, engagementOnChain: { ...(ctx.engagementOnChain as NonNullable<KernelContext["engagementOnChain"]>), payee: ATTACKER } }), "K-06", "REJECT", "PAYEE_MISMATCH");
    expectCheck(phaseA(intent(), context({ engagementOnChain: null })), "K-06", null, null); // K-05 owns that failure
  });

  it("a pending payee change => HOLD PAYEE_CHANGE_PENDING; a mismatch still wins", () => {
    expectCheck(phaseA(intent(), context({ payeeChangePending: true })), "K-06", "HOLD", "PAYEE_CHANGE_PENDING");
    expectCheck(phaseA(wallet(ATTACKER, PAYEE), context({ payeeChangePending: true })), "K-06", "REJECT", "PAYEE_MISMATCH");
  });

  it("no engagement => REJECT NO_ENGAGEMENT", () => {
    expectCheck(phaseA(intent(), context({ engagement: null })), "K-06", "REJECT", "NO_ENGAGEMENT");
  });
});

describe("K-07 CURRENCY_DECIMALS", () => {
  const currency = (a: string, b: string | null = a) => {
    const i = clone(intent());
    i.extraction.a.amount.currencyPrinted = a;
    if (i.extraction.b !== null && b !== null) i.extraction.b.amount.currencyPrinted = b;
    return i;
  };
  const noUsd = policy({ currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: false } });

  it.each(["USDC", " usdc ", "USD", "$", "ＵＳＤＣ"])("accepts %j (USD aliases only when treatUsdAsUsdc)", (c) => {
    expectCheck(phaseA(currency(c)), "K-07", null, null);
  });

  it.each(["EUR", "€", "", "US$", "USDT", "dollars"])("refuses %j => REJECT CURRENCY_UNSUPPORTED", (c) => {
    expectCheck(phaseA(currency(c)), "K-07", "REJECT", "CURRENCY_UNSUPPORTED");
  });

  it("USD and $ are refused when treatUsdAsUsdc is false; USDC still passes", () => {
    expectCheck(phaseA(currency("USD"), context(), noUsd), "K-07", "REJECT", "CURRENCY_UNSUPPORTED");
    expectCheck(phaseA(currency("$"), context(), noUsd), "K-07", "REJECT", "CURRENCY_UNSUPPORTED");
    expectCheck(phaseA(currency("USDC"), context(), noUsd), "K-07", null, null);
  });

  it("extraction B's currency is checked too", () => {
    expectCheck(phaseA(currency("USDC", "EUR")), "K-07", "REJECT", "CURRENCY_UNSUPPORTED");
  });

  it.each<[string, (c: KernelContext) => KernelContext]>([
    ["token decimals 18 (Arc native) vs 6", (c) => ({ ...c, chain: { ...c.chain, tokenDecimals: 18 } })],
    ["vault-stored decimals differ", (c) => ({ ...c, chain: { ...c.chain, vaultTokenDecimals: 18 } })],
    ["engagement decimals differ", () => ctxFor(engagement({ currencyDecimals: 18 }))],
  ])("%s => REJECT DECIMALS_MISMATCH", (_label, mutate) => {
    expectCheck(phaseA(intent(), mutate(context())), "K-07", "REJECT", "DECIMALS_MISMATCH");
  });

  it("policy decimals differ => REJECT DECIMALS_MISMATCH", () => {
    expectCheck(phaseA(intent(), context(), policy({ currency: { code: "USDC", decimals: 18, treatUsdAsUsdc: true } })), "K-07", "REJECT", "DECIMALS_MISMATCH");
  });

  describe("scale sanity: > 10^(decimals+9) base units is absurd (ATK-05)", () => {
    const amount = (printed: string, parsed: string) =>
      both(intent(), (x) => {
        x.amount.printed = printed;
        x.amount.parsedBaseUnits = parsed;
        x.lineItems = [];
      });

    it("spec vector: 5 USDC expected, 5000000000000000000 claimed => REJECT", () => {
      const e = phaseA(amount("5.00", "5000000000000000000"));
      expectCheck(e, "K-07", "REJECT", "SCALE_ABSURD");
      expect(e.verdict).toBe("REJECT");
    });

    it("an absurd printed amount is refused by the kernel's own parse", () => {
      expectCheck(phaseA(amount("8000000000000000000", "8000000")), "K-07", "REJECT", "SCALE_ABSURD");
    });

    it("an amount past the 30-digit intentId preimage range leaves the intent unbound and is refused", () => {
      const e = phaseA(amount(`1${"0".repeat(30)}`, "1000000"));
      expect(e.intentIdBound).toBe(false);
      expectCheck(e, "K-07", "REJECT", "SCALE_ABSURD");
      expect(e.verdict).toBe("REJECT");
    });

    it("boundary: exactly 10^15 base units passes K-07, one more fails", () => {
      expectCheck(phaseA(amount("1000000000", "1000000000000000")), "K-07", null, null);
      expectCheck(phaseA(amount("1000000000.000001", "1000000000000001")), "K-07", "REJECT", "SCALE_ABSURD");
    });
  });
});

describe("K-08 AMOUNT_CONFORMANCE", () => {
  const gross = (printed: string, parsed: string) =>
    both(intent(), (x) => {
      x.amount.printed = printed;
      x.amount.parsedBaseUnits = parsed;
      x.lineItems = [];
    });

  it("ATK-06 compensating errors: +20 on one milestone is REJECT OVERPAY, -20 on another is ESCALATE UNDERPAY_PARTIAL", () => {
    expectCheck(phaseA(gross("1,020.00", "1020000000")), "K-08", "REJECT", "OVERPAY");
    expectCheck(phaseA({ ...gross("980.00", "980000000"), milestoneId: M2 }, context({ milestone: engagement().milestones[1] as Milestone })), "K-08", "ESCALATE", "UNDERPAY_PARTIAL");
  });

  it("released (incl. pending) + gross > engagement cap => REJECT OVERPAY; exactly the cap passes", () => {
    const released = (engagementTotal: bigint) => context({ released: { ...context().released, engagementTotal } });
    expectCheck(phaseA(intent(), released(CAP - GROSS + 1n)), "K-08", "REJECT", "OVERPAY");
    expectCheck(phaseA(intent(), released(CAP - GROSS)), "K-08", null, null);
  });

  describe("partialAllowed milestones", () => {
    const partial = engagement({ milestones: [milestone(M1, "design", { partialAllowed: true }), milestone(M2, "build")] });

    it("a lower gross passes; a higher one is still OVERPAY", () => {
      expectCheck(phaseA(gross("400.00", "400000000"), ctxFor(partial)), "K-08", null, null);
      expectCheck(phaseA(gross("1,000.01", "1000010000"), ctxFor(partial)), "K-08", "REJECT", "OVERPAY");
    });

    it("cumulative partial releases may not exceed the milestone amount (unknown prior amount counts as the whole milestone)", () => {
      const prior = (amountBaseUnits: bigint | null) => summary({ verdict: "RELEASE", milestoneId: M1, amountBaseUnits });
      expectCheck(phaseA(gross("400.00", "400000000"), ctxFor(partial, { priorDecisions: [prior(700_000_000n)] })), "K-08", "REJECT", "OVERPAY");
      expectCheck(phaseA(gross("300.00", "300000000"), ctxFor(partial, { priorDecisions: [prior(700_000_000n)] })), "K-08", null, null);
      expectCheck(phaseA(gross("1.00", "1000000"), ctxFor(partial, { priorDecisions: [prior(null)] })), "K-08", "REJECT", "OVERPAY");
      // non-RELEASE priors and other milestones do not count
      expectCheck(phaseA(gross("400.00", "400000000"), ctxFor(partial, { priorDecisions: [summary({ verdict: "HOLD", milestoneId: M1, amountBaseUnits: 900_000_000n })] })), "K-08", null, null);
    });

    it("the intent's own chain (TOCTOU re-evaluation) is not counted against itself", () => {
      const first = phaseA(gross("400.00", "400000000"), ctxFor(partial));
      const own = summary({ verdict: "RELEASE", milestoneId: M1, intentId: first.intentId, amountBaseUnits: 400_000_000n });
      const reevaluation = { decisionId: own.decisionId, intentId: first.intentId, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: 400_000_000n };
      expectCheck(phaseA(gross("400.00", "400000000"), ctxFor(partial, { priorDecisions: [own], reevaluation })), "K-08", null, null);
    });
  });

  it("missing engagement, milestone or gross fail closed", () => {
    expectCheck(phaseA(intent(), context({ engagement: null })), "K-08", "REJECT", "NO_ENGAGEMENT");
    expectCheck(phaseA({ ...intent(), milestoneId: `0x${"ab".repeat(32)}` }), "K-08", "REJECT", "UNKNOWN_MILESTONE");
    const unknownGross = both(intent(), (x) => {
      x.amount.printed = "1,000";
      x.amount.parsedBaseUnits = null;
      x.lineItems = [];
    });
    expectCheck(phaseA(unknownGross), "K-08", "ESCALATE", "AMOUNT_AMBIGUOUS");
  });

  it.each<[string, (c: KernelContext) => KernelContext]>([
    ["negative released total", (c) => ({ ...c, released: { ...c.released, engagementTotal: -1n } })],
    ["released total not a bigint", (c) => ({ ...c, released: { ...c.released, engagementTotal: 5 as unknown as bigint } })],
    ["invoiceReceivedAt after now", (c) => ({ ...c, invoiceReceivedAt: "2026-10-05T12:00:01Z" })],
    ["ctx.paymentTerms differ from the signed engagement terms (INV-19)", (c) => ({ ...c, paymentTerms: TWO_TEN_NET_30 })],
  ])("context fault: %s => HOLD KERNEL_ERROR", (_label, mutate) => {
    expectCheck(phaseA(intent(), mutate(context())), "K-08", "HOLD", "KERNEL_ERROR");
  });

  describe("release amount = amountDue(payAt) from the SIGNED terms (TOCTOU re-evaluation)", () => {
    // 2/10 net 30, received 2026-10-05T10:00:00Z => window ends 2026-10-15T10:00:00Z; gross 1,000 => discounted 980.
    const termsEng = engagement({ paymentTerms: TWO_TEN_NET_30 });
    const myId = phaseA(intent(), ctxFor(termsEng)).intentId;
    const reeval = (now: string, payAt: string, amount: bigint) =>
      phaseA(intent(), ctxFor(termsEng, { now, reevaluation: { decisionId: summary().decisionId, intentId: myId, payAt, releaseAmountBaseUnits: amount } }));

    it("the discounted amount inside the window passes and is reported", () => {
      const e = reeval("2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z", 980_000_000n);
      expectCheck(e, "K-08", null, null);
      expect(e.releaseAmountBaseUnits).toBe("980000000");
      expect(e.payAt).toBe("2026-10-06T00:00:00Z");
      expect(e.amountBaseUnits).toBe("1000000000"); // the intent stays on the gross
    });

    it("paying the gross inside the window is OVERPAY; less than due is UNDERPAY_PARTIAL", () => {
      expectCheck(reeval("2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z", 1_000_000_000n), "K-08", "REJECT", "OVERPAY");
      expectCheck(reeval("2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z", 970_000_000n), "K-08", "ESCALATE", "UNDERPAY_PARTIAL");
    });

    it("window boundary at ±1 s: at the end the discount holds; one second later the discounted amount is UNDERPAY", () => {
      expectCheck(reeval("2026-10-15T10:00:00Z", "2026-10-15T10:00:00Z", 980_000_000n), "K-08", null, null);
      expectCheck(reeval("2026-10-15T10:00:01Z", "2026-10-15T10:00:00Z", 980_000_000n), "K-08", "ESCALATE", "UNDERPAY_PARTIAL");
      expectCheck(reeval("2026-10-15T10:00:01Z", "2026-10-15T10:00:00Z", 1_000_000_000n), "K-08", null, null);
    });

    it("amountDue is taken at max(now, scheduled payAt)", () => {
      // evaluated early (inside the window) for a payAt after the window: the full amount is due
      expectCheck(reeval("2026-10-06T00:00:00Z", "2026-10-16T00:00:00Z", 980_000_000n), "K-08", "ESCALATE", "UNDERPAY_PARTIAL");
      expect(reeval("2026-10-06T00:00:00Z", "2026-10-16T00:00:00Z", 1_000_000_000n).payAt).toBe("2026-10-16T00:00:00Z");
    });

    it("no signed terms: the release amount is the gross", () => {
      const e = phaseA(intent(), context({ reevaluation: { decisionId: summary().decisionId, intentId: phaseA(intent()).intentId, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: GROSS } }));
      expectCheck(e, "K-08", null, null);
      expect(e.releaseAmountBaseUnits).toBe("1000000000");
    });

    it("signed terms the terms package refuses => HOLD KERNEL_ERROR, no release amount", () => {
      const bad = engagement({ paymentTerms: { netDays: 10, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: true } });
      const id = phaseA(intent(), ctxFor(bad)).intentId;
      const e = phaseA(intent(), ctxFor(bad, { reevaluation: { decisionId: summary().decisionId, intentId: id, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: GROSS } }));
      expectCheck(e, "K-08", "HOLD", "KERNEL_ERROR");
      expect(e.releaseAmountBaseUnits).toBeNull();
    });

    it("a first evaluation has no release amount yet (K-14 picks payAt in WP-05)", () => {
      const e = phaseA(intent(), ctxFor(termsEng));
      expect(e.releaseAmountBaseUnits).toBeNull();
      expect(e.payAt).toBeNull();
    });
  });

  it("uses the engagement id from the intent binding", () => {
    expect(phaseA(intent()).engagementId).toBe(ENGAGEMENT_ID);
  });
});
