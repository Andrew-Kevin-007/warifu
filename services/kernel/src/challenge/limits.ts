// Abuse controls for the public challenge (docs/15 section 4, RT-04): per-IP sliding windows keyed on a SALTED hash (never the raw
// address, no fingerprinting), a global concurrency gate with a bounded queue, and the degrade ladder L0..L3 (section 10). Pure
// and clock-injected, so every limit has a boundary test.
import { createHash } from "node:crypto";

/** 0x + sha256(ip || salt), hex (the column's format, migration 0003). The only form of an address that is stored or logged. */
export function ipHash(ip: string, salt: string): string {
  return `0x${createHash("sha256").update(ip, "utf8").update("\u0000", "utf8").update(salt, "utf8").digest("hex")}`;
}

export interface LimitDecision {
  readonly ok: boolean;
  /** Seconds until the oldest hit leaves the window (only meaningful when !ok). */
  readonly retryAfterSeconds: number;
}

/** At most `limit` hits per `windowMs` per key. Memory is bounded: expired hits and empty keys are dropped on every call. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 50_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || windowMs < 1) throw new RangeError("limit and window must be positive");
  }

  /** Record one hit for `key` if it fits; otherwise report when it will. */
  hit(key: string): LimitDecision {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const live = (this.hits.get(key) ?? []).filter((x) => x > cutoff);
    if (live.length >= this.limit) {
      this.hits.set(key, live);
      const oldest = live[0] ?? t;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000)) };
    }
    live.push(t);
    this.hits.set(key, live);
    if (this.hits.size > this.maxKeys) this.sweep(cutoff);
    return { ok: true, retryAfterSeconds: 0 };
  }

  private sweep(cutoff: number): void {
    for (const [k, v] of this.hits) if (v.every((x) => x <= cutoff)) this.hits.delete(k);
    // still over the cap: a flood of distinct keys; drop the oldest keys (Map keeps insertion order)
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next();
      if (first.done === true) break;
      this.hits.delete(first.value);
    }
  }
}

/** Per-IP free-form limits: 5 per hour and 30 per day; one-click 60 per hour (docs/15 section 4). */
export interface ChallengeLimits {
  readonly freeFormHour: SlidingWindow;
  readonly freeFormDay: SlidingWindow;
  readonly oneClickHour: SlidingWindow;
}

export function defaultLimits(now: () => number): ChallengeLimits {
  return {
    freeFormHour: new SlidingWindow(5, 3_600_000, now),
    freeFormDay: new SlidingWindow(30, 86_400_000, now),
    oneClickHour: new SlidingWindow(60, 3_600_000, now),
  };
}

export type GateResult = { readonly ok: true; release(): void } | { readonly ok: false; readonly reason: "QUEUE_FULL" };

/** At most `maxRunning` attempts at once; up to `maxQueue` wait; beyond that the caller answers 429 with Retry-After. */
export class ConcurrencyGate {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly maxRunning = 3,
    private readonly maxQueue = 20,
  ) {}

  get load(): { running: number; queued: number } {
    return { running: this.running, queued: this.waiting.length };
  }

  async acquire(): Promise<GateResult> {
    if (this.running < this.maxRunning) {
      this.running += 1;
      return { ok: true, release: this.releaser() };
    }
    if (this.waiting.length >= this.maxQueue) return { ok: false, reason: "QUEUE_FULL" };
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return { ok: true, release: this.releaser() };
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next !== undefined) next(); // hand the slot straight to the next waiter: `running` stays the same
      else this.running -= 1;
    };
  }
}

export type DegradeLevel = "L0" | "L1" | "L2";

export interface DegradeInput {
  /** CHALLENGE_ENABLED. false = kill switch: replay only. */
  readonly enabled: boolean;
  /** Spent today / daily budget, in parts per 10,000 (integer math). */
  readonly budgetUsedBp: number;
  /** A configured, priced model and key exist. Without one, free-form is off (L1) by construction. */
  readonly llmConfigured: boolean;
  readonly backendHealthy: boolean;
}

/** L0 everything · L1 one-click + benign only · L2 replay only (docs/15 section 10; L3 is a static fallback outside this process). */
export function degradeLevel(i: DegradeInput): DegradeLevel {
  if (!i.enabled || !i.backendHealthy || i.budgetUsedBp >= 10_000) return "L2";
  if (i.budgetUsedBp >= 8_000 || !i.llmConfigured) return "L1";
  return "L0";
}

/** Plain-text attempt input rules (docs/15 section 4): UTF-8 text, at most 4096 bytes, no NUL. */
export const MAX_ATTEMPT_BYTES = 4096;
export function checkAttemptText(text: unknown): { ok: true; text: string } | { ok: false; code: "NOT_TEXT" | "EMPTY" | "TOO_LARGE" | "NUL" | "INVALID_UTF8" } {
  if (typeof text !== "string") return { ok: false, code: "NOT_TEXT" };
  if (text.trim() === "") return { ok: false, code: "EMPTY" };
  if (text.includes("\u0000")) return { ok: false, code: "NUL" };
  if (text.includes("�")) return { ok: false, code: "INVALID_UTF8" };
  if (Buffer.byteLength(text, "utf8") > MAX_ATTEMPT_BYTES) return { ok: false, code: "TOO_LARGE" };
  return { ok: true, text };
}
