import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { CertificateLookup } from '@/components/product/CertificateLookup';
import { loadBundle } from '@/server/recorded';

export const metadata: Metadata = { title: `Loss bound certificate | ${BRAND.name}` };
export const dynamic = 'force-dynamic';

export default function Page() {
  const rec = loadBundle()?.certificate ?? null;
  const defaultVault = process.env.NEXT_PUBLIC_SANDBOX_VAULT ?? '';
  return (
    <PageFrame
      eyebrow="Loss bound certificate"
      title="A bound you can recompute"
      lede="A certificate states the most that can leave a vault within each horizon, with its assumptions and exclusions first. Anyone can recompute it from the chain with the command line verifier."
    >
      <Section title="Open a certificate">
        <CertificateLookup defaultVault={defaultVault} />
      </Section>
      <Section title="Recorded bundle">
        <p>
          {rec === null
            ? 'The committed replay bundle holds no certificate yet: none has been built against a deployed vault. The page for a vault shows a certificate only when one is available live or recorded.'
            : 'The committed replay bundle holds one certificate; open its vault above.'}
        </p>
      </Section>
    </PageFrame>
  );
}
