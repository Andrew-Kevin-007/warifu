// Geometry-only ratios. Money never becomes a JS number for display (INV-10): an amount string is
// converted to basis points with bigint arithmetic, and only that unitless bp is used for shapes.

const UINT = /^\d{1,78}$/;

/** value/total as basis points in [0, 10000], or null when either side is not a base-unit integer or total is 0. */
export function ratioBp(value: string, total: string): number | null {
  if (!UINT.test(value) || !UINT.test(total)) return null;
  const t = BigInt(total);
  if (t === 0n) return null;
  const v = BigInt(value);
  const bp = (v * 10000n) / t;
  return Number(bp > 10000n ? 10000n : bp);
}

/** Bucket 0..20 (5 % steps) for CSS `data-ratio`; monotone in bp. */
export function quantize(bp: number): number {
  if (!Number.isFinite(bp)) return 0;
  const c = Math.min(10000, Math.max(0, bp));
  return Math.round(c / 500);
}
