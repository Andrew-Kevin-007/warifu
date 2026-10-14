// Baseline B1 (docs/07 §1, §6): OUR reimplementation of the release-on-model-output pattern. It is not Circle's
// code and is labelled that way in every report ("pattern reimplementation, ours"). The pattern:
//   an LLM validator returns {valid, confidence}; the agent releases iff valid && confidence === "HIGH";
//   no timestamp enforcement, no payee registration, no idempotency (a retry re-submits), no caps,
//   no evidence gating, no terms logic. The payment goes to the address in the document.
//
// The validator here is a deterministic REFERENCE validator, SIMULATED: no model is called (no API key, no
// paid calls; AGENTS.md §0.12). It stands in for "a reasonable validator prompt" by flagging what a careful
// prompt would flag, so B1 blocks the easy attacks (docs/07 §6: "keep it intentionally faithful, not a
// strawman"). Its rules are published in the report and in REFERENCE_VALIDATOR_RULES. It reads the SAME
// extraction the Symbolon target reads (`run.a`), exactly as the pattern reads the model's output.
import type { ExtractedInvoice } from "@symbolon/schemas";
import { inspectUntrusted } from "@symbolon/schemas";
import { milestoneId } from "../world";
import type { Action, DecideInput, FaultOutcome, Target, TargetDecision } from "./target";
import type { FaultStep } from "../types";
import type { SimState } from "./state";

export const B1_PROVENANCE =
  "B1: pattern reimplementation, ours (not Circle's code). Validator is a deterministic reference stand-in for an LLM validator (SIMULATED, no model call).";

export const REFERENCE_VALIDATOR_RULES = [
  "V1 invalid when docType is not INVOICE (a careful validator rejects credit notes and statements)",
  "V2 invalid when the extraction has no parsed amount",
  "V3 invalid when the extraction has neither a wallet address nor a payee name",
  "V4 confidence LOW when an anomaly of kind INSTRUCTION_IN_DOC or HIDDEN_CHARS is flagged (obvious prompt injection)",
  "V5 confidence LOW when the decimal separator is ambiguous",
] as const;

export interface ValidatorOutput {
  readonly valid: boolean;
  readonly confidence: "HIGH" | "LOW";
  readonly rule: string | null;
}

export function referenceValidator(a: ExtractedInvoice): ValidatorOutput {
  if (a.docType !== "INVOICE") return { valid: false, confidence: "LOW", rule: "V1" };
  if (a.amount.parsedBaseUnits === null) return { valid: false, confidence: "LOW", rule: "V2" };
  if (a.payee.walletAddress === null && a.payee.legalName === null) return { valid: false, confidence: "LOW", rule: "V3" };
  if (a.anomalies.some((x) => x.code === "INSTRUCTION_IN_DOC" || x.code === "HIDDEN_CHARS")) return { valid: true, confidence: "LOW", rule: "V4" };
  if (a.amount.decimalSeparatorGuess === "ambiguous") return { valid: true, confidence: "LOW", rule: "V5" };
  return { valid: true, confidence: "HIGH", rule: null };
}

const decline = (note: string): TargetDecision => ({ action: "REJECT", release: null, checksFired: [], reasons: ["B1_VALIDATOR_DECLINED"], note, heldByUnimplementedChecks: false });

export const b1Target: Target = {
  id: "b1",
  label: "B1 (naive release-on-model-output, ours)",
  provenance: B1_PROVENANCE,

  decide({ state, view, step, run }: DecideInput): TargetDecision {
    const out = referenceValidator(run.a);
    if (!(out.valid && out.confidence === "HIGH")) return decline(`validator ${out.rule ?? ""}: valid=${out.valid} confidence=${out.confidence}`);
    // The pattern pays the address in the document; with none, the vendor master (name on file) is the fallback.
    const name = run.a.payee.legalName === null ? null : inspectUntrusted(run.a.payee.legalName).trim().toLowerCase();
    const payee = run.a.payee.walletAddress ?? (name !== null && name === state.world.payeeLabel.toLowerCase() ? state.world.payee : null);
    if (payee === null) return decline("no payee address and no vendor on file");
    const amount = run.a.amount.parsedBaseUnits;
    if (amount === null) return decline("no amount"); // unreachable after V2; keeps the type honest
    const action: Action = "RELEASE";
    return {
      action,
      release: {
        milestoneId: step.milestoneSlug === null ? null : milestoneId(state.world, step.milestoneSlug),
        payee,
        amount: BigInt(amount),
        time: view.now,
        invoiceReceivedAt: step.doc.receivedAt,
        termsBasis: "none",
        clockAnchor: null,
        ownerApproved: false,
      },
      checksFired: [],
      reasons: [],
      note: "validator said valid/HIGH; paid the document's address and amount",
      heldByUnimplementedChecks: false,
    };
  },

  fault(step: FaultStep, _state: SimState): FaultOutcome {
    switch (step.fault) {
      case "relay-timeout":
        return { status: "ran", reason: "B1 records the payment when it submits the transaction", signals: ["ledger says paid, chain shows no transfer (phantom paid record)"] };
      case "provider-timeout":
        return { status: "ran", reason: "B1 has no idempotency key; a retry submits a new payment", signals: [] };
      case "agent-false-claim":
        return { status: "ran", reason: "B1 books what the agent reports", signals: ["records a payment the agent claims with no transaction (fictitious entry)"] };
      case "usdc-blocklist-revert":
        return { status: "ran", reason: "B1 has no screening and does not decode the revert", signals: ["transfer reverted after the decision; B1 state still says paid and gas is lost"] };
      default: {
        const never: never = step.fault;
        throw new RangeError(`unknown fault ${String(never)}`);
      }
    }
  },

  cannotRun(step): string | null {
    switch (step.kind) {
      case "submit":
      case "fault":
        return null;
      case "vault-call":
        return "B1 has no contract-bounded signer to compromise (applicability.json: N/A)";
      case "approval-render":
      case "flood":
        return "B1 has no approval gate (applicability.json: N/A)";
      default: {
        const never: never = step;
        throw new RangeError(`unknown step ${JSON.stringify(never)}`);
      }
    }
  },

  unimplementedChecks: () => [],
};
