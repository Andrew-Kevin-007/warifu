// verify: staleness matrix, tamper, fail-closed and fallback behaviour against a fake chain (the same matrix runs against a
// real anvil + real SymbolonVault in anvil.lbc.test.ts). docs/16 §5.2, §10 tests 4 and 5.
import { computeCertHash } from "@symbolon/schemas";
import type { Hex32, LossBoundCertificate } from "@symbolon/schemas";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { attachPublisher, buildFromReader } from "../../src/lbc/build";
import { parseArtifact } from "../../src/lbc/code-match";
import { EXIT_CODES, verifyCertificate } from "../../src/lbc/verify";
import type { VerifyOptions } from "../../src/lbc/verify";
import { FakeChain, GUARDIAN, SIGNER2, T0, USDC, VAULT, chainWith, engagement, exampleState, h32, makeState } from "./helpers/fake-chain";

type Cert = LossBoundCertificate;
const NOW = T0 + 1000n;
const GIT = "0123456789abcdef0123456789abcdef01234567";

async function built(chain: FakeChain, over: Record<string, unknown> = {}): Promise<Cert> {
  const { cert } = await buildFromReader(chain, VAULT, { block: "latest", gitSha: GIT, nowSeconds: NOW, ...over });
  return cert;
}
const verify = (cert: unknown, chain: FakeChain, o: Partial<VerifyOptions> = {}) => verifyCertificate(cert, chain, { nowSeconds: NOW, ...o });
const rehash = (c: Cert): Cert => ({ ...c, certHash: computeCertHash(c) });

describe("a fresh certificate", () => {
  it("is VALID (exit 0) when verified at its own block, and the build already recorded that", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    expect(cert.validity.status).toBe("VALID");
    const r = await verify(cert, chain);
    expect(r.outcome).toBe("VALID");
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("at-block");
    expect(r.codeMatch.status).toBe("NOT_CHECKED");
  });
  it("is VALID against an independent reader of the same chain (nothing about the builder is trusted)", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const other = new FakeChain().push(100n, exampleState());
    expect((await verify(JSON.parse(JSON.stringify(cert)), other)).outcome).toBe("VALID");
  });
  it("certHash recomputes from the document", async () => {
    const cert = await built(chainWith(exampleState()));
    expect(computeCertHash(cert)).toBe(cert.certHash);
  });
});

describe("staleness matrix (docs/16 §5.2 table)", () => {
  const engBinds = () => chainWith(exampleState()); // engagements bind everywhere (ΣR 150 < B 200)
  const balBinds = () => chainWith(makeState({ balance: 100n * USDC, engagements: [engagement("a", { cap: 500n * USDC })] })); // B=100 binds

  it("fund the vault, balance NOT binding -> VALID", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ balance: 900n * USDC });
    const r = await verify(cert, chain);
    expect(r.outcome).toBe("VALID");
    expect(r.findings.join("\n")).toContain("not binding");
  });
  it("fund the vault, balance binding -> STALE BALANCE_INCREASED with a diff", async () => {
    const chain = balBinds();
    const cert = await built(chain);
    expect(cert.bounds.T3c.horizons.some((h) => h.binding.includes("balance"))).toBe(true);
    chain.next({ balance: 150n * USDC });
    const r = await verify(cert, chain);
    expect(r.outcome).toBe("STALE");
    expect(r.exitCode).toBe(10);
    expect(r.reasons).toEqual(["BALANCE_INCREASED"]);
    expect(r.diffs).toContainEqual({ path: "inputs.balanceBaseUnits", document: "100000000", recomputed: "150000000" });
  });
  it("balance binding only through a tie still counts (binding lists every tied term)", async () => {
    const chain = chainWith(makeState({ balance: 150n * USDC, engagements: [engagement("a", { cap: 150n * USDC })] })); // B == ΣR
    const cert = await built(chain);
    chain.next({ balance: 151n * USDC });
    expect((await verify(cert, chain)).reasons).toEqual(["BALANCE_INCREASED"]);
  });
  it("register an engagement -> STALE ENGAGEMENTS_CHANGED", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ engagements: [...chain.head.engagements, engagement("new")] });
    const r = await verify(cert, chain);
    expect(r.outcome).toBe("STALE");
    expect(r.reasons).toEqual(["ENGAGEMENTS_CHANGED"]);
    expect(r.diffs.map((d) => d.path)).toContain("inputs.engagementsDigest");
  });
  it("close an engagement -> STALE", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ engagements: chain.head.engagements.map((e, i) => (i === 0 ? { ...e, active: false } : e)) });
    expect((await verify(cert, chain)).reasons).toEqual(["ENGAGEMENTS_CHANGED"]);
  });
  it("change a payee (executed payee change) -> STALE", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ engagements: chain.head.engagements.map((e, i) => (i === 0 ? { ...e, payee: SIGNER2 } : e)) });
    expect((await verify(cert, chain)).reasons).toEqual(["ENGAGEMENTS_CHANGED"]);
  });
  it("rotate the kernel signer -> STALE CONFIG_CHANGED", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ kernelSigner: SIGNER2 });
    const r = await verify(cert, chain);
    expect(r.outcome).toBe("STALE");
    expect(r.reasons).toEqual(["CONFIG_CHANGED"]);
    expect(r.diffs.map((d) => d.path)).toEqual(["inputs.configHash"]);
  });
  it("setGuardian -> STALE CONFIG_CHANGED", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ guardian: SIGNER2 });
    expect((await verify(cert, chain)).reasons).toEqual(["CONFIG_CHANGED"]);
    expect(GUARDIAN).toBeTruthy();
  });
  it("a limit change (a different vault's numbers behind the same address) -> STALE with the limit in the diff", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ dailyCap: 400n * USDC });
    const r = await verify(cert, chain);
    expect(r.reasons).toEqual(["CONFIG_CHANGED"]);
    expect(r.diffs).toContainEqual({ path: "inputs.limits.dailyCap", document: "200000000", recomputed: "400000000" });
  });
  it("release a payment (balance down, released up) -> VALID", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ balance: 150n * USDC, engagements: chain.head.engagements.map((e, i) => (i === 0 ? { ...e, released: e.released + 50n * USDC } : e)) });
    expect((await verify(cert, chain)).outcome).toBe("VALID");
  });
  it("pause and unpause -> VALID", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ paused: true });
    expect((await verify(cert, chain)).outcome).toBe("VALID");
    chain.next({ paused: false });
    expect((await verify(cert, chain)).outcome).toBe("VALID");
  });
  it("an engagement ending with time (sumRemaining falls) -> VALID", async () => {
    const chain = chainWith(exampleState({ engagements: [engagement("a", { end: T0 + 10n, cap: 100n * USDC }), engagement("b", { cap: 50n * USDC })] }));
    const cert = await built(chain);
    chain.next({}, 100n); // a block 100 s later: engagement a has ended
    const r = await verify(cert, chain);
    expect(r.outcome).toBe("VALID");
    expect(r.latest?.sumRemainingBaseUnits).toBe("50000000");
  });
  it("wait past the freshness window -> STALE FRESHNESS_EXCEEDED (chain time counts, a rewound verifier clock cannot hide it)", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({}, 86_401n);
    const r = await verify(cert, chain, { nowSeconds: 0n });
    expect(r.outcome).toBe("STALE");
    expect(r.reasons).toEqual(["FRESHNESS_EXCEEDED"]);
    expect((await verify(cert, chain, { nowSeconds: 0n, freshnessSeconds: 90_000 })).outcome).toBe("VALID");
  });
  it("several reasons are all reported", async () => {
    const chain = balBinds();
    const cert = await built(chain);
    chain.next({ kernelSigner: SIGNER2, balance: 150n * USDC, engagements: [...chain.head.engagements, engagement("n")] }, 90_000n);
    const r = await verify(cert, chain);
    expect([...r.reasons].sort()).toEqual(["BALANCE_INCREASED", "CONFIG_CHANGED", "ENGAGEMENTS_CHANGED", "FRESHNESS_EXCEEDED"]);
  });
  it("`--block N` pins the comparison point so a stale diff is reproducible", async () => {
    const chain = engBinds();
    const cert = await built(chain);
    chain.next({ kernelSigner: SIGNER2 });
    chain.next({});
    expect((await verify(cert, chain, { latestBlock: 100n })).outcome).toBe("VALID");
    expect((await verify(cert, chain, { latestBlock: 101n })).outcome).toBe("STALE");
  });
});

describe("tamper: any edit to a hashed field is caught (docs/16 §10 test 5)", () => {
  const cases: [string, (c: Cert) => void][] = [
    ["a horizon value (lowered)", (c) => void (c.bounds.T3c.horizons[3]!.value = "1")],
    ["a horizon binding", (c) => void (c.bounds.T3c.horizons[0]!.binding = ["balance"])],
    ["perDay", (c) => void (c.bounds.T3c.perDay = "1")],
    ["perReleaseUnapproved", (c) => void (c.bounds.T3c.perReleaseUnapproved = "1")],
    ["timeToEmpty", (c) => void (c.bounds.T3c.timeToEmpty = { days: 99, limitedBy: "balance" })],
    ["alarmed value", (c) => void (c.bounds.T3c.alarmed.value = "1")],
    ["T3_ownerExposed", (c) => void (c.bounds.T3_ownerExposed[0]!.value = "1")],
    ["T1 loss", (c) => void (c.bounds.T1.unauthorizedLoss = "1")],
    ["T2 loss", (c) => void (c.bounds.T2.loss = "1")],
    ["balance", (c) => void (c.inputs.balanceBaseUnits = "1")],
    ["sumRemaining", (c) => void (c.inputs.sumRemainingBaseUnits = "1")],
    ["activeEngagements", (c) => void (c.inputs.activeEngagements = 99)],
    ["perTxCap limit", (c) => void (c.inputs.limits.perTxCap = "1")],
    ["dailyCap limit", (c) => void (c.inputs.limits.dailyCap = "1")],
    ["hourlyCap limit", (c) => void (c.inputs.limits.hourlyCap = "1")],
    ["humanThreshold limit", (c) => void (c.inputs.limits.humanThreshold = "1")],
    ["ringSize limit", (c) => void (c.inputs.limits.ringSize = 32)],
    ["configHash", (c) => void (c.inputs.configHash = h32("x"))],
    ["engagementsDigest", (c) => void (c.inputs.engagementsDigest = h32("x"))],
    ["token", (c) => void (c.subject.token = SIGNER2)],
    ["tokenDecimals", (c) => void (c.subject.tokenDecimals = 18)],
    ["block timestamp", (c) => void (c.asOf.timestamp = c.asOf.timestamp + 1)],
  ];
  for (const [name, edit] of cases) {
    it(`${name}: edited with the old hash -> MISMATCH (CERT_HASH_MISMATCH); with a forged new hash -> MISMATCH (field diff)`, async () => {
      const chain = chainWith(exampleState());
      const cert = await built(chain);
      const forged: Cert = JSON.parse(JSON.stringify(cert));
      edit(forged);
      const r1 = await verify(forged, chain);
      expect(r1.outcome, "old hash").toBe("MISMATCH");
      expect(r1.exitCode).toBe(30);
      expect(r1.reasons).toContain("CERT_HASH_MISMATCH");
      const r2 = await verify(rehash(forged), chain);
      expect(r2.outcome, "forged hash").toBe("MISMATCH");
      expect(r2.reasons).toContain("FIELD_MISMATCH");
      expect(r2.diffs.length).toBeGreaterThan(0);
    });
  }
  it("wrong chain id in the document -> UNVERIFIED (exit 20)", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const forged = rehash({ ...cert, subject: { ...cert.subject, chainId: 1 } });
    const r = await verify(forged, chain);
    expect(r.outcome).toBe("UNVERIFIED");
    expect(r.exitCode).toBe(20);
    expect(r.reasons).toEqual(["BLOCK_HASH_MISMATCH"]);
  });
  it("wrong block hash (a different chain or a reorganization) -> UNVERIFIED BLOCK_HASH_MISMATCH", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const forged = rehash({ ...cert, asOf: { ...cert.asOf, blockHash: h32("other chain") } });
    expect((await verify(forged, chain)).reasons).toEqual(["BLOCK_HASH_MISMATCH"]);
    const reorged = new FakeChain().push(100n, exampleState(), { number: 100n, hash: h32("reorged"), timestamp: T0 });
    expect((await verify(cert, reorged)).outcome).toBe("UNVERIFIED");
  });
  it("a block the node does not know -> UNVERIFIED", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    expect((await verify(rehash({ ...cert, asOf: { ...cert.asOf, blockNumber: 5000 } }), chain)).outcome).toBe("UNVERIFIED");
  });
  it("a document that is not an lbc/1 certificate -> UNVERIFIED SCHEMA_INVALID; an unknown algorithm major -> ALGORITHM_UNSUPPORTED", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    expect((await verify({ nope: 1 }, chain)).reasons).toEqual(["SCHEMA_INVALID"]);
    expect((await verify(null, chain)).outcome).toBe("UNVERIFIED");
    const v2: Cert = { ...cert, algorithm: { ...cert.algorithm, version: "2.0.0" } };
    expect((await verify(rehash(v2), chain)).reasons).toEqual(["ALGORITHM_UNSUPPORTED"]);
  });
  it("an extra unknown field is rejected (strict schema) rather than ignored", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    expect((await verify({ ...cert, extra: 1 }, chain)).outcome).toBe("UNVERIFIED");
  });
  it("a stale `validity` field in the file changes nothing (it is a result, not evidence)", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const lying: Cert = { ...cert, validity: { ...cert.validity, status: "STALE", reasons: ["CONFIG_CHANGED"] } };
    expect((await verify(lying, chain)).outcome).toBe("VALID");
    chain.next({ kernelSigner: SIGNER2 });
    const claimsValid: Cert = { ...cert, validity: { ...cert.validity, status: "VALID", reasons: [] } };
    expect((await verify(claimsValid, chain)).outcome).toBe("STALE");
  });
});

describe("fail closed on RPC problems (never VALID)", () => {
  for (const fault of ["chainId", "header", "vaultState", "code"] as const) {
    it(`${fault} throws -> UNVERIFIED RPC_ERROR`, async () => {
      const chain = chainWith(exampleState());
      const cert = await built(chain);
      chain.fault = fault;
      const r = await verify(cert, chain);
      expect(r.outcome).toBe("UNVERIFIED");
      expect(r.exitCode).toBe(20);
      expect(r.reasons).toContain("RPC_ERROR");
    });
  }
  it("the vault has no code (empty code answer) -> UNVERIFIED", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    chain.blocks.get(100n)!.code = "0x";
    expect((await verify(cert, chain)).outcome).toBe("UNVERIFIED");
  });
  it("an all-zero vault answer (limits 0) -> UNVERIFIED, not a bound of 0 and not VALID", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const zero = new FakeChain().push(100n, makeState({ perTxCap: 0n, dailyCap: 0n, hourlyCap: 0n, humanThreshold: 0n, balance: 0n }));
    const r = await verify(cert, zero);
    expect(r.outcome).toBe("UNVERIFIED");
    expect(r.reasons).toContain("RPC_ERROR");
  });
  it("a vault whose configHash view disagrees with its getters -> UNVERIFIED CONFIG_HASH_INCONSISTENT", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const lying = new FakeChain().push(100n, { ...exampleState(), configHash: h32("lie") });
    expect((await verify(cert, lying)).reasons).toEqual(["CONFIG_HASH_INCONSISTENT"]);
  });
  it("a node behind the certificate's block -> UNVERIFIED", async () => {
    const chain = chainWith(exampleState());
    chain.next({});
    chain.next({});
    const cert = await built(chain);
    const behind = new FakeChain().push(100n, exampleState()).push(101n, exampleState());
    behind.blocks.set(102n, chain.blocks.get(102n)!);
    behind.latestNumber = 101n;
    expect((await verify(cert, behind)).outcome).toBe("UNVERIFIED");
  });
  it("building also refuses on a read fault instead of producing a number", async () => {
    const chain = chainWith(exampleState());
    chain.fault = "vaultState";
    await expect(built(chain)).rejects.toThrow();
  });
});

describe("no archive state: latest-with-digest-equality (docs/16 §5.2 step 2)", () => {
  async function setup() {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    chain.next({});
    chain.pruned.add(100n);
    return { chain, cert };
  }
  it("reports the mode and is VALID when the digests are equal", async () => {
    const { chain, cert } = await setup();
    const r = await verify(cert, chain);
    expect(r.mode).toBe("latest-with-digest-equality");
    expect(r.outcome).toBe("VALID");
    expect(r.findings.join("\n")).toContain("MODE=latest-with-digest-equality");
  });
  it("still catches a forged bound (math recomputed from the stated inputs and the on-chain limits)", async () => {
    const { chain, cert } = await setup();
    const forged = JSON.parse(JSON.stringify(cert)) as Cert;
    forged.bounds.T3c.horizons[3]!.value = "1";
    const r = await verify(rehash(forged), chain);
    expect(r.outcome).toBe("MISMATCH");
  });
  it("still catches forged limits", async () => {
    const { chain, cert } = await setup();
    const forged = JSON.parse(JSON.stringify(cert)) as Cert;
    forged.inputs.limits.dailyCap = "1";
    expect((await verify(rehash(forged), chain)).outcome).toBe("MISMATCH");
  });
  it("a changed config or engagement set is STALE, not VALID", async () => {
    const { chain, cert } = await setup();
    chain.next({ kernelSigner: SIGNER2 });
    expect((await verify(cert, chain)).reasons).toEqual(["CONFIG_CHANGED"]);
  });
  it("--require-archive refuses to downgrade", async () => {
    const { chain, cert } = await setup();
    const r = await verify(cert, chain, { requireArchive: true });
    expect(r.outcome).toBe("UNVERIFIED");
    expect(r.mode).toBeNull();
  });
  it("remaining capacity larger than the document states with unchanged engagements -> MISMATCH", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    // forge the document to understate sumRemaining, then present a chain where it is really larger
    const forged = JSON.parse(JSON.stringify(cert)) as Cert;
    forged.inputs.sumRemainingBaseUnits = "1000000";
    chain.pruned.add(100n);
    chain.next({});
    const r = await verify(rehash(forged), chain);
    expect(r.outcome).toBe("MISMATCH");
  });
});

describe("code match (docs/16 §5.3)", () => {
  const artifactFor = (code: string, refs: Record<string, { start: number; length: number }[]> = {}) => parseArtifact({ deployedBytecode: { object: code, immutableReferences: refs } });
  it("MATCH when the on-chain code equals the artifact with immutables zeroed (immutables may differ per deployment)", async () => {
    const chain = chainWith(exampleState());
    chain.code0 = "0x60aa60bb60cc60dd";
    chain.blocks.get(100n)!.code = "0x60aa60bb60cc60dd";
    const cert = await built(chain);
    const art = artifactFor("0x60aa00ff60cc60dd", { "7": [{ start: 2, length: 2 }] });
    // on-chain bytes 2..3 are "60bb", artifact has "00ff": equal after zeroing both
    const r = await verify(cert, chain, { artifact: art });
    expect(r.codeMatch.status).toBe("MATCH");
    expect(r.outcome).toBe("VALID");
  });
  it("a different build -> UNVERIFIED CODE_NOT_VALIDATED (exit 20)", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const r = await verify(cert, chain, { artifact: artifactFor("0x600160025555") });
    expect(r.outcome).toBe("UNVERIFIED");
    expect(r.reasons).toEqual(["CODE_NOT_VALIDATED"]);
    expect(r.codeMatch.status).toBe("MISMATCH");
  });
  it("a difference outside the immutable ranges is a mismatch", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const r = await verify(cert, chain, { artifact: artifactFor("0x6001600155", { "1": [{ start: 0, length: 1 }] }) });
    expect(r.reasons).toEqual(["CODE_NOT_VALIDATED"]);
  });
  it("validation results attributed to different bytecode than the supplied build -> CODE_NOT_VALIDATED", async () => {
    const chain = chainWith(exampleState());
    const art = artifactFor("0x6001600055");
    const validation = {
      schema: "symbolon-blast-validation/1",
      provenance: { gitSha: GIT, gitDirty: false, seeds: [1], modelIds: [], promptHashes: [], vaultRuntimeCodeHash: h32("some other build"), tools: {} },
      t3: { trials: 500, violations: 0, bestAttack24hBaseUnits: "150000000" },
      t1: { plans: 240, losses: 0 },
    };
    const cert = await built(chain, { validationResults: validation });
    expect(cert.validation?.codeMatch.status).toBe("NOT_CHECKED");
    const r = await verify(cert, chain, { artifact: art });
    expect(r.reasons).toEqual(["CODE_NOT_VALIDATED"]);
  });
  it("validation attributed to the supplied build and matching on-chain code -> MATCH recorded at build and VALID at verify", async () => {
    const chain = chainWith(exampleState());
    const art = artifactFor("0x6001600055");
    const validation = {
      schema: "symbolon-blast-validation/1",
      provenance: { gitSha: GIT, gitDirty: false, seeds: [1], modelIds: [], promptHashes: [], vaultRuntimeCodeHash: art.codeHash, tools: {} },
      t3: { trials: 500, violations: 0, bestAttack24hBaseUnits: "150000000" },
      t1: { plans: 240, losses: 0 },
    };
    const cert = await built(chain, { validationResults: validation, artifact: art });
    expect(cert.validation).toMatchObject({ t3Trials: 500, t3Violations: 0, upper95: "0.006", tightness: "1.0", codeMatch: { status: "MATCH" } });
    expect((await verify(cert, chain, { artifact: art })).outcome).toBe("VALID");
  });
  it("validation recorded as MISMATCH at build is UNVERIFIED even without an artifact at verify", async () => {
    const chain = chainWith(exampleState());
    const validation = {
      schema: "symbolon-blast-validation/1",
      provenance: { gitSha: GIT, gitDirty: false, seeds: [], modelIds: [], promptHashes: [], vaultRuntimeCodeHash: h32("x"), tools: {} },
      t3: { trials: 10, violations: 0, bestAttack24hBaseUnits: "0" },
      t1: { plans: 0, losses: 0 },
    };
    const cert = await built(chain, { validationResults: validation, artifact: artifactFor("0x6001600055") });
    expect(cert.validation?.codeMatch.status).toBe("MISMATCH");
    expect((await verify(cert, chain)).reasons).toEqual(["CODE_NOT_VALIDATED"]);
  });
});

describe("publisher signature (a convenience, never the evidence; RT-20)", () => {
  it("a valid signature verifies; a wrong key or edited hash is MISMATCH", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    const acct = privateKeyToAccount(generatePrivateKey());
    const signed = await attachPublisher(cert, { address: acct.address, signMessage: (m) => acct.signMessage({ message: m }) });
    const r = await verify(signed, chain);
    expect(r.publisher).toBe("VALID");
    expect(r.outcome).toBe("VALID");
    const other = privateKeyToAccount(generatePrivateKey());
    const bad = { ...signed, publisher: { address: other.address, sig: signed.publisher!.sig } };
    const rb = await verify(bad, chain);
    expect(rb.publisher).toBe("INVALID");
    expect(rb.outcome).toBe("MISMATCH");
  });
  it("the same certificate without a signature verifies identically", async () => {
    const chain = chainWith(exampleState());
    const cert = await built(chain);
    expect((await verify(cert, chain)).publisher).toBe("ABSENT");
  });
});

describe("exit codes", () => {
  it("are 0 / 10 / 20 / 30 / 2 as documented", () => {
    expect(EXIT_CODES).toEqual({ VALID: 0, STALE: 10, UNVERIFIED: 20, MISMATCH: 30, USAGE: 2 });
  });
});

describe("validity recorded at build", () => {
  it("a certificate built at an old block is already STALE and says why", async () => {
    const chain = chainWith(exampleState());
    chain.next({ kernelSigner: SIGNER2 });
    const { cert } = await buildFromReader(chain, VAULT, { block: 100n, gitSha: GIT, nowSeconds: NOW });
    expect(cert.validity.status).toBe("STALE");
    expect(cert.validity.reasons).toEqual(["CONFIG_CHANGED"]);
  });
  it("build refuses when the node does not know the block, and when it changes under us", async () => {
    const chain = chainWith(exampleState());
    await expect(buildFromReader(chain, VAULT, { block: 999n, gitSha: GIT, nowSeconds: NOW })).rejects.toThrow(/BLOCK_UNAVAILABLE/);
    chain.pruned.add(100n);
    await expect(buildFromReader(chain, VAULT, { block: 100n, gitSha: GIT, nowSeconds: NOW })).rejects.toThrow(/BLOCK_UNAVAILABLE/);
  });
  it("a bad vault address is refused", async () => {
    await expect(buildFromReader(chainWith(exampleState()), "0x123", { gitSha: GIT, nowSeconds: NOW })).rejects.toThrow(/INVALID_OPTION/);
  });
});

export type { Hex32 };
