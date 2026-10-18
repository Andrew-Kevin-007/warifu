/* global fetch, Buffer */
// Register an entity secret with Circle (developer-controlled wallets), testnet or mainnet key as given.
//   $env:CIRCLE_API_KEY='...'                      (this window only; never paste it anywhere)
//   node scripts/circle-register-entity-secret.mjs D:\secrets\circle-entity-secret.txt D:\secrets\circle-recovery.dat
// Reads the 64-hex secret from the file, encrypts it with Circle's entity public key (RSA-OAEP SHA-256) and registers the ciphertext.
// The recovery file Circle returns is written OUTSIDE the repo. Prints a status only: never the key, the secret, or the ciphertext.
// VERIFY(V-26): endpoints and scheme are from memory of Circle's docs; on a non-2xx answer register it in the Circle console instead.
import { constants, publicEncrypt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [secretFile, recoveryOut] = process.argv.slice(2);
const apiKey = process.env.CIRCLE_API_KEY ?? '';
if (!secretFile || !recoveryOut || apiKey.length < 20) {
  console.error('usage: set CIRCLE_API_KEY, then: node scripts/circle-register-entity-secret.mjs <secret file> <new recovery file>');
  process.exit(2);
}
if (existsSync(recoveryOut)) { console.error('refused: the recovery file already exists'); process.exit(2); }
const secret = readFileSync(secretFile, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(secret)) { console.error('the secret file must hold 64 lowercase hex characters'); process.exit(2); }

const BASE = 'https://api.circle.com';
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
const brief = (j) => String(j?.message ?? j?.error ?? '').slice(0, 160);

const kr = await fetch(`${BASE}/v1/w3s/config/entity/publicKey`, { headers });
const kj = await kr.json().catch(() => null);
if (!kr.ok || typeof kj?.data?.publicKey !== 'string') { console.error(`public key fetch failed: HTTP ${kr.status} ${brief(kj)}`); process.exit(1); }

const ciphertext = publicEncrypt({ key: kj.data.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(secret, 'hex')).toString('base64');
const rr = await fetch(`${BASE}/v1/w3s/config/entity/entitySecret`, { method: 'POST', headers, body: JSON.stringify({ entitySecretCiphertext: ciphertext }) });
const rj = await rr.json().catch(() => null);
if (!rr.ok) { console.error(`registration failed: HTTP ${rr.status} ${brief(rj)}`); process.exit(1); }
const recovery = rj?.data?.recoveryFile;
if (typeof recovery === 'string' && recovery.length > 0) {
  // Owner-only where the OS honours it (POSIX); on Windows the protection is the ACL of the folder outside the repo.
  writeFileSync(recoveryOut, recovery, { flag: 'wx', mode: 0o600 });
  console.log(`registered. Recovery file saved to ${recoveryOut} (outside the repo; back it up in your password manager).`);
} else {
  console.log('registered (Circle returned no recovery file; download it from the Circle console if it offers one).');
}
