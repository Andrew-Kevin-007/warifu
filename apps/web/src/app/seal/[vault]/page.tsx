import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { isAddress } from '@/server/public-data';

export const metadata: Metadata = {
  title: `The ${BRAND.name} seal | ${BRAND.name}`,
  description: 'An embeddable badge that shows the state of a vault’s loss bound certificate.',
};
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.NODE_ENV === 'production' ? `https://${BRAND.repoSlug}.invalid` : 'http://localhost:3000');

export default async function Page({ params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!isAddress(vault)) notFound();
  const base = SITE_URL.replace(/\/$/, '');
  const img = `${base}/api/public/seal/${vault}`;
  const link = `${base}/certificate/${vault}`;
  const html = `<a href="${link}"><img src="${img}" alt="${BRAND.name} seal" width="320" height="120"></a>`;
  const md = `[![${BRAND.name} seal](${img})](${link})`;
  return (
    <PageFrame
      eyebrow="Seal"
      title="The seal for this vault"
      lede="A small badge that mirrors the state of the vault's loss bound certificate. It is a picture of a recorded state, not a promise; click through to recompute it yourself."
    >
      <p className="sy-mono">{vault}</p>
      <Section title="Preview">
        <a href={`/certificate/${vault}`}>
          <img src={`/api/public/seal/${vault}`} alt={`${BRAND.name} seal for this vault`} width={320} height={120} />
        </a>
      </Section>
      <Section title="Embed it">
        <p className="body-text-s">HTML</p>
        <pre className="sy-pre">{html}</pre>
        <p className="body-text-s">Markdown</p>
        <pre className="sy-pre">{md}</pre>
      </Section>
      <Section title="What the colour means">
        <ul className="sy-list">
          <li><strong>Intact red seal.</strong> The certificate is VALID: it matches the vault&apos;s on-chain state, and the one figure on the badge is read from the certificate document, with the block it was calculated at.</li>
          <li><strong>Cracked red seal.</strong> The certificate is STALE or does not match: the vault changed since it was calculated. No figure is shown; recompute before relying on anything.</li>
          <li><strong>Blank grey seal.</strong> Nothing has been recomputed for this vault. The seal makes no claim at all.</li>
        </ul>
        <p className="body-text-s">
          A badge labelled RECORDED comes from the committed replay bundle, not from a live service. The badge refreshes about once a minute and
          never says more than the certificate does; its assumptions and exclusions are on the certificate page.
        </p>
      </Section>
    </PageFrame>
  );
}
