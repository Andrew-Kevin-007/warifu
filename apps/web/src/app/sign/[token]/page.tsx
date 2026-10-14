import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/product/PageFrame';
import { EngagementStatus } from '@/components/product/EngagementStatus';
import type { EngagementViewData } from '@/components/product/EngagementStatus';
import { kernelCall } from '@/server/kernel-client';

export const metadata: Metadata = { title: 'Sign engagement | Symbolon', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

// The link token is the engagement id. The kernel verifies the EIP-712 signature against the engagement's payee address,
// so possession of the link grants nothing beyond the ability to submit a signature that must verify.
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = token.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) notFound();
  const r = await kernelCall<{ engagement: EngagementViewData }>(`/v1/engagements/${id}`);
  if (!r.ok) {
    return (
      <PageFrame eyebrow="Payee" title="This signing link is not available">
        <p>The engagement could not be found or the kernel could not be reached.</p>
      </PageFrame>
    );
  }
  return (
    <PageFrame eyebrow="Payee" title="Review and sign the engagement terms" lede="Check the terms hash and the typed data below, then sign with the wallet of the payee address named in the engagement.">
      <EngagementStatus e={r.data.engagement} fixedRole="payee" />
    </PageFrame>
  );
}
