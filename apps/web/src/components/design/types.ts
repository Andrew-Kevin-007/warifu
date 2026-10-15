// Shared vocabulary of the design kit. Presentational only: no fetching, no wallet, no secrets.
import type { ReactNode } from 'react';

/** Where the content on screen came from. `fixture` is the preview-only label. */
export type Mode = 'live' | 'recorded' | 'simulated' | 'demo' | 'fixture';

/** Build profile. `challenge` is the attackable origin: Stills only unless the 3D flag allows scenes. */
export type Profile = 'app' | 'challenge' | 'local';

/** Certificate / receipt validity (docs/16). */
export type Validity = 'VALID' | 'STALE' | 'UNVERIFIED';

/** Cell outcome vocabulary of the real attack-matrix/1 file (plus the N/A the schema renders for applicable:false). */
export type CellOutcome = 'BLOCKED' | 'ESCALATED' | 'HELD' | 'LOSS' | 'NOOP' | 'NOT_RUN' | 'N/A';

/** Poses of the tally token. `hollow` means no claim is made. */
export type TokenPose = 'apart' | 'approach' | 'scan' | 'seated' | 'mismatch' | 'hollow';

/** A node the lane fills (Untrusted text goes through the lane's UntrustedText, never through the kit). */
export type Slot = ReactNode;

/** Rendering decision for a canvas scene. */
export type RenderMode = 'still' | 'scene';
