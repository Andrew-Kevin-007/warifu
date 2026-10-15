// Stand-in for app/services/agreement.service (OURS): records what the route writes to its transactions table.
import { edge } from "./edges";

export function createAgreementService(_supabase: unknown) {
  return {
    async createTransaction(params: Record<string, unknown>): Promise<void> {
      edge.recordedTransactions.push(params);
    },
  };
}
