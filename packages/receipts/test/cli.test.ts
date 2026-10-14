import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RawLog } from "@symbolon/chain";
import { eip712DomainSeparator, type Address, type Hex32 } from "@symbolon/schemas";
import { parseCliArgs } from "../src/cli/args";
import { EXIT_NOT_VERIFIED, EXIT_USAGE, EXIT_VERIFIED, MAX_LOG_REQUESTS, runCli, type ChainReader, type CliIo } from "../src/cli/run";
import { encodeVaultLog } from "../../chain/test/helpers/encode-log";
import { DOMAIN, KERNEL, RELEASE_RECEIPT, STRANGER, signed } from "./helpers";

const VAULT = DOMAIN.verifyingContract as Address;
const dir = mkdtempSync(join(tmpdir(), "symbolon-receipts-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const d = RELEASE_RECEIPT.decision;
const releasedLog = (receiptHash: Hex32, over: Record<string, unknown> = {}): RawLog => {
  const { topics, data } = encodeVaultLog("Released", {
    intentId: d.intentId,
    engagementId: d.engagementId,
    payee: d.payee,
    amount: BigInt(d.releaseAmountBaseUnits as string),
    receiptHash,
    ...over,
  });
  return { address: VAULT, topics, data, blockNumber: 7n, transactionHash: ("0x" + "cd".repeat(32)) as `0x${string}`, logIndex: 0, removed: false };
};

interface Rig {
  io: CliIo;
  out: string[];
  err: string[];
  rpcCalls: string[];
  fetched: string[];
}

function rig(opts: { files?: Record<string, string | Uint8Array>; urls?: Record<string, string>; chain?: Partial<ChainReader> } = {}): Rig {
  const out: string[] = [];
  const err: string[] = [];
  const rpcCalls: string[] = [];
  const fetched: string[] = [];
  const reader: ChainReader = {
    chainId: async () => (rpcCalls.push("chainId"), DOMAIN.chainId),
    kernelSigner: async () => (rpcCalls.push("kernelSigner"), KERNEL.address),
    tokenDecimals: async () => (rpcCalls.push("tokenDecimals"), 6),
    domainSeparator: async () => (rpcCalls.push("domainSeparator"), eip712DomainSeparator(DOMAIN)),
    latestBlock: async () => (rpcCalls.push("latestBlock"), 100n),
    releasedLogs: async () => (rpcCalls.push("releasedLogs"), []),
    ...opts.chain,
  };
  const io: CliIo = {
    readFile: async (path) => {
      const f = opts.files?.[path];
      if (f === undefined) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: "ENOENT" });
      return typeof f === "string" ? new TextEncoder().encode(f) : f;
    },
    fetchText: async (url) => {
      fetched.push(url);
      const u = opts.urls?.[url];
      if (u === undefined) throw new Error("HTTP_404");
      return u;
    },
    chain: () => reader,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
  };
  return { io, out, err, rpcCalls, fetched };
}

const base = ["--vault", VAULT, "--chain-id", String(DOMAIN.chainId), "--signer", KERNEL.address];

describe("parseCliArgs", () => {
  const run = (...a: string[]) => parseCliArgs(a);
  const usage = (...a: string[]) => {
    const r = run(...a);
    return r.kind === "usage-error" ? r.message : r.kind;
  };

  it("--help", () => {
    expect(run("--help").kind).toBe("help");
    expect(run("-h").kind).toBe("help");
  });

  it("a file with a pinned signer is a run", () => {
    const r = run("r.json", ...base);
    expect(r.kind).toBe("run");
    if (r.kind !== "run") return;
    expect(r.options.input).toEqual({ kind: "file", path: "r.json" });
    expect(r.options.chain).toEqual({ kind: "offline", chainId: DOMAIN.chainId });
    expect(r.options.signer).toBe(KERNEL.address);
  });

  it("a hash needs --url, is lower-cased, and the base URL loses trailing slashes", () => {
    const h = "0x" + "AB".repeat(32);
    expect(usage(h, ...base)).toContain("--url");
    const r = run(h, ...base, "--url", "https://x.example/");
    expect(r.kind === "run" && r.options.input).toEqual({ kind: "hash", hash: h.toLowerCase(), baseUrl: "https://x.example" });
  });

  it("is strict: unknown options, repeats, extra or missing inputs, bad values", () => {
    expect(usage("r.json", ...base, "--bogus")).toContain("unknown");
    expect(usage("r.json", ...base, "--vault", VAULT)).toContain("twice");
    expect(usage(...base)).toContain("exactly one");
    expect(usage("a.json", "b.json", ...base)).toContain("exactly one");
    expect(usage("r.json", "--chain-id", "1", "--signer", KERNEL.address)).toContain("--vault is required");
    expect(usage("r.json", "--vault", "0x1234", "--chain-id", "1", "--signer", KERNEL.address)).toContain("--vault");
    expect(usage("r.json", "--vault", VAULT.toLowerCase().replace(/[a-f]/, (c) => c.toUpperCase()), "--chain-id", "1", "--signer", KERNEL.address)).toMatch(/--vault|EIP-55/);
    for (const bad of ["0", "1.5", "abc", "01", String(2 ** 60)]) expect(usage("r.json", "--vault", VAULT, "--chain-id", bad, "--signer", KERNEL.address), bad).toContain("--chain-id");
    expect(run("r.json", "--vault", VAULT, "--chain-id", "-1", "--signer", KERNEL.address).kind).toBe("usage-error");
    expect(usage("r.json", "--vault", VAULT, "--signer", KERNEL.address)).toContain("--chain-id");
    expect(usage("r.json", ...base, "--url", "https://x.example")).toContain("--url");
  });

  it("will not run offline without a signer pin unless explicitly told to", () => {
    expect(usage("r.json", "--vault", VAULT, "--chain-id", "1")).toContain("pin the signer");
    expect(run("r.json", "--vault", VAULT, "--chain-id", "1", "--allow-unpinned-signer").kind).toBe("run");
  });

  it("--rpc: reads chain id from the chain, bounds the block options, and rejects non-http URLs", () => {
    const r = run("r.json", "--vault", VAULT, "--rpc", "https://rpc.example", "--from-block", "5", "--log-range", "1000");
    expect(r.kind).toBe("run");
    if (r.kind === "run") expect(r.options.chain).toMatchObject({ kind: "rpc", fromBlock: 5n, logRange: 1000n, chainId: undefined });
    expect(usage("r.json", "--vault", VAULT, "--rpc", "file:///etc/passwd")).toContain("--rpc");
    expect(usage("r.json", "--vault", VAULT, "--rpc", "https://rpc.example", "--from-block", "1.5")).toContain("--from-block");
    expect(usage("r.json", "--vault", VAULT, "--rpc", "https://rpc.example", "--log-range", "0")).toContain("--log-range");
    expect(usage("r.json", ...base, "--from-block", "5")).toContain("--rpc");
  });
});

describe("runCli (offline)", () => {
  it("verifies a good receipt file: exit 0, RESULT: VERIFIED, hash and verdict shown", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) } });
    expect(await runCli(["r.json", ...base], r.io)).toBe(EXIT_VERIFIED);
    const text = r.out.join("");
    expect(text).toContain("RESULT: VERIFIED");
    expect(text).toContain(s.receiptHash);
    expect(text).toContain("verdict RELEASE");
    expect(text).not.toContain("WARNING");
    expect(r.rpcCalls).toEqual([]);
    expect(r.err).toEqual([]);
  });

  it("exit 1 and no receipt facts for a tampered file", async () => {
    const s = await signed();
    const tampered = JSON.stringify(s).replace('"amountBaseUnits":"1500000000"', '"amountBaseUnits":"1500000001"');
    expect(tampered).not.toBe(JSON.stringify(s));
    const r = rig({ files: { "r.json": tampered } });
    expect(await runCli(["r.json", ...base], r.io)).toBe(EXIT_NOT_VERIFIED);
    const text = r.out.join("");
    expect(text).toContain("RESULT: NOT VERIFIED");
    expect(text).toContain("FAIL  HASH");
    expect(text).not.toContain("verdict ");
  });

  it("exit 1 when signed by someone other than the pinned signer", async () => {
    const s = await signed("RELEASE", STRANGER);
    const r = rig({ files: { "r.json": JSON.stringify(s) } });
    expect(await runCli(["r.json", ...base], r.io)).toBe(EXIT_NOT_VERIFIED);
  });

  it("an unpinned pass carries a loud warning", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) } });
    expect(await runCli(["r.json", "--vault", VAULT, "--chain-id", String(DOMAIN.chainId), "--allow-unpinned-signer"], r.io)).toBe(EXIT_VERIFIED);
    expect(r.out.join("")).toContain("WARNING: the signer was not pinned");
  });

  it("--json is machine-readable and carries the same verdict", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) } });
    expect(await runCli(["r.json", ...base, "--json"], r.io)).toBe(EXIT_VERIFIED);
    const j = JSON.parse(r.out.join(""));
    expect(j).toMatchObject({ ok: true, receiptHash: s.receiptHash, signer: KERNEL.address, signerPinned: true });
    expect(j.checks.map((c: { id: string }) => c.id)).toEqual(["SCHEMA", "HASH", "SIGNATURE", "SIGNER", "ANCHOR"]);
  });

  it("usage errors and unreadable files are exit 2, with a short label instead of the raw exception text", async () => {
    const a = rig();
    expect(await runCli([], a.io)).toBe(EXIT_USAGE);
    expect(a.err.join("")).toContain("usage:");
    const b = rig();
    expect(await runCli(["missing.json", ...base], b.io)).toBe(EXIT_USAGE);
    expect(b.err.join("")).toContain("ENOENT");
    expect(b.err.join("")).not.toContain("no such file");
    expect(b.out).toEqual([]);
  });

  it("--help is exit 0 and prints usage on stdout", async () => {
    const r = rig();
    expect(await runCli(["--help"], r.io)).toBe(EXIT_VERIFIED);
    expect(r.out.join("")).toContain("usage: verify-receipt");
  });

  it("a receipt given by hash is fetched from <base>/api/public/receipt/<hash> and must hash to that value", async () => {
    const s = await signed();
    const url = `https://app.example/api/public/receipt/${s.receiptHash}`;
    const good = rig({ urls: { [url]: JSON.stringify(s) } });
    expect(await runCli([s.receiptHash, ...base, "--url", "https://app.example/"], good.io)).toBe(EXIT_VERIFIED);
    expect(good.fetched).toEqual([url]);

    // The server answers with a different (valid, signed) receipt than the one asked for.
    const other = await signed("ESCALATE");
    const swapped = rig({ urls: { [url]: JSON.stringify(other) } });
    expect(await runCli([s.receiptHash, ...base, "--url", "https://app.example"], swapped.io)).toBe(EXIT_NOT_VERIFIED);
    expect(swapped.out.join("")).toContain("is not the requested");
  });

  it("never prints receipt prose", async () => {
    const s = await signed("ESCALATE");
    const r = rig({ files: { "r.json": JSON.stringify(s) } });
    await runCli(["r.json", ...base], r.io);
    const text = r.out.join("");
    for (const c of s.receipt.decision.checks) expect(text).not.toContain(c.detail as unknown as string);
  });
});

describe("runCli (--rpc)", () => {
  const rpcArgs = ["--vault", VAULT, "--rpc", "https://rpc.example"];

  it("pins the signer from the vault, reads decimals and finds the Released event: VERIFIED with ANCHOR PASS", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) }, chain: { releasedLogs: async () => [releasedLog(s.receiptHash)] } });
    expect(await runCli(["r.json", ...rpcArgs], r.io)).toBe(EXIT_VERIFIED);
    expect(r.out.join("")).toMatch(/PASS\s+ANCHOR/);
    expect(r.rpcCalls).toEqual(expect.arrayContaining(["chainId", "domainSeparator", "kernelSigner", "tokenDecimals", "latestBlock"]));
  });

  it("NOT VERIFIED when the vault has no Released event, or one that disagrees", async () => {
    const s = await signed();
    const none = rig({ files: { "r.json": JSON.stringify(s) } });
    expect(await runCli(["r.json", ...rpcArgs], none.io)).toBe(EXIT_NOT_VERIFIED);
    expect(none.out.join("")).toMatch(/FAIL\s+ANCHOR/);
    const wrong = rig({ files: { "r.json": JSON.stringify(s) }, chain: { releasedLogs: async () => [releasedLog(s.receiptHash, { payee: STRANGER.address })] } });
    expect(await runCli(["r.json", ...rpcArgs], wrong.io)).toBe(EXIT_NOT_VERIFIED);
  });

  it("the kernel signer is the vault's, not the file's: a stranger-signed receipt fails even with a matching event", async () => {
    const s = await signed("RELEASE", STRANGER);
    const r = rig({ files: { "r.json": JSON.stringify(s) }, chain: { releasedLogs: async () => [releasedLog(s.receiptHash)] } });
    expect(await runCli(["r.json", ...rpcArgs], r.io)).toBe(EXIT_NOT_VERIFIED);
  });

  it("refuses when --chain-id disagrees with the RPC", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) } });
    expect(await runCli(["r.json", ...rpcArgs, "--chain-id", "1"], r.io)).toBe(EXIT_USAGE);
    expect(r.err.join("")).toContain("does not match the RPC");
  });

  it("NOT VERIFIED when the vault's domain separator is not the one this receipt format signs for", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) }, chain: { domainSeparator: async () => ("0x" + "00".repeat(32)) as Hex32 } });
    expect(await runCli(["r.json", ...rpcArgs], r.io)).toBe(EXIT_NOT_VERIFIED);
    expect(r.out.join("")).toContain("DOMAIN_MISMATCH");
    expect(r.rpcCalls).not.toContain("kernelSigner");
  });

  it("an RPC failure is exit 2 with a short label, never a verdict", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) }, chain: { chainId: async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:8545")) } });
    expect(await runCli(["r.json", ...rpcArgs], r.io)).toBe(EXIT_USAGE);
    expect(r.err.join("")).not.toContain("10.0.0.1");
    expect(r.out).toEqual([]);
  });

  it("a getLogs failure during the anchor search fails the ANCHOR check (exit 1)", async () => {
    const s = await signed();
    const r = rig({ files: { "r.json": JSON.stringify(s) }, chain: { releasedLogs: async () => Promise.reject(new Error("range too large")) } });
    expect(await runCli(["r.json", ...rpcArgs], r.io)).toBe(EXIT_NOT_VERIFIED);
  });

  it("--log-range searches in chunks that cover [from, latest] exactly once, and refuses an unbounded number of requests", async () => {
    const s = await signed();
    const calls: Array<[bigint, bigint]> = [];
    const r = rig({
      files: { "r.json": JSON.stringify(s) },
      chain: { latestBlock: async () => 25n, releasedLogs: async (_v, _i, from, to) => (calls.push([from, to]), from === 11n ? [releasedLog(s.receiptHash)] : []) },
    });
    expect(await runCli(["r.json", ...rpcArgs, "--from-block", "1", "--log-range", "10"], r.io)).toBe(EXIT_VERIFIED);
    expect(calls).toEqual([[1n, 10n], [11n, 20n], [21n, 25n]]);

    const huge = rig({ files: { "r.json": JSON.stringify(s) }, chain: { latestBlock: async () => MAX_LOG_REQUESTS * 10n + 5n } });
    expect(await runCli(["r.json", ...rpcArgs, "--log-range", "10"], huge.io)).toBe(EXIT_NOT_VERIFIED);
    expect(huge.rpcCalls.filter((c) => c === "releasedLogs")).toEqual([]);
  });
});

describe("bin/verify-receipt.mjs (the real process)", () => {
  const bin = resolve(import.meta.dirname, "..", "bin", "verify-receipt.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 60_000 });

  it("--help exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("usage: verify-receipt");
  });

  it("verifies a receipt file offline: exit 0, then exit 1 after one byte changes", async () => {
    const s = await signed();
    const file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify(s));
    const args = [file, "--vault", VAULT, "--chain-id", String(DOMAIN.chainId), "--signer", KERNEL.address];
    const good = run(args);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("RESULT: VERIFIED");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(s).replace(s.signature.slice(10, 12), s.signature.slice(10, 12) === "00" ? "01" : "00"));
    const r = run([bad, ...args.slice(1)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("RESULT: NOT VERIFIED");
  }, 120_000);

  it("a missing file is exit 2", () => {
    const r = run([join(dir, "nope.json"), "--vault", VAULT, "--chain-id", "1", "--signer", KERNEL.address]);
    expect(r.status).toBe(2);
  });
});
