import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import PilotBody from '@/components/pages/pilot/PilotBody';
import type { NetworkSummary, PilotModel } from '@/components/pages/pilot/types';
import { money } from '@/server/attack-lab-model';
import { kernelCall } from '@/server/kernel-client';

export const metadata: Metadata = { title: `Pilot | ${BRAND.name}`, description: 'Real-use figures from pilot tenants only, by network.' };
export const dynamic = 'force-dynamic';

interface PilotStats {
  stats: { network: string; businesses: number; releases: number; payees: number; valueBaseUnits: string }[];
}

// Pilot tenants only (tenants.kind = 'pilot', INV-17): demo tenants, challenge attempts, house attackers and self-payments between our
// own wallets are never counted. Testnet and mainnet are separate plates and are never added together.
export default async function Page() {
  const r = await kernelCall<PilotStats>('/v1/pilot-stats');
  const by = new Map((r.ok ? r.data.stats : []).map((s) => [s.network, s]));
  const net = (network: 'testnet' | 'mainnet'): NetworkSummary => {
    const s = by.get(network);
    return { network, businesses: s?.businesses ?? 0, payments: s?.releases ?? 0, payees: s?.payees ?? 0, value: money(s?.valueBaseUnits ?? '0') };
  };
  const model: PilotModel = {
    mode: r.ok ? 'live' : 'recorded',
    baseline: { users: 0, value: money('0') },
    networks: [net('testnet'), net('mainnet')],
    // Per-payment explorer links need transaction hashes, which this view does not publish yet: the rail stays empty rather than invented.
    payments: [],
  };
  return <PilotBody model={model} />;
}
