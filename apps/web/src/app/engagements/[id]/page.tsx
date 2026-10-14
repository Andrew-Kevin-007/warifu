import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/product/PageFrame';
import { EngagementStatus } from '@/components/product/EngagementStatus';
import type { EngagementViewData } from '@/components/product/EngagementStatus';
import { kernelCall } from '@/server/kernel-client';

export const metadata: Metadata = { title: `Engagement | ${BRAND.name}` };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^0x[0-9a-f]{64}$/.test(id)) notFound();
  const r = await kernelCall<{ engagement: EngagementViewData }>(`/v1/engagements/${id}`);
  if (!r.ok) {
    return (
      <PageFrame eyebrow="Engagement" title="Engagement unavailable">
        <p>{r.status === 404 ? 'No such engagement for this tenant.' : 'The kernel could not be reached, so nothing is shown rather than a stale status.'}</p>
      </PageFrame>
    );
  }
  return (
    <PageFrame eyebrow="Engagement" title="Engagement terms and signatures" lede="Both parties sign the same typed data. The payee can sign from the link /sign/<engagement id>.">
      <EngagementStatus e={r.data.engagement} fixedRole={null} />
    </PageFrame>
  );
}
