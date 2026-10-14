import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Chip, PageFrame, Section, SourceBanner } from '@/components/product/PageFrame';
import { loadBundle } from '@/server/recorded';

export const metadata: Metadata = { title: `Recorded run | ${BRAND.name}` };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ bundle: string }> }) {
  const { bundle: id } = await params;
  if (id !== 'main') notFound();
  const b = loadBundle();
  return (
    <PageFrame
      eyebrow="Replay"
      title="Recorded run"
      lede="The committed, hash-checked bundle the judge pages fall back to when live services are unavailable."
    >
      <SourceBanner source="RECORDED" />
      {b === null ? (
        <p>No replay bundle is committed in this deployment.</p>
      ) : (
        <>
          <Section title="Bundle">
            <div className="sy-table-wrap">
              <table className="sy-table">
                <tbody>
                  <tr><th>Bundle hash</th><td className="sy-mono">{b.bundleHash}</td></tr>
                  <tr><th>Built at</th><td className="sy-mono">{b.builtAt}</td></tr>
                  <tr><th>Git commit</th><td className="sy-mono">{b.gitSha}</td></tr>
                  <tr><th>Harness</th><td className="sy-mono">{Object.entries(b.harnessVersions).map(([k, v]) => `${k}=${v}`).join(' ')}</td></tr>
                  <tr><th>Recorded attempts</th><td>{b.attempts.length}</td></tr>
                  <tr><th>Recorded receipts</th><td>{b.receipts.length}</td></tr>
                  <tr><th>Certificate</th><td>{b.certificate === null ? <Chip tone="muted">none recorded</Chip> : <Chip>recorded</Chip>}</td></tr>
                </tbody>
              </table>
            </div>
            <pre className="sy-pre" style={{ marginTop: 12 }}>pnpm verify-bundle replay-data/bundle.json</pre>
          </Section>
          <Section title="Rendered from this bundle">
            <ul className="sy-list">
              <li><Link href="/attack-lab">Attack lab</Link></li>
              <li><Link href="/judge">Judge path</Link></li>
              <li><Link href="/certificate">Certificate</Link></li>
            </ul>
          </Section>
        </>
      )}
    </PageFrame>
  );
}
