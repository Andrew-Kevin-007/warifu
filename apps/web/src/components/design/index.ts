// Barrel for the design kit. Presentational only: no fetching, no wallet, no secrets, no storage.
export { default as DesignRoot } from './DesignRoot';
export type { CellOutcome, Mode, Profile, RenderMode, Slot, TokenPose, Validity } from './types';

export { ratioBp, quantize } from './runtime/ratio';
export { formatCount, isCount, shortHash, countAt, clamp01, windowed } from './runtime/format';
export { stepSpring, isSettled } from './runtime/spring';
export { decideRenderMode, capDpr, initGovernor, pushFrame } from './runtime/capabilities';
export { validityChip, modeChip, provenanceMode, tokenPoseFor, cellGrammar, isScored, assemblyPose } from './runtime/states';
export { sealBytes, sealTicks, isHex32 } from './runtime/seal';
export { LatticeFocusProvider, useLatticeFocus } from './runtime/LatticeFocus';

export { default as Appear } from './primitives/Appear';
export { default as CountUp } from './primitives/CountUp';
export { default as Glyph } from './primitives/Glyph';
export { ModeTag, ValidityPill, MiniTag } from './primitives/Tag';
export { FractureRule, NodeFrame, FractureWord, Eyebrow, Plate, PositionsList, Stat, LinkButton } from './primitives/Layout';

export { default as TallyTokenStill } from './stills/TallyTokenStill';
export { default as ReceiptSealStill } from './stills/ReceiptSealStill';
export type { SealState } from './stills/ReceiptSealStill';
export { default as VaultDrumStill } from './stills/VaultDrumStill';
export type { DrumCap } from './stills/VaultDrumStill';
export { default as HorizonStepsStill } from './stills/HorizonStepsStill';
export type { HorizonStep } from './stills/HorizonStepsStill';
export { default as AttackLatticeGrid, LatticeLegend } from './stills/AttackLatticeGrid';
export type { LatticeModel, LatticeCell, LatticeTarget } from './stills/AttackLatticeGrid';
export { TetrapodStill, FooterTetrapodsStill } from './stills/Tetrapods';
export { default as HeroStill } from './stills/HeroStill';
