import type { Metadata } from 'next';
import { PageFrame, Section, Chip } from '@/components/product/PageFrame';
import { LiteAudit } from '@/components/product/LiteAudit';
import { loadBlastClosedForm } from '@/server/recorded';

export const metadata: Metadata = {
  title: 'Blast radius | Symbolon',
  description: 'How much can leave an agent wallet if the agent and its key are compromised, calculated from the limits you set.',
};
export const dynamic = 'force-dynamic';

export default function Page() {
  const c = loadBlastClosedForm();
  return (
    <PageFrame
      eyebrow="Blast Radius Lite"
      title="If the agent is compromised, what is the most that can leave?"
      lede="Enter the limits your agent wallet has today. The answer is closed-form arithmetic on those numbers, with the assumptions and exclusions shown next to it. It is an estimate, not a certificate."
    >
      <Section title="Your limits">
        <LiteAudit />
      </Section>

      <Section title="How the arithmetic was checked">
        {c === null ? (
          <p>No recorded validation campaign is available in this deployment.</p>
        ) : (
          <div className="sy-card">
            <p><Chip tone="muted">RECORDED</Chip> {c.wording}</p>
            <p style={{ marginTop: 8 }}>
              Closed form against exhaustive enumeration: {c.campaign.executedCases} executed cases, {c.campaign.violations} violations; {c.campaign.tightnessCases} tightness cases, {c.campaign.tightnessMismatches} mismatches.
            </p>
            <ul className="sy-list" style={{ marginTop: 8 }}>
              {c.limits.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </div>
        )}
      </Section>
    </PageFrame>
  );
}
