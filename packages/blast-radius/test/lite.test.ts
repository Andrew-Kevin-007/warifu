// Blast Radius Lite (docs/08 §7): hand-computed report, both input modes, fail-closed parsing with a positive
// control for every refusal, untrusted text kept inert, and 1,000-run properties.
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LITE_INPUT_SCHEMA,
  LiteInputError,
  MAX_LITE_INPUT_CHARS,
  auditLite,
  auditLiteFromJson,
  durationText,
  parseLiteInput,
} from "../src/lite";
import type { LiteReport } from "../src/lite";
import { fcParams } from "./helpers/arb";

const numbers = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: LITE_INPUT_SCHEMA,
  mode: "numbers",
  decimals: 6,
  balance: "1000",
  dailyLimit: "200",
  weeklyLimit: "600",
  ...o,
});
const M = 1_000_000n;
const horizon = (r: LiteReport, mode: "rolling" | "calendar", label: string) => {
  const h = r.interpretations[mode].horizons.find((x) => x.label === label);
  if (h === undefined) throw new Error(`no horizon ${label}`);
  return { value: BigInt(h.value.baseUnits), binding: [...h.binding] };
};

describe("hand-computed report: balance 1000, daily 200, weekly 600 (6 decimals)", () => {
  const r = auditLite(numbers({ lossTarget: "500" }));

  it("rolling windows: daily binds to 48 h, weekly binds from 4 d, balance caps the month", () => {
    // 1 min..24 h: 1 daily window = 200 ; 48 h: 2 = 400 ; 7 d: min(7*200=1400, 1 weekly window = 600) = 600 ;
    // 30 d: min(6000, 5 weekly windows = 3000, balance 1000) = 1000
    expect(horizon(r, "rolling", "1m")).toEqual({ value: 200n * M, binding: ["daily limit"] });
    expect(horizon(r, "rolling", "24h")).toEqual({ value: 200n * M, binding: ["daily limit"] });
    expect(horizon(r, "rolling", "48h")).toEqual({ value: 400n * M, binding: ["daily limit"] });
    expect(horizon(r, "rolling", "7d")).toEqual({ value: 600n * M, binding: ["weekly limit"] });
    expect(horizon(r, "rolling", "30d")).toEqual({ value: 1000n * M, binding: ["balance"] });
  });
  it("calendar buckets: 24 h touches 2 daily buckets (the 2x boundary effect)", () => {
    // 24 h: daily 2*200 = 400 (weekly 2*600 = 1200) ; 48 h: 3 daily buckets = 600 ; 7 d: daily 8 buckets = 1600,
    // weekly 2 buckets = 1200, balance 1000 binds
    // even 1 minute can straddle a reset: 200 just before it and 200 just after = 400
    expect(horizon(r, "calendar", "1m")).toEqual({ value: 400n * M, binding: ["daily limit"] });
    expect(horizon(r, "calendar", "24h")).toEqual({ value: 400n * M, binding: ["daily limit"] });
    expect(horizon(r, "calendar", "48h")).toEqual({ value: 600n * M, binding: ["daily limit"] });
    expect(horizon(r, "calendar", "7d")).toEqual({ value: 1000n * M, binding: ["balance"] });
  });
  it("boundary effect block", () => {
    expect(r.boundaryEffect).toEqual({
      rolling24h: { baseUnits: "200000000", formatted: "200" },
      calendar24h: { baseUnits: "400000000", formatted: "400" },
      extra: { baseUnits: "200000000", formatted: "200" },
      present: true,
    });
  });
  it("time to empty: rolling needs the later of daily (5 windows: 4 d + 1 s) and weekly (2 windows: 7 d + 1 s)", () => {
    expect(r.interpretations.rolling.drainSeconds).toBe(String(7n * 86_400n + 1n)); // weekly dominates
    // calendar: daily 5 buckets -> 3 d + 2 s ; weekly 2 buckets -> 2 s ; the later one
    expect(r.interpretations.calendar.drainSeconds).toBe(String(3n * 86_400n + 2n));
  });
  it("detection for a 500 target: rolling 2 daily windows = 172800 s, calendar 86401 s", () => {
    expect(r.interpretations.rolling.detection.maxSeconds).toBe("172800");
    expect(r.interpretations.calendar.detection.maxSeconds).toBe("86401");
    expect(r.interpretations.rolling.detection.lossTargetSource).toBe("supplied");
  });
  it("default loss target is 10 % of the balance and says so", () => {
    const d = auditLite(numbers());
    expect(d.interpretations.rolling.detection.lossTarget.baseUnits).toBe(String(100n * M));
    expect(d.interpretations.rolling.detection.lossTargetSource).toBe("default: 10 % of balance");
    expect(d.interpretations.rolling.detection.maxSeconds).toBe("0"); // one daily window (200) already exceeds 100
  });
  it("is labelled as an estimate, not a certificate, with assumptions and exclusions", () => {
    expect(r.kind).toBe("LITE_ESTIMATE");
    expect(r.notACertificate).toMatch(/nothing here is a Loss Bound Certificate/);
    expect(r.assumptions.map((a) => a.id)).toContain("A-POLICY-KEY");
    expect(r.exclusions.map((a) => a.id)).toContain("X-UNCOUNTED-FLOWS");
    expect(r.headline).toMatch(/Calculated from the numbers supplied/);
    expect(r.headline).toContain("200 units");
    expect(r.headline).toContain("400 units");
  });
  it("asks the questions docs/08 §7 requires", () => {
    const q = r.questions.join("\n");
    expect(q).toMatch(/approvals and allowances/);
    expect(q).toMatch(/sibling wallet/);
    expect(q).toMatch(/change the policy/);
  });
});

describe("no period limit: the balance is the only limit (fail closed, never a smaller number)", () => {
  const r = auditLite({ schema: LITE_INPUT_SCHEMA, mode: "numbers", decimals: 6, balance: "250.5", perTxLimit: "10" });
  it("every horizon equals the balance and the drain takes one second", () => {
    for (const mode of ["rolling", "calendar"] as const) {
      for (const h of r.interpretations[mode].horizons) expect(h.value.baseUnits).toBe("250500000");
      expect(r.interpretations[mode].drainSeconds).toBe("1");
    }
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["NO_PERIOD_LIMIT", "PER_TX_NOT_A_VOLUME_BOUND", "BALANCE_REACHABLE_WITHIN_A_DAY"]));
    expect(r.headline).toMatch(/whole balance/);
  });
  it("a zero balance yields zero bounds", () => {
    const z = auditLite(numbers({ balance: "0" }));
    expect(z.interpretations.rolling.horizons.every((h) => h.value.baseUnits === "0")).toBe(true);
    expect(z.interpretations.rolling.drainSeconds).toBe("0");
  });
});

describe("Agent-Wallet-style policy JSON gives the same bounds as the numbers mode (RT-23)", () => {
  const policyInput = {
    schema: LITE_INPUT_SCHEMA,
    mode: "agent-wallet-policy",
    decimals: 6,
    balance: "1000",
    policy: {
      limits: { perTransaction: "50", daily: "200", weekly: "600", monthly: null },
      recipients: { allowlist: ["0xabc", "0xdef"], blocklist: [] },
      contracts: { allowlist: null, blocklist: ["0x123"] },
    },
  };
  const a = auditLite(policyInput);
  const b = auditLite(numbers({ perTxLimit: "50", recipientAllowlistInUse: true }));
  it("same interpretations", () => {
    expect(a.interpretations).toEqual(b.interpretations);
    expect(a.boundaryEffect).toEqual(b.boundaryEffect);
  });
  it("list contents are reduced to in-use flags and never echoed", () => {
    expect(a.inputs).toMatchObject({ recipientAllowlistInUse: true, recipientBlocklistInUse: false, contractAllowlistInUse: null, contractBlocklistInUse: true });
    expect(JSON.stringify(a)).not.toMatch(/0xabc|0xdef|0x123/);
    expect(a.questions.join(" ")).toMatch(/recipient allowlist/);
  });
  it("an empty policy object means no limits, and is reported as such", () => {
    const e = auditLite({ schema: LITE_INPUT_SCHEMA, mode: "agent-wallet-policy", decimals: 6, balance: "10", policy: {} });
    expect(e.findings.map((f) => f.id)).toContain("NO_PERIOD_LIMIT");
  });
});

describe("fail-closed parsing: every refusal has a positive control", () => {
  const refused: readonly [string, unknown][] = [
    ["a misspelt limit key (would silently be unlimited)", numbers({ dailyLmit: "200", dailyLimit: undefined })],
    ["an unknown key", numbers({ extra: 1 })],
    ["__proto__ smuggled through JSON", JSON.parse('{"schema":"blast-lite-input/1","mode":"numbers","decimals":6,"balance":"1","__proto__":{"dailyLimit":"1"}}') as unknown],
    ["a limit of 0 (ambiguous: off or nothing?)", numbers({ dailyLimit: "0" })],
    ["a zero human-approval threshold", numbers({ humanApprovalThreshold: "0.000000" })],
    ["a negative amount", numbers({ dailyLimit: "-5" })],
    ["exponent notation", numbers({ dailyLimit: "1e6" })],
    ["digit separators", numbers({ dailyLimit: "1,000" })],
    ["more fraction digits than decimals", numbers({ dailyLimit: "1.0000001" })],
    ["a JS number instead of a decimal string", numbers({ dailyLimit: 200 })],
    ["a missing balance", numbers({ balance: undefined })],
    ["a non-string balance", numbers({ balance: 1000 })],
    ["the wrong schema tag", numbers({ schema: "blast-lite-input/2" })],
    ["an unknown mode", numbers({ mode: "magic" })],
    ["decimals above 36", numbers({ decimals: 37 })],
    ["fractional decimals", numbers({ decimals: 6.5 })],
    ["zero keys", numbers({ keys: 0 })],
    ["a currency label with markup", numbers({ currency: "<b>USD</b>" })],
    ["a list with more than 10,000 entries", { schema: LITE_INPUT_SCHEMA, mode: "agent-wallet-policy", decimals: 6, balance: "1", policy: { recipients: { allowlist: new Array<string>(10_001).fill("a") } } }],
    ["an over-long list entry", { schema: LITE_INPUT_SCHEMA, mode: "agent-wallet-policy", decimals: 6, balance: "1", policy: { recipients: { allowlist: ["x".repeat(129)] } } }],
    ["null", null],
    ["an array", []],
    ["a string", "balance=1000"],
  ];
  for (const [name, input] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => parseLiteInput(input)).toThrow(LiteInputError);
    });
  }
  it("positive controls: the same shapes without the fault are accepted", () => {
    expect(() => parseLiteInput(numbers())).not.toThrow();
    expect(() => parseLiteInput(numbers({ dailyLimit: "0.5", keys: 2, currency: "USDC", humanApprovalThreshold: "50" }))).not.toThrow();
    expect(() => parseLiteInput({ schema: LITE_INPUT_SCHEMA, mode: "agent-wallet-policy", decimals: 6, balance: "1", policy: { recipients: { allowlist: new Array<string>(10_000).fill("a") } } })).not.toThrow();
    expect(() => parseLiteInput(numbers({ decimals: 36 }))).not.toThrow();
  });
  it("reports every problem at once, with paths, and does not echo the untrusted value", () => {
    let caught: unknown;
    try {
      parseLiteInput(numbers({ dailyLimit: "<img src=x onerror=alert(1)>", weeklyLimit: "0" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LiteInputError);
    const err = caught as LiteInputError;
    expect(err.issues.map((i) => i.path)).toEqual(["dailyLimit", "weeklyLimit"]);
    expect(err.message).not.toMatch(/onerror|<img/);
  });
  it("auditLiteFromJson: size cap, empty, invalid JSON and wrong types are errors; a valid text works", () => {
    expect(() => auditLiteFromJson("")).toThrow(LiteInputError);
    expect(() => auditLiteFromJson("{not json")).toThrow(LiteInputError);
    expect(() => auditLiteFromJson(" ".repeat(MAX_LITE_INPUT_CHARS + 1))).toThrow(LiteInputError);
    expect(() => auditLiteFromJson(5 as unknown as string)).toThrow(LiteInputError);
    expect(auditLiteFromJson(JSON.stringify(numbers())).kind).toBe("LITE_ESTIMATE");
  });
});

describe("untrusted text is inert in the report", () => {
  it("a hostile currency label is rejected; hostile list entries never appear", () => {
    const hostile = "<script>alert(1)</script>";
    const r = auditLite({ schema: LITE_INPUT_SCHEMA, mode: "agent-wallet-policy", decimals: 6, balance: "10", policy: { recipients: { allowlist: [hostile] } } });
    expect(JSON.stringify(r)).not.toContain("script");
  });
});

describe("wording (DEC-012): no overclaiming in any generated string", () => {
  it("passes the claims linter rules on a rich report", async () => {
    const modPath = "../../../scripts/claims-lint.mjs";
    const lint = (await import(/* @vite-ignore */ modPath)) as { lintText: (t: string) => { rule: string; match: string }[] };
    const r = auditLite(numbers({ perTxLimit: "10", keys: 3, roles: 2, recipientAllowlistInUse: true, humanApprovalThreshold: "5", monthlyLimit: "1500" }));
    const text = [r.headline, r.notACertificate, ...r.findings.map((f) => f.text), ...r.questions, ...r.assumptions.map((a) => a.text), ...r.exclusions.map((a) => a.text), ...r.notes, r.interpretations.rolling.detection.text, r.interpretations.rolling.drainText].join("\n");
    expect(lint.lintText(text)).toEqual([]);
    // negative control: the linter does catch an overclaim
    expect(lint.lintText("This is guaranteed and provably safe").length).toBeGreaterThan(0);
  });
});

describe("findings", () => {
  it("flags redundant and mis-ordered period limits", () => {
    const ids = (o: Record<string, unknown>) => auditLite(numbers(o)).findings.map((f) => f.id);
    expect(ids({ weeklyLimit: "100" })).toContain("LIMIT_ORDER_WEEKLY_BELOW_DAILY");
    expect(ids({ weeklyLimit: "1400" })).toContain("LIMIT_REDUNDANT_WEEKLY");
    expect(ids({ weeklyLimit: "1399.999999" })).not.toContain("LIMIT_REDUNDANT_WEEKLY");
    expect(ids({ monthlyLimit: "4000" })).toContain("LIMIT_REDUNDANT_MONTHLY");
  });
  it("mentions the human-approval gap only when no threshold is given", () => {
    expect(auditLite(numbers()).findings.map((f) => f.id)).toContain("NO_HUMAN_APPROVAL_THRESHOLD");
    expect(auditLite(numbers({ humanApprovalThreshold: "50" })).findings.map((f) => f.id)).not.toContain("NO_HUMAN_APPROVAL_THRESHOLD");
  });
  it("no calendar boundary finding without a period limit", () => {
    expect(auditLite({ schema: LITE_INPUT_SCHEMA, mode: "numbers", decimals: 6, balance: "5" }).findings.map((f) => f.id)).not.toContain("CALENDAR_BOUNDARY_EFFECT");
  });
});

describe("durationText", () => {
  it("renders with bigint arithmetic", () => {
    expect(durationText(0n)).toBe("0 s");
    expect(durationText(61n)).toBe("1 min 1 s");
    expect(durationText(4n * 86_400n + 1n)).toBe("4 d 1 s");
    expect(durationText(90_061n)).toBe("1 d 1 h 1 min 1 s");
  });
});

describe("properties over random configurations (1,000 runs)", () => {
  const amt = fc.bigInt({ min: 1n, max: 5_000n }).map((v) => v.toString());
  const cfg = fc.record({
    balance: fc.bigInt({ min: 0n, max: 20_000n }).map((v) => v.toString()),
    dailyLimit: fc.option(amt, { nil: undefined }),
    weeklyLimit: fc.option(amt, { nil: undefined }),
    monthlyLimit: fc.option(amt, { nil: undefined }),
  });
  const build = (c: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = { schema: LITE_INPUT_SCHEMA, mode: "numbers", decimals: 0 };
    for (const [k, v] of Object.entries(c)) if (v !== undefined) o[k] = v;
    return o;
  };
  it("calendar >= rolling at every horizon; every value <= balance; non-decreasing in the horizon", () => {
    fc.assert(
      fc.property(cfg, (c) => {
        const r = auditLite(build(c));
        const bal = BigInt(c.balance);
        for (const mode of ["rolling", "calendar"] as const) {
          let prev = 0n;
          r.interpretations[mode].horizons.forEach((h, k) => {
            const v = BigInt(h.value.baseUnits);
            const roll = BigInt(r.interpretations.rolling.horizons[k]?.value.baseUnits ?? "0");
            if (v > bal || v < prev || (mode === "calendar" && v < roll)) throw new Error(`violated at ${mode} ${h.label}`);
            prev = v;
          });
        }
        return true;
      }),
      fcParams(50),
    );
  });
  it("tightening the daily limit never raises any rolling or calendar figure", () => {
    fc.assert(
      fc.property(cfg, fc.bigInt({ min: 1n, max: 1000n }), (c, frac) => {
        if (c.dailyLimit === undefined) return true;
        const tight = (BigInt(c.dailyLimit) * frac) / 1000n;
        if (tight === 0n) return true;
        const a = auditLite(build(c));
        const b = auditLite(build({ ...c, dailyLimit: tight.toString() }));
        return (["rolling", "calendar"] as const).every((m) => b.interpretations[m].horizons.every((h, k) => BigInt(h.value.baseUnits) <= BigInt(a.interpretations[m].horizons[k]?.value.baseUnits ?? "0")));
      }),
      fcParams(51),
    );
  });
  it("the report is JSON-safe (no bigint survives) and deterministic", () => {
    fc.assert(
      fc.property(cfg, (c) => {
        const r1 = JSON.stringify(auditLite(build(c)));
        return r1 === JSON.stringify(auditLite(build(c)));
      }),
      fcParams(52),
    );
  });
});
