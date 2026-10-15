// Stand-in for lib/utils/developer-controlled-wallets-client (OURS): the Circle API call is replaced by a recorder; the
// harness applies the escrow contract's own withdraw() semantics (vendor/arc-escrow/original/RefundProtocol.sol).
import { edge } from "./edges";
import type { CircleExecutionCall } from "./edges";

export const circleDeveloperSdk = {
  async createContractExecutionTransaction(args: CircleExecutionCall & { fee?: unknown }): Promise<{ data: { id: string } }> {
    edge.circleCalls.push({ walletId: args.walletId, contractAddress: args.contractAddress, abiFunctionSignature: args.abiFunctionSignature, abiParameters: args.abiParameters });
    return { data: { id: `local-tx-${edge.circleCalls.length}` } };
  },
};
