// View model for /pilot. There is no combined figure, no target and no progress: those props do not exist.
import type { Mode, Slot } from '../../design/types';

export type PilotNetwork = 'testnet' | 'mainnet';

export interface NetworkSummary {
  network: PilotNetwork;
  businesses: number;
  payments: number;
  payees: number;
  /** lane MoneyAmount, for this network only */
  value: Slot;
}

export interface PilotPayment {
  /** structural key (hash prefix or index), never untrusted text */
  key: string;
  network: PilotNetwork;
  /** lane ExplorerLink */
  link: Slot;
  late?: boolean;
}

export interface PilotModel {
  mode: Mode;
  /** the honest baseline at Tameion start */
  baseline: { users: number; value: Slot };
  networks: NetworkSummary[];
  payments: PilotPayment[];
  /** "as of" stamp, text */
  freezeStamp?: string;
  consent?: Slot;
}
