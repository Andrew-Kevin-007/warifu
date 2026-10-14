import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageFrame, Section, SourceBanner } from '@/components/product/PageFrame';
import { CertificateBody } from '@/components/product/CertificateView';
import { getCertificate, isAddress } from '@/server/public-data';

export const metadata: Metadata = {
  title: 'Loss bound certificate | Symbolon',
  description: 'The most that can leave a vault in a given time under stated assumptions, calculated from on-chain state and empirically tested.',
};
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!isAddress(vault)) notFound();
  const r = await getCertificate(vault);
  return (
    <PageFrame
      eyebrow="Loss bound certificate"
      title="How much can leave this vault?"
      lede="Exclusions come first, then the bound, then the assumptions it rests on. The number is calculated from on-chain state and empirically tested; it says nothing about anything outside the stated model."
    >
      <p className="sy-mono">{vault}</p>
      {r.source === 'UNAVAILABLE' ? (
        <Section title="No certificate available">
          <div className="sy-card">
            <p>{r.reason}.</p>
            <p className="body-text-s" style={{ marginTop: 8 }}>
              Nothing is shown here rather than an unverified number. Certificates are built from the vault&apos;s on-chain state with{' '}
              <span className="sy-mono">pnpm lbc build</span> and checked with <span className="sy-mono">pnpm lbc verify</span>.
            </p>
          </div>
        </Section>
      ) : (
        <>
          <SourceBanner source={r.source} note="The status chip below is the recorded one, not a fresh recomputation." />
          <CertificateBody view={r.data.view} source={r.source} />
        </>
      )}
    </PageFrame>
  );
}
