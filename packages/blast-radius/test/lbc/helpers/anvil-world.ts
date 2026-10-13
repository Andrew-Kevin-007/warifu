// A real local anvil (stock Foundry, V-19: not arc-anvil) with the real SymbolonVault and MockUSDC from contracts/out.
// Throwaway keys are generated per run; the relayer is anvil's first UNLOCKED account (no key in the repo).
// Anvil suites skip with a warning when anvil or contracts/out is missing, unless REQUIRE_ANVIL=1 or CI=true.
import { readFileSync, existsSync } from "node:fs";
import { arcChain, symbolonVaultAbi } from "@symbolon/chain";
import { createAnvilClient } from "@symbolon/chain/anvil";
import { EIP712_TYPES } from "@symbolon/schemas";
import type { Address, Hex32 } from "@symbolon/schemas";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, stringToBytes } from "viem";
import type { Abi, Hex, PublicClient, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { VAULT_ARTIFACT, MOCK_USDC_ARTIFACT } from "../../../../chain/test/helpers/artifacts";
import { anvilAvailable, startAnvil } from "../../../../chain/test/helpers/anvil-process";
import type { AnvilProcess } from "../../../../chain/test/helpers/anvil-process";
import { viemChainReader } from "../../../src/lbc/viem-reader";

export const USDC = 1_000_000n;
export { VAULT_ARTIFACT };

export function anvilSuiteEnabled(suite: string): boolean {
  const required = process.env["REQUIRE_ANVIL"] === "1" || process.env["CI"] === "true";
  if (!anvilAvailable()) {
    if (required) throw new Error(`[${suite}] anvil required but not found`);
    console.warn(`[${suite}] anvil not found: skipping`);
    return false;
  }
  if (!existsSync(VAULT_ARTIFACT) || !existsSync(MOCK_USDC_ARTIFACT)) {
    if (required) throw new Error(`[${suite}] contracts/out is missing: run forge build in contracts/`);
    console.warn(`[${suite}] contracts/out missing: skipping`);
    return false;
  }
  return true;
}

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
}
const art = (p: string): Artifact => JSON.parse(readFileSync(p, "utf8")) as Artifact;

export interface VaultConfig {
  perTxCap: bigint;
  dailyCap: bigint;
  hourlyCap: bigint;
  humanThreshold: bigint;
  payeeChangeDelay: number;
  signerChangeDelay: number;
}
export const DEFAULT_CONFIG: VaultConfig = { perTxCap: 100n * USDC, dailyCap: 200n * USDC, hourlyCap: 0n, humanThreshold: 50n * USDC, payeeChangeDelay: 172_800, signerChangeDelay: 86_400 };

const id32 = (label: string): Hex32 => keccak256(stringToBytes(label)) as Hex32;

export class World {
  readonly owner: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  readonly payee: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  readonly kernel: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  readonly kernel2: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  readonly guardian: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  readonly guardian2: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey());
  token!: Address;
  relayer!: Address;
  private n = 0;
  constructor(
    readonly anvil: AnvilProcess,
    readonly pub: PublicClient,
    readonly wallet: WalletClient,
    readonly dev: ReturnType<typeof createAnvilClient>,
  ) {}

  static async open(): Promise<World> {
    const anvil = await startAnvil();
    const chain = arcChain("local", anvil.url);
    const pub = createPublicClient({ chain, transport: http(anvil.url) }) as PublicClient;
    const wallet = createWalletClient({ chain, transport: http(anvil.url) });
    const w = new World(anvil, pub, wallet, createAnvilClient(anvil.url));
    w.relayer = getAddress((await wallet.getAddresses())[0]!);
    w.token = await w.deploy(MOCK_USDC_ARTIFACT, [6]);
    await w.dev.setBalance({ address: w.owner.address, value: 10n ** 20n });
    return w;
  }
  async close(): Promise<void> {
    await this.anvil.stop();
  }

  /** An independent reader: its own client and transport, as a counterparty would use. */
  reader() {
    const chain = arcChain("local", this.anvil.url);
    return viemChainReader(createPublicClient({ chain, transport: http(this.anvil.url) }) as PublicClient);
  }

  private async deploy(path: string, args: readonly unknown[]): Promise<Address> {
    const a = art(path);
    const hash = await this.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [...args], account: this.relayer, chain: this.wallet.chain });
    const r = await this.pub.waitForTransactionReceipt({ hash });
    return getAddress(r.contractAddress!);
  }

  async deployVault(cfg: Partial<VaultConfig> = {}): Promise<Address> {
    const c = { ...DEFAULT_CONFIG, ...cfg };
    return this.deploy(VAULT_ARTIFACT, [this.token, this.owner.address, this.kernel.address, this.guardian.address, c.perTxCap, c.dailyCap, c.hourlyCap, c.humanThreshold, c.payeeChangeDelay, c.signerChangeDelay]);
  }

  private async send(from: PrivateKeyAccount | null, to: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
    const hash = await this.wallet.writeContract({ address: to, abi, functionName, args: [...args], account: from ?? this.relayer, chain: this.wallet.chain });
    await this.pub.waitForTransactionReceipt({ hash });
  }
  private vaultTx(vault: Address, from: PrivateKeyAccount | null, fn: string, args: readonly unknown[] = []) {
    return this.send(from, vault, symbolonVaultAbi as unknown as Abi, fn, args);
  }

  async fund(vault: Address, amount: bigint): Promise<void> {
    await this.send(null, this.token, art(MOCK_USDC_ARTIFACT).abi, "mint", [vault, amount]);
  }
  async withdraw(vault: Address, amount: bigint): Promise<void> {
    await this.vaultTx(vault, this.owner, "withdraw", [this.owner.address, amount]);
  }
  async now(): Promise<bigint> {
    return (await this.pub.getBlock()).timestamp;
  }
  async warp(seconds: number): Promise<void> {
    await this.dev.increaseTime({ seconds });
    await this.dev.mine({ blocks: 1 });
  }

  /** Register an engagement co-signed by owner and payee. Window: now-1h .. now+30d. Returns its id. */
  async register(vault: Address, label: string, cap: bigint, over: { end?: bigint } = {}): Promise<Hex32> {
    const ts = await this.now();
    const engagementId = id32(`${label}:${String(this.n++)}`);
    const message = {
      engagementId,
      owner: this.owner.address,
      payee: this.payee.address,
      cap,
      start: ts - 3600n,
      end: over.end ?? ts + 30n * 86_400n,
      termsHash: id32(`terms:${label}`),
      nonce: 1n,
    };
    const domain = { name: "SymbolonVault", version: "1", chainId: 31337, verifyingContract: vault } as const;
    const types = { EngagementTerms: EIP712_TYPES.EngagementTerms };
    const ownerSig = await this.owner.signTypedData({ domain, types, primaryType: "EngagementTerms", message });
    const payeeSig = await this.payee.signTypedData({ domain, types, primaryType: "EngagementTerms", message });
    await this.vaultTx(vault, null, "registerEngagement", [message, ownerSig, payeeSig]);
    return engagementId;
  }
  closeEngagement(vault: Address, id: Hex32) {
    return this.vaultTx(vault, this.owner, "closeEngagement", [id]);
  }
  setGuardian(vault: Address) {
    return this.vaultTx(vault, this.owner, "setGuardian", [this.guardian2.address]);
  }
  pause(vault: Address) {
    return this.vaultTx(vault, this.owner, "pause");
  }
  unpause(vault: Address) {
    return this.vaultTx(vault, this.owner, "unpause");
  }
  async rotateSigner(vault: Address, signerDelay = DEFAULT_CONFIG.signerChangeDelay): Promise<void> {
    await this.vaultTx(vault, this.owner, "proposeKernelSigner", [this.kernel2.address]);
    await this.warp(signerDelay + 1);
    await this.vaultTx(vault, this.owner, "executeKernelSigner");
  }
  /** Release `amount` (<= humanThreshold, so no owner approval) with a kernel attestation. */
  async release(vault: Address, engagementId: Hex32, amount: bigint, label: string): Promise<void> {
    const ts = await this.now();
    const message = {
      intentId: id32(`intent:${label}:${String(this.n++)}`),
      engagementId,
      milestoneId: id32("milestone"),
      payee: this.payee.address,
      amount,
      receiptHash: id32("receipt"),
      deadline: ts + 600n,
    };
    const domain = { name: "SymbolonVault", version: "1", chainId: 31337, verifyingContract: vault } as const;
    const kernelSig = await this.kernel.signTypedData({ domain, types: { Attestation: EIP712_TYPES.Attestation }, primaryType: "Attestation", message });
    await this.vaultTx(vault, null, "release", [message, kernelSig, { receiptHash: id32("none"), deadline: 0n }, "0x"]);
  }
}
