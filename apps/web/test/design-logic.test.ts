import { describe, expect, it } from 'vitest';
import { quantize, ratioBp } from '../src/components/design/runtime/ratio';
import { clamp01, countAt, formatCount, isCount, shortHash, windowed } from '../src/components/design/runtime/format';
import { isSettled, stepSpring } from '../src/components/design/runtime/spring';
import {
  capDpr,
  decideRenderMode,
  initGovernor,
  pushFrame,
  type CapabilityInput,
} from '../src/components/design/runtime/capabilities';
import {
  assemblyPose,
  cellGrammar,
  isScored,
  modeChip,
  provenanceMode,
  tokenPoseFor,
  validityChip,
} from '../src/components/design/runtime/states';
import {
  edgeAmplitudes,
  fracturePolyline,
  halfPath,
  STEP_AMPLITUDES,
  STILL_DISC,
  tokenPaths,
} from '../src/components/design/three/fracture';

const base: CapabilityInput = {
  reducedMotion: false,
  saveData: false,
  reducedData: false,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  webgl2: true,
  profile: 'app',
  design3dOff: false,
  governorTripped: false,
  contextLost: false,
};

describe('ratio / quantize', () => {
  it('ratioBp(1n,3n) is 3333 basis points', () => {
    expect(ratioBp('1', '3')).toBe(3333);
  });
  it('is exact for bigint-sized amounts and never goes through Number', () => {
    const big = '123456789012345678901234567890';
    expect(ratioBp(big, big)).toBe(10000);
    expect(ratioBp('0', big)).toBe(0);
  });
  it('clamps over-balance values and rejects non-integers or zero totals', () => {
    expect(ratioBp('200', '100')).toBe(10000);
    expect(ratioBp('1.5', '100')).toBeNull();
    expect(ratioBp('5', '0')).toBeNull();
    expect(ratioBp('-5', '10')).toBeNull();
  });
  it('quantize is monotone over 0..10000 and spans 0..20', () => {
    let prev = -1;
    for (let bp = 0; bp <= 10000; bp += 25) {
      const q = quantize(bp);
      expect(q).toBeGreaterThanOrEqual(prev);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(20);
      prev = q;
    }
    expect(quantize(0)).toBe(0);
    expect(quantize(10000)).toBe(20);
    expect(quantize(Number.NaN)).toBe(0);
    expect(quantize(-3)).toBe(0);
    expect(quantize(99999)).toBe(20);
  });
});

describe('format', () => {
  it('formats integer counts and refuses non-counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(null)).toBe('—');
    expect(formatCount(1.5)).toBe('—');
    expect(isCount(-1)).toBe(false);
    expect(isCount(7)).toBe(true);
  });
  it('count-up final step equals the prop exactly (never an approximation)', () => {
    const to = 17;
    expect(countAt(0, to, 1)).toBe(to);
    expect(countAt(0, to, 5)).toBe(to);
    expect(countAt(3, to, 0)).toBe(3);
    expect(formatCount(countAt(0, to, 1))).toBe(new Intl.NumberFormat('en-US').format(to));
  });
  it('window / clamp / shortHash', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(windowed(0.5, 0.3, 0.7)).toBeCloseTo(0.5);
    expect(windowed(0.1, 0.3, 0.7)).toBe(0);
    expect(windowed(0.9, 0.3, 0.7)).toBe(1);
    const h = '0x' + 'ab'.repeat(32);
    expect(shortHash(h)).toMatch(/^0xabababab…abababab$/);
    expect(shortHash('0x12')).toBe('0x12');
  });
});

describe('spring', () => {
  it('settles on target without overshoot beyond 2 % (critically damped)', () => {
    let s = { x: 0, v: 0 };
    let maxX = 0;
    for (let i = 0; i < 400; i++) {
      s = stepSpring(s, 1, 1 / 60);
      maxX = Math.max(maxX, s.x);
    }
    expect(maxX).toBeLessThan(1.02);
    expect(isSettled(s, 1)).toBe(true);
  });
  it('a stalled frame cannot explode the integrator', () => {
    const s = stepSpring({ x: 0, v: 0 }, 1, 30);
    expect(Math.abs(s.x)).toBeLessThan(2);
  });
});

describe('capabilities: still vs scene selection', () => {
  it('uses a scene when everything allows it', () => {
    expect(decideRenderMode(base)).toEqual({ mode: 'scene', reason: null });
  });
  it.each([
    [{ reducedMotion: true }, 'reduced-motion'],
    [{ saveData: true }, 'save-data'],
    [{ reducedData: true }, 'save-data'],
    [{ deviceMemory: 4, hardwareConcurrency: 4 }, 'low-end-device'],
    [{ webgl2: false }, 'no-webgl2'],
    [{ profile: 'challenge' as const, design3dOff: true }, 'challenge-3d-off'],
    [{ contextLost: true }, 'context-lost'],
    [{ governorTripped: true }, 'governor'],
  ])('falls back to a Still for %j', (patch, reason) => {
    const d = decideRenderMode({ ...base, ...patch });
    expect(d.mode).toBe('still');
    expect(d.reason).toBe(reason);
  });
  it('challenge profile may use scenes when the 3D flag is not off', () => {
    expect(decideRenderMode({ ...base, profile: 'challenge', design3dOff: false }).mode).toBe('scene');
  });
  it('governor: first breach drops DPR, second breach asks for a Still', () => {
    let g = initGovernor();
    for (let i = 0; i < 60; i++) g = pushFrame(g, 40);
    expect(g.breaches).toBe(1);
    expect(capDpr(2, g.breaches)).toBe(1);
    for (let i = 0; i < 60; i++) g = pushFrame(g, 40);
    expect(g.breaches).toBe(2);
    expect(capDpr(3, 0)).toBe(1.75);
  });
  it('governor stays quiet at 60 fps', () => {
    let g = initGovernor();
    for (let i = 0; i < 300; i++) g = pushFrame(g, 16.6);
    expect(g.breaches).toBe(0);
  });
});

describe('state -> chip / pose mapping', () => {
  it('validity chips carry a word, a glyph and a pose', () => {
    expect(validityChip('VALID')).toMatchObject({ label: 'Valid', glyph: 'joined', pose: 'seated' });
    expect(validityChip('STALE')).toMatchObject({ glyph: 'offset', pose: 'mismatch' });
    expect(validityChip('UNVERIFIED')).toMatchObject({ glyph: 'open', pose: 'hollow' });
    expect(validityChip('MISMATCH').className).toContain('loss');
  });
  it('mode chips: recorded and simulated are frozen, live is not', () => {
    expect(modeChip('live').frozen).toBe(false);
    expect(modeChip('recorded').frozen).toBe(true);
    expect(modeChip('simulated').frozen).toBe(true);
    expect(modeChip('fixture').label).toBe('Fixture');
  });
  it('recordedOutputs === false maps to SIMULATED, never RECORDED', () => {
    expect(provenanceMode('recorded', false)).toBe('simulated');
    expect(provenanceMode('live', false)).toBe('simulated');
    expect(provenanceMode('recorded', true)).toBe('recorded');
    expect(provenanceMode('recorded', null)).toBe('recorded');
    expect(provenanceMode('demo', false)).toBe('demo');
  });
  it('unknown / null validity is a hollow token (no claim)', () => {
    expect(tokenPoseFor(null)).toBe('hollow');
    expect(tokenPoseFor('VALID')).toBe('seated');
  });
  it('cell grammar: a loss is a loss, not-built wins over outcome, N/A is not scored', () => {
    expect(cellGrammar('LOSS', 'run')).toEqual({ kind: 'loss', label: 'Loss' });
    expect(cellGrammar('BLOCKED', 'not-built').kind).toBe('notbuilt');
    expect(cellGrammar('N/A', 'run').kind).toBe('na');
    expect(cellGrammar(null, 'run').kind).toBe('notrun');
    expect(isScored('loss')).toBe(true);
    expect(isScored('na')).toBe(false);
    expect(isScored('notbuilt')).toBe(false);
  });
  it('assembly never seats an unchecked fit', () => {
    const all = { approach: 1, scan: 1, seat: 1 };
    expect(assemblyPose('unknown', all)).toBe('hollow');
    expect(assemblyPose('match', all)).toBe('seated');
    expect(assemblyPose('mismatch', all)).toBe('mismatch');
    expect(assemblyPose('match', { approach: 1, scan: 0.4, seat: 0 })).toBe('scan');
    expect(assemblyPose('match', { approach: 0, scan: 0, seat: 0 })).toBe('apart');
  });
});

describe('fracture geometry', () => {
  it('has seven steps (14 points) and is orthogonal', () => {
    const poly = fracturePolyline(STILL_DISC, STEP_AMPLITUDES);
    expect(poly.length).toBe(STEP_AMPLITUDES.length * 2);
    for (let i = 1; i < poly.length; i++) {
      const dx = Math.abs(poly[i].x - poly[i - 1].x);
      const dy = Math.abs(poly[i].y - poly[i - 1].y);
      expect(dx === 0 || dy === 0).toBe(true);
    }
  });
  it('polyline end points lie on the disc', () => {
    const poly = fracturePolyline(STILL_DISC, STEP_AMPLITUDES);
    for (const p of [poly[0], poly[poly.length - 1]]) {
      const d = Math.hypot(p.x - STILL_DISC.cx, p.y - STILL_DISC.cy);
      expect(d).toBeCloseTo(STILL_DISC.r, 5);
    }
  });
  it('matching edge equals the proposal edge; mismatch moves exactly steps 2 and 5', () => {
    const m = edgeAmplitudes(false);
    expect(m).toEqual([...STEP_AMPLITUDES]);
    const x = edgeAmplitudes(true);
    const moved = x.map((v, i) => (v !== m[i] ? i : -1)).filter((i) => i >= 0);
    expect(moved).toEqual([1, 4]);
    const same = tokenPaths(false);
    const diff = tokenPaths(true);
    expect(same.left).toBe(diff.left);
    expect(same.right).not.toBe(diff.right);
  });
  it('half paths are closed and use the right arc direction', () => {
    const poly = fracturePolyline(STILL_DISC, STEP_AMPLITUDES);
    expect(halfPath(STILL_DISC, poly, 'left')).toMatch(/ 1 (1|0) \d/); // sweep flag 1 (clockwise on screen)
    expect(halfPath(STILL_DISC, poly, 'right')).toMatch(/A120 120 0 \d 0 /);
    expect(halfPath(STILL_DISC, poly, 'left').endsWith('Z')).toBe(true);
  });
});
