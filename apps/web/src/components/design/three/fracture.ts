// The step fracture of the tally token: an orthogonal polyline, seven steps. The matching edge of the
// other half is the SAME polyline; the mismatch variant moves steps 2 and 5 by +/-0.07 R.
// Pure and shared by the SVG Still and the three.js geometry (no three import here).

export const STEP_AMPLITUDES = [0.12, -0.08, 0.16, -0.12, 0.08, -0.16, 0.12] as const;
export const MISMATCH_SHIFT = 0.07;

export interface Pt {
  x: number;
  y: number;
}

export interface Disc {
  cx: number;
  cy: number;
  r: number;
}

/** Amplitudes (in units of R) of the right half's matching edge. */
export function edgeAmplitudes(mismatch: boolean): number[] {
  const a = [...STEP_AMPLITUDES] as number[];
  if (mismatch) {
    a[1] += MISMATCH_SHIFT;
    a[4] -= MISMATCH_SHIFT;
  }
  return a;
}

/** Orthogonal polyline from the disc top to its bottom (points strictly on or inside the disc). */
export function fracturePolyline(d: Disc, amps: readonly number[]): Pt[] {
  const n = amps.length;
  const top = d.cy - d.r;
  const h = (2 * d.r) / n;
  const chord = (dx: number) => Math.sqrt(Math.max(0, d.r * d.r - dx * dx));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const dx = amps[i] * d.r;
    const x = d.cx + dx;
    if (i === 0) pts.push({ x, y: d.cy - chord(dx) });
    else pts.push({ x, y: top + h * i });
    if (i === n - 1) pts.push({ x, y: d.cy + chord(dx) });
    else pts.push({ x, y: top + h * (i + 1) });
  }
  return pts;
}

function angleOf(d: Disc, p: Pt): number {
  return Math.atan2(p.y - d.cy, p.x - d.cx);
}

/** Closed path for one half. side 'left' keeps the part left of the polyline. */
export function halfPath(d: Disc, poly: Pt[], side: 'left' | 'right'): string {
  const first = poly[0];
  const last = poly[poly.length - 1];
  // Left half: arc from the bottom point back to the top via the left side = clockwise on screen (sweep 1).
  const a0 = angleOf(d, last);
  const a1 = angleOf(d, first);
  let sweepAngle = side === 'left' ? a1 - a0 : a0 - a1; // clockwise travel for left, counter-clockwise for right
  while (sweepAngle < 0) sweepAngle += Math.PI * 2;
  while (sweepAngle >= Math.PI * 2) sweepAngle -= Math.PI * 2;
  const large = sweepAngle > Math.PI ? 1 : 0;
  const sweep = side === 'left' ? 1 : 0;
  const f = (n: number) => Number(n.toFixed(2));
  const body = poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)} ${f(p.y)}`).join(' ');
  return `${body} A${f(d.r)} ${f(d.r)} 0 ${large} ${sweep} ${f(first.x)} ${f(first.y)} Z`;
}

/** Shared geometry for both halves in the Still's 360 x 320 box. */
export const STILL_DISC: Disc = { cx: 180, cy: 160, r: 120 };

export function tokenPaths(mismatch: boolean, disc: Disc = STILL_DISC): { left: string; right: string } {
  const leftPoly = fracturePolyline(disc, STEP_AMPLITUDES);
  const rightPoly = fracturePolyline(disc, edgeAmplitudes(mismatch));
  return { left: halfPath(disc, leftPoly, 'left'), right: halfPath(disc, rightPoly, 'right') };
}

/** Just the polyline as an open path (the seam), for scan lines and tick positions. */
export function seamPath(disc: Disc = STILL_DISC): string {
  const poly = fracturePolyline(disc, STEP_AMPLITUDES);
  return poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${Number(p.x.toFixed(2))} ${Number(p.y.toFixed(2))}`).join(' ');
}

/** Polygon (x,y pairs) of a half for geometry builders: polyline then a 64-gon arc along the disc. */
export function halfPolygon(disc: Disc, poly: Pt[], side: 'left' | 'right', arcSegments = 64): Pt[] {
  const first = poly[0];
  const last = poly[poly.length - 1];
  const a0 = angleOf(disc, last);
  const a1 = angleOf(disc, first);
  const out: Pt[] = [...poly];
  // travel from last back to first along the circle; left = clockwise on screen (increasing atan2 in y-down coords)
  let delta = side === 'left' ? a1 - a0 : a0 - a1;
  while (delta < 0) delta += Math.PI * 2;
  const dir = side === 'left' ? 1 : -1;
  for (let i = 1; i < arcSegments; i++) {
    const a = a0 + dir * (delta * i) / arcSegments;
    out.push({ x: disc.cx + disc.r * Math.cos(a), y: disc.cy + disc.r * Math.sin(a) });
  }
  return out;
}
