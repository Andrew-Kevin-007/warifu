// Arc network config and the deployments/*.json loader. Fail closed: unknown chain id, unknown network name,
// malformed or inconsistent deployment file -> ChainError, never a default. Token and vault addresses come
// only from the deployment file (AGENTS.md section 3); nothing is hardcoded here.
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, getAddress, http, isAddress, type Chain, type PublicClient } from "viem";
import * as z from "zod";
import { ChainError } from "./errors";
import { MAX_DECIMALS, MAX_UINT256, money, type Money } from "./money";

/** Arc testnet chain id: docs/06 B.4, VERIFY_LOG V-20 (0x4cef52). */
export const ARC_TESTNET_CHAIN_ID = 5042002;
/** Local anvil / forge in-process chain. */
export const LOCAL_CHAIN_ID = 31337;

// VERIFY(V-03): the Arc mainnet chain id is not hardcoded. The operator supplies it (ARC_MAINNET_CHAIN_ID, taken from
// the Arc docs' network page) and it is accepted only where passed in explicitly (`mainnetChainId`); at boot the kernel
// compares it with the live RPC's eth_chainId (verifyRpcChainId), so a wrong id or a wrong RPC stops the process.
// Without that option every unknown chain id is still UNKNOWN_CHAIN, exactly as before.
export const NETWORKS = ["mainnet", "testnet", "local"] as const;
export type NetworkName = (typeof NETWORKS)[number];

export interface NetworkOptions {
  /** Operator-supplied Arc mainnet chain id (ARC_MAINNET_CHAIN_ID). Absent = mainnet is refused. */
  readonly mainnetChainId?: number;
}

const CHAIN_ID_TO_NETWORK: Readonly<Record<number, NetworkName>> = {
  [ARC_TESTNET_CHAIN_ID]: "testnet",
  [LOCAL_CHAIN_ID]: "local",
};

/** A mainnet chain id must be a positive safe integer and must not collide with testnet or local. */
export function checkMainnetChainId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ChainError("BAD_CONFIG", "mainnet chain id must be a positive integer");
  if (Object.hasOwn(CHAIN_ID_TO_NETWORK, id)) throw new ChainError("BAD_CONFIG", "mainnet chain id collides with the testnet or local chain id");
  return id;
}

export function networkForChainId(chainId: number, opts: NetworkOptions = {}): NetworkName {
  const network = Object.hasOwn(CHAIN_ID_TO_NETWORK, chainId) ? CHAIN_ID_TO_NETWORK[chainId] : undefined;
  if (network !== undefined) return network;
  if (opts.mainnetChainId !== undefined && chainId === checkMainnetChainId(opts.mainnetChainId)) return "mainnet";
  throw new ChainError("UNKNOWN_CHAIN", `chain id ${String(chainId)} is not a known Arc/local chain (mainnet needs ARC_MAINNET_CHAIN_ID, V-03)`);
}

export function chainIdForNetwork(network: string, opts: NetworkOptions = {}): number {
  switch (network) {
    case "testnet":
      return ARC_TESTNET_CHAIN_ID;
    case "local":
      return LOCAL_CHAIN_ID;
    case "mainnet":
      if (opts.mainnetChainId === undefined) throw new ChainError("UNKNOWN_CHAIN", "mainnet needs ARC_MAINNET_CHAIN_ID (V-03)");
      return checkMainnetChainId(opts.mainnetChainId);
    default:
      throw new ChainError("UNKNOWN_CHAIN", `unknown network ${JSON.stringify(network.slice(0, 20))}`);
  }
}

/** Parse ARC_MAINNET_CHAIN_ID from an env-like object; undefined when unset. */
export function mainnetChainIdFromEnv(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env.ARC_MAINNET_CHAIN_ID;
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) throw new ChainError("BAD_CONFIG", "ARC_MAINNET_CHAIN_ID must be a positive decimal integer");
  return checkMainnetChainId(Number.parseInt(raw, 10));
}

export interface ArcConfig {
  readonly network: NetworkName;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly chain: Chain;
}

function checkRpcUrl(network: NetworkName, rpcUrl: string): string {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch (cause) {
    throw new ChainError("BAD_CONFIG", "RPC URL is not a valid URL", { cause });
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ChainError("BAD_CONFIG", "RPC URL must be https (plain http only for loopback)");
  }
  if (network !== "local" && loopback) {
    throw new ChainError("BAD_CONFIG", `a loopback RPC URL is not valid for network ${network}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ChainError("BAD_CONFIG", "RPC URL must not embed credentials");
  }
  return url.toString();
}

/** Build a viem Chain for a known network. Gas is native USDC with 18 decimals (AGENTS.md section 3). */
export function arcChain(network: NetworkName, rpcUrl: string, opts: NetworkOptions = {}): Chain {
  const checked = checkRpcUrl(network, rpcUrl);
  return defineChain({
    id: chainIdForNetwork(network, opts),
    name: network === "mainnet" ? "Arc" : network === "testnet" ? "Arc Testnet" : "Local (anvil)",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [checked] } },
  });
}

/**
 * Read NETWORK / ARC_RPC_URL (docs/06 B.5) from an env-like object. `local` may omit the URL (anvil default
 * port); testnet must supply ARC_RPC_URL. `mainnet` takes its own variables, ARC_MAINNET_CHAIN_ID and
 * ARC_MAINNET_RPC_URL (https), and refuses a stray ARC_RPC_URL so a testnet endpoint can never be picked up for
 * mainnet by accident. The caller must still run verifyRpcChainId against the live node.
 */
export function arcConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ArcConfig {
  const networkName = env.NETWORK;
  if (networkName === undefined || networkName === "") {
    throw new ChainError("BAD_CONFIG", "NETWORK is not set (mainnet|testnet|local)");
  }
  const mainnetChainId = networkName === "mainnet" ? mainnetChainIdFromEnv(env) : undefined;
  const opts: NetworkOptions = mainnetChainId === undefined ? {} : { mainnetChainId };
  const chainId = chainIdForNetwork(networkName, opts);
  const network = networkForChainId(chainId, opts);
  let rpc: string | undefined;
  if (network === "mainnet") {
    if (env.ARC_RPC_URL !== undefined && env.ARC_RPC_URL !== "") {
      throw new ChainError("BAD_CONFIG", "ARC_RPC_URL must be unset on mainnet (use ARC_MAINNET_RPC_URL)");
    }
    rpc = env.ARC_MAINNET_RPC_URL;
  } else {
    rpc = env.ARC_RPC_URL;
  }
  const rpcUrl = rpc !== undefined && rpc !== "" ? rpc : network === "local" ? "http://127.0.0.1:8545" : undefined;
  if (rpcUrl === undefined) throw new ChainError("BAD_CONFIG", network === "mainnet" ? "ARC_MAINNET_RPC_URL is not set" : "ARC_RPC_URL is not set");
  const chain = arcChain(network, rpcUrl, opts);
  return { network, chainId, rpcUrl: checkRpcUrl(network, rpcUrl), chain };
}

export function createArcPublicClient(config: ArcConfig): PublicClient {
  return createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
}

/** Ask the node for its chain id and compare with the config. A wrong RPC must never be used silently. */
export async function verifyRpcChainId(client: Pick<PublicClient, "getChainId">, expected: number): Promise<void> {
  let actual: number;
  try {
    actual = await client.getChainId();
  } catch (cause) {
    throw new ChainError("RPC_ERROR", "eth_chainId failed", { cause });
  }
  if (actual !== expected) {
    throw new ChainError("CHAIN_ID_MISMATCH", `RPC reports chain id ${String(actual)}, expected ${String(expected)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// deployments/<network>.json  (written by contracts/script/Deploy.s.sol; docs/06 A.6, docs/16 section 2.4)
// ---------------------------------------------------------------------------------------------------------

export const DEPLOYMENTS_SCHEMA_ID = "symbolon-deployments/1";
export const PROFILES = ["production", "sandbox"] as const;
export type DeploymentProfile = (typeof PROFILES)[number];

const AddressText = z
  .string()
  .refine((s) => isAddress(s, { strict: true }), "not a valid address (bad checksum or shape)")
  .transform((s) => getAddress(s));
const NonZeroAddress = AddressText.refine((a) => a !== "0x0000000000000000000000000000000000000000", "zero address");
const Hex32Text = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex")
  .transform((s) => s.toLowerCase() as `0x${string}`);
// One refine (not regex + refine): zod 4 keeps running later checks after a failed one, and BigInt("25.5") throws.
const BaseUnitsText = z
  .string()
  .refine((s) => /^(0|[1-9][0-9]{0,77})$/.test(s) && BigInt(s) <= MAX_UINT256, "expected canonical base-unit integer string within uint256")
  .transform((s) => BigInt(s));
const SmallUint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const GroupSchema = z.strictObject({
  vault: NonZeroAddress,
  token: NonZeroAddress,
  tokenDecimals: z.number().int().min(0).max(MAX_DECIMALS),
  owner: NonZeroAddress,
  kernelSigner: NonZeroAddress,
  guardian: NonZeroAddress,
  caps: z.strictObject({
    perTxCap: BaseUnitsText,
    dailyCap: BaseUnitsText,
    hourlyCap: BaseUnitsText,
    humanThreshold: BaseUnitsText,
  }),
  payeeChangeDelay: SmallUint,
  signerChangeDelay: SmallUint,
  deployer: NonZeroAddress,
  chainId: z.number().int().positive(),
  configHash: Hex32Text,
  runtimeCodeHash: Hex32Text,
  artifactPath: z.string().min(1).max(300),
  gitSha: z.string().min(1).max(64),
  // The forge script cannot know these (Deploy.s.sol header); a deploy wrapper may add them.
  txHash: Hex32Text.optional(),
  blockNumber: SmallUint.optional(),
});

const FileSchema = z.strictObject({
  schema: z.literal(DEPLOYMENTS_SCHEMA_ID),
  network: z.string(),
  chainId: z.number().int().positive(),
  production: GroupSchema.nullable(),
  sandbox: GroupSchema.nullable(),
});

export interface DeploymentGroup {
  readonly profile: DeploymentProfile;
  readonly chainId: number;
  readonly vault: `0x${string}`;
  readonly token: `0x${string}`;
  readonly tokenDecimals: number;
  readonly owner: `0x${string}`;
  readonly kernelSigner: `0x${string}`;
  readonly guardian: `0x${string}`;
  readonly caps: {
    readonly perTxCap: Money;
    readonly dailyCap: Money;
    readonly hourlyCap: Money;
    readonly humanThreshold: Money;
  };
  readonly payeeChangeDelay: number;
  readonly signerChangeDelay: number;
  readonly deployer: `0x${string}`;
  readonly configHash: `0x${string}`;
  readonly runtimeCodeHash: `0x${string}`;
  readonly artifactPath: string;
  readonly gitSha: string;
  readonly txHash: `0x${string}` | undefined;
  readonly blockNumber: number | undefined;
}

export interface Deployments {
  readonly network: NetworkName;
  readonly chainId: number;
  readonly production: DeploymentGroup | null;
  readonly sandbox: DeploymentGroup | null;
}

function bad(message: string, cause?: unknown): ChainError {
  return new ChainError("BAD_DEPLOYMENT", message, cause === undefined ? undefined : { cause });
}

/** Validate an already-parsed deployments file. Pure. A mainnet file needs `opts.mainnetChainId` (V-03). */
export function parseDeployments(raw: unknown, opts: NetworkOptions = {}): Deployments {
  let parsed: ReturnType<typeof FileSchema.safeParse>;
  try {
    parsed = FileSchema.safeParse(raw);
  } catch (cause) {
    throw bad("deployments file could not be validated", cause);
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw bad(`malformed deployments file at ${first === undefined ? "?" : first.path.join(".") || "(root)"}: ${first?.message ?? "invalid"}`);
  }
  const file = parsed.data;
  const network = networkForChainId(file.chainId, opts);
  if (file.network !== network) throw bad(`network ${JSON.stringify(file.network.slice(0, 20))} does not match chain id ${String(file.chainId)} (${network})`);

  const groups: Record<DeploymentProfile, DeploymentGroup | null> = { production: null, sandbox: null };
  for (const profile of PROFILES) {
    const g = file[profile];
    if (g === null) continue;
    if (g.chainId !== file.chainId) throw bad(`${profile}.chainId ${String(g.chainId)} != file chainId ${String(file.chainId)}`);
    if (g.vault === g.token) throw bad(`${profile}: vault and token are the same address`);
    const d = g.tokenDecimals;
    groups[profile] = {
      profile,
      chainId: g.chainId,
      vault: g.vault,
      token: g.token,
      tokenDecimals: d,
      owner: g.owner,
      kernelSigner: g.kernelSigner,
      guardian: g.guardian,
      caps: {
        perTxCap: money(g.caps.perTxCap, d),
        dailyCap: money(g.caps.dailyCap, d),
        hourlyCap: money(g.caps.hourlyCap, d),
        humanThreshold: money(g.caps.humanThreshold, d),
      },
      payeeChangeDelay: g.payeeChangeDelay,
      signerChangeDelay: g.signerChangeDelay,
      deployer: g.deployer,
      configHash: g.configHash,
      runtimeCodeHash: g.runtimeCodeHash,
      artifactPath: g.artifactPath,
      gitSha: g.gitSha,
      txHash: g.txHash,
      blockNumber: g.blockNumber,
    };
  }

  // SEC-04: production and sandbox never share a vault, owner, kernel signer or guardian address.
  const prod = groups.production;
  const sand = groups.sandbox;
  if (prod !== null && sand !== null) {
    const pick = (g: DeploymentGroup) => [g.vault, g.owner, g.kernelSigner, g.guardian];
    const prodSet = new Set(pick(prod));
    for (const a of pick(sand)) {
      if (prodSet.has(a)) throw bad(`production and sandbox share address ${a} (SEC-04)`);
    }
  }
  return { network, chainId: file.chainId, production: prod, sandbox: sand };
}

/** Read and validate deployments/<network>.json from disk. */
export function loadDeployments(path: string, opts: NetworkOptions = {}): Deployments {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw bad(`cannot read deployments file ${path}`, cause);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw bad(`deployments file ${path} is not valid JSON`, cause);
  }
  return parseDeployments(raw, opts);
}

/** Pick one profile's group; a missing (null) group is an error, not a fallback to the other profile. */
export function selectDeployment(deployments: Deployments, profile: DeploymentProfile): DeploymentGroup {
  const group = deployments[profile];
  if (group === null) throw bad(`no ${profile} deployment recorded on ${deployments.network}`);
  return group;
}
