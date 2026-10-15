import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { Chip, PageFrame, Section } from '@/components/product/PageFrame';
import { kernelCall } from '@/server/kernel-client';

export const metadata: Metadata = { title: `Pilot | ${BRAND.name}`, description: 'Real-use figures from pilot tenants only.' };
export const dynamic = 'force-dynamic';

interface PilotStats {
  tenants?: number;
  payments?: { txHash: string; amountBaseUnits: string; network: string }[];
}

export default async function Page() {
  const r = await kernelCall<PilotStats>('/v1/pilot-stats');
  return (
    <PageFrame
      eyebrow="Pilot"
      title="Real use, counted honestly"
      lede="This page counts pilot tenants only. Demo tenants, challenge attempts, house attackers and self-payments between our own wallets are never counted here."
    >
      <Section title="Figures">
        {r.ok ? (
          <div className="sy-card">
            <p><Chip>LIVE</Chip></p>
            <p style={{ marginTop: 8 }}>{r.data.tenants ?? 0} pilot tenant(s); {r.data.payments?.length ?? 0} recorded payment(s).</p>
          </div>
        ) : (
          <div className="sy-card">
            <p><Chip tone="muted">NO DATA</Chip></p>
            <p style={{ marginTop: 8 }}>
              No pilot statistics are published yet. When a pilot payment exists, it appears here with an explorer link to the transaction. Until then this page states no number.
            </p>
          </div>
        )}
      </Section>
    </PageFrame>
  );
}
