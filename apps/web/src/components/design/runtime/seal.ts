// ReceiptSeal fingerprint: 32 radial ticks, tick length = the byte value of the 32-byte hash.
// One flipped byte changes exactly one tick. Pure; shared by the SVG Still and the three scene.

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export function isHex32(s: string): boolean {
  return HEX32.test(s);
}

/** 32 byte values, or null when the input is not a 32-byte hex digest (the seal then renders hollow). */
export function sealBytes(hash: string | null | undefined): number[] | null {
  if (!hash || !HEX32.test(hash)) return null;
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(parseInt(hash.slice(2 + i * 2, 4 + i * 2), 16));
  return out;
}

export interface Tick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Geometry of the ticks around (cx, cy): from r0 outward, length = minLen + byte/255 * span. */
export function sealTicks(bytes: number[], cx: number, cy: number, r0: number, minLen = 5, span = 17): Tick[] {
  return bytes.map((b, i) => {
    const a = (i / bytes.length) * Math.PI * 2 - Math.PI / 2;
    const len = minLen + (b / 255) * span;
    const f = (n: number) => Number(n.toFixed(2));
    return {
      x1: f(cx + Math.cos(a) * r0),
      y1: f(cy + Math.sin(a) * r0),
      x2: f(cx + Math.cos(a) * (r0 + len)),
      y2: f(cy + Math.sin(a) * (r0 + len)),
    };
  });
}
