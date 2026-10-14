import { ADVISORY_LABEL } from '@symbolon/receipts/approval';
import type { Untrusted } from '@symbolon/schemas';
import { UntrustedText } from '@/components/safety/UntrustedText';

/** Model prose: collapsed by default, labelled, and placed away from the Approve action (INV-20). */
export function AdvisoryNote({ text }: { text: Untrusted<string> }) {
  return (
    <details className="sy-details sy-card">
      <summary>{ADVISORY_LABEL}</summary>
      <p className="body-text-s" style={{ marginTop: 8 }}>
        Written by a language model from the invoice. It is not used for the decision and may be wrong.
      </p>
      <p style={{ marginTop: 8 }}>
        <UntrustedText value={text} max={600} />
      </p>
    </details>
  );
}
