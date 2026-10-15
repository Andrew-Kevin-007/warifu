// Hand-written critically damped spring (no physics engine, no wasm). stiffness 90, damping 19 ~ 1.2 s settle.

export interface SpringState {
  x: number;
  v: number;
}

export const SPRING_STIFFNESS = 90;
export const SPRING_DAMPING = 19;

/** Semi-implicit Euler with a clamped dt so a stalled tab cannot explode the integrator. */
export function stepSpring(s: SpringState, target: number, dtSeconds: number): SpringState {
  const dt = Math.min(Math.max(dtSeconds, 0), 1 / 20);
  const a = SPRING_STIFFNESS * (target - s.x) - SPRING_DAMPING * s.v;
  const v = s.v + a * dt;
  return { x: s.x + v * dt, v };
}

export function isSettled(s: SpringState, target: number, eps = 1e-3): boolean {
  return Math.abs(s.x - target) < eps && Math.abs(s.v) < eps;
}
