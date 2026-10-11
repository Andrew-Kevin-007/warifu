// Real-anvil integration: deploys MockUSDC + SymbolonVault from the forge artifacts, drives real transactions
// and checks that the decoders round-trip the logs the node actually emitted.
// Needs `anvil` on PATH (or ANVIL_BIN). Without it the suite is skipped with a warning, unless REQUIRE_ANVIL=1
// or CI=true, in which case it runs and fails. Stock anvil (V-19), chain 31337.
import {
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  getAddress,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EIP712_TYPES } from "@symbolon/schemas";
import {
  ChainError,
  arcChain,
  assertTokenDecimals,
  decodeErc20Transfer,
  decodeVaultLog,
  decodeVaultLogs,
  decodeVaultRevertData,
  getBalanceBaseUnits,
  money,
  symbolonVaultAbi,
  vaultRevertName,
  type ChainErrorCode,
  type RawLog,
} from "../src/index";
import {
  createAnvilClient,
  increaseTime,
  setNativeBalance,
  snapshot,
  revertTo,
  withImpersonation,
} from "../src/anvil";
import { encodeVaultLog } from "./helpers/encode-log";
import { MOCK_USDC_ARTIFACT, VAULT_ARTIFACT, readArtifact } from "./helpers/artifacts";
import { anvilAvailable, startAnvil, type AnvilProcess } from "./helpers/anvil-process";

const required = process.env.REQUIRE_ANVIL === "1" || process.env.CI === "true";
const haveAnvil = anvilAvailable();
if (!haveAnvil && !required) {
  console.warn("[chain tests] anvil not found: skipping the real-anvil integration suite (set ANVIL_BIN, or REQUIRE_ANVIL=1 to make this fatal)");
}

async function codeOf(p: Promise<unknown>): Promise<ChainErrorCode | "no-throw"> {
  try {
    await p;
    return "no-throw";
  } catch (e) {
    if (e instanceof ChainError) return e.code;
    throw e;
  }
}

const id = (label: string): Hex => keccak256(toHex(label));
const USDC = 1_000_000n;

describe.skipIf(!haveAnvil && !required)("decoders and helpers against a real anvil node", () => {
  let anvil: AnvilProcess;
  let url: string;
  let pub: ReturnType<typeof createPublicClient>;
  let wallet: ReturnType<typeof createWalletClient>;
  let dev: ReturnType<typeof createAnvilClient>;
  let deployer: Address, owner: Address, kernel: Address, payee: Address, guardian: Address, stranger: Address;
  let token: Address, vault: Address, token18: Address, vault18: Address;
  let tokenAbi: Abi;
  let deployLogs: RawLog[];
  let registerLogs: readonly Log[];
  let releaseLogs: readonly Log[];
  let regStart = 0n;
  let regEnd = 0n;

  const ENGAGEMENT = id("engagement-1");
  const INTENT = id("intent-1");
  const RECEIPT = id("receipt-1");
  const TERMS_HASH = id("terms-1");

  async function deploy(artifactPath: string, args: readonly unknown[]): Promise<{ address: Address; logs: Log[] }> {
    const a = readArtifact(artifactPath);
    const hash = await wallet.deployContract({ abi: a.abi as Abi, bytecode: a.bytecode.object, args: [...args], account: deployer, chain: wallet.chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.contractAddress === null || r.contractAddress === undefined) throw new Error("deployment produced no address");
    return { address: getAddress(r.contractAddress), logs: r.logs };
  }

  async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], account: Address) {
    const hash = await wallet.writeContract({ address, abi, functionName, args: [...args], account, chain: wallet.chain });
    return pub.waitForTransactionReceipt({ hash });
  }

  async function sign(signer: Address, primaryType: "EngagementTerms" | "Attestation", message: Record<string, unknown>): Promise<Hex> {
    return wallet.signTypedData({
      account: signer,
      domain: { name: "SymbolonVault", version: "1", chainId: 31337, verifyingContract: vault },
      types: { [primaryType]: EIP712_TYPES[primaryType] },
      primaryType,
      message,
    } as never);
  }

  function attestation(intentId: Hex, amount: bigint, deadline: bigint) {
    return { intentId, engagementId: ENGAGEMENT, milestoneId: id("milestone-1"), payee, amount, receiptHash: RECEIPT, deadline };
  }

  async function release(att: ReturnType<typeof attestation>) {
    const sig = await sign(kernel, "Attestation", att);
    return send(vault, symbolonVaultAbi as Abi, "release", [att, sig, { receiptHash: `0x${"00".repeat(32)}`, deadline: 0n }, "0x"], deployer);
  }

  beforeAll(async () => {
    anvil = await startAnvil();
    url = anvil.url;
    const chain = arcChain("local", url);
    pub = createPublicClient({ chain, transport: http(url) });
    wallet = createWalletClient({ chain, transport: http(url) });
    dev = createAnvilClient(url);
    [deployer, owner, kernel, payee, guardian, stranger] = (await wallet.getAddresses()).map((a) => getAddress(a)) as [Address, Address, Address, Address, Address, Address];

    tokenAbi = readArtifact(MOCK_USDC_ARTIFACT).abi as Abi;
    token = (await deploy(MOCK_USDC_ARTIFACT, [6])).address;
    token18 = (await deploy(MOCK_USDC_ARTIFACT, [18])).address;
    const ctor = (t: Address) => [t, owner, kernel, guardian, 25n * USDC, 60n * USDC, 0n, 20n * USDC, 172_800, 86_400];
    const v = await deploy(VAULT_ARTIFACT, ctor(token));
    vault = v.address;
    deployLogs = v.logs as RawLog[];
    vault18 = (await deploy(VAULT_ARTIFACT, ctor(token18))).address;
    await send(token, tokenAbi, "mint", [vault, 1_000n * USDC], deployer);

    // register an engagement: owner and payee both sign the same EngagementTerms digest
    const ts = (await pub.getBlock()).timestamp;
    regStart = ts - 3_600n;
    regEnd = ts + 30n * 86_400n;
    const terms = { engagementId: ENGAGEMENT, owner, payee, cap: 100n * USDC, start: regStart, end: regEnd, termsHash: TERMS_HASH, nonce: 1n };
    const ownerSig = await sign(owner, "EngagementTerms", terms);
    const payeeSig = await sign(payee, "EngagementTerms", terms);
    registerLogs = (await send(vault, symbolonVaultAbi as Abi, "registerEngagement", [terms, ownerSig, payeeSig], deployer)).logs;

    const ts2 = (await pub.getBlock()).timestamp;
    releaseLogs = (await release(attestation(INTENT, 5n * USDC, ts2 + 3_600n))).logs;
  }, 120_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const opts = () => ({ vault, decimals: 6 });

  describe("decimals (V-04)", () => {
    it("assertTokenDecimals returns the verified token and 6 decimals", async () => {
      expect(await assertTokenDecimals(pub, vault, 6)).toEqual({ token, decimals: 6 });
      expect(await assertTokenDecimals(pub, vault)).toEqual({ token, decimals: 6 });
    });

    it("rejects the 6 vs 18 confusion in both directions", async () => {
      expect(await codeOf(assertTokenDecimals(pub, vault, 18))).toBe("DECIMALS_MISMATCH");
      expect(await assertTokenDecimals(pub, vault18, 18)).toEqual({ token: token18, decimals: 18 });
      expect(await codeOf(assertTokenDecimals(pub, vault18, 6))).toBe("DECIMALS_MISMATCH");
    });

    it("fails closed when the address is not a vault", async () => {
      expect(await codeOf(assertTokenDecimals(pub, stranger))).toBe("RPC_ERROR");
    });

    it("getBalanceBaseUnits returns Money at the verified decimals and refuses a wrong scale", async () => {
      const bal = await getBalanceBaseUnits(pub, token, vault, 6);
      expect(bal).toEqual(money(995n * USDC, 6)); // 1000 minted - 5 released
      expect(await codeOf(getBalanceBaseUnits(pub, token, vault, 18))).toBe("DECIMALS_MISMATCH");
    });
  });

  describe("event decoders round-trip real logs", () => {
    it("ConfigChanged from the constructor carries the vault's configHash()", async () => {
      const decoded = decodeVaultLogs(deployLogs, opts());
      expect(decoded.map((d) => d.event.name)).toEqual(["ConfigChanged"]);
      const hash = await pub.readContract({ address: vault, abi: symbolonVaultAbi, functionName: "configHash" });
      expect(decoded[0]?.event).toEqual({ name: "ConfigChanged", configHash: hash });
    });

    it("EngagementRegistered matches the inputs and reports cap as 6-decimal Money", async () => {
      const [d] = decodeVaultLogs(registerLogs, opts());
      expect(d?.event).toMatchObject({
        name: "EngagementRegistered",
        engagementId: ENGAGEMENT,
        owner,
        payee,
        cap: money(100n * USDC, 6),
        start: regStart,
        end: regEnd,
        termsHash: TERMS_HASH,
      });
      expect(d?.meta.logIndex).toBeTypeOf("number");
    });

    it("Released matches the inputs; the token's Transfer is skipped by address and decoded by its own decoder", async () => {
      const decoded = decodeVaultLogs(releaseLogs, opts());
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.event).toEqual({
        name: "Released",
        intentId: INTENT,
        engagementId: ENGAGEMENT,
        payee,
        amount: money(5n * USDC, 6),
        receiptHash: RECEIPT,
      });
      const tokenLog = releaseLogs.find((l) => l.address.toLowerCase() === token.toLowerCase());
      expect(tokenLog).toBeDefined();
      const t = decodeErc20Transfer(tokenLog as RawLog, { token, decimals: 6 });
      expect(t).toMatchObject({ from: vault, to: payee, amount: money(5n * USDC, 6) });
    });

    it("re-encoding the decoded event reproduces the node's topics and data exactly", () => {
      const raw = releaseLogs.find((l) => l.address.toLowerCase() === vault.toLowerCase()) as RawLog;
      const { event } = decodeVaultLog(raw, opts());
      if (event.name !== "Released") throw new Error("expected Released");
      const re = encodeVaultLog("Released", { intentId: event.intentId, engagementId: event.engagementId, payee: event.payee, amount: event.amount.units, receiptHash: event.receiptHash });
      expect(re.topics).toEqual(raw.topics);
      expect(re.data).toBe(raw.data);
    });

    it("pause / unpause / guardian events decode with their WP-07 names (VaultPaused, VaultUnpaused)", async () => {
      const snap = await snapshot(dev);
      const p = await send(vault, symbolonVaultAbi as Abi, "pause", [], guardian);
      const u = await send(vault, symbolonVaultAbi as Abi, "unpause", [], owner);
      expect(decodeVaultLogs(p.logs as RawLog[], opts()).map((d) => d.event)).toEqual([{ name: "VaultPaused", by: guardian }]);
      expect(decodeVaultLogs(u.logs as RawLog[], opts()).map((d) => d.event)).toEqual([{ name: "VaultUnpaused", by: owner }]);
      await revertTo(dev, snap);
    });
  });

  describe("negative controls: tampered or misplaced logs", () => {
    const real = () => releaseLogs.find((l) => l.address.toLowerCase() === vault.toLowerCase()) as RawLog;
    const code = (raw: RawLog, o = opts()): ChainErrorCode | "no-throw" => {
      try {
        decodeVaultLog(raw, o);
        return "no-throw";
      } catch (e) {
        if (e instanceof ChainError) return e.code;
        throw e;
      }
    };

    it("the untouched log decodes (control)", () => {
      expect(code(real())).toBe("no-throw");
    });

    it("unknown selector -> UNKNOWN_EVENT", () => {
      expect(code({ ...real(), topics: [id("Nothing(uint256)"), ...real().topics.slice(1)] })).toBe("UNKNOWN_EVENT");
    });

    it("a different known selector with Released's topics -> BAD_LOG (topic/data shape no longer fits)", () => {
      const closed = encodeVaultLog("EngagementClosed", { engagementId: ENGAGEMENT }).topics[0] as Hex;
      expect(code({ ...real(), topics: [closed, ...real().topics.slice(1)] })).toBe("BAD_LOG");
    });

    it("truncated data, extra data bytes and missing/extra topics -> BAD_LOG", () => {
      const r = real();
      expect(code({ ...r, data: r.data.slice(0, r.data.length - 2) as Hex })).toBe("BAD_LOG");
      expect(code({ ...r, data: "0x" })).toBe("BAD_LOG");
      expect(code({ ...r, topics: r.topics.slice(0, 3) })).toBe("BAD_LOG");
      expect(code({ ...r, topics: [...r.topics, id("extra")] })).toBe("BAD_LOG");
      expect(code({ ...r, topics: [] })).toBe("BAD_LOG");
    });

    it("emitted by another address (look-alike event) -> BAD_LOG", () => {
      expect(code({ ...real(), address: stranger })).toBe("BAD_LOG");
      expect(code(real(), { vault: stranger, decimals: 6 })).toBe("BAD_LOG");
    });

    it("removed or pending logs -> BAD_LOG", () => {
      const r = real();
      expect(code({ ...r, removed: true })).toBe("BAD_LOG");
      expect(code({ ...r, blockNumber: null })).toBe("BAD_LOG");
      expect(code({ ...r, transactionHash: null })).toBe("BAD_LOG");
      expect(code({ ...r, logIndex: null })).toBe("BAD_LOG");
    });

    it("an altered amount word decodes to a DIFFERENT amount (decoding is not authentication)", () => {
      const r = real();
      const words = r.data.slice(2).match(/.{64}/g) as string[];
      words[0] = (6n * USDC).toString(16).padStart(64, "0"); // amount word
      const forged = decodeVaultLog({ ...r, data: `0x${words.join("")}` }, opts()).event;
      expect(forged).toMatchObject({ name: "Released", amount: money(6n * USDC, 6) });
      expect(forged).not.toEqual(decodeVaultLog(r, opts()).event);
    });

    it("the same bytes at other decimals give a different Money (the caller must pass verified decimals)", () => {
      const at18 = decodeVaultLog(real(), { vault, decimals: 18 }).event;
      expect(at18).toMatchObject({ amount: { units: 5n * USDC, decimals: 18 } });
    });

    it("a Transfer from another token, or with ERC-721 shape, is refused", () => {
      const tokenLog = releaseLogs.find((l) => l.address.toLowerCase() === token.toLowerCase()) as RawLog;
      expect(() => decodeErc20Transfer(tokenLog, { token: token18, decimals: 6 })).toThrow(ChainError);
      expect(() => decodeErc20Transfer({ ...tokenLog, topics: [...tokenLog.topics, id("tokenId")] }, { token, decimals: 6 })).toThrow(ChainError);
    });
  });

  describe("reverts", () => {
    it("vaultRevertName extracts the custom error from a real failed call", async () => {
      const ts = (await pub.getBlock()).timestamp;
      const again = attestation(INTENT, 5n * USDC, ts + 3_600n); // replay of a used intent
      const sig = await sign(kernel, "Attestation", again);
      const call = pub.simulateContract({
        address: vault,
        abi: symbolonVaultAbi,
        functionName: "release",
        args: [again, sig, { receiptHash: `0x${"00".repeat(32)}`, deadline: 0n }, "0x"],
        account: deployer,
      });
      const err = await call.then(() => undefined, (e: unknown) => e);
      expect(vaultRevertName(err)).toBe("AlreadyUsed");

      const big = attestation(id("intent-big"), 26n * USDC, ts + 3_600n); // one base unit over 25 USDC would also do
      const bigSig = await sign(kernel, "Attestation", big);
      const err2 = await pub
        .simulateContract({ address: vault, abi: symbolonVaultAbi, functionName: "release", args: [big, bigSig, { receiptHash: `0x${"00".repeat(32)}`, deadline: 0n }, "0x"], account: deployer })
        .then(() => undefined, (e: unknown) => e);
      expect(vaultRevertName(err2)).toBe("PerTxCap");
    });

    it("decodeVaultRevertData round-trips encoded errors and refuses garbage", () => {
      for (const errorName of ["PerTxCap", "DailyCap", "Paused", "BadKernelSig", "ApprovalRequired"] as const) {
        const data = encodeErrorResult({ abi: symbolonVaultAbi, errorName });
        expect(decodeVaultRevertData(data).errorName).toBe(errorName);
      }
      expect(() => decodeVaultRevertData("0xdeadbeef")).toThrow(ChainError);
      expect(() => decodeVaultRevertData("0x")).toThrow(ChainError);
      expect(vaultRevertName(new Error("boom"))).toBeUndefined();
    });
  });

  describe("anvil helpers", () => {
    it("increaseTime advances block.timestamp by at least the requested seconds", async () => {
      const before = (await pub.getBlock()).timestamp;
      await increaseTime(dev, 7_200);
      const after = (await pub.getBlock()).timestamp;
      expect(after - before).toBeGreaterThanOrEqual(7_200n);
      expect(after - before).toBeLessThan(7_300n);
    });

    it("increaseTime moves a time-dependent vault outcome: a release past the engagement window reverts OutOfWindow", async () => {
      const snap = await snapshot(dev);
      await increaseTime(dev, 31 * 86_400); // past regEnd
      const ts = (await pub.getBlock()).timestamp;
      const att = attestation(id("late"), USDC, ts + 3_600n);
      const sig = await sign(kernel, "Attestation", att);
      const err = await pub
        .simulateContract({ address: vault, abi: symbolonVaultAbi, functionName: "release", args: [att, sig, { receiptHash: `0x${"00".repeat(32)}`, deadline: 0n }, "0x"], account: deployer })
        .then(() => undefined, (e: unknown) => e);
      expect(vaultRevertName(err)).toBe("OutOfWindow");
      await revertTo(dev, snap);
    });

    it("withImpersonation lets a test act as a contract (the vault) and stops afterwards", async () => {
      const snap = await snapshot(dev);
      await setNativeBalance(dev, vault, 10n ** 18n);
      const before = await getBalanceBaseUnits(pub, token, stranger, 6);
      await withImpersonation(dev, vault, async () => {
        const hash = await wallet.writeContract({ address: token, abi: tokenAbi, functionName: "transfer", args: [stranger, 2n * USDC], account: vault, chain: wallet.chain });
        await pub.waitForTransactionReceipt({ hash });
      });
      const after = await getBalanceBaseUnits(pub, token, stranger, 6);
      expect(after.units - before.units).toBe(2n * USDC);
      await revertTo(dev, snap);
    });

    it("refuses to run against a chain that is not 31337 (negative control: real node with chain id 5042002)", async () => {
      const other = await startAnvil(5042002);
      try {
        const c = createAnvilClient(other.url);
        expect(await codeOf(increaseTime(c, 60))).toBe("NOT_LOCAL_CHAIN");
        expect(await codeOf(setNativeBalance(c, stranger, 1n))).toBe("NOT_LOCAL_CHAIN");
        expect((await codeOf(withImpersonation(c, stranger, async () => 1)))).toBe("NOT_LOCAL_CHAIN");
      } finally {
        await other.stop();
      }
    }, 30_000);

    it("refuses a non-loopback URL outright", () => {
      expect(() => createAnvilClient("https://rpc.testnet.arc.io")).toThrow(ChainError);
    });
  });
});
