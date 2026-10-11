// @symbolon/chain — Money, ABIs, event decoders, Arc config (owner: CHAIN, WP-06).
// Anvil test helpers are NOT exported here: import them from "@symbolon/chain/anvil".
export const PACKAGE_NAME = "@symbolon/chain" as const;

export * from "./errors";
export * from "./money";
export * from "./fees";
export * from "./config";
export * from "./decimals";
export * from "./decoders";
export { symbolonVaultAbi } from "./abi/symbolonVault";
export { erc20Abi } from "viem";
