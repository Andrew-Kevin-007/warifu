import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { AuditLookup } from '@/components/audit/AuditLookup';
import ReceiptSealStill from '@/components/design/stills/ReceiptSealStill';

export const metadata: Metadata = { title: `Receipt verifier | ${BRAND.name}` };

export default function Page() {
  return (
    <PageFrame
      eyebrow="Receipt verifier"
      title="Check a receipt yourself"
      lede="Every decision produces a signed receipt. Enter a receipt hash to verify it in your own browser against the vault and a public RPC. Nothing here asks you to trust our server."
    >
      <Section title="Receipt hash">
        <div className="sy-audit-lookup">
          <div className="sy-audit-lookup__form">
            <AuditLookup />
            <p className="body-text-s sy-audit-lookup__note">
              Receipts from the Break the Treasurer challenge are signed under a fixture vault and are not on any chain, so their signer step shows SKIP on purpose. The hash and the signature are still checked.
            </p>
          </div>
          <div className="sy-audit-lookup__seal">
            <ReceiptSealStill hash={null} state="hollow" label="Receipt seal, hollow until a receipt verifies" />
          </div>
        </div>
      </Section>
    </PageFrame>
  );
}
