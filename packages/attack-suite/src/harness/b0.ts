// Baseline B0 (docs/07 §1): the ACTUAL release-decision path of circlefin/arc-escrow, vendored at a pinned commit
// (vendor/arc-escrow/COMMIT) and EXECUTED, not described. The decision is the vendored `validate-work` route:
//   build the validator prompt from the agreement's tasks -> model answers {valid, confidence, reasons}
//   -> release iff `valid && confidence === "HIGH"` -> `withdraw(uint256[])` on the escrow contract.
// What is stubbed is only the network edge (vendor/arc-escrow/stubs/, VENDOR.md lists each one): the model call is a
// deterministic SIMULATED validator (no key, no paid call), Supabase/Circle answers are in-memory, and the escrow
// contract's own `withdraw()` semantics (RefundProtocol.sol: pays `amount - withdrawnAmount` to the payee fixed at
// `pay()` time, so a repeat pays 0) are applied here after the route has made its call.
//
// Mapping of our world onto its job/deliverable API (published, docs/07 §1, applicability.json):
//   the signed engagement milestone  = one escrow agreement whose beneficiary and amount are FIXED at creation;
//   the invoice document              = the deliverable (uploaded as the "file" the validator inspects);
//   the milestone description         = the agreement's task (the requirement in the validator prompt).
// Consequence, by the pattern's design and reported as such: no document can change WHO is paid or HOW MUCH (both
// are the agreement's), so payee-swap and amount attacks cannot lose money here; what the pattern lacks is evidence
// gating, a time window, idempotency in the route (the contract provides it), caps, terms logic, and any check that
// the deliverable is the one the agreement is about.
import { hashJcs, formatBaseUnits, inspectUntrusted } from "@symbolon/schemas";
import type { ExtractedInvoice } from "@symbolon/schemas";
import { POST } from "../../vendor/arc-escrow/linked/validate-work.route";
import { edge, resetEdge } from "../../vendor/arc-escrow/stubs/edges";
import type { ValidatorOutput } from "../../vendor/arc-escrow/stubs/edges";
import { milestoneId, WORLD, worldMilestone } from "../world";
import type { FaultStep, ScenarioId } from "../types";
import { referenceValidator } from "./b1";
import type { SimState } from "./state";
import type { DecideInput, FaultOutcome, Target, TargetDecision } from "./target";

export const B0_PROVENANCE =
  "B0: the validate-work release path of circlefin/arc-escrow vendored at a pinned commit and executed; only network edges are stubbed; the model call is a deterministic SIMULATED validator (no key, no paid call); the escrow contract's withdraw() semantics are applied by the harness.";

/** What the vendored route did for one (agreement, deliverable, read). */
export interface B0RouteResult {
  readonly httpStatus: number;
  readonly error: string | null;
  /** The Circle call the route made to release funds, or null when it declined. */
  readonly withdraw: { readonly walletId: string; readonly abiFunctionSignature: string; readonly abiParameters: unknown[] } | null;
  readonly validator: ValidatorOutput;
  /** The agreement's task text was in the prompt the vendored route built (sanity). */
  readonly promptHasTask: boolean;
}

export interface B0Input {
  readonly scenarioId: ScenarioId;
  readonly milestoneSlug: string;
  readonly docLabel: string;
  readonly docText: string;
  readonly read: ExtractedInvoice;
}

const CONTRACT_ADDRESS = `0x${"b0".repeat(20)}`; // placeholder escrow address (SIMULATED)

/** The SIMULATED model: the same reference rules as B1's validator (V1-V5), in the vendored prompt's answer shape. */
export function simulatedModel(read: ExtractedInvoice): ValidatorOutput {
  const v = referenceValidator(read);
  if (!v.valid) return { valid: false, confidence: "LOW", reasons: [`rule ${v.rule ?? ""}`] };
  if (v.confidence === "LOW") return { valid: true, confidence: "MEDIUM", reasons: [`rule ${v.rule ?? ""}`] };
  return { valid: true, confidence: "HIGH", reasons: [] };
}

export function b0Key(i: B0Input): string {
  return hashJcs({ s: i.scenarioId, m: i.milestoneSlug, t: i.docText, a: i.read });
}

/** Execute the vendored route once. Sequential by design: the stubs share one `edge`. */
export async function runVendoredRoute(i: B0Input): Promise<B0RouteResult> {
  const world = WORLD[i.scenarioId];
  const ms = worldMilestone(world, i.milestoneSlug);
  const agreementId = `agreement/${i.scenarioId}/${i.milestoneSlug}`;
  resetEdge({
    user: { id: "depositor" },
    contractAddress: CONTRACT_ADDRESS,
    validator: () => simulatedModel(i.read),
    agreement: {
      id: agreementId,
      circle_contract_id: `contract/${agreementId}`,
      beneficiary_wallet_id: `wallet/${world.payee}`,
      terms: { tasks: [ms.description], amounts: [{ amount: formatBaseUnits(ms.amount, 6) }] },
      beneficiary_wallet: { circle_wallet_id: `wallet/${world.payee}`, profiles: { id: "beneficiary", auth_user_id: "beneficiary" } },
    },
  });
  const form = new FormData();
  form.set("file", new Blob([i.docText], { type: "text/plain" }), `${i.docLabel.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
  form.set("circleContractId", `contract/${agreementId}`);
  const res = await POST(new Request("http://b0.local/api/contracts/validate-work", { method: "POST", body: form }));
  const body = res.body as { error?: string };
  const call = edge.circleCalls[0];
  const prompt = edge.prompts[0] ?? "";
  const validator = simulatedModel(i.read);
  return {
    httpStatus: res.status,
    error: typeof body.error === "string" ? body.error : null,
    withdraw: call === undefined ? null : { walletId: call.walletId, abiFunctionSignature: call.abiFunctionSignature, abiParameters: call.abiParameters },
    validator,
    promptHasTask: prompt.includes(ms.description),
  };
}

const table = new Map<string, B0RouteResult>();

/** Run the vendored route for every input not yet seen (async; the harness's decide() is synchronous and only looks up). */
export async function prepareB0(inputs: Iterable<B0Input>): Promise<void> {
  for (const i of inputs) {
    const k = b0Key(i);
    if (!table.has(k)) table.set(k, await runVendoredRoute(i));
  }
}

export function b0Lookup(i: B0Input): B0RouteResult | undefined {
  return table.get(b0Key(i));
}

const decline = (note: string): TargetDecision => ({ action: "REJECT", release: null, checksFired: [], reasons: ["B0_ROUTE_DECLINED"], note, heldByUnimplementedChecks: false });

/** RefundProtocol.withdraw: pays `amount - withdrawnAmount` to the payee fixed at pay() time; what is already out stays out. */
function withdrawnOf(state: SimState, slug: string): bigint {
  return state.releases.reduce((s, r) => (r.milestoneSlug === slug ? s + r.amount : s), 0n);
}

export const b0Target: Target = {
  id: "b0",
  label: "B0 (circlefin/arc-escrow release path, pinned, edges stubbed)",
  provenance: B0_PROVENANCE,

  decide({ state, view, step, run }: DecideInput): TargetDecision {
    if (view.noEngagement || step.milestoneSlug === null) {
      return decline("no escrow agreement exists for this vendor: validate-work needs the circleContractId of an agreement whose beneficiary was fixed at creation");
    }
    const input: B0Input = { scenarioId: state.world.scenarioId, milestoneSlug: step.milestoneSlug, docLabel: step.doc.docLabel, docText: inspectUntrusted(step.doc.text), read: run.a };
    const r = b0Lookup(input);
    if (r === undefined) throw new RangeError(`B0 was not prepared for ${step.stepId}/${run.label} (call prepareB0 first)`);
    if (r.withdraw === null) return decline(`validate-work answered HTTP ${r.httpStatus}${r.error === null ? "" : `: ${r.error}`}; validator ${r.validator.valid ? "valid" : "invalid"}/${r.validator.confidence}`);
    const ms = worldMilestone(state.world, step.milestoneSlug);
    const remaining = ms.amount - (withdrawnOf(state, step.milestoneSlug) > ms.amount ? ms.amount : withdrawnOf(state, step.milestoneSlug));
    if (remaining <= 0n) {
      return { action: "NOOP", release: null, checksFired: [], reasons: [], note: "validate-work called withdraw(); the contract pays 0 because payment.withdrawnAmount already equals payment.amount", heldByUnimplementedChecks: false };
    }
    return {
      action: "RELEASE",
      release: {
        milestoneId: milestoneId(state.world, step.milestoneSlug),
        payee: state.world.payee, // fixed at agreement creation, not read from the document
        amount: remaining, // fixed at agreement creation, not read from the document
        time: view.now,
        invoiceReceivedAt: step.doc.receivedAt,
        termsBasis: "none",
        clockAnchor: null,
        ownerApproved: false,
      },
      checksFired: [],
      reasons: [],
      note: "validator valid/HIGH: the route called withdraw(uint256[]); the contract pays the agreement's beneficiary the agreement's amount",
      heldByUnimplementedChecks: false,
    };
  },

  fault(step: FaultStep, _state: SimState): FaultOutcome {
    // Modelled from the upstream webhook route (app/api/webhooks/circle/route.ts @ the pinned commit), not executed.
    switch (step.fault) {
      case "relay-timeout":
        return { status: "ran", reason: "the route stores the transaction and sets the agreement PENDING; CLOSED is set only by a COMPLETE webhook, so a lost relay leaves no 'paid' record", signals: [] };
      case "provider-timeout":
        return { status: "ran", reason: "the route has no idempotency key, but a second withdraw() pays 0 (RefundProtocol.withdrawnAmount), so a retry cannot pay twice", signals: [] };
      case "agent-false-claim":
        return { status: "ran", reason: "B0 has no agent-narrated ledger: its rows are written by the route after the SDK answers, and the status only by webhooks", signals: [] };
      case "usdc-blocklist-revert":
        return { status: "ran", reason: "a reverted withdraw() arrives as a FAILED webhook which sets the agreement back to LOCKED; no paid state remains (gas is spent by the sender)", signals: [] };
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
        return "B0 has no contract-bounded signer to compromise (applicability.json: N/A)";
      case "approval-render":
      case "flood":
        return "B0 has no approval gate (applicability.json: N/A)";
      default: {
        const never: never = step;
        throw new RangeError(`unknown step ${JSON.stringify(never)}`);
      }
    }
  },

  unimplementedChecks: () => [],
};
