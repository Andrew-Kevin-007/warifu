import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { epochSecondsFromIso, formatBaseUnits, isoFromEpochSeconds, jcs, symbolonDomain, untrusted, type ApprovalView } from "@symbolon/schemas";
import {
  ADVISORY_LABEL,
  buildApprovalTypedData,
  buildApprovalView,
  checkWysiwys,
  renderModel,
  signedModel,
  type ApprovalDraft,
} from "../src/approval/index";
import { APPROVAL_VIEW } from "../../schemas/test/fixtures";
import { DOMAIN, STRANGER } from "./helpers";

const draftOf = (v: ApprovalView, over: Partial<ApprovalDraft> = {}): ApprovalDraft => ({
  intentId: v.intentId,
  receiptHash: v.receiptHash,
  engagementId: v.engagementId,
  milestoneId: v.milestoneId,
  payee: v.payee,
  decimals: v.decimals,
  grossBaseUnits: v.grossBaseUnits,
  releaseBaseUnits: v.releaseBaseUnits,
  diffVsEngagement: v.diffVsEngagement,
  reasons: v.reasons,
  planSummary: v.planSummary,
  expiresAt: v.expiresAt,
  advisory: v.advisory,
  domain: v.typedData.domain,
  ...over,
});

const view = (over: Partial<ApprovalDraft> = {}): ApprovalView => {
  const r = buildApprovalView(draftOf(APPROVAL_VIEW, over));
  if (!r.ok) throw new Error(`fixture view does not build: ${r.error.message}`);
  return r.value;
};
const model = (v: unknown) => {
  const r = renderModel(v);
  if (!r.ok) throw new Error(`renderModel failed: ${r.error.message}`);
  return r.value;
};

describe("buildApprovalTypedData: the only producer of OwnerApproval typed data", () => {
  it("reproduces the reference view's typed data from its four facts", () => {
    const td = buildApprovalTypedData({ ...APPROVAL_VIEW, domain: DOMAIN });
    expect(td.ok && td.value).toEqual(APPROVAL_VIEW.typedData);
  });

  it("accepts a whole view in place of the facts and gives the same answer", () => {
    const td = buildApprovalTypedData(APPROVAL_VIEW);
    expect(td.ok && td.value).toEqual(APPROVAL_VIEW.typedData);
  });

  it("commits the amount to what the vault would pay and the deadline to the expiry", () => {
    const td = buildApprovalTypedData(APPROVAL_VIEW);
    if (!td.ok) throw new Error("build failed");
    expect(td.value.message.amount).toBe(APPROVAL_VIEW.releaseBaseUnits);
    expect(td.value.message.amount).not.toBe(APPROVAL_VIEW.grossBaseUnits);
    expect(td.value.message.deadline).toBe(epochSecondsFromIso(APPROVAL_VIEW.expiresAt).toString());
    expect(td.value.message.receiptHash).toBe(APPROVAL_VIEW.receiptHash);
  });

  it("fails closed on bad input instead of throwing", () => {
    const base = { ...APPROVAL_VIEW, domain: DOMAIN };
    for (const bad of [{ ...base, releaseBaseUnits: "-1" }, { ...base, releaseBaseUnits: "1.5" }, { ...base, expiresAt: "tomorrow" }, { ...base, intentId: "0x12" }, null, 7]) {
      const r = buildApprovalTypedData(bad as never);
      expect(r.ok).toBe(false);
    }
  });
});

describe("buildApprovalView", () => {
  it("builds a view equal to the reference one, with display strings and hash derived, not supplied", () => {
    const v = view();
    expect(v).toEqual(APPROVAL_VIEW);
    expect(v.display.release).toBe(formatBaseUnits(v.releaseBaseUnits, v.decimals));
  });

  it("refuses a draft with a zero or malformed amount, a bad expiry, or an unknown reason", () => {
    for (const over of [{ releaseBaseUnits: "x" }, { grossBaseUnits: "-5" }, { expiresAt: "soon" }, { reasons: ["NOT_A_REASON"] }, { decimals: 256 }]) {
      expect(buildApprovalView(draftOf(APPROVAL_VIEW, over as never)).ok).toBe(false);
    }
  });

  it("keeps a plain advisory note and accepts a view with none", () => {
    expect(view({ advisory: { text: "ok" as never } }).advisory).not.toBeNull();
    expect(view({ advisory: null }).advisory).toBeNull();
  });
});

describe("renderModel and signedModel (INV-20: what you see is what you sign)", () => {
  it("jcs(renderModel(view)) equals jcs(signedModel(view)) for the reference view", () => {
    const a = renderModel(APPROVAL_VIEW);
    const b = signedModel(APPROVAL_VIEW);
    expect(a.ok && b.ok && jcs(a.value) === jcs(b.value)).toBe(true);
  });

  it("holds for generated views: any amount, decimals, expiry and payee", () => {
    const amount = fc.bigInt({ min: 1n, max: 10n ** 30n }).map((x) => x.toString());
    fc.assert(
      fc.property(amount, fc.integer({ min: 0, max: 18 }), fc.integer({ min: 1_700_000_000, max: 4_000_000_000 }), (units, decimals, t) => {
        const gross = (BigInt(units) + 1000n).toString();
        const r = buildApprovalView(draftOf(APPROVAL_VIEW, { releaseBaseUnits: units, grossBaseUnits: gross, decimals, expiresAt: isoFromEpochSeconds(BigInt(t)) }));
        if (!r.ok) return true; // a view the schema refuses produces no model at all, which is also what we want
        const a = renderModel(r.value);
        const b = signedModel(r.value);
        return a.ok && b.ok && jcs(a.value) === jcs(b.value) && checkWysiwys(a.value, r.value).ok;
      }),
      { numRuns: 300 },
    );
  });

  it("the signed section shows exactly the typed data the wallet is asked to sign", () => {
    const m = model(APPROVAL_VIEW);
    const msg = APPROVAL_VIEW.typedData.message;
    expect(m.signed.primaryType).toBe("OwnerApproval");
    expect(m.signed.intentId).toBe(msg.intentId);
    expect(m.signed.receiptHash).toBe(msg.receiptHash);
    expect(m.signed.amount.baseUnits).toBe(msg.amount);
    expect(m.signed.deadline.epochSeconds).toBe(msg.deadline);
    expect(m.signed.typedDataHash).toBe(APPROVAL_VIEW.typedDataHash);
    expect(m.signed.domain).toEqual(APPROVAL_VIEW.typedData.domain);
  });

  it("refuses a view whose display, hash, typed data or expiry disagree with each other (no model, fail closed)", () => {
    const tampered: Array<[string, unknown]> = [
      ["display.release says $50", { ...APPROVAL_VIEW, display: { ...APPROVAL_VIEW.display, release: "50.00" } }],
      ["releaseBaseUnits changed, typed data not", { ...APPROVAL_VIEW, releaseBaseUnits: "1" }],
      ["typed data amount changed, display not", { ...APPROVAL_VIEW, typedData: { ...APPROVAL_VIEW.typedData, message: { ...APPROVAL_VIEW.typedData.message, amount: "9999999999" } } }],
      ["typedDataHash wrong", { ...APPROVAL_VIEW, typedDataHash: "0x" + "00".repeat(32) }],
      ["expiry moved, deadline not", { ...APPROVAL_VIEW, expiresAt: "2030-01-01T00:00:00Z" }],
      ["not an object", "view"],
    ];
    for (const [name, v] of tampered) {
      expect(renderModel(v).ok, name).toBe(false);
      expect(signedModel(v).ok, name).toBe(false);
      expect(checkWysiwys({}, v).ok, name).toBe(false);
    }
  });

  it("keeps the AI note collapsed, labelled, and outside the signed section", () => {
    const m = model(APPROVAL_VIEW);
    expect(m.advisory).toEqual({ collapsed: true, label: ADVISORY_LABEL, text: APPROVAL_VIEW.advisory?.text });
    expect(JSON.stringify(m.signed)).not.toContain(APPROVAL_VIEW.advisory?.text as unknown as string);
    expect(model(view({ advisory: null })).advisory).toBeNull();
  });

  it("carries reason codes and the signed engagement's payee label, not sentences", () => {
    const m = model(APPROVAL_VIEW);
    expect(m.reasons).toEqual(["HUMAN_REQUIRED"]);
    expect(m.payee).toEqual(APPROVAL_VIEW.payee);
  });
});

describe("checkWysiwys (ATK-23: UI shows $50, wallet signs $500)", () => {
  type Loose = Record<string, unknown>;
  const good = (): Loose => structuredClone(model(APPROVAL_VIEW)) as unknown as Loose;
  /** Set (or with `undefined`, delete) the member at `path` of a plain object. */
  const put = (m: Loose, path: readonly string[], value: unknown): void => {
    let at = m;
    for (const k of path.slice(0, -1)) at = at[k] as Loose;
    const last = path[path.length - 1] as string;
    if (value === undefined) delete at[last];
    else at[last] = value;
  };

  it("accepts the model derived from the view", () => {
    expect(checkWysiwys(good(), APPROVAL_VIEW)).toEqual({ ok: true });
  });

  it("names the path of every field a hostile UI changed, and never prints values", () => {
    const m = good();
    put(m, ["signed", "amount", "display"], "50.00");
    put(m, ["signed", "amount", "baseUnits"], "50000000");
    put(m, ["payee", "label"], "Someone Else");
    const r = checkWysiwys(m, APPROVAL_VIEW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.differences).toEqual(expect.arrayContaining(["$.signed.amount.display", "$.signed.amount.baseUnits", "$.payee.label"]));
    expect(r.differences.join(" ")).not.toContain("Someone Else");
  });

  it.each([
    ["receipt hash", ["signed", "receiptHash"], "0x" + "12".repeat(32), "$.signed.receiptHash"],
    ["deadline", ["signed", "deadline", "epochSeconds"], "1", "$.signed.deadline.epochSeconds"],
    ["typed data hash", ["signed", "typedDataHash"], "0x" + "12".repeat(32), "$.signed.typedDataHash"],
    ["advisory moved out of its collapsed state", ["advisory", "collapsed"], false, "$.advisory.collapsed"],
    ["extra field smuggled in", ["approveNow"], true, "$.approveNow"],
    ["field removed", ["reasons"], undefined, "$.reasons"],
  ] as const)("detects a tampered %s", (_n, path, value, expected) => {
    const m = good();
    put(m, path, value);
    const r = checkWysiwys(m, APPROVAL_VIEW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.differences.some((p) => p.startsWith(expected))).toBe(true);
  });

  it("refuses a view for another vault or chain than the app is deployed against", () => {
    const other = symbolonDomain(1, STRANGER.address);
    const r = checkWysiwys(good(), APPROVAL_VIEW, { expectedDomain: other });
    expect(r.ok).toBe(false);
    expect(checkWysiwys(good(), APPROVAL_VIEW, { expectedDomain: DOMAIN }).ok).toBe(true);
  });

  it("bounds the number of reported differences, and never throws on odd input", () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    const r = checkWysiwys({ ...good(), ...wide }, APPROVAL_VIEW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.differences.length).toBeLessThanOrEqual(16);
    for (const odd of [null, undefined, 3, "x", [], () => 1, { n: 10n }]) expect(checkWysiwys(odd, APPROVAL_VIEW).ok).toBe(false);
  });

  it("an attacker-controlled diff string stays data: it is carried as Untrusted and never alters the comparison", () => {
    const evil = `Acme${String.fromCharCode(0x202e)}<img src=x onerror=alert(1)>`; // right-to-left override + markup
    const v = view({ diffVsEngagement: [{ field: "payee.legalName", expected: "Acme Design Studio", actual: untrusted(evil) }] });
    const m = model(v);
    expect(m.diffVsEngagement[0]?.actual).toBe(evil);
    expect(checkWysiwys(structuredClone(m), v)).toEqual({ ok: true });
    expect(JSON.stringify(m.signed)).not.toContain("onerror");
  });
});

describe("the approval entry point is safe for apps/web (no signing, no keys, no chain code)", () => {
  it("imports nothing but the schemas, its own result type and itself", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..", "src", "approval");
    const specs = new Set<string>();
    for (const f of readdirSync(root)) {
      for (const m of readFileSync(join(root, f), "utf8").matchAll(/from\s+"([^"]+)"/g)) specs.add(m[1] as string);
    }
    expect([...specs].sort()).toEqual(["../result", "./build", "./render", "@symbolon/schemas"].sort());
  });
});
