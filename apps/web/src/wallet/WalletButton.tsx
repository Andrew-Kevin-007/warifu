'use client';

import { useState } from 'react';
import { connect } from './eip1193';

/** Owner sign-in is a wallet connection only: actions carry EIP-712 signatures, there is no session or cookie. */
export function WalletButton() {
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {account === null ? (
        <button type="button" className="sy-btn" onClick={() => void connect().then(setAccount, (e: unknown) => setError(e instanceof Error ? e.message : 'wallet error'))}>
          Connect wallet
        </button>
      ) : (
        <p className="sy-mono">connected {account}</p>
      )}
      {error !== null ? <p role="alert" className="body-text-s">{error}</p> : null}
    </div>
  );
}
