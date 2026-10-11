// Token decimals are read on-chain, never assumed (V-04: Arc's ERC-20 USDC interface is 6 decimals, native gas is 18).
import type { Address, PublicClient } from "viem";
import { erc20Abi } from "viem";
import { symbolonVaultAbi } from "./abi/symbolonVault";
import { ChainError } from "./errors";
import { isValidDecimals, money, type Money } from "./money";

type Reader = Pick<PublicClient, "readContract">;

/** Read `decimals()` from an ERC-20 and validate its range. */
export async function readTokenDecimals(client: Reader, token: Address): Promise<number> {
  let decimals: unknown;
  try {
    decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  } catch (cause) {
    throw new ChainError("RPC_ERROR", `decimals() call to ${token} failed`, { cause });
  }
  if (!isValidDecimals(decimals)) {
    throw new ChainError("INVALID_DECIMALS", `token ${token} reports decimals ${String(decimals)}`);
  }
  return decimals;
}

/** Throw DECIMALS_MISMATCH unless `actual === expected`. */
export function assertDecimalsEqual(actual: number, expected: number, what: string): void {
  if (actual !== expected) {
    throw new ChainError("DECIMALS_MISMATCH", `${what}: on-chain ${String(actual)} != expected ${String(expected)}`);
  }
}

export interface VerifiedToken {
  readonly token: Address;
  readonly decimals: number;
}

/**
 * Verify a vault's settlement token decimals three ways: the vault's immutable `tokenDecimals()` (read at
 * deploy), the token's live `decimals()`, and, when given, the decimals the caller expects (for example from
 * deployments/*.json). Any disagreement throws DECIMALS_MISMATCH. Returns the verified token and decimals.
 */
export async function assertTokenDecimals(client: Reader, vault: Address, expectedDecimals?: number): Promise<VerifiedToken> {
  let token: Address;
  let vaultDecimals: unknown;
  try {
    token = await client.readContract({ address: vault, abi: symbolonVaultAbi, functionName: "token" });
    vaultDecimals = await client.readContract({ address: vault, abi: symbolonVaultAbi, functionName: "tokenDecimals" });
  } catch (cause) {
    throw new ChainError("RPC_ERROR", `reading token/tokenDecimals from vault ${vault} failed`, { cause });
  }
  if (!isValidDecimals(vaultDecimals)) {
    throw new ChainError("INVALID_DECIMALS", `vault ${vault} reports tokenDecimals ${String(vaultDecimals)}`);
  }
  const live = await readTokenDecimals(client, token);
  assertDecimalsEqual(live, vaultDecimals, `token ${token} decimals() vs vault tokenDecimals()`);
  if (expectedDecimals !== undefined) assertDecimalsEqual(vaultDecimals, expectedDecimals, "vault tokenDecimals() vs expected");
  return { token, decimals: vaultDecimals };
}

/**
 * ERC-20 balance of `account` as Money. `expectedDecimals` is required: the token's live decimals must equal
 * it, so a balance can never be interpreted at the wrong scale. The native 18-decimal balance is not exposed.
 */
export async function getBalanceBaseUnits(client: Reader, token: Address, account: Address, expectedDecimals: number): Promise<Money> {
  const live = await readTokenDecimals(client, token);
  assertDecimalsEqual(live, expectedDecimals, `token ${token} decimals() vs expected`);
  let balance: bigint;
  try {
    balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  } catch (cause) {
    throw new ChainError("RPC_ERROR", `balanceOf(${account}) on ${token} failed`, { cause });
  }
  return money(balance, expectedDecimals);
}
