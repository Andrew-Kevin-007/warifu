import type { Metadata } from 'next';
import Link from 'next/link';
import { formatBaseUnits } from '@symbolon/schemas';
import { Chip, PageFrame, Section } from '@/components/product/PageFrame';
import { WalletButton } from '@/wallet/WalletButton';
import { kernelCall } from '@/server/kernel-client';

export const metadata: Metadata = { title: 'Dashboard | Symbolon' };
export const dynamic = 'force-dynamic';

interface State {
  profile: string;
  breaker: { halted: boolean; reason: string | null };
  vault: { address: string; chainId: number; balanceBaseUnits: string; decimals: number; paused: boolean };
  pendingReleasesBaseUnits: string;
  policyHash: string;
}

export default async function Page() {
  const r = await kernelCall<State>('/v1/state');
  return (
    <PageFrame eyebrow="Owner" title="Dashboard" lede="Vault balance and breaker state, read from the chain through the kernel. Owner actions are wallet signatures; there is no session.">
      <Section title="Wallet">
        <WalletButton />
      </Section>
      <Section title="Vault">
        {!r.ok ? (
          <div className="sy-card">
            <Chip tone="muted">UNAVAILABLE</Chip>
            <p style={{ marginTop: 8 }}>The kernel could not be reached or is not configured for this deployment ({r.code}). No stale numbers are shown.</p>
          </div>
        ) : (
          <div className="sy-table-wrap">
            <table className="sy-table">
              <tbody>
                <tr><th>Profile</th><td>{r.data.profile}</td></tr>
                <tr><th>Vault</th><td className="sy-mono">{r.data.vault.address}</td></tr>
                <tr><th>Balance (on-chain)</th><td>{formatBaseUnits(r.data.vault.balanceBaseUnits, r.data.vault.decimals)}</td></tr>
                <tr><th>Pending releases</th><td>{formatBaseUnits(r.data.pendingReleasesBaseUnits, r.data.vault.decimals)}</td></tr>
                <tr><th>Vault</th><td>{r.data.vault.paused ? <Chip tone="fail">PAUSED</Chip> : <Chip tone="pass">ACTIVE</Chip>}</td></tr>
                <tr><th>Breaker</th><td>{r.data.breaker.halted ? <Chip tone="fail">HALTED {r.data.breaker.reason ?? ''}</Chip> : <Chip tone="pass">CLOSED</Chip>}</td></tr>
                <tr><th>Policy hash</th><td className="sy-mono">{r.data.policyHash}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Work">
        <ul className="sy-list">
          <li><Link href="/engagements/new">Create an engagement</Link></li>
          <li><Link href="/intents/new">Submit a payment intent</Link></li>
          <li><Link href="/certificate">Loss bound certificate</Link></li>
        </ul>
        <p className="body-text-s" style={{ marginTop: 8 }}>
          A decisions feed needs a list route on the kernel API, which does not exist yet; open a decision from its intent id.
        </p>
      </Section>
    </PageFrame>
  );
}
