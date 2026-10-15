// Baseline B2 (docs/07 §1): "reasonable hardening" a competent team would add in a day on top of the B1 pattern.
// Written to be read by a skeptical judge; it is deliberately NOT a strawman and not a copy of Symbolon:
//   H1 strict schema validation of the model output (invoice, amount parsed and positive, USD/USDC, no ambiguity);
//   H2 recipient allowlist (an address must be a known payee of the tenant, else decline);
//   H3 per-transaction and rolling-24h caps enforced in application logic (Agent-Wallet style);
//   H4 exact duplicate-invoice-number check (a number already paid is declined).
// What it does NOT have (and what Symbolon's lanes add): no signed engagement (the amount is the document's), no
// milestone binding or amount-due logic, no evidence gating, no time window, no terms logic, no near-duplicate or
// velocity rules, no on-chain payee binding (the same key holder enforces the caps). Published so others can improve it.
import { inspectUntrusted } from "@symbolon/schemas";
import type { ExtractedInvoice } from "@symbolon/schemas";
import { epochSecondsFromIso } from "@symbolon/schemas";
import { milestoneId, WORLD, usdc } from "../world";
import { referenceValidator } from "./b1";
import type { SimState } from "./state";
import type { DecideInput, FaultOutcome, Target, TargetDecision } from "./target";
import type { FaultStep } from "../types";

export const B2_PROVENANCE =
  "B2: reasonable hardening, ours (strict output schema, payee allowlist, per-tx and daily caps, exact duplicate-number check) on top of the B1 pattern; validator is the same deterministic SIMULATED stand-in as B1.";

export const B2_CONTROLS = [
  "H1 strict schema: docType INVOICE, parsed amount > 0, currency USD/USDC, no ambiguous separator, wallet or vendor name present",
  "H2 recipient allowlist: the paid address must belong to a registered payee of the tenant",
  "H3 caps in app logic: per-transaction cap and rolling 24 h cap (the sandbox policy values)",
  "H4 exact duplicate-invoice-number check against numbers already paid",
] as const;

const PER_TX_CAP = usdc(25);
const DAILY_CAP = usdc(60);
const DAY = 86_400n;
const ALLOWLIST: ReadonlySet<string> = new Set(Object.values(WORLD).map((w) => w.payee.toLowerCase()));

const decline = (rule: string, note: string): TargetDecision => ({ action: "REJECT", release: null, checksFired: [], reasons: [`B2_${rule}`], note, heldByUnimplementedChecks: false });

/** H1: the shape and sanity of the model's output, nothing about whether the payment is owed. */
function schemaProblem(a: ExtractedInvoice): string | null {
  if (a.docType !== "INVOICE") return "docType is not INVOICE";
  if (a.amount.parsedBaseUnits === null || BigInt(a.amount.parsedBaseUnits) <= 0n) return "no positive parsed amount";
  if (a.amount.decimalSeparatorGuess === "ambiguous") return "ambiguous decimal separator";
  const cur = inspectUntrusted(a.amount.currencyPrinted).trim().toUpperCase();
  if (!["USD", "USDC", "$", ""].includes(cur)) return `currency ${cur} is not USD/USDC`;
  if (a.payee.walletAddress === null && a.payee.legalName === null) return "neither wallet nor vendor name";
  return null;
}

export const b2Target: Target = {
  id: "b2",
  label: "B2 (reasonable hardening, ours)",
  provenance: B2_PROVENANCE,

  decide({ state, view, step, run }: DecideInput): TargetDecision {
    const a = run.a;
    const model = referenceValidator(a); // the pattern's gate: valid && confidence HIGH
    if (!(model.valid && model.confidence === "HIGH")) return decline("VALIDATOR", `validator ${model.rule ?? ""}: valid=${model.valid} confidence=${model.confidence}`);
    const bad = schemaProblem(a);
    if (bad !== null) return decline("SCHEMA", bad);
    const name = a.payee.legalName === null ? null : inspectUntrusted(a.payee.legalName).trim().toLowerCase();
    const payee = a.payee.walletAddress ?? (name !== null && name === state.world.payeeLabel.toLowerCase() ? state.world.payee : null);
    if (payee === null || !ALLOWLIST.has(payee.toLowerCase())) return decline("ALLOWLIST", "recipient is not on the allowlist");
    const amount = BigInt(a.amount.parsedBaseUnits as string);
    if (amount > PER_TX_CAP) return decline("PER_TX_CAP", "amount exceeds the per-transaction cap");
    const now = epochSecondsFromIso(view.now);
    const last24h = state.releases.filter((r) => epochSecondsFromIso(r.time) > now - DAY).reduce((s, r) => s + r.amount, 0n);
    if (last24h + amount > DAILY_CAP) return decline("DAILY_CAP", "amount would exceed the rolling 24 h cap");
    const number = inspectUntrusted(a.invoiceNumber);
    if (state.releases.some((r) => r.invoiceNumber === number)) return decline("DUPLICATE_NUMBER", "this exact invoice number was already paid");
    return {
      action: "RELEASE",
      release: {
        milestoneId: step.milestoneSlug === null ? null : milestoneId(state.world, step.milestoneSlug),
        payee,
        amount,
        time: view.now,
        invoiceReceivedAt: step.doc.receivedAt,
        termsBasis: "none",
        clockAnchor: null,
        ownerApproved: false,
      },
      checksFired: [],
      reasons: [],
      note: "validator HIGH and H1-H4 passed: paid the document's address and amount",
      heldByUnimplementedChecks: false,
    };
  },

  fault(step: FaultStep, _state: SimState): FaultOutcome {
    // Same architecture as B1 (it records the payment at submission): only the duplicate-number check differs.
    switch (step.fault) {
      case "relay-timeout":
        return { status: "ran", reason: "B2 records the payment when it submits the transaction (as B1)", signals: ["ledger says paid, chain shows no transfer (phantom paid record)"] };
      case "provider-timeout":
        return { status: "ran", reason: "a retry carries the same invoice number, which H4 declines", signals: [] };
      case "agent-false-claim":
        return { status: "ran", reason: "B2 books what the agent reports (as B1)", signals: ["records a payment the agent claims with no transaction (fictitious entry)"] };
      case "usdc-blocklist-revert":
        return { status: "ran", reason: "B2 has no screening and does not decode the revert (as B1)", signals: ["transfer reverted after the decision; B2 state still says paid and gas is lost"] };
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
        return "B2's caps are enforced by the same key holder, so there is no compromised-signer-with-bounds notion (applicability.json: N/A)";
      case "approval-render":
      case "flood":
        return "B2 has no approval gate (applicability.json: N/A)";
      default: {
        const never: never = step;
        throw new RangeError(`unknown step ${JSON.stringify(never)}`);
      }
    }
  },

  unimplementedChecks: () => [],
};
