'use client';

// The approval screen (component d, INV-20: what you see is what you sign). Everything shown is rendered from the SAME
// object that is signed: renderModel(view) is displayed, checkWysiwys(model, view) must pass before Sign is enabled, and the
// raw typed data plus its hash sit beside the wallet prompt. One intent per approval: no multi-select action exists. The AI
// note is NOT in this component (the page renders it elsewhere), so it can never be adjacent to the Approve button.
import { useMemo, useState } from 'react';
import { checkWysiwys, renderModel } from '@symbolon/receipts/approval';
import type { Eip712Domain } from '@symbolon/schemas';
import { UntrustedText } from '@/components/safety/UntrustedText';
import { connect, signTypedDataV4 } from './eip1193';

type Phase = { t: 'idle' } | { t: 'signing' } | { t: 'submitted'; verdict: string } | { t: 'error'; message: string };

interface ViewLike {
  intentId: string;
  typedData: { domain: { chainId: number | string }; message: { intentId: string; receiptHash: string; amount: string; deadline: string } };
  typedDataHash: string;
}

export function ApprovalPanel({ view, expectedDomain }: { view: unknown; expectedDomain: Eip712Domain | null }) {
  const model = useMemo(() => renderModel(view), [view]);
  const wysiwys = useMemo(() => (model.ok ? checkWysiwys(model.value, view, expectedDomain === null ? {} : { expectedDomain }) : null), [model, view, expectedDomain]);
  const [account, setAccount] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });

  if (!model.ok || wysiwys === null) {
    return (
      <div className="sy-card" role="alert">
        <span className="sy-chip sy-chip--fail">CANNOT APPROVE</span>
        <p style={{ marginTop: 8 }}>The approval view is not consistent, so nothing can be signed from this screen.</p>
      </div>
    );
  }
  const m = model.value;
  const v = view as ViewLike;
  const canSign = wysiwys.ok && account !== null && phase.t !== 'signing' && phase.t !== 'submitted';

  async function sign() {
    if (account === null) return;
    setPhase({ t: 'signing' });
    try {
      const signature = await signTypedDataV4(account, v.typedData);
      const msg = v.typedData.message;
      const res = await fetch('/api/owner/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `approve-${msg.receiptHash.slice(2, 34)}` },
        body: JSON.stringify({ intentId: msg.intentId, receiptHash: msg.receiptHash, amount: msg.amount, deadline: msg.deadline, signature }),
      });
      const j = (await res.json()) as { decision?: { verdict?: string }; error?: { code?: string } };
      if (!res.ok) throw new Error(`the kernel refused the approval (${j.error?.code ?? `HTTP ${String(res.status)}`})`);
      setPhase({ t: 'submitted', verdict: j.decision?.verdict ?? 'UNKNOWN' });
    } catch (e) {
      setPhase({ t: 'error', message: e instanceof Error ? e.message.slice(0, 240) : 'signing failed' });
    }
  }

  return (
    <div className="sy-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
      <div className="sy-card">
        <h3 className="heading-h6">What you are approving</h3>
        <div className="sy-table-wrap" style={{ marginTop: 12 }}>
          <table className="sy-table">
            <tbody>
              <tr><th>Pay</th><td>{m.signed.amount.display}</td></tr>
              <tr><th>Invoiced (gross)</th><td>{m.gross.display}</td></tr>
              <tr><th>To</th><td>{m.payee.label} <div className="sy-mono">{m.payee.address}</div></td></tr>
              <tr><th>Engagement</th><td className="sy-mono">{m.engagementId}</td></tr>
              <tr><th>Milestone</th><td className="sy-mono">{m.milestoneId}</td></tr>
              <tr><th>Valid until</th><td className="sy-mono">{m.signed.deadline.iso}</td></tr>
              <tr><th>Reasons</th><td className="sy-mono">{m.reasons.join(', ') || 'none'}</td></tr>
            </tbody>
          </table>
        </div>
        {m.diffVsEngagement.length > 0 ? (
          <>
            <h4 className="heading-h6" style={{ marginTop: 16 }}>Where the invoice differs from the signed engagement</h4>
            <div className="sy-table-wrap" style={{ marginTop: 8 }}>
              <table className="sy-table">
                <thead><tr><th>Field</th><th>Signed engagement</th><th>Invoice says</th></tr></thead>
                <tbody>
                  {m.diffVsEngagement.map((d) => (
                    <tr key={d.field}>
                      <td className="sy-mono">{d.field}</td>
                      <td className="sy-mono">{d.expected}</td>
                      <td className="sy-mono"><UntrustedText value={d.actual} max={160} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>

      <div className="sy-card">
        <h3 className="heading-h6">What the wallet will sign</h3>
        <p style={{ marginTop: 8 }}>
          <span className={`sy-chip ${wysiwys.ok ? 'sy-chip--pass' : 'sy-chip--fail'}`}>{wysiwys.ok ? 'DISPLAY MATCHES SIGNATURE' : 'DISPLAY DOES NOT MATCH'}</span>
        </p>
        {!wysiwys.ok ? (
          <p className="sy-mono" role="alert" style={{ marginTop: 8 }}>differs at: {wysiwys.differences.join(', ')}</p>
        ) : null}
        <p className="body-text-s" style={{ marginTop: 8 }}>EIP-712 typed data hash</p>
        <p className="sy-mono">{v.typedDataHash}</p>
        <pre className="sy-pre" style={{ marginTop: 8 }} aria-label="Raw typed data">{JSON.stringify(v.typedData, null, 2)}</pre>

        <p style={{ marginTop: 16 }}>
          {account === null ? (
            <button type="button" className="sy-btn sy-btn--secondary" onClick={() => void connect().then(setAccount, (e: unknown) => setPhase({ t: 'error', message: e instanceof Error ? e.message : 'wallet error' }))}>
              Connect wallet
            </button>
          ) : (
            <span className="sy-mono">wallet {account}</span>
          )}
        </p>
        <p style={{ marginTop: 12 }}>
          <button type="button" className="sy-btn" disabled={!canSign} onClick={() => void sign()}>
            Sign and approve this one payment
          </button>
        </p>
        {phase.t === 'signing' ? <p aria-live="polite">Waiting for the wallet…</p> : null}
        {phase.t === 'submitted' ? (
          <p aria-live="polite"><span className="sy-chip sy-chip--pass">SUBMITTED</span> The kernel re-evaluated the intent: verdict {phase.verdict}. The approval grants nothing by itself.</p>
        ) : null}
        {phase.t === 'error' ? <p role="alert"><span className="sy-chip sy-chip--fail">ERROR</span> {phase.message}</p> : null}
      </div>
    </div>
  );
}
