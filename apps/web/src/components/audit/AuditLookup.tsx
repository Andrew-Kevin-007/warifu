'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function AuditLookup() {
  const router = useRouter();
  const [v, setV] = useState('');
  const ok = /^0x[0-9a-fA-F]{64}$/.test(v);
  return (
    <form
      className="sy-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) router.push(`/audit/${v.toLowerCase()}`);
      }}
    >
      <label className="sy-label" htmlFor="rh">Receipt hash (0x + 64 hex characters)</label>
      <input id="rh" className="sy-input sy-mono" value={v} onChange={(e) => setV(e.target.value.trim())} spellCheck={false} autoComplete="off" />
      <p style={{ marginTop: 12 }}>
        <button type="submit" className="sy-btn" disabled={!ok}>Open verifier</button>
      </p>
    </form>
  );
}
