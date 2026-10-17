// Generates the throwaway TESTNET keys for the first real Arc testnet payment (handoff 5b) and prints ADDRESSES ONLY.
// Private keys go to a file outside the repo (default D:\symbolon\demo\secrets\testnet-keys.json) and, for the kernel roles, straight
// into services/kernel/.env.local (which is gitignored). They are never printed, never committed, never pasted into chat.
//   pnpm env:init                       (once, creates services/kernel/.env.local)
//   node scripts/testnet-keys.mjs       (this script; refuses to overwrite an existing keys file)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEYS_FILE = process.env.TESTNET_KEYS_FILE ?? 'D:\\symbolon\\demo\\secrets\\testnet-keys.json';
const ENV_FILE = 'services/kernel/.env.local';
const ROLES = ['deployer', 'kernelSigner', 'guardian', 'relayer', 'payee'];

if (existsSync(KEYS_FILE)) {
  console.error(`refusing to overwrite ${KEYS_FILE}. Keep using it, or move it away first.`);
  process.exit(1);
}
if (!existsSync(ENV_FILE)) {
  console.error(`${ENV_FILE} not found. Run: pnpm env:init`);
  process.exit(1);
}

const CAST = existsSync('D:\\tools\\foundry\\bin\\cast.exe') ? 'D:\\tools\\foundry\\bin\\cast.exe' : 'cast';
const r = spawnSync(CAST, ['wallet', 'new', '--number', String(ROLES.length), '--json'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error('cast wallet new failed (is D:\\tools\\foundry\\bin on PATH?)');
  process.exit(1);
}
const wallets = JSON.parse(r.stdout);
if (!Array.isArray(wallets) || wallets.length !== ROLES.length) {
  console.error('unexpected output from cast wallet new');
  process.exit(1);
}

const keys = Object.fromEntries(ROLES.map((role, i) => [role, { address: wallets[i].address, privateKey: wallets[i].private_key }]));
mkdirSync(dirname(KEYS_FILE), { recursive: true });
writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { flag: 'wx' });

// Fill only the three kernel secrets that are still placeholders; leave everything else as it is.
let env = readFileSync(ENV_FILE, 'utf8');
const put = (name, value) => {
  const re = new RegExp(`^${name}=PASTE_[A-Z_]+_HERE`, 'm');
  if (re.test(env)) env = env.replace(re, `${name}=${value}`);
};
put('KERNEL_SIGNER_PRIVATE_KEY', keys.kernelSigner.privateKey);
put('GUARDIAN_PRIVATE_KEY', keys.guardian.privateKey);
put('RELAYER_PRIVATE_KEY', keys.relayer.privateKey);
writeFileSync(ENV_FILE, env);

console.log(`keys saved to ${KEYS_FILE} (outside the repo; back it up in your password manager, never paste it anywhere)`);
console.log('kernel signer, guardian and relayer keys written into', ENV_FILE);
console.log('\nADDRESSES (public; fund the ones marked FUND from https://faucet.circle.com, Arc testnet):');
for (const role of ROLES) {
  const fund = role === 'deployer' || role === 'relayer' || role === 'payee' ? '  <- FUND' : '';
  console.log(`  ${role.padEnd(13)} ${keys[role].address}${fund}`);
}
console.log('  owner         your browser-wallet account (also FUND; it signs and approves)');
