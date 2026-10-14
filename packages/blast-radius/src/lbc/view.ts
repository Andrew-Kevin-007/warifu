// UI data contract for `/certificate/[vault]` and the `/judge` card (docs/16 §7), and the generated headline sentence.
// Everything a surface shows is produced HERE from the certificate; no surface types a number (INV-18). The section order
// is part of the contract: exclusions first, then the headline, then the status chip (RT-21: say what is excluded before
// the number). Strings use only the allowed wording of docs/16 §4.3 ("calculated from on-chain state", "empirically
// tested", "assuming A-..."); a test runs the claims linter over everything this module emits.
import { formatBaseUnits } from "@symbolon/schemas";
import type { LossBoundCertificate } from "@symbolon/schemas";
import type { FieldDiff, VerifyResult } from "./verify";

type Cert = LossBoundCertificate;

export const VIEW_SECTION_ORDER = Object.freeze(["exclusions", "headline", "status", "horizons", "assumptions", "validation", "verify", "diff"] as const);

function money(base: string, decimals: number): string {
  return `$${formatBaseUnits(base, decimals)}`;
}

function horizonLabelText(label: string): string {
  return label === "1m" ? "1 minute" : label === "1h" ? "1 hour" : label === "6h" ? "6 hours" : label === "24h" ? "24 h" : label === "48h" ? "48 h" : "7 days";
}

/** "If the AI and the kernel key are both compromised, at most $X can leave in the first 24 h (...)". */
export function headlineSentence(cert: Cert, horizonLabel: Cert["bounds"]["T3c"]["horizons"][number]["label"] = "24h"): string {
  const h = cert.bounds.T3c.horizons.find((x) => x.label === horizonLabel);
  if (h === undefined) throw new RangeError(`the certificate has no ${horizonLabel} horizon`);
  return `If the AI and the kernel key are both compromised, at most ${money(h.value, cert.subject.tokenDecimals)} can leave in the first ${horizonLabelText(h.label)} (calculated from on-chain state at block ${String(cert.asOf.blockNumber)}; assumptions and exclusions below).`;
}

/** The alarmed variant: shown as "if the monitor and guardian work", never as the headline. */
export function alarmedSentence(cert: Cert): string {
  const a = cert.bounds.T3c.alarmed;
  return `Assuming A-MON (the monitor and guardian work) and a detection latency of ${String(a.seconds)} s, at most ${money(a.value, cert.subject.tokenDecimals)} can leave before the vault is paused.`;
}

export function validationSentence(cert: Cert): string {
  const v = cert.validation;
  if (v === null) return "Not validated for this deployment: the numbers are calculated from on-chain state; no empirical trials are attributed to this vault's bytecode.";
  const rate = v.t3Violations === 0 ? `0 violations (95 % upper bound on the violation rate about ${v.upper95})` : `${String(v.t3Violations)} violations (no upper bound claimed)`;
  const code =
    v.codeMatch.status === "MATCH" ? "on-chain code matched to the validated build" : v.codeMatch.status === "MISMATCH" ? "on-chain code does NOT match the validated build" : `validated against build ${v.codeMatch.gitSha}; on-chain code not matched`;
  return `Empirically tested against ${String(v.t3Trials)} trials; ${rate}; best attack found ${money(v.t3BestAttack24h, cert.subject.tokenDecimals)} in 24 h (tightness ${v.tightness}); ${String(v.t1Plans)} red-team plans, ${String(v.t1Losses)} losses; ${code}.`;
}

export interface CertificateView {
  readonly order: typeof VIEW_SECTION_ORDER;
  readonly exclusions: readonly { id: string; text: string }[];
  readonly headline: string;
  readonly alarmed: string;
  readonly status: Cert["validity"] & { readonly label: "VALID" | "STALE" | "UNVERIFIED" | "MISMATCH" };
  readonly horizons: readonly { label: string; seconds: number; valueBaseUnits: string; valueDisplay: string; binding: readonly string[] }[];
  readonly assumptions: Cert["assumptions"];
  readonly notes: readonly string[];
  readonly validation: { readonly sentence: string; readonly block: Cert["validation"] };
  readonly verifyCommand: string;
  readonly diff: readonly FieldDiff[];
  readonly certHash: string;
  readonly asOf: Cert["asOf"];
  readonly vault: string;
}

export function verifyCommand(cert: Cert): string {
  return `pnpm lbc verify ${cert.subject.vault} --rpc <your-own-rpc-url> --artifact <foundry-artifact.json>`;
}

/** @param verification the server-side re-check (or the replay bundle's recorded one); drives the chip and the diff panel */
export function certificateView(cert: Cert, verification?: Pick<VerifyResult, "outcome" | "diffs">): CertificateView {
  const label = verification?.outcome ?? cert.validity.status;
  return {
    order: VIEW_SECTION_ORDER,
    exclusions: cert.exclusions,
    headline: headlineSentence(cert),
    alarmed: alarmedSentence(cert),
    status: { ...cert.validity, label },
    horizons: cert.bounds.T3c.horizons.map((h) => ({ label: h.label, seconds: h.seconds, valueBaseUnits: h.value, valueDisplay: money(h.value, cert.subject.tokenDecimals), binding: h.binding })),
    assumptions: cert.assumptions,
    notes: cert.notes,
    validation: { sentence: validationSentence(cert), block: cert.validation },
    verifyCommand: verifyCommand(cert),
    diff: label === "STALE" || label === "MISMATCH" ? (verification?.diffs ?? []) : [],
    certHash: cert.certHash,
    asOf: cert.asOf,
    vault: cert.subject.vault,
  };
}
