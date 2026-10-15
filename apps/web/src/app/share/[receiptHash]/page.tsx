import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame, Section, SourceBanner, Chip } from '@/components/product/PageFrame';
import { getReceipt, isHex32 } from '@/server/public-data';
import { niceTry } from '@/lib/nice-try';

export const metadata: Metadata = {
  title: `A receipt worth sharing | ${BRAND.name}`,
  description: 'One decision, its reason code and its receipt hash.',
};
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ receiptHash: string }> }) {
  const hash = (await params).receiptHash.toLowerCase();
  if (!isHex32(hash)) notFound();
  const r = await getReceipt(hash);
  if (r.source === 'UNAVAILABLE') {
    return (
      <PageFrame eyebrow="Share" title="No public receipt here" lede="This receipt is not available. It may not be public, or it may not exist; nothing is shown rather than a guess.">
        <Section title="Receipt hash">
          <p className="sy-mono">{hash}</p>
          <p className="body-text-s">
            <Link href={`/audit/${hash}`}>Try the verifier</Link> if you hold the receipt bytes yourself.
          </p>
        </Section>
      </PageFrame>
    );
  }
  const d = r.data.signed.receipt.decision;
  const n = niceTry({ verdict: d.verdict, reasons: d.reasons, receiptHash: hash });
  return (
    <PageFrame eyebrow="Share" title={n.line} lede="Templated from the decision's reason code. It is copy, not evidence: the receipt below is the evidence.">
      <SourceBanner source={r.source} />
      <Section title="The decision">
        <p>
          <Chip tone={d.verdict === 'RELEASE' ? 'pass' : 'fail'}>{d.verdict}</Chip>{' '}
          {n.reasonCode !== null ? <span className="sy-mono">{n.reasonCode}</span> : null}
        </p>
        <p className="sy-mono">{hash}</p>
        <p>
          <Link href={`/audit/${hash}`}>Verify this receipt yourself</Link>
        </p>
      </Section>
      <Section title="The card">
        <img src={`/api/public/share/${hash}/card.svg`} alt={`${BRAND.name} card: ${d.verdict}`} width={600} height={315} />
        <p className="body-text-s">Right-click to save, or link to this page.</p>
      </Section>
    </PageFrame>
  );
}
