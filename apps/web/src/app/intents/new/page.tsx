import type { Metadata } from 'next';
import { PageFrame, Section } from '@/components/product/PageFrame';
import { JsonSubmit } from '@/components/product/JsonSubmit';

export const metadata: Metadata = { title: 'New payment intent | Symbolon' };

export default function Page() {
  return (
    <PageFrame
      eyebrow="Owner"
      title="Submit a payment intent"
      lede="Paste a structured payment intent. The kernel validates it strictly and answers with a decision; the invoice extraction step that produces intents from documents runs in the agent service, not in this web app."
    >
      <Section title="Intent">
        <JsonSubmit endpoint="/api/owner/intents" template="{}" redirectBase="/intents" idField="intentId" label="Submit for a decision" />
      </Section>
      <Section title="Note">
        <p className="body-text-s">Document upload and extraction are not wired into this build. Invoice text never reaches the browser DOM except through the untrusted-text component.</p>
      </Section>
    </PageFrame>
  );
}
