// The Loss Bound Certificate against a REAL anvil node and the REAL SymbolonVault (docs/16 §10 test 4: anvil staleness
// matrix; §5 acceptance: `lbc verify` returns 0 with an independent reader and 10 after a config change). Stock anvil is
// not Arc (V-19): a local pass is a smoke test of the mechanism, not a statement about Arc (V-29, V-30 are open).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Address } from "@symbolon/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFromReader } from "../../src/lbc/build";
import { parseArtifact } from "../../src/lbc/code-match";
import { verifyCertificate } from "../../src/lbc/verify";
import { USDC, VAULT_ARTIFACT, World, anvilSuiteEnabled } from "./helpers/anvil-world";

const enabled = anvilSuiteEnabled("anvil.lbc");
const GIT = "0123456789abcdef0123456789abcdef01234567";
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

describe.skipIf(!enabled)("LBC on a real vault (anvil)", () => {
  let w: World;
  beforeAll(async () => {
    w = await World.open();
  }, 60_000);
  afterAll(async () => {
    await w?.close();
  });

  const build = async (vault: Address, extra: Record<string, unknown> = {}) =>
    (await buildFromReader(w.reader(), vault, { block: "latest", gitSha: GIT, nowSeconds: await w.now(), ...extra })).cert;
  const verify = async (cert: unknown, extra: Record<string, unknown> = {}) => verifyCertificate(cert, w.reader(), { nowSeconds: await w.now(), ...extra });

  /** engagements bind (ΣR=150 < B=200); balance does not */
  async function engBound(): Promise<{ vault: Address; id: `0x${string}` }> {
    const vault = await w.deployVault();
    await w.fund(vault, 200n * USDC);
    const id = await w.register(vault, "main", 150n * USDC);
    return { vault, id };
  }
  /** balance binds (B=100 < ΣR=500) */
  async function balBound(): Promise<{ vault: Address; id: `0x${string}` }> {
    const vault = await w.deployVault();
    await w.fund(vault, 100n * USDC);
    const id = await w.register(vault, "main", 500n * USDC);
    return { vault, id };
  }

  it("builds the numbers the closed form gives, from the real chain (hand-checked: p*=50, d*=200, ΣR=150, all horizons 150)", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    expect(cert.inputs).toMatchObject({ balanceBaseUnits: "200000000", sumRemainingBaseUnits: "150000000", activeEngagements: 1 });
    expect(cert.inputs.limits).toEqual({ perTxCap: "100000000", dailyCap: "200000000", hourlyCap: "0", humanThreshold: "50000000", ringSize: 64 });
    expect(cert.bounds.T3c.perReleaseUnapproved).toBe("50000000");
    expect(cert.bounds.T3c.perDay).toBe("200000000");
    expect(cert.bounds.T3c.horizons.map((h) => h.value)).toEqual(Array(6).fill("150000000"));
    expect(cert.validity.status).toBe("VALID");
    expect(cert.subject.chainId).toBe(31337);
  });

  it("fund the vault: balance not binding -> VALID", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    await w.fund(vault, 500n * USDC);
    expect((await verify(cert)).outcome).toBe("VALID");
  });
  it("fund the vault: balance binding -> STALE BALANCE_INCREASED", async () => {
    const { vault } = await balBound();
    const cert = await build(vault);
    await w.fund(vault, 1n);
    const r = await verify(cert);
    expect(r.outcome).toBe("STALE");
    expect(r.reasons).toEqual(["BALANCE_INCREASED"]);
  });
  it("register an engagement -> STALE ENGAGEMENTS_CHANGED", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    await w.register(vault, "second", 10n * USDC);
    expect((await verify(cert)).reasons).toEqual(["ENGAGEMENTS_CHANGED"]);
  });
  it("close an engagement -> STALE ENGAGEMENTS_CHANGED", async () => {
    const { vault, id } = await engBound();
    const cert = await build(vault);
    await w.closeEngagement(vault, id);
    expect((await verify(cert)).reasons).toEqual(["ENGAGEMENTS_CHANGED"]);
  });
  it("rotate the kernel signer -> STALE CONFIG_CHANGED", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    await w.rotateSigner(vault);
    const r = await verify(cert, { freshnessSeconds: 10 * 86_400 });
    expect(r.outcome).toBe("STALE");
    expect(r.reasons).toEqual(["CONFIG_CHANGED"]);
  });
  it("setGuardian -> STALE CONFIG_CHANGED", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    await w.setGuardian(vault);
    expect((await verify(cert)).reasons).toEqual(["CONFIG_CHANGED"]);
  });
  it("release a payment -> VALID (balance and remaining capacity only fell)", async () => {
    const { vault, id } = await engBound();
    const cert = await build(vault);
    await w.release(vault, id, 40n * USDC, "p1");
    const r = await verify(cert);
    expect(r.outcome).toBe("VALID");
    expect(r.latest?.sumRemainingBaseUnits).toBe("110000000");
    expect(r.latest?.balanceBaseUnits).toBe("160000000");
  });
  it("pause then unpause -> VALID", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    await w.pause(vault);
    expect((await verify(cert)).outcome).toBe("VALID");
    await w.unpause(vault);
    expect((await verify(cert)).outcome).toBe("VALID");
  });
  it("wait past the freshness window -> STALE FRESHNESS_EXCEEDED", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    await w.warp(86_400 + 60);
    const r = await verify(cert);
    expect(r.outcome).toBe("STALE");
    expect(r.reasons).toEqual(["FRESHNESS_EXCEEDED"]);
  });

  it("a forged lower bound is MISMATCH against the real chain, with a field diff", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    const forged = JSON.parse(JSON.stringify(cert)) as typeof cert;
    forged.bounds.T3c.horizons[3]!.value = "1";
    const r = await verify(forged);
    expect(r.outcome).toBe("MISMATCH");
    expect(r.reasons).toContain("CERT_HASH_MISMATCH");
  });

  it("code match: the real build's runtime code, immutables zeroed, matches the deployed vault; another vault's artifact does not", async () => {
    const { vault } = await engBound();
    const cert = await build(vault);
    const artifact = parseArtifact(JSON.parse(readFileSync(VAULT_ARTIFACT, "utf8")));
    expect(artifact.ranges.length).toBeGreaterThan(0);
    const r = await verify(cert, { artifact });
    expect(r.codeMatch.status).toBe("MATCH");
    expect(r.outcome).toBe("VALID");
    // two vaults deployed with different immutables share the zeroed hash (validation transfers across configs of one build)
    const other = await w.deployVault({ perTxCap: 7n * USDC, dailyCap: 9n * USDC });
    const c2 = await build(other);
    expect((await verify(c2, { artifact })).codeMatch.artifactCodeHash).toBe(artifact.codeHash);
    expect((await verify(c2, { artifact })).codeMatch.status).toBe("MATCH");
    const tampered = parseArtifact({ deployedBytecode: { object: `0x${"60".repeat(40)}`, immutableReferences: {} } });
    expect((await verify(cert, { artifact: tampered })).reasons).toEqual(["CODE_NOT_VALIDATED"]);
  });

  it("an address with no contract -> build refuses, verify is UNVERIFIED (never a bound of 0)", async () => {
    await expect(build("0x000000000000000000000000000000000000dEaD")).rejects.toThrow();
  });

  it("CLI: `lbc build` then `lbc verify` returns 0 with an independent reader, and 10 after a config change", async () => {
    const { vault } = await engBound();
    const dir = mkdtempSync(join(tmpdir(), "lbc-"));
    try {
      const file = join(dir, "cert.json");
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", pathToFileURL(join(ROOT, "packages/blast-radius/scripts/register-ts.mjs")).href, join(ROOT, "packages/blast-radius/src/cli/lbc.ts"), ...args],
          { encoding: "utf8", cwd: ROOT, timeout: 60_000 },
        );
      const b = run(["build", vault, "--rpc", w.anvil.url, "--block", "latest", "--git-sha", GIT, "--out", file]);
      expect(b.status, b.stderr).toBe(0);
      expect(b.stderr).toContain("at most $150.00");
      writeFileSync(join(dir, "artifact-path.txt"), VAULT_ARTIFACT);
      const v0 = run(["verify", file, "--rpc", w.anvil.url, "--artifact", VAULT_ARTIFACT]);
      expect(v0.status, v0.stdout + v0.stderr).toBe(0);
      expect(v0.stdout).toContain("RESULT VALID");
      expect(v0.stdout + v0.stderr).not.toContain(w.anvil.url);
      await w.setGuardian(vault); // a config change
      const v1 = run(["verify", file, "--rpc", w.anvil.url]);
      expect(v1.status, v1.stdout + v1.stderr).toBe(10);
      expect(v1.stdout).toContain("CONFIG_CHANGED");
      expect(v1.stdout).toContain("inputs.configHash");
      const ex = run(["explain", file]);
      expect(ex.status).toBe(0);
      expect(ex.stdout.indexOf("EXCLUSIONS")).toBeLessThan(ex.stdout.indexOf("If the AI and the kernel key"));
      const bad = run(["verify", file]); // no --rpc
      expect(bad.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
