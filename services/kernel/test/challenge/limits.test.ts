import { describe, expect, it } from "vitest";
import { ConcurrencyGate, MAX_ATTEMPT_BYTES, SlidingWindow, checkAttemptText, defaultLimits, degradeLevel, ipHash } from "../../src/challenge/limits";

describe("ipHash", () => {
  it("is salted, stable, and never the address", () => {
    const a = ipHash("203.0.113.9", "salt-one");
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(ipHash("203.0.113.9", "salt-one"));
    expect(a).not.toBe(ipHash("203.0.113.9", "salt-two"));
    expect(a).not.toBe(ipHash("203.0.113.10", "salt-one"));
    expect(a).not.toContain("203");
  });
});

describe("SlidingWindow", () => {
  it("allows exactly `limit` hits per window, then reports Retry-After, then recovers", () => {
    let t = 1_000_000;
    const w = new SlidingWindow(5, 3_600_000, () => t);
    for (let i = 0; i < 5; i++) expect(w.hit("k").ok).toBe(true);
    const denied = w.hit("k");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSeconds).toBe(3600);
    t += 1_800_000;
    expect(w.hit("k")).toMatchObject({ ok: false, retryAfterSeconds: 1800 });
    t += 1_800_001;
    expect(w.hit("k").ok).toBe(true);
  });

  it("keys are independent and a flood of distinct keys stays bounded", () => {
    const w = new SlidingWindow(1, 1000, () => 5, 100);
    expect(w.hit("a").ok).toBe(true);
    expect(w.hit("b").ok).toBe(true);
    expect(w.hit("a").ok).toBe(false);
    for (let i = 0; i < 1000; i++) w.hit(`flood-${String(i)}`);
    expect((w as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(100);
  });

  it("the default free-form limits are 5 an hour and 30 a day; one-click 60 an hour", () => {
    let t = 0;
    const l = defaultLimits(() => t);
    for (let i = 0; i < 5; i++) expect(l.freeFormHour.hit("ip").ok).toBe(true);
    expect(l.freeFormHour.hit("ip").ok).toBe(false);
    for (let i = 0; i < 30; i++) expect(l.freeFormDay.hit("ip").ok).toBe(true);
    expect(l.freeFormDay.hit("ip").ok).toBe(false);
    for (let i = 0; i < 60; i++) expect(l.oneClickHour.hit("ip").ok).toBe(true);
    expect(l.oneClickHour.hit("ip").ok).toBe(false);
    t += 3_600_001;
    expect(l.oneClickHour.hit("ip").ok).toBe(true);
  });

  it("rejects nonsense configuration", () => {
    expect(() => new SlidingWindow(0, 1000, () => 0)).toThrow();
    expect(() => new SlidingWindow(1, 0, () => 0)).toThrow();
  });
});

describe("ConcurrencyGate", () => {
  it("runs 3, queues up to 20, refuses the 24th, and hands slots on in order", async () => {
    const g = new ConcurrencyGate(3, 20);
    const held = [];
    for (let i = 0; i < 3; i++) {
      const r = await g.acquire();
      expect(r.ok).toBe(true);
      held.push(r);
    }
    const order: number[] = [];
    const waiters = Array.from({ length: 20 }, (_, i) => g.acquire().then((r) => { order.push(i); return r; }));
    await Promise.resolve();
    expect(g.load).toEqual({ running: 3, queued: 20 });
    expect(await g.acquire()).toEqual({ ok: false, reason: "QUEUE_FULL" });
    const first = held[0];
    if (first?.ok === true) first.release();
    const r0 = await waiters[0];
    expect(r0?.ok).toBe(true);
    expect(g.load).toEqual({ running: 3, queued: 19 });
    expect(order).toEqual([0]);
    if (first?.ok === true) first.release(); // releasing twice must not free a second slot
    expect(g.load).toEqual({ running: 3, queued: 19 });
  });

  it("frees capacity when nothing waits", async () => {
    const g = new ConcurrencyGate(1, 0);
    const a = await g.acquire();
    expect(await g.acquire()).toEqual({ ok: false, reason: "QUEUE_FULL" });
    if (a.ok) a.release();
    expect(g.load).toEqual({ running: 0, queued: 0 });
    expect((await g.acquire()).ok).toBe(true);
  });
});

describe("degradeLevel (docs/15 section 10)", () => {
  const base = { enabled: true, budgetUsedBp: 0, llmConfigured: true, backendHealthy: true };
  it("L0 normally, L1 at 80 % of budget or without an LLM, L2 at 100 %, when disabled, or when the backend is down", () => {
    expect(degradeLevel(base)).toBe("L0");
    expect(degradeLevel({ ...base, budgetUsedBp: 7_999 })).toBe("L0");
    expect(degradeLevel({ ...base, budgetUsedBp: 8_000 })).toBe("L1");
    expect(degradeLevel({ ...base, llmConfigured: false })).toBe("L1");
    expect(degradeLevel({ ...base, budgetUsedBp: 10_000 })).toBe("L2");
    expect(degradeLevel({ ...base, enabled: false })).toBe("L2");
    expect(degradeLevel({ ...base, backendHealthy: false })).toBe("L2");
  });
});

describe("checkAttemptText", () => {
  it("accepts plain text up to 4096 bytes and refuses empty, NUL, invalid UTF-8, oversize and non-strings", () => {
    expect(checkAttemptText("Invoice 1\nTotal 10 USDC")).toEqual({ ok: true, text: "Invoice 1\nTotal 10 USDC" });
    expect(checkAttemptText("a".repeat(MAX_ATTEMPT_BYTES))).toMatchObject({ ok: true });
    expect(checkAttemptText("a".repeat(MAX_ATTEMPT_BYTES + 1))).toEqual({ ok: false, code: "TOO_LARGE" });
    expect(checkAttemptText("é".repeat(2049))).toEqual({ ok: false, code: "TOO_LARGE" }); // bytes, not characters
    expect(checkAttemptText("   ")).toEqual({ ok: false, code: "EMPTY" });
    expect(checkAttemptText("a\u0000b")).toEqual({ ok: false, code: "NUL" });
    expect(checkAttemptText("a�b")).toEqual({ ok: false, code: "INVALID_UTF8" });
    expect(checkAttemptText(42)).toEqual({ ok: false, code: "NOT_TEXT" });
  });
});
