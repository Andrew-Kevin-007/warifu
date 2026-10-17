'use client';

// Client-side receipt verifier (component e, RT-20): recompute keccak256(JCS(receipt)), recover the EIP-712 signer,
// compare with the kernel signer READ FROM THE VAULT over a public RPC, and look for the Released event. The server is
// used only to fetch the receipt bytes; none of its answers are trusted. Reuses @symbolon/receipts in the browser.
import { useState } from 'react';
import { createPublicClient, http, parseAbiItem } from 'viem';
import type { Hex } from 'viem';
import { symbolonVaultAbi } from '@symbolon/chain';
import type { RawLog } from '@symbolon/chain';
import { verifyReceipt } from '@symbolon/receipts/verify';
import type { VerifyReport } from '@symbolon/receipts/verify';
import { checkReleasedAnchor } from '@symbolon/receipts/anchor';
import { eip712DomainSeparator, symbolonDomain } from '@symbolon/schemas';
import type { Address, Hex32 } from '@symbolon/schemas';

const RELEASED = parseAbiItem(
  'event Released(bytes32 indexed intentId, bytes32 indexed engagementId, address indexed payee, uint256 amount, bytes32 receiptHash)',
);

type Phase = { t: 'idle' } | { t: 'running' } | { t: 'error'; message: string } | { t: 'done'; report: VerifyReport; notes: string[] };

export function ReceiptVerifier({ hash, rpcUrl }: { hash: string; rpcUrl: string | null }) {
  const [vault, setVault] = useState('');
  const [pasted, setPasted] = useState('');
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });

  async function run() {
    setPhase({ t: 'running' });
    const notes: string[] = [];
    try {
      let input: unknown;
      let unit: { chainId: number; vault: string } | null = null;
      if (pasted.trim() !== '') {
        input = JSON.parse(pasted);
      } else {
        const res = await fetch(`/api/public/receipt/${encodeURIComponent(hash)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`the server has no receipt ${hash} (HTTP ${res.status}); paste the signed receipt JSON instead`);
        const j = (await res.json()) as Record<string, unknown>;
        input = { receipt: j['receipt'], receiptHash: j['receiptHash'], signature: j['signature'], signer: j['signer'] };
        const u = j['unit'] as { chainId?: unknown; vault?: unknown } | undefined;
        if (u !== undefined && typeof u.chainId === 'number' && Number.isSafeInteger(u.chainId) && typeof u.vault === 'string' && /^0x[0-9a-fA-F]{40}$/.test(u.vault)) unit = { chainId: u.chainId, vault: u.vault };
      }
      if (unit !== null) {
        // A unit-mode challenge receipt: signed by the sandbox kernel signer under a fixture vault domain, never anchored on a chain. We can
        // check that the bytes are intact and that this key signed them, but NOT who the key belongs to, so the signer is not pinned.
        const report = await verifyReceipt(input, { domain: symbolonDomain(unit.chainId, unit.vault as Address), allowUnpinnedSigner: true, expectedReceiptHash: hash as Hex32 });
        setPhase({
          t: 'done',
          report,
          notes: [
            'Unit-mode challenge receipt. The hash and the signature check out in this browser; the signer is not pinned to an on-chain vault and there is no on-chain release to find, so a verified result here means the receipt was not altered and this key signed it, not that the key belongs to anyone.',
          ],
        });
        return;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error('enter the vault address (0x…, 40 hex characters)');
      if (rpcUrl === null) throw new Error('no public RPC is configured for this deployment (NEXT_PUBLIC_ARC_RPC_URL)');
      const vaultAddr = vault as Address;
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
      const chainId = await client.getChainId();
      const domain = symbolonDomain(chainId, vaultAddr);
      const read = <T,>(functionName: 'kernelSigner' | 'tokenDecimals' | 'domainSeparator') =>
        client.readContract({ address: vaultAddr, abi: symbolonVaultAbi, functionName } as never) as Promise<T>;
      const [separator, signer, decimalsRaw] = await Promise.all([read<Hex32>('domainSeparator'), read<Address>('kernelSigner'), read<number | bigint>('tokenDecimals')]);
      if (separator !== eip712DomainSeparator(domain)) {
        throw new Error("the vault's EIP-712 domain separator differs from (name, version, chain id, vault): wrong vault or chain");
      }
      notes.push(`chain id ${String(chainId)}; kernel signer read from the vault: ${signer}`);
      const decimals = Number.parseInt(String(decimalsRaw), 10);
      const report = await verifyReceipt(input, {
        domain,
        expectedSigner: signer,
        checkAnchor: async (receipt, receiptHash) => {
          const latest = await client.getBlockNumber();
          const logs = await client.getLogs({ address: vaultAddr, event: RELEASED, args: { intentId: receipt.decision.intentId as Hex }, fromBlock: 0n, toBlock: latest });
          const raw: RawLog[] = logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex, removed: l.removed }));
          return checkReleasedAnchor(receipt, receiptHash, raw, { vault: vaultAddr, decimals });
        },
      });
      setPhase({ t: 'done', report, notes });
    } catch (e) {
      setPhase({ t: 'error', message: e instanceof Error ? e.message.slice(0, 300) : 'verification could not run' });
    }
  }

  return (
    <div className="sy-card">
      <label className="sy-label" htmlFor="vault">Vault address <span className="sy-muted">(not needed for a challenge receipt)</span></label>
      <input id="vault" className="sy-input sy-mono" value={vault} onChange={(e) => setVault(e.target.value.trim())} placeholder="0x…" spellCheck={false} autoComplete="off" />
      <details className="sy-details" style={{ marginTop: 12 }}>
        <summary>Paste a signed receipt instead of fetching it from this server</summary>
        <textarea className="sy-input sy-mono" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} aria-label="Signed receipt JSON" />
      </details>
      <p style={{ marginTop: 16 }}>
        <button type="button" className="sy-btn" onClick={() => void run()} disabled={phase.t === 'running'}>
          {phase.t === 'running' ? 'Verifying…' : 'Verify in this browser'}
        </button>
      </p>
      {phase.t === 'error' ? (
        <p role="alert" style={{ marginTop: 12 }}>
          <span className="sy-chip sy-chip--fail">NOT VERIFIED</span> {phase.message}
        </p>
      ) : null}
      {phase.t === 'done' ? (
        <div style={{ marginTop: 16 }} aria-live="polite">
          <p>
            <span className={`sy-chip ${phase.report.ok ? 'sy-chip--pass' : 'sy-chip--fail'}`}>{phase.report.ok ? 'VERIFIED' : 'NOT VERIFIED'}</span>
          </p>
          <div className="sy-table-wrap" style={{ marginTop: 12 }}>
            <table className="sy-table">
              <thead>
                <tr><th>Check</th><th>Result</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {phase.report.checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td><span className={`sy-chip ${c.status === 'PASS' ? 'sy-chip--pass' : c.status === 'FAIL' ? 'sy-chip--fail' : 'sy-chip--muted'}`}>{c.status}</span></td>
                    <td className="sy-mono">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {phase.notes.map((n) => (
            <p key={n} className="body-text-s sy-mono" style={{ marginTop: 8 }}>{n}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
