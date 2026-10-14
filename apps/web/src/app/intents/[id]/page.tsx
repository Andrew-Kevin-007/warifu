import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApprovalViewSchema, DecisionSchema, symbolonDomain } from '@symbolon/schemas';
import { Chip, PageFrame, Section } from '@/components/product/PageFrame';
import type { ChipTone } from '@/components/product/PageFrame';
import { AdvisoryNote } from '@/components/product/AdvisoryNote';
import { UntrustedText } from '@/components/safety/UntrustedText';
import { ApprovalPanel } from '@/wallet/ApprovalPanel';
import { kernelCall } from '@/server/kernel-client';

export const metadata: Metadata = { title: `Decision | ${BRAND.name}` };
export const dynamic = 'force-dynamic';

const VERDICT_TONE: Record<string, ChipTone> = { RELEASE: 'pass', REJECT: 'fail', HOLD: 'warn', ESCALATE: 'warn', REPLAY: 'muted' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^0x[0-9a-f]{64}$/.test(id)) notFound();
  const r = await kernelCall<{ decision: unknown; receiptHash: string | null; release: unknown }>(`/v1/intents/${id}`);
  if (!r.ok) {
    return (
      <PageFrame eyebrow="Decision" title="Decision unavailable">
        <p>{r.status === 404 ? 'No such intent for this tenant.' : 'The kernel could not be reached, so nothing is shown rather than a stale decision.'}</p>
      </PageFrame>
    );
  }
  const parsed = DecisionSchema.safeParse(r.data.decision);
  if (!parsed.success) {
    return (
      <PageFrame eyebrow="Decision" title="No decision yet">
        <p>This intent has no decision recorded.</p>
      </PageFrame>
    );
  }
  const d = parsed.data;
  let approval: ReturnType<typeof ApprovalViewSchema.safeParse> | null = null;
  if (d.verdict === 'ESCALATE') {
    const av = await kernelCall<unknown>(`/v1/intents/${id}/approval-view`);
    approval = av.ok ? ApprovalViewSchema.safeParse(av.data) : null;
  }
  const expected = process.env.NEXT_PUBLIC_SANDBOX_VAULT && process.env.NEXT_PUBLIC_CHAIN_ID
    ? symbolonDomain(Number.parseInt(process.env.NEXT_PUBLIC_CHAIN_ID, 10), process.env.NEXT_PUBLIC_SANDBOX_VAULT as `0x${string}`)
    : null;

  return (
    <PageFrame eyebrow="Decision" title={`Verdict ${d.verdict}`} lede="The checks come first. Each row is a deterministic kernel check; model output is never a release condition.">
      <p>
        <Chip tone={VERDICT_TONE[d.verdict] ?? 'plain'}>{d.verdict}</Chip>{' '}
        {d.reasons.map((c) => <span key={c} className="sy-chip sy-chip--muted" style={{ marginRight: 4 }}>{c}</span>)}
      </p>

      <Section title="Checks">
        <div className="sy-table-wrap">
          <table className="sy-table">
            <thead><tr><th>Check</th><th>Result</th><th>Code</th><th>Detail</th></tr></thead>
            <tbody>
              {d.checks.map((c) => (
                <tr key={c.id}>
                  <td><span className="sy-mono">{c.id}</span> {c.name}</td>
                  <td><Chip tone={c.status === 'PASS' ? 'pass' : c.status === 'FAIL' ? 'fail' : 'muted'}>{c.status}</Chip></td>
                  <td className="sy-mono">{c.code ?? ''}</td>
                  <td><UntrustedText value={c.detail} max={200} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Agent proposal and kernel verdict">
        <div className="sy-grid">
          <div className="sy-card">
            <p className="body-text-s">Agent (advisory)</p>
            {d.agentRecommendation === null ? (
              <p>No recommendation recorded.</p>
            ) : (
              <>
                <p><Chip tone="muted">{d.agentRecommendation.verdict}</Chip></p>
                <ul className="sy-list" style={{ marginTop: 8 }}>
                  {d.agentRecommendation.reasons.map((x, i) => <li key={i}><UntrustedText value={x} max={200} /></li>)}
                </ul>
              </>
            )}
          </div>
          <div className="sy-card">
            <p className="body-text-s">Kernel (decides)</p>
            <p><Chip tone={VERDICT_TONE[d.verdict] ?? 'plain'}>{d.verdict}</Chip></p>
            <p className="sy-mono" style={{ marginTop: 8 }}>receipt {r.data.receiptHash ?? 'n/a'}</p>
            {r.data.receiptHash ? <p className="body-text-s"><a href={`/audit/${r.data.receiptHash}`}>Verify this receipt</a></p> : null}
          </div>
        </div>
      </Section>

      {d.humanExplanation !== null ? (
        <Section title="Explanation">
          <p>{d.humanExplanation}</p>
          <p className="body-text-s">Templated by the kernel from the structured facts above.</p>
        </Section>
      ) : null}

      {d.verdict === 'ESCALATE' ? (
        <Section title="Owner approval">
          {approval !== null && approval.success ? (
            <ApprovalPanel view={approval.data} expectedDomain={expected} />
          ) : (
            <div className="sy-card" role="alert">
              <Chip tone="fail">APPROVAL UNAVAILABLE</Chip>
              <p style={{ marginTop: 8 }}>The approval view could not be loaded or did not validate, so Sign is not offered.</p>
            </div>
          )}
        </Section>
      ) : null}

      {approval !== null && approval.success && approval.data.advisory !== null ? (
        <Section title="Note from the AI model">
          <AdvisoryNote text={approval.data.advisory.text} />
        </Section>
      ) : null}
    </PageFrame>
  );
}
