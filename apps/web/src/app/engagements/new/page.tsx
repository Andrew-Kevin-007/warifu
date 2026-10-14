import type { Metadata } from 'next';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { JsonSubmit } from '@/components/product/JsonSubmit';

export const metadata: Metadata = { title: 'New engagement | Symbolon' };

const TEMPLATE = JSON.stringify(
  {
    slug: 'design-sprint-1',
    owner: '0x0000000000000000000000000000000000000000',
    payee: '0x0000000000000000000000000000000000000000',
    payeeLabel: 'Example Studio',
    capBaseUnits: '1000000',
    start: '2026-11-01T00:00:00Z',
    end: '2026-12-01T00:00:00Z',
    sequential: false,
    milestones: [
      { slug: 'm1', description: 'First deliverable', amountBaseUnits: '500000', partialAllowed: false, immediate: false, dueDate: null, category: 'design', evidenceSpec: [] },
    ],
    paymentTerms: null,
  },
  null,
  2,
);

export default function Page() {
  return (
    <PageFrame
      eyebrow="Owner"
      title="Create an engagement"
      lede="An engagement binds the payee address, the amounts, the window and the evidence to a pair of signatures. Replace the placeholder addresses (the zero address is refused) and submit; both parties then sign the same typed data."
    >
      <Section title="Terms">
        <JsonSubmit endpoint="/api/owner/engagements" template={TEMPLATE} redirectBase="/engagements" idField="engagementId" label="Create draft" />
      </Section>
    </PageFrame>
  );
}
