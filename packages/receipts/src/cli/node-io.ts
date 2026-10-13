// The process edge of `verify-receipt`: files, HTTP and JSON-RPC. Everything here is a thin adapter around the injected
// CliIo/ChainReader interfaces in run.ts; the decisions live there and are tested with fakes. Read-only: it never sends a
// transaction and holds no key.
import { readFile } from "node:fs/promises";
import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { symbolonVaultAbi, type RawLog } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import type { ChainReader, CliIo } from "./run";

const FETCH_TIMEOUT_MS = 15_000;
const RELEASED = parseAbiItem(
  "event Released(bytes32 indexed intentId, bytes32 indexed engagementId, address indexed payee, uint256 amount, bytes32 receiptHash)",
);

async function readBounded(path: string, maxBytes: number): Promise<Uint8Array> {
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error("FILE_TOO_LARGE");
  return new Uint8Array(bytes);
}

async function fetchBounded(url: string, maxBytes: number): Promise<string> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const declared = Number.parseInt(res.headers.get("content-length") ?? "0", 10);
  if (declared > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function chainReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: FETCH_TIMEOUT_MS, retryCount: 1 }) });
  const read = <T>(address: Address, functionName: "kernelSigner" | "tokenDecimals" | "domainSeparator"): Promise<T> =>
    client.readContract({ address, abi: symbolonVaultAbi, functionName } as never) as Promise<T>;
  return {
    chainId: () => client.getChainId(),
    kernelSigner: (vault) => read<Address>(vault, "kernelSigner"),
    tokenDecimals: async (vault) => Number.parseInt(String(await read<number | bigint>(vault, "tokenDecimals")), 10),
    domainSeparator: (vault) => read<Hex32>(vault, "domainSeparator"),
    latestBlock: () => client.getBlockNumber(),
    async releasedLogs(vault, intentId, fromBlock, toBlock): Promise<RawLog[]> {
      const logs = await client.getLogs({ address: vault, event: RELEASED, args: { intentId: intentId as Hex }, fromBlock, toBlock });
      return logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
        removed: l.removed,
      }));
    },
  };
}

export const nodeIo: CliIo = {
  readFile: readBounded,
  fetchText: fetchBounded,
  chain: chainReader,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};
