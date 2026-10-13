// Argument parsing for `pnpm verify-receipt <file|hash> [options]`. Strict: unknown options, repeated options, missing
// pins and contradictory options are usage errors (exit 2), never silently ignored. Pure (no I/O): `parseArgs` of
// node:util only reads the array it is given.
import { parseArgs } from "node:util";
import { getAddress, isAddress } from "viem";
import type { Address, Hex32 } from "@symbolon/schemas";

export const USAGE = `usage: verify-receipt <receipt.json | 0x<receiptHash>> [options]

Checks a Symbolon receipt: strict schema, receiptHash recomputed from the content (RFC 8785 JCS + keccak256), EIP-712
Receipt signature, signer pin, and (with --rpc) the vault's on-chain Released event.

  --vault <address>        the vault the receipt was signed for (EIP-712 verifyingContract)   [required]
  --chain-id <n>           EIP-712 chainId (read from --rpc when omitted)
  --signer <address>       the expected kernel signer; default with --rpc: the vault's kernelSigner()
  --allow-unpinned-signer  accept a signer nobody pinned (proves only that SOME key signed these exact bytes)
  --rpc <url>              also read the chain: domain separator, kernel signer, token decimals, Released anchor
  --from-block <n>         first block to search for the Released event (default 0)
  --log-range <n>          search in chunks of n blocks (for RPCs that cap eth_getLogs ranges)
  --url <base>             where to fetch a receipt by hash: <base>/api/public/receipt/<hash>
  --json                   machine-readable output
  -h, --help               this text

exit codes: 0 verified, 1 NOT verified, 2 usage or input error`;

export type CliInput =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "hash"; readonly hash: Hex32; readonly baseUrl: string };

/** Where the EIP-712 chain id comes from, and whether the chain is read. */
export type CliChain =
  | { readonly kind: "offline"; readonly chainId: number }
  | {
      readonly kind: "rpc";
      readonly rpc: string;
      /** If given, must equal the RPC's chain id. */
      readonly chainId: number | undefined;
      readonly fromBlock: bigint;
      readonly logRange: bigint | undefined;
    };

export interface CliOptions {
  readonly input: CliInput;
  readonly vault: Address;
  readonly chain: CliChain;
  readonly signer: Address | undefined;
  readonly allowUnpinnedSigner: boolean;
  readonly json: boolean;
}

export type ParsedArgs =
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string }
  | { readonly kind: "run"; readonly options: CliOptions };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_ID_RE = /^[1-9][0-9]{0,15}$/;
const BLOCK_RE = /^(0|[1-9][0-9]{0,15})$/;
const RANGE_RE = /^[1-9][0-9]{0,9}$/;

function usageError(message: string): ParsedArgs {
  return { kind: "usage-error", message };
}

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function address(text: string): Address | null {
  return isAddress(text) ? getAddress(text) : null;
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let values;
  let positionals;
  let tokens;
  try {
    ({ values, positionals, tokens } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        vault: { type: "string" },
        "chain-id": { type: "string" },
        signer: { type: "string" },
        "allow-unpinned-signer": { type: "boolean" },
        rpc: { type: "string" },
        "from-block": { type: "string" },
        "log-range": { type: "string" },
        url: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    return usageError("unknown or incomplete option");
  }
  // node:util lets a repeated option silently overwrite the earlier one; a verifier must not.
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== "option") continue;
    if (seen.has(t.name)) return usageError("an option was given twice");
    seen.add(t.name);
  }
  if (values.help === true) return { kind: "help" };
  const [first, ...more] = positionals;
  if (first === undefined || more.length > 0) return usageError("expected exactly one receipt file or receipt hash");

  if (values.vault === undefined) return usageError("--vault is required (the EIP-712 domain is the vault's)");
  const vault = address(values.vault);
  if (vault === null) return usageError("--vault is not a valid address (a mixed-case address must carry a correct EIP-55 checksum)");

  let signer: Address | undefined;
  if (values.signer !== undefined) {
    const s = address(values.signer);
    if (s === null) return usageError("--signer is not a valid address (a mixed-case address must carry a correct EIP-55 checksum)");
    signer = s;
  }

  let chainId: number | undefined;
  if (values["chain-id"] !== undefined) {
    const parsed = CHAIN_ID_RE.test(values["chain-id"]) ? parseInt(values["chain-id"], 10) : 0;
    if (!Number.isSafeInteger(parsed) || parsed < 1) return usageError("--chain-id must be a positive integer");
    chainId = parsed;
  }

  let input: CliInput;
  if (HASH_RE.test(first)) {
    if (values.url === undefined) return usageError("a receipt hash needs --url <base> to fetch it from");
    if (!isHttpUrl(values.url)) return usageError("--url must be an http(s) URL");
    input = { kind: "hash", hash: first.toLowerCase() as Hex32, baseUrl: values.url.replace(/\/+$/, "") };
  } else {
    if (values.url !== undefined) return usageError("--url only applies when the input is a receipt hash");
    input = { kind: "file", path: first };
  }

  let chain: CliChain;
  if (values.rpc !== undefined) {
    if (!isHttpUrl(values.rpc)) return usageError("--rpc must be an http(s) URL");
    if (values["from-block"] !== undefined && !BLOCK_RE.test(values["from-block"])) return usageError("--from-block must be a non-negative integer");
    if (values["log-range"] !== undefined && !RANGE_RE.test(values["log-range"])) return usageError("--log-range must be a positive integer");
    chain = {
      kind: "rpc",
      rpc: values.rpc,
      chainId,
      fromBlock: values["from-block"] === undefined ? 0n : BigInt(values["from-block"]),
      logRange: values["log-range"] === undefined ? undefined : BigInt(values["log-range"]),
    };
  } else {
    if (values["from-block"] !== undefined || values["log-range"] !== undefined) return usageError("--from-block and --log-range only apply with --rpc");
    if (chainId === undefined) return usageError("give --chain-id, or --rpc to read it from the chain");
    chain = { kind: "offline", chainId };
  }

  const allowUnpinnedSigner = values["allow-unpinned-signer"] === true;
  if (signer === undefined && chain.kind === "offline" && !allowUnpinnedSigner) {
    return usageError("pin the signer: --signer <address>, or --rpc to read the vault's kernelSigner(), or --allow-unpinned-signer");
  }

  return { kind: "run", options: { input, vault, chain, signer, allowUnpinnedSigner, json: values.json === true } };
}
