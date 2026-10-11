// Test helpers for a local anvil node (time travel, impersonation, funding). Import via "@symbolon/chain/anvil",
// never from the package root, so production code does not pull them in. Every helper first checks that the
// node reports chain id 31337 and refuses to run otherwise: an anvil_* / evm_* call aimed at a real chain
// would either fail or, worse, mislead a test into thinking it had time-travelled.
import { createTestClient, http, publicActions, type Address, type Hex } from "viem";
import { ChainError } from "./errors";
import { LOCAL_CHAIN_ID } from "./config";

export type AnvilClient = ReturnType<typeof createAnvilClient>;

export function createAnvilClient(rpcUrl: string) {
  const url = new URL(rpcUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new ChainError("NOT_LOCAL_CHAIN", "anvil helpers only connect to a loopback URL");
  }
  return createTestClient({ mode: "anvil", transport: http(rpcUrl) }).extend(publicActions);
}

/** Throws NOT_LOCAL_CHAIN unless the node is chain 31337. */
export async function assertLocalChain(client: AnvilClient): Promise<void> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (cause) {
    throw new ChainError("RPC_ERROR", "eth_chainId failed", { cause });
  }
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new ChainError("NOT_LOCAL_CHAIN", `node reports chain id ${String(chainId)}, anvil helpers need ${String(LOCAL_CHAIN_ID)}`);
  }
}

function assertPositiveSeconds(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new ChainError("INVALID_AMOUNT", "seconds must be a non-negative safe integer");
}

/** Advance chain time by `seconds` and mine one block so `block.timestamp` reflects it. */
export async function increaseTime(client: AnvilClient, seconds: number): Promise<void> {
  assertPositiveSeconds(seconds);
  await assertLocalChain(client);
  await client.increaseTime({ seconds });
  await client.mine({ blocks: 1 });
}

/** Set the timestamp of the next block (must be later than the current block's). */
export async function setNextBlockTimestamp(client: AnvilClient, timestamp: bigint): Promise<void> {
  await assertLocalChain(client);
  await client.setNextBlockTimestamp({ timestamp });
}

export async function mine(client: AnvilClient, blocks = 1): Promise<void> {
  if (!Number.isSafeInteger(blocks) || blocks < 1) throw new ChainError("INVALID_AMOUNT", "blocks must be a positive safe integer");
  await assertLocalChain(client);
  await client.mine({ blocks });
}

export async function impersonate(client: AnvilClient, address: Address): Promise<void> {
  await assertLocalChain(client);
  await client.impersonateAccount({ address });
}

export async function stopImpersonating(client: AnvilClient, address: Address): Promise<void> {
  await assertLocalChain(client);
  await client.stopImpersonatingAccount({ address });
}

/** Impersonate `address` for the duration of `fn`, always stopping afterwards. */
export async function withImpersonation<T>(client: AnvilClient, address: Address, fn: () => Promise<T>): Promise<T> {
  await impersonate(client, address);
  try {
    return await fn();
  } finally {
    await stopImpersonating(client, address);
  }
}

/** Give an account native gas balance (wei at 18 decimals; test funding only, never a token amount). */
export async function setNativeBalance(client: AnvilClient, address: Address, weiAmount: bigint): Promise<void> {
  if (typeof weiAmount !== "bigint" || weiAmount < 0n) throw new ChainError("INVALID_AMOUNT", "balance must be a non-negative bigint");
  await assertLocalChain(client);
  await client.setBalance({ address, value: weiAmount });
}

export async function snapshot(client: AnvilClient): Promise<Hex> {
  await assertLocalChain(client);
  return client.snapshot();
}

export async function revertTo(client: AnvilClient, id: Hex): Promise<void> {
  await assertLocalChain(client);
  await client.revert({ id });
}
