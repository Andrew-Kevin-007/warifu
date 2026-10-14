'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function CertificateLookup({ defaultVault }: { defaultVault: string }) {
  const router = useRouter();
  const [v, setV] = useState(defaultVault);
  const ok = /^0x[0-9a-fA-F]{40}$/.test(v);
  return (
    <form
      className="sy-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) router.push(`/certificate/${v}`);
      }}
    >
      <label className="sy-label" htmlFor="cv">Vault address</label>
      <input id="cv" className="sy-input sy-mono" value={v} onChange={(e) => setV(e.target.value.trim())} placeholder="0x…" spellCheck={false} autoComplete="off" />
      <p style={{ marginTop: 12 }}>
        <button type="submit" className="sy-btn" disabled={!ok}>Show certificate</button>
      </p>
    </form>
  );
}
