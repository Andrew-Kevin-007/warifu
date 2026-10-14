// Stand-in for lib/utils/smart-contract-platform-client (OURS): the Circle Smart Contract Platform edge.
import { edge } from "./edges";

export const circleContractSdk = {
  async getContract(_args: { id: string }): Promise<{ data: { contract: { contractAddress: string | null } } }> {
    return { data: { contract: { contractAddress: edge.contractAddress } } };
  },
};
