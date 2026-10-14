// Integer-count formatting only. Money, bounds and rates are never formatted here (lane MoneyAmount / ClaimsNumber).

const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Grouped integer, e.g. 1,234. Non-counts return the em dash (never a guessed number). */
export function formatCount(n: number | null | undefined): string {
  return isCount(n) ? NF.format(n) : '—';
}

/** Middle-truncate a hex digest for display; the full value stays in the DOM via the caller's title/copy. */
export function shortHash(hex: string, head = 10, tail = 8): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** Eased progress helper used by CountUp: returns the displayed integer for t in [0,1]. Final step is exact. */
export function countAt(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  if (t <= 0) return from;
  return Math.round(from + (to - from) * t);
}

/** Fixed-point 0..1 clamp used by scroll-linked scenes. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Piecewise window: 0 before a, 1 after b, linear between. */
export function windowed(p: number, a: number, b: number): number {
  if (b <= a) return p >= b ? 1 : 0;
  return clamp01((p - a) / (b - a));
}
