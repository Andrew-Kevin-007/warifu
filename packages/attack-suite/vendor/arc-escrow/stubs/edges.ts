// The network edges of the vendored arc-escrow validate-work route, in one place (docs/07 §1 "B0": only network edges
// are stubbed). OURS, not Circle's code. The harness sets `edge` before each call of the vendored POST handler and reads
// the recorded Circle calls afterwards. Nothing here decides a release: the decision is the vendored route's
// (`valid && confidence === "HIGH"`), and the only thing a stub adds is what the outside world would answer.

export interface ValidatorOutput {
  readonly valid: boolean;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly reasons: string[];
}

export interface CircleExecutionCall {
  readonly walletId: string;
  readonly contractAddress: string;
  readonly abiFunctionSignature: string;
  readonly abiParameters: unknown[];
}

export interface AgreementRecord {
  readonly id: string;
  readonly circle_contract_id: string;
  readonly beneficiary_wallet_id: string;
  readonly terms: { readonly tasks: string[]; readonly amounts: Array<{ readonly amount: string }> };
  readonly beneficiary_wallet: { readonly circle_wallet_id: string; readonly profiles: { readonly id: string; readonly auth_user_id: string } };
}

export interface Edge {
  user: { id: string } | null;
  agreement: AgreementRecord | null;
  contractAddress: string | null;
  /** SIMULATED stand-in for the gpt-4o call: receives the vendored prompt text and the uploaded file as text. */
  validator: ((prompt: string, uploadedText: string) => ValidatorOutput) | null;
  prompts: string[];
  circleCalls: CircleExecutionCall[];
  recordedTransactions: Array<Record<string, unknown>>;
  statusUpdates: string[];
}

export const edge: Edge = {
  user: null,
  agreement: null,
  contractAddress: null,
  validator: null,
  prompts: [],
  circleCalls: [],
  recordedTransactions: [],
  statusUpdates: [],
};

export function resetEdge(init: Pick<Edge, "user" | "agreement" | "contractAddress" | "validator">): void {
  edge.user = init.user;
  edge.agreement = init.agreement;
  edge.contractAddress = init.contractAddress;
  edge.validator = init.validator;
  edge.prompts = [];
  edge.circleCalls = [];
  edge.recordedTransactions = [];
  edge.statusUpdates = [];
}
