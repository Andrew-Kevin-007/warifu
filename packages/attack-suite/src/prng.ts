// Seeded, deterministic randomness for fixtures and generators (docs/07 §2 "Determinism").
// No Math.random, no Date, no environment: the same seed string always yields the same stream, on every
// machine. The generator is SFC32; its state is derived from sha256 of the seed so any string is a valid seed.
import { sha256Utf8 } from "@symbolon/schemas";

function hexWord(hex: string, index: number): number {
  return parseInt(hex.slice(2 + index * 8, 2 + index * 8 + 8), 16) >>> 0;
}

export class Rng {
  readonly seed: string;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    this.seed = seed;
    const h = sha256Utf8(`symbolon-attack-rng/1:${seed}`);
    this.a = hexWord(h, 0);
    this.b = hexWord(h, 1);
    this.c = hexWord(h, 2);
    this.d = hexWord(h, 3);
    for (let i = 0; i < 15; i++) this.nextU32(); // warm-up
  }

  /** Next unsigned 32-bit integer (SFC32). */
  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform integer in [0, maxExclusive), by rejection sampling (no modulo bias). */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x1_0000_0000) {
      throw new RangeError(`maxExclusive must be an integer in [1, 2^32], got ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
    for (;;) {
      const x = this.nextU32();
      if (x < limit) return x % maxExclusive;
    }
  }

  /** Uniform integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    if (hi < lo) throw new RangeError("range: hi < lo");
    return lo + this.int(hi - lo + 1);
  }

  bool(): boolean {
    return this.int(2) === 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick from an empty list");
    return items[this.int(items.length)] as T;
  }

  /** Fisher-Yates; returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  /** `n` distinct items in random order (n is clamped to the list length). */
  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, Math.min(n, items.length)));
  }

  /** An independent stream for a sub-task, so adding a draw in one place does not shift another. */
  child(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }
}
