import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BRAND } from '@/lib/brand';
import CertificateBody from '@/components/pages/certificate/CertificateBody';
import { certificateModel } from '@/server/certificate-model';
import { getCertificate, isAddress } from '@/server/public-data';

export const metadata: Metadata = {
  title: `Loss bound certificate | ${BRAND.name}`,
  description: 'The most that can leave a vault in a given time under stated assumptions, calculated from on-chain state and empirically tested.',
};
export const dynamic = 'force-dynamic';

// Exclusions first, then the bound, then the assumptions (docs/16 section 7). LIVE = the kernel re-checked it against the RPC just
// now; RECORDED = the committed bundle's copy; neither = UNVERIFIED with no number.
export default async function Page({ params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!isAddress(vault)) notFound();
  const r = await getCertificate(vault);
  const model =
    r.source === 'UNAVAILABLE'
      ? certificateModel({ vault, mode: 'recorded', cert: null, view: null })
      : certificateModel({ vault, mode: r.source === 'LIVE' ? 'live' : 'recorded', cert: r.data.certificate, view: r.data.view });
  return <CertificateBody model={model} />;
}
