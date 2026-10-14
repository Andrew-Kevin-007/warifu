'use client';

// Engagement signing for the owner and the payee (EIP-712 EngagementTerms). The typed data comes from the kernel, which
// rebuilds it from the stored terms; this component signs it unchanged and shows the raw JSON and its digest first.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { connect, signTypedDataV4 } from './eip1193';

type TypedData = { domain: { chainId: number | string }; message: Record<string, unknown> };

export function SignEngagementPanel({ engagementId, termsHash, typedData, digest, fixedRole }: { engagementId: string; termsHash: string; typedData: TypedData; digest: string | null; fixedRole: 'owner' | 'payee' | null }) {
  const router = useRouter();
  const [role, setRole] = useState<'owner' | 'payee'>(fixedRole ?? 'owner');
  const [account, setAccount] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function sign() {
    if (account === null) return;
    setBusy(true);
    setMsg(null);
    try {
      const signature = await signTypedDataV4(account, typedData);
      const res = await fetch(`/api/owner/engagements/${engagementId}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, signature, termsHash }),
      });
      const j = (await res.json()) as { error?: { code?: string } };
      if (!res.ok) throw new Error(`the kernel refused the signature (${j.error?.code ?? `HTTP ${String(res.status)}`})`);
      setMsg({ tone: 'ok', text: 'Signature accepted.' });
      router.refresh();
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message.slice(0, 240) : 'signing failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sy-card">
      <h3 className="heading-h6">What the wallet will sign</h3>
      <p className="body-text-s" style={{ marginTop: 8 }}>Terms hash</p>
      <p className="sy-mono">{termsHash}</p>
      {digest !== null ? (
        <>
          <p className="body-text-s" style={{ marginTop: 8 }}>EIP-712 digest</p>
          <p className="sy-mono">{digest}</p>
        </>
      ) : null}
      <pre className="sy-pre" style={{ marginTop: 8 }} aria-label="Raw typed data">{JSON.stringify(typedData, null, 2)}</pre>
      {fixedRole === null ? (
        <>
          <label className="sy-label" htmlFor="role">Signing as</label>
          <select id="role" className="sy-input" value={role} onChange={(e) => setRole(e.target.value === 'payee' ? 'payee' : 'owner')}>
            <option value="owner">Owner</option>
            <option value="payee">Payee</option>
          </select>
        </>
      ) : (
        <p style={{ marginTop: 8 }}>You are signing as the <strong>{fixedRole}</strong>.</p>
      )}
      <p style={{ marginTop: 16 }}>
        {account === null ? (
          <button type="button" className="sy-btn sy-btn--secondary" onClick={() => void connect().then(setAccount, (e: unknown) => setMsg({ tone: 'error', text: e instanceof Error ? e.message : 'wallet error' }))}>
            Connect wallet
          </button>
        ) : (
          <span className="sy-mono">wallet {account}</span>
        )}
      </p>
      <p style={{ marginTop: 12 }}>
        <button type="button" className="sy-btn" disabled={account === null || busy} onClick={() => void sign()}>
          Sign these terms
        </button>
      </p>
      {msg !== null ? <p role={msg.tone === 'error' ? 'alert' : 'status'}>{msg.tone === 'ok' ? <span className="sy-chip sy-chip--pass">OK</span> : <span className="sy-chip sy-chip--fail">ERROR</span>} {msg.text}</p> : null}
    </div>
  );
}
