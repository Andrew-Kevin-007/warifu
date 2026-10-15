// Pure still/scene decision (DESIGN_BRIEF 3.6). The hook that reads the browser lives in useDesignCapabilities.
import type { Profile, RenderMode } from '../types';

export interface CapabilityInput {
  reducedMotion: boolean;
  saveData: boolean;
  reducedData: boolean;
  deviceMemory: number | null;
  hardwareConcurrency: number | null;
  webgl2: boolean;
  profile: Profile;
  /** NEXT_PUBLIC_DESIGN_3D === 'off' */
  design3dOff: boolean;
  /** The governor swapped the scene to a Still after repeated slow frames. */
  governorTripped: boolean;
  /** A `webglcontextlost` event was seen. */
  contextLost: boolean;
}

export type StillReason =
  | 'reduced-motion'
  | 'save-data'
  | 'low-end-device'
  | 'no-webgl2'
  | 'challenge-3d-off'
  | 'governor'
  | 'context-lost';

export interface Decision {
  mode: RenderMode;
  reason: StillReason | null;
}

export function decideRenderMode(c: CapabilityInput): Decision {
  if (c.reducedMotion) return { mode: 'still', reason: 'reduced-motion' };
  if (c.saveData || c.reducedData) return { mode: 'still', reason: 'save-data' };
  if (c.deviceMemory !== null && c.hardwareConcurrency !== null && c.deviceMemory <= 4 && c.hardwareConcurrency <= 4) {
    return { mode: 'still', reason: 'low-end-device' };
  }
  if (c.profile === 'challenge' && c.design3dOff) return { mode: 'still', reason: 'challenge-3d-off' };
  if (!c.webgl2) return { mode: 'still', reason: 'no-webgl2' };
  if (c.contextLost) return { mode: 'still', reason: 'context-lost' };
  if (c.governorTripped) return { mode: 'still', reason: 'governor' };
  return { mode: 'scene', reason: null };
}

/** Rolling-mean frame governor. First breach: drop DPR to 1. Second breach: swap to Still. */
export interface GovernorState {
  samples: number[];
  breaches: 0 | 1 | 2;
}

export const GOVERNOR_WINDOW = 60;
export const GOVERNOR_LIMIT_MS = 28;

export function initGovernor(): GovernorState {
  return { samples: [], breaches: 0 };
}

export function pushFrame(g: GovernorState, frameMs: number): GovernorState {
  const samples = g.samples.length >= GOVERNOR_WINDOW ? g.samples.slice(1) : g.samples.slice();
  samples.push(frameMs);
  if (samples.length < GOVERNOR_WINDOW) return { samples, breaches: g.breaches };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  if (mean > GOVERNOR_LIMIT_MS && g.breaches < 2) {
    // restart the window after each breach so the second needs a fresh 60 frames at the lower DPR
    return { samples: [], breaches: (g.breaches + 1) as 1 | 2 };
  }
  return { samples, breaches: g.breaches };
}

/** DPR cap: min(devicePixelRatio, 1.75), 1 once the governor has breached. */
export function capDpr(devicePixelRatio: number, breaches: number): number {
  if (breaches >= 1) return 1;
  return Math.min(Math.max(devicePixelRatio, 1), 1.75);
}
