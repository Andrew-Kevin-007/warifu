// Fixed wording of the certificate (docs/16 §4, DEC-012). Assumptions and exclusions are constants of the algorithm
// version, not free text: changing one changes `algorithm.version` and therefore every certHash. The wording follows
// the language rules of §4.3 (nothing here may trip `pnpm claims:lint`; a test runs the linter over every string).
import type { AssumptionId } from "@symbolon/schemas";

export const ALGORITHM_ID = "symbolon-bounds" as const;
/** Bump on ANY change to bounds semantics, digest forms, or the texts below. */
export const ALGORITHM_VERSION = "1.0.0" as const;
/** docs/16 §2.2: 60 s poll + pause tx + finality margin. A published parameter, not a measurement. */
export const DEFAULT_DETECTION_LATENCY_SECONDS_NUMBER = 300;
export const DEFAULT_FRESHNESS_SECONDS = 86_400;
/** Default confirmations behind the latest block when the node has no `finalized` tag (V-29). */
export const DEFAULT_CONFIRMATIONS = 2;

export const ASSUMPTIONS: readonly { readonly id: AssumptionId; readonly text: string }[] = Object.freeze([
  { id: "A-EVID", text: "Evidence collectors report truthfully about the world (weak evidence is highlighted, not solved)." },
  { id: "A-MON", text: "The monitor and guardian are running; this applies to the alarmed figure only." },
  { id: "A-OWNER-KEY", text: "The owner key is not compromised (threat model T4); a multisig or hardware key is recommended." },
  { id: "A-TOKEN", text: "The settlement token behaves as an honest ERC-20: no issuer freeze, upgrade or depeg events." },
  { id: "A-CHAIN", text: "The chain is live and final at the stated block; the verifier's RPC endpoint is honest (use your own)." },
  { id: "A-MODEL", text: "The contract's behaviour matches the modelled semantics in docs/08 section 4. This is a calculation plus differential trials, not a formal verification; a bug outside the model is not covered." },
]);

export const EXCLUSIONS: readonly { readonly id: string; readonly text: string }[] = Object.freeze([
  { id: "X-OWNER-KEY", text: "Owner key compromise (T4): loss equals the vault balance." },
  { id: "X-PAYEE-KEY", text: "Payee key compromise receiving authorized funds (T5)." },
  { id: "X-TOKEN-ISSUER", text: "Issuer actions on the token: blocklisting, freezing, upgrade or depeg." },
  { id: "X-CHAIN", text: "Chain halt or deep reorganization." },
  { id: "X-RPC", text: "A dishonest RPC endpoint on the verifier's side." },
  { id: "X-CONTRACT-BUGS", text: "Contract bugs outside the modelled semantics." },
  { id: "X-WORK-QUALITY", text: "Quality or delivery of the work: the certificate bounds who, how much and how fast, not whether the work was good." },
  { id: "X-AVAILABILITY", text: "Availability: with a stolen kernel signer the 64-slot release ring can be filled with dust to block legitimate payments for up to 24 h. This is not a fund-loss path." },
  { id: "X-OTHER-TOKENS", text: "Tokens other than the configured settlement token." },
]);

export const NOTE_OWNER_APPROVALS = "Outstanding owner approvals (signed and unused) are owner-authorized amounts and are not added to the bound.";
export const NOTE_BURST = "No hourly cap is set: the whole daily cap can leave within the first minute (rolling caps limit volume, not rate).";
export const NOTE_VALIDATION_NONE = "No validation results are attached: the numbers are calculated from on-chain state and are not validated for this deployment.";
export const NOTE_POLICY_LOOSER = "POLICY_LOOSER_THAN_VAULT: the supplied kernel policy allows more than the vault does, so the policy layer is decorative; the vault limits above are what holds when the kernel signer is stolen.";
export const NOTE_TERMS_UNVERIFIED = "TERMS_UNVERIFIED: terms for at least one active engagement were missing or did not match the on-chain termsHash; its weak-evidence exposure counts as its full cap.";
