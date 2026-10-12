// A real local anvil (stock Foundry, V-19) with the real SymbolonVault + MockUSDC from contracts/out, for the engagement
// service tests. Signers are generated throwaway keys (never a real key); the relayer is anvil's first UNLOCKED account.
// Needs `anvil` on PATH (or ANVIL_BIN). Without it the suites skip with a warning, unless REQUIRE_ANVIL=1 or CI=true.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arcChain, symbolonVaultAbi } from "@symbolon/chain";
import { createAnvilClient } from "@symbolon/chain/anvil";
import { EIP712_TYPES } from "@symbolon/schemas";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const CONTRACTS = resolve(REPO_ROOT, "contracts");
const VAULT_ARTIFACT = resolve(CONTRACTS, "out/SymbolonVault.sol/SymbolonVault.json");
const MOCK_USDC_ARTIFACT = resolve(CONTRACTS, "out/Mocks.sol/MockUSDC.json");
const ANVIL_BIN = process.env["ANVIL_BIN"] ?? "anvil";

export const anvilRequired = process.env["REQUIRE_ANVIL"] === "1" || process.env["CI"] === "true";

export function anvilAvailable(): boolean {
  const r = spawnSync(ANVIL_BIN, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.error === undefined && r.status === 0;
}

/** Decide whether anvil suites run; throws (so the suite fails) when anvil is required but missing. */
export function anvilSuiteEnabled(suite: string): boolean {
  if (anvilAvailable()) {
    if (!existsSync(VAULT_ARTIFACT) || !existsSync(MOCK_USDC_ARTIFACT)) {
      if (anvilRequired) throw new Error(`[${suite}] contracts/out is missing: run \`forge build\` in contracts/ (stock forge, FOUNDRY_OFFLINE=true)`);
      console.warn(`[${suite}] contracts/out missing: skipping anvil tests`);
      return false;
    }
    return true;
  }
  if (anvilRequired) throw new Error(`[${suite}] anvil required (REQUIRE_ANVIL=1 or CI=true) but not found`);
  console.warn(`[${suite}] anvil not found: skipping the anvil tests (set ANVIL_BIN, or REQUIRE_ANVIL=1 to make this fatal)`);
  return false;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      srv.close(() => ok(port));
    });
  });
}

async function chainIdOf(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return ((await res.json()) as { result?: string }).result;
  } catch {
    return undefined;
  }
}

export interface Anvil {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startAnvil(): Promise<Anvil> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child: ChildProcess = spawn(ANVIL_BIN, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error("anvil exited during startup");
    if ((await chainIdOf(url)) === "0x7a69") {
      return {
        url,
        stop: () =>
          new Promise<void>((done) => {
            if (exited) return done();
            child.once("exit", () => done());
            child.kill();
          }),
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("anvil did not become ready within 10 s");
}

interface Artifact {
  readonly abi: readonly unknown[];
  readonly bytecode: { readonly object: Hex };
}
const artifact = (p: string): Artifact => JSON.parse(readFileSync(p, "utf8")) as Artifact;

export const USDC = 1_000_000n;
export const CAP_PER_TX = 25n * USDC;
export const CAP_DAILY = 60n * USDC;
export const HUMAN_THRESHOLD = 20n * USDC;
export const PAYEE_DELAY = 172_800; // 2 days
export const SIGNER_DELAY = 86_400;

export interface Party {
  readonly account: PrivateKeyAccount;
  readonly address: Address;
}
export function newParty(): Party {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, address: getAddress(account.address) };
}

export interface VaultWorld {
  readonly anvil: Anvil;
  readonly url: string;
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly dev: ReturnType<typeof createAnvilClient>;
  readonly relayerAccount: Address;
  readonly token: Address;
  readonly vault: Address;
  readonly owner: Party;
  readonly payee: Party;
  readonly kernel: Party;
  readonly guardian: Party;
  readonly chainId: 31337;
  /** Sign a Symbolon typed-data object (as a wallet would). */
  signTyped(p: Party, typedData: { domain: unknown; primaryType: string; message: unknown }): Promise<Hex>;
  /** Mine `n` empty blocks. */
  mine(n: number): Promise<void>;
  /** Advance chain time and mine one block. */
  warp(seconds: number): Promise<void>;
  /** Owner pauses the vault (an owner tx, sent by the owner account from a funded address). */
  ownerTx(functionName: string, args: readonly unknown[]): Promise<Hex>;
  stop(): Promise<void>;
}

export async function openVaultWorld(): Promise<VaultWorld> {
  const anvil = await startAnvil();
  const chain = arcChain("local", anvil.url);
  const pub = createPublicClient({ chain, transport: http(anvil.url) }) as PublicClient;
  const wallet = createWalletClient({ chain, transport: http(anvil.url) });
  const dev = createAnvilClient(anvil.url);
  const accounts = await wallet.getAddresses();
  const relayerAccount = getAddress(accounts[0] as Address);
  const owner = newParty();
  const payee = newParty();
  const kernel = newParty();
  const guardian = newParty();

  async function deploy(path: string, args: readonly unknown[]): Promise<Address> {
    const a = artifact(path);
    const hash = await wallet.deployContract({ abi: a.abi as Abi, bytecode: a.bytecode.object, args: [...args], account: relayerAccount, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.contractAddress === null || r.contractAddress === undefined) throw new Error("deployment produced no address");
    return getAddress(r.contractAddress);
  }
  const token = await deploy(MOCK_USDC_ARTIFACT, [6]);
  const vault = await deploy(VAULT_ARTIFACT, [token, owner.address, kernel.address, guardian.address, CAP_PER_TX, CAP_DAILY, 0n, HUMAN_THRESHOLD, PAYEE_DELAY, SIGNER_DELAY]);

  const w: VaultWorld = {
    anvil,
    url: anvil.url,
    pub,
    wallet,
    dev,
    relayerAccount,
    token,
    vault,
    owner,
    payee,
    kernel,
    guardian,
    chainId: 31337,
    async signTyped(p, td) {
      const t = td as { domain: { chainId: number; verifyingContract: Address; name: string; version: string }; primaryType: keyof typeof EIP712_TYPES; message: Record<string, unknown> };
      const fields = EIP712_TYPES[t.primaryType];
      const message: Record<string, unknown> = {};
      for (const f of fields) {
        const v = t.message[f.name];
        message[f.name] = /^uint\d+$/.test(f.type) ? BigInt(v as string) : v;
      }
      return p.account.signTypedData({
        domain: { ...t.domain, chainId: BigInt(t.domain.chainId) },
        types: { [t.primaryType]: EIP712_TYPES[t.primaryType] },
        primaryType: t.primaryType,
        message,
      } as never);
    },
    async mine(n) {
      await dev.mine({ blocks: n });
    },
    async warp(seconds) {
      await dev.increaseTime({ seconds });
      await dev.mine({ blocks: 1 });
    },
    async ownerTx(functionName, args) {
      // The owner key is a throwaway with no balance: fund it on the local chain, then send from it.
      await dev.setBalance({ address: owner.address, value: 10n ** 20n });
      const hash = await wallet.writeContract({ address: vault, abi: symbolonVaultAbi as Abi, functionName, args: [...args], account: owner.account, chain });
      await pub.waitForTransactionReceipt({ hash });
      return hash;
    },
    stop: () => anvil.stop(),
  };
  return w;
}
