import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import {
  ARC_MIN_MAX_FEE_PER_GAS,
  ARC_TESTNET_CHAIN_ID,
  ChainError,
  LOCAL_CHAIN_ID,
  arcChain,
  arcConfigFromEnv,
  assertFeeFloor,
  chainIdForNetwork,
  loadDeployments,
  money,
  networkForChainId,
  parseDeployments,
  selectDeployment,
  verifyRpcChainId,
  withFeeFloor,
  type ChainErrorCode,
} from "../src/index";

function code(fn: () => unknown): ChainErrorCode | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    if (e instanceof ChainError) return e.code;
    throw e;
  }
}

// Obviously fake addresses (repeated bytes); never real accounts.
const addr = (b: string) => getAddress(`0x${b.repeat(20)}`);
const hex32 = (b: string) => `0x${b.repeat(32)}`;

function group(seed: number, chainId = ARC_TESTNET_CHAIN_ID): Record<string, unknown> {
  const h = (n: number) => (seed * 16 + n).toString(16).padStart(2, "0");
  return {
    vault: addr(h(1)),
    token: addr("aa"),
    tokenDecimals: 6,
    owner: addr(h(2)),
    kernelSigner: addr(h(3)),
    guardian: addr(h(4)),
    caps: { perTxCap: "25000000", dailyCap: "60000000", hourlyCap: "0", humanThreshold: "20000000" },
    payeeChangeDelay: 172800,
    signerChangeDelay: 86400,
    deployer: addr(h(5)),
    chainId,
    configHash: hex32("11"),
    runtimeCodeHash: hex32("22"),
    artifactPath: "contracts/out/SymbolonVault.sol/SymbolonVault.json",
    gitSha: "abc1234",
  };
}

function without(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...o };
  delete copy[key];
  return copy;
}

function file(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "symbolon-deployments/1", network: "testnet", chainId: ARC_TESTNET_CHAIN_ID, production: group(1), sandbox: group(2), ...over };
}

describe("chain ids and networks", () => {
  it("knows exactly testnet 5042002 and local 31337 (V-20)", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
    expect(ARC_TESTNET_CHAIN_ID).toBe(0x4cef52);
    expect(networkForChainId(5042002)).toBe("testnet");
    expect(networkForChainId(31337)).toBe("local");
    expect(chainIdForNetwork("testnet")).toBe(5042002);
    expect(LOCAL_CHAIN_ID).toBe(31337);
  });

  it.each([1, 0, -1, 5042003, 42161, 1.5, Number.NaN])("rejects unknown chain id %s", (id) => {
    expect(code(() => networkForChainId(id))).toBe("UNKNOWN_CHAIN");
  });

  it.each(["mainnet", "", "Testnet", "__proto__", "constructor"])("rejects network name %j (mainnet id unverified, V-03)", (n) => {
    expect(code(() => chainIdForNetwork(n))).toBe("UNKNOWN_CHAIN");
  });

  it("does not resolve prototype keys as chain ids", () => {
    expect(code(() => networkForChainId("constructor" as unknown as number))).toBe("UNKNOWN_CHAIN");
  });
});

describe("arcChain / arcConfigFromEnv", () => {
  it("builds the testnet chain with 18-decimal native USDC gas", () => {
    const c = arcChain("testnet", "https://rpc.example.invalid/");
    expect(c.id).toBe(5042002);
    expect(c.nativeCurrency).toEqual({ name: "USDC", symbol: "USDC", decimals: 18 });
  });

  it("reads NETWORK and ARC_RPC_URL; local defaults to loopback", () => {
    expect(arcConfigFromEnv({ NETWORK: "testnet", ARC_RPC_URL: "https://rpc.example.invalid/x" })).toMatchObject({ network: "testnet", chainId: 5042002 });
    expect(arcConfigFromEnv({ NETWORK: "local" })).toMatchObject({ network: "local", chainId: 31337, rpcUrl: "http://127.0.0.1:8545/" });
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["no NETWORK", {}],
    ["empty NETWORK", { NETWORK: "" }],
    ["mainnet (V-03)", { NETWORK: "mainnet", ARC_RPC_URL: "https://rpc.example.invalid/" }],
    ["testnet without RPC", { NETWORK: "testnet" }],
    ["plain http for testnet", { NETWORK: "testnet", ARC_RPC_URL: "http://rpc.example.invalid/" }],
    ["loopback for testnet", { NETWORK: "testnet", ARC_RPC_URL: "http://127.0.0.1:8545" }],
    ["embedded credentials", { NETWORK: "testnet", ARC_RPC_URL: "https://user:pw@rpc.example.invalid/" }],
    ["not a URL", { NETWORK: "testnet", ARC_RPC_URL: "not a url" }],
    ["file URL", { NETWORK: "testnet", ARC_RPC_URL: "file:///etc/passwd" }],
  ])("rejects %s", (_name, env) => {
    expect(["BAD_CONFIG", "UNKNOWN_CHAIN"]).toContain(code(() => arcConfigFromEnv(env)));
  });
});

describe("verifyRpcChainId", () => {
  const client = (id: number | Error) => ({
    getChainId: () => (id instanceof Error ? Promise.reject(id) : Promise.resolve(id)),
  });
  it("accepts a matching chain id", async () => {
    await expect(verifyRpcChainId(client(5042002), 5042002)).resolves.toBeUndefined();
  });
  it("rejects a mismatch and an RPC failure", async () => {
    await expect(verifyRpcChainId(client(1), 5042002)).rejects.toMatchObject({ code: "CHAIN_ID_MISMATCH" });
    await expect(verifyRpcChainId(client(new Error("down")), 5042002)).rejects.toMatchObject({ code: "RPC_ERROR" });
  });
});

describe("deployments loader", () => {
  it("parses a valid file into checksummed addresses and Money caps at the token's decimals", () => {
    const d = parseDeployments(file());
    expect(d.network).toBe("testnet");
    const sb = selectDeployment(d, "sandbox");
    expect(sb.vault).toBe(addr("21"));
    expect(sb.caps.perTxCap).toEqual(money(25_000_000n, 6));
    expect(sb.caps.hourlyCap).toEqual(money(0n, 6));
    expect(sb.tokenDecimals).toBe(6);
    expect(sb.txHash).toBeUndefined();
  });

  it("accepts all-lowercase addresses and normalises them to EIP-55", () => {
    const g = group(1);
    g.token = String(g.token).toLowerCase();
    expect(parseDeployments(file({ production: g })).production?.token).toBe(addr("aa"));
  });

  it("a null group is allowed, but selecting it is an error (no fallback to the other profile)", () => {
    const d = parseDeployments(file({ production: null }));
    expect(d.production).toBeNull();
    expect(code(() => selectDeployment(d, "production"))).toBe("BAD_DEPLOYMENT");
    expect(selectDeployment(d, "sandbox").profile).toBe("sandbox");
  });

  it("accepts the optional txHash / blockNumber", () => {
    const g = { ...group(1), txHash: hex32("ab"), blockNumber: 123 };
    const p = parseDeployments(file({ production: g })).production;
    expect(p?.txHash).toBe(hex32("ab"));
    expect(p?.blockNumber).toBe(123);
  });

  it("local network file", () => {
    const d = parseDeployments(file({ network: "local", chainId: 31337, production: null, sandbox: group(2, 31337) }));
    expect(d.network).toBe("local");
  });

  const bad: [string, () => unknown][] = [
    ["not an object", () => "x"],
    ["null", () => null],
    ["wrong schema id", () => file({ schema: "symbolon-deployments/2" })],
    ["unknown chain id", () => file({ chainId: 1 })],
    ["network name disagrees with chain id", () => file({ network: "local" })],
    ["mainnet-named file", () => file({ network: "mainnet", chainId: 1 })],
    ["group chain id disagrees", () => file({ production: group(1, 31337) })],
    ["extra top-level key", () => file({ extra: 1 })],
    ["extra group key", () => file({ production: { ...group(1), extra: true } })],
    ["missing vault", () => file({ production: without(group(1), "vault") })],
    ["bad checksum (mixed case)", () => file({ production: { ...group(1), vault: "0x" + "aB".repeat(20) } })],
    ["not an address", () => file({ production: { ...group(1), owner: "0x1234" } })],
    ["zero address", () => file({ production: { ...group(1), guardian: "0x" + "00".repeat(20) } })],
    ["vault equals token", () => file({ production: { ...group(1), token: addr("11") } })],
    ["decimals 255", () => file({ production: { ...group(1), tokenDecimals: 255 } })],
    ["decimals as string", () => file({ production: { ...group(1), tokenDecimals: "6" } })],
    ["cap as number", () => file({ production: { ...group(1), caps: { perTxCap: 25000000, dailyCap: "1", hourlyCap: "0", humanThreshold: "1" } } })],
    ["cap with leading zero", () => file({ production: { ...group(1), caps: { perTxCap: "025", dailyCap: "1", hourlyCap: "0", humanThreshold: "1" } } })],
    ["cap with decimal point", () => file({ production: { ...group(1), caps: { perTxCap: "25.5", dailyCap: "1", hourlyCap: "0", humanThreshold: "1" } } })],
    ["cap above uint256", () => file({ production: { ...group(1), caps: { perTxCap: (2n ** 256n).toString(), dailyCap: "1", hourlyCap: "0", humanThreshold: "1" } } })],
    ["configHash wrong length", () => file({ production: { ...group(1), configHash: "0x1234" } })],
    ["negative delay", () => file({ production: { ...group(1), payeeChangeDelay: -1 } })],
    ["SEC-04: shared kernel signer across profiles", () => file({ sandbox: { ...group(2), kernelSigner: group(1).kernelSigner } })],
    ["SEC-04: sandbox owner is the production vault", () => file({ sandbox: { ...group(2), owner: group(1).vault } })],
  ];
  it.each(bad)("rejects: %s", (_name, make) => {
    expect(code(() => parseDeployments(make()))).toMatch(/^(BAD_DEPLOYMENT|UNKNOWN_CHAIN)$/);
  });

  it("the token may be shared across profiles (same USDC), unlike vault/owner/signer/guardian", () => {
    expect(() => parseDeployments(file())).not.toThrow(); // both groups use addr("aa") as token
  });

  describe("from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "chain-deployments-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("loads a file, and rejects a missing file, invalid JSON and an empty file", () => {
      const ok = join(dir, "testnet.json");
      writeFileSync(ok, JSON.stringify(file()));
      expect(loadDeployments(ok).sandbox?.vault).toBe(addr("21"));
      expect(code(() => loadDeployments(join(dir, "missing.json")))).toBe("BAD_DEPLOYMENT");
      const garbage = join(dir, "garbage.json");
      writeFileSync(garbage, "{not json");
      expect(code(() => loadDeployments(garbage))).toBe("BAD_DEPLOYMENT");
      const empty = join(dir, "empty.json");
      writeFileSync(empty, "");
      expect(code(() => loadDeployments(empty))).toBe("BAD_DEPLOYMENT");
    });
  });
});

describe("Arc fee floor (V-20)", () => {
  it("is 20 gwei", () => {
    expect(ARC_MIN_MAX_FEE_PER_GAS).toBe(20n * 10n ** 9n);
  });
  it("withFeeFloor raises low fees, keeps high ones, defaults undefined to the floor", () => {
    expect(withFeeFloor(1n)).toBe(ARC_MIN_MAX_FEE_PER_GAS);
    expect(withFeeFloor(0n)).toBe(ARC_MIN_MAX_FEE_PER_GAS);
    expect(withFeeFloor(ARC_MIN_MAX_FEE_PER_GAS)).toBe(ARC_MIN_MAX_FEE_PER_GAS);
    expect(withFeeFloor(ARC_MIN_MAX_FEE_PER_GAS + 1n)).toBe(ARC_MIN_MAX_FEE_PER_GAS + 1n);
    expect(withFeeFloor(undefined)).toBe(ARC_MIN_MAX_FEE_PER_GAS);
    expect(code(() => withFeeFloor(-1n))).toBe("FEE_BELOW_FLOOR");
  });
  it("assertFeeFloor is exact at the boundary", () => {
    expect(code(() => assertFeeFloor(ARC_MIN_MAX_FEE_PER_GAS - 1n))).toBe("FEE_BELOW_FLOOR");
    expect(code(() => assertFeeFloor(ARC_MIN_MAX_FEE_PER_GAS))).toBe("no-throw");
    expect(code(() => assertFeeFloor(20 as unknown as bigint))).toBe("FEE_BELOW_FLOOR");
  });
});
