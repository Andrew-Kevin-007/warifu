import type { Metadata } from 'next';
import Link from 'next/link';
import { Chip, PageFrame, Section, SourceBanner } from '@/components/product/PageFrame';
import { loadAttackMatrix, loadAttackMeta } from '@/server/recorded';

export const metadata: Metadata = { title: 'Break the Treasurer | Symbolon', description: 'Attack a testnet sandbox treasurer. No funds, no prize.' };
export const dynamic = 'force-dynamic';

// Live attempts need the sandbox kernel (GET/POST /v1/challenge/*, WP-32), which is not reachable from this build; until it
// is, this page shows the recorded attack set read-only. It accepts no input, so it cannot be used to attack anything.
export default function Page() {
  const meta = loadAttackMeta();
  const m = loadAttackMatrix();
  const ids = m === null ? [] : Array.from(new Set(m.attacks.map((a) => a.attackId))).sort();
  return (
    <PageFrame
      eyebrow="Challenge"
      title="Break the Treasurer"
      lede="Attack a treasurer that runs on testnet with no real funds and no prize. An independent oracle decides whether money left that should not have."
    >
      <SourceBanner source="RECORDED" note="The live sandbox is not connected to this page, so attempts cannot be submitted here yet." />
      <Section title="The attack set">
        <ul className="sy-list">
          {ids.map((id) => (
            <li key={id}><span className="sy-mono">{id}</span> {meta[id]?.title ?? ''}: {meta[id]?.caption ?? ''}</li>
          ))}
        </ul>
        <p style={{ marginTop: 12 }}><Link className="sy-btn" href="/attack-lab">See how each target fared</Link></p>
      </Section>
      <Section title="Ground rules">
        <ul className="sy-list">
          <li><Chip tone="warn">TESTNET</Chip> The sandbox shares no key, database, vault or origin with any pilot.</li>
          <li>Attack traffic is not customer traffic and is never counted as traction.</li>
          <li>Testing terms and how to report a real flaw are on the <Link href="/security">security page</Link>.</li>
        </ul>
      </Section>
    </PageFrame>
  );
}
