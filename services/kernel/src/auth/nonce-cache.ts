// Replay protection for service tokens (RT-31, SEC-14). A nonce is remembered until its token's `exp` has passed,
// so within a token's lifetime a second use is refused. The cache is bounded and FAILS CLOSED: when it is full of
// unexpired nonces, new tokens are refused (a flood costs availability, never authority). In-process only: the
// kernel runs as one instance, and tokens issued before the process booted are refused outright (see token.ts).
export type NonceResult = "OK" | "REPLAYED" | "FULL";

export class NonceCache {
  readonly #seen = new Map<string, number>();
  readonly #capacity: number;

  constructor(capacity = 100_000) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError("capacity must be a positive integer");
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#seen.size;
  }

  /** Remember `nonce` until `expSec` (epoch seconds). Atomic: JS is single-threaded between the check and the set. */
  checkAndInsert(nonce: string, expSec: number, nowSec: number): NonceResult {
    const existing = this.#seen.get(nonce);
    if (existing !== undefined && existing > nowSec) return "REPLAYED";
    if (this.#seen.size >= this.#capacity) this.#purge(nowSec);
    if (existing === undefined && this.#seen.size >= this.#capacity) return "FULL";
    this.#seen.set(nonce, expSec);
    return "OK";
  }

  #purge(nowSec: number): void {
    for (const [n, exp] of this.#seen) if (exp <= nowSec) this.#seen.delete(n);
  }
}
