'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Posts a JSON body to a same-origin owner route; the kernel validates strictly and the error code is shown as is. */
export function JsonSubmit({ endpoint, template, redirectBase, idField, label }: { endpoint: string; template: string; redirectBase: string; idField: string; label: string }) {
  const router = useRouter();
  const [text, setText] = useState(template);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      JSON.parse(text);
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      const j = (await res.json()) as Record<string, unknown> & { error?: { code?: string } };
      if (!res.ok) throw new Error(`refused (${j.error?.code ?? `HTTP ${String(res.status)}`})`);
      const nested = (j['engagement'] ?? j['decision'] ?? j) as Record<string, unknown>;
      const id = String(nested[idField] ?? j[idField] ?? '');
      if (/^0x[0-9a-f]{64}$/.test(id)) router.push(`${redirectBase}/${id}`);
      else setErr('accepted, but no id was returned');
    } catch (e) {
      setErr(e instanceof SyntaxError ? 'not valid JSON' : e instanceof Error ? e.message.slice(0, 240) : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sy-card">
      <label className="sy-label" htmlFor="json-body">JSON body</label>
      <textarea id="json-body" className="sy-input sy-mono" rows={18} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <p style={{ marginTop: 12 }}>
        <button type="button" className="sy-btn" disabled={busy} onClick={() => void submit()}>{label}</button>
      </p>
      {err !== null ? <p role="alert"><span className="sy-chip sy-chip--fail">ERROR</span> {err}</p> : null}
    </div>
  );
}
