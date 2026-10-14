'use client';

import { useState } from 'react';
import type { LiteReport } from '@symbolon/blast-radius/lite';

const FIELDS = [
  { key: 'balance', label: 'Balance' },
  { key: 'perTxLimit', label: 'Per-transaction limit (optional)' },
  { key: 'dailyLimit', label: 'Daily limit (optional)' },
  { key: 'weeklyLimit', label: 'Weekly limit (optional)' },
  { key: 'monthlyLimit', label: 'Monthly limit (optional)' },
] as const;

type State = { t: 'idle' } | { t: 'busy' } | { t: 'error'; message: string } | { t: 'ok'; report: LiteReport };

export function LiteAudit() {
  const [vals, setVals] = useState<Record<string, string>>({ balance: '', perTxLimit: '', dailyLimit: '', weeklyLimit: '', monthlyLimit: '' });
  const [decimals, setDecimals] = useState('6');
  const [state, setState] = useState<State>({ t: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ t: 'busy' });
    const body: Record<string, unknown> = { schema: 'blast-lite-input/1', mode: 'numbers', decimals: Number.parseInt(decimals, 10), currency: 'USDC' };
    for (const f of FIELDS) if (vals[f.key] !== '') body[f.key] = vals[f.key];
    try {
      const res = await fetch('/api/public/blast/lite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await res.json()) as { report?: LiteReport; error?: { code: string; issues?: { path: string; message: string }[] } };
      if (!res.ok || j.report === undefined) {
        const detail = j.error?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ?? j.error?.code ?? `HTTP ${res.status}`;
        setState({ t: 'error', message: detail.slice(0, 400) });
        return;
      }
      setState({ t: 'ok', report: j.report });
    } catch {
      setState({ t: 'error', message: 'the audit service could not be reached' });
    }
  }

  return (
    <div>
      <form className="sy-card" onSubmit={(e) => void submit(e)}>
        <div className="sy-grid">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="sy-label" htmlFor={f.key}>{f.label}</label>
              <input id={f.key} className="sy-input sy-mono" inputMode="decimal" value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value.trim() })} />
            </div>
          ))}
          <div>
            <label className="sy-label" htmlFor="dec">Token decimals</label>
            <input id="dec" className="sy-input sy-mono" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value.trim())} />
          </div>
        </div>
        <p className="body-text-s" style={{ marginTop: 12 }}>
          Amounts are in whole tokens (for example 2500.50). Numbers only: nothing is read from any wallet or chain.
        </p>
        <p style={{ marginTop: 12 }}>
          <button className="sy-btn" type="submit" disabled={state.t === 'busy' || vals['balance'] === ''}>
            {state.t === 'busy' ? 'Calculating…' : 'Calculate'}
          </button>
        </p>
      </form>

      {state.t === 'error' ? <p role="alert" className="sy-banner" style={{ marginTop: 16 }}>{state.message}</p> : null}

      {state.t === 'ok' ? <Report r={state.report} /> : null}
    </div>
  );
}

function Report({ r }: { r: LiteReport }) {
  const rolling = r.interpretations.rolling;
  const calendar = r.interpretations.calendar;
  return (
    <div style={{ marginTop: 24 }} aria-live="polite">
      <div className="sy-card">
        <p className="heading-h6">{r.headline}</p>
        <p className="body-text-s" style={{ marginTop: 8 }}>{r.notACertificate}</p>
      </div>

      <h3 className="heading-h6" style={{ marginTop: 24 }}>At most, by horizon</h3>
      <div className="sy-table-wrap" style={{ marginTop: 8 }}>
        <table className="sy-table">
          <thead><tr><th>Horizon</th><th>Rolling windows</th><th>Calendar buckets</th></tr></thead>
          <tbody>
            {rolling.horizons.map((h, i) => (
              <tr key={h.label}>
                <td>{h.label}</td>
                <td>{h.value.formatted} {r.currency}</td>
                <td>{calendar.horizons[i]?.value.formatted} {r.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="body-text-s" style={{ marginTop: 8 }}>{rolling.drainText}</p>

      {r.findings.length > 0 ? (
        <>
          <h3 className="heading-h6" style={{ marginTop: 24 }}>Findings</h3>
          <ul className="sy-list" style={{ marginTop: 8 }}>
            {r.findings.map((f) => (
              <li key={f.id}><span className="sy-chip">{f.severity}</span> {f.text}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="heading-h6" style={{ marginTop: 24 }}>Exclusions</h3>
      <ul className="sy-list" style={{ marginTop: 8 }}>
        {r.exclusions.map((x) => <li key={x.id}><span className="sy-mono">{x.id}</span> {x.text}</li>)}
      </ul>
      <h3 className="heading-h6" style={{ marginTop: 24 }}>Assumptions</h3>
      <ul className="sy-list" style={{ marginTop: 8 }}>
        {r.assumptions.map((a) => <li key={a.id}><span className="sy-mono">{a.id}</span> {a.text}</li>)}
      </ul>
      <h3 className="heading-h6" style={{ marginTop: 24 }}>Questions to answer for your platform</h3>
      <ul className="sy-list" style={{ marginTop: 8 }}>
        {r.questions.map((q) => <li key={q}>{q}</li>)}
      </ul>
    </div>
  );
}
