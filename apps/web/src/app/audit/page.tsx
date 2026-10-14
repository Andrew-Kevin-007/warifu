import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { AuditLookup } from '@/components/audit/AuditLookup';

export const metadata: Metadata = { title: `Receipt verifier | ${BRAND.name}` };

export default function Page() {
  return (
    <PageFrame
      eyebrow="Receipt verifier"
      title="Check a receipt without trusting us"
      lede="Every decision produces a signed receipt. Enter a receipt hash to verify it in your own browser against the vault and a public RPC."
    >
      <Section title="Receipt hash">
        <AuditLookup />
      </Section>
    </PageFrame>
  );
}
