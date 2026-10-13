// Loss Bound Certificate (docs/16): build, verify, view. WP-34 (owner: BLAST). The viem ChainReader is a separate export
// (`@symbolon/blast-radius/lbc/viem-reader`) so consumers that only need the types do not load it.
export { assembleCertificate, attachPublisher, buildFromReader } from "./build";
export type { AssembleOptions, BuildFromReaderOptions } from "./build";
export { computeBody, computeBounds, assertVaultState } from "./body";
export type { Body, BodyOptions } from "./body";
export { computeConfigHash, computeEngagementsDigest, deriveEngagementInputs, countsTowardBound, digestEntries } from "./digest";
export { matchArtifact, parseArtifact } from "./code-match";
export type { CodeMatchResult, ParsedArtifact } from "./code-match";
export { classifyRequirement, computeWeakEvidenceExposure, parseTermsDocument } from "./terms";
export type { EngagementExposure, EvidenceStrength, ParsedTerms, WeakEvidenceResult } from "./terms";
export { ValidationResultsSchema, buildValidation, decimalCeil, decimalFloor, upper95 } from "./validation";
export type { ValidationResults } from "./validation";
export {
  ALGORITHM_ID,
  ALGORITHM_VERSION,
  ASSUMPTIONS,
  DEFAULT_CONFIRMATIONS,
  DEFAULT_DETECTION_LATENCY_SECONDS_NUMBER,
  DEFAULT_FRESHNESS_SECONDS,
  EXCLUSIONS,
} from "./texts";
export { EXIT_CODES, diffJson, toValidity, verifyCertificate } from "./verify";
export type { FieldDiff, LatestSummary, VerifyMode, VerifyOptions, VerifyOutcome, VerifyReason, VerifyResult } from "./verify";
export { VIEW_SECTION_ORDER, alarmedSentence, certificateView, headlineSentence, validationSentence, verifyCommand } from "./view";
export type { CertificateView } from "./view";
export { ChainReadError, LbcError } from "./types";
export type { BlockHeader, BlockRef, ChainReader, EngagementState, Hex, LbcErrorCode, VaultState } from "./types";
