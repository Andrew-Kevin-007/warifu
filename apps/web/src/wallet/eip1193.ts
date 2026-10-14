// Wallet access: the ONLY place in apps/web that talks to a browser wallet (INV-16; lint + dependency-cruiser keep
// src/challenge/** and src/replay/** away from it). Plain EIP-1193, no wallet library, no key ever held by this app.

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function provider(): Eip1193 {
  const p = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (p === undefined) throw new Error('no browser wallet found (EIP-1193 provider missing)');
  return p;
}

export async function connect(): Promise<string> {
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as unknown;
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error('the wallet returned no account');
  }
  return accounts[0].toLowerCase();
}

export async function walletChainId(): Promise<number> {
  const id = (await provider().request({ method: 'eth_chainId' })) as unknown;
  if (typeof id !== 'string' || !/^0x[0-9a-fA-F]+$/.test(id)) throw new Error('the wallet returned no chain id');
  return Number.parseInt(id, 16);
}

/**
 * eth_signTypedData_v4 over EXACTLY the JSON given. Callers pass the typed data from the validated ApprovalView or
 * engagement view; this function never builds or alters a message. Refuses when the wallet is on another chain than the
 * typed data's domain, so a signature for one chain can never be produced by accident.
 */
export async function signTypedDataV4(account: string, typedData: { domain: { chainId: number | string } }): Promise<string> {
  const want = Number(typedData.domain.chainId);
  const have = await walletChainId();
  if (want !== have) throw new Error(`the wallet is on chain ${String(have)} but the signature is for chain ${String(want)}; switch networks`);
  const sig = (await provider().request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedData)] })) as unknown;
  if (typeof sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(sig)) throw new Error('the wallet returned no signature');
  return sig.toLowerCase();
}
