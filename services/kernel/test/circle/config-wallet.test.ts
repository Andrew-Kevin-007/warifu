// Circle configuration rules and the wallet-generation helpers/CLI (mocked Circle edge, throwaway files only).
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { loadConfig } from "../../src/config";
import { runGenerateWallet } from "../../src/circle/generate-wallet-cli";
import { generateRelayerWallet } from "../../src/circle/wallet";
import { Secret } from "../../src/secret";
import { fakeCircle } from "../helpers/circle-fakes";

const SECRET_HEX = randomBytes(32).toString("hex");
const base = (): Record<string, string> => ({
  KERNEL_PROFILE: "production",
  NETWORK: "testnet",
  DATABASE_URL: "postgres://kernel@db.prod.example.test:5432/symbolon",
  SERVICE_TOKEN_SECRET: randomBytes(32).toString("hex"),
  KERNEL_SIGNER_PRIVATE_KEY: generatePrivateKey(),
  EVIDENCE_MODE: "live",
});
const circleEnv = (): Record<string, string> => ({
  ...base(),
  CIRCLE_API_KEY: "TEST_API_KEY:0123456789abcdef:0123456789abcdef",
  CIRCLE_ENTITY_SECRET: SECRET_HEX,
  RELAYER_WALLET_ID: "wallet-0001",
  RELAYER_WALLET_ADDRESS: "0x00000000000000000000000000000000000000AA",
  CIRCLE_WEBHOOK_PUBLIC_KEY_ID: "key-id-0001-aaaa, key-id-0002-bbbb",
});

describe("circle config", () => {
  it("absent unless configured", () => {
    expect(loadConfig(base()).circle).toBeNull();
  });
  it("a full configuration parses; secrets are Secrets; the address is lowercased; key ids are a list", () => {
    const c = loadConfig(circleEnv()).circle!;
    expect(String(c.apiKey)).toBe("[redacted]");
    expect(JSON.stringify(c)).not.toContain(SECRET_HEX);
    expect(c.walletAddress).toBe("0x00000000000000000000000000000000000000aa");
    expect(c.webhookKeyIds).toEqual(["key-id-0001-aaaa", "key-id-0002-bbbb"]);
    expect(c.blockchain).toBe("ARC-TESTNET");
  });
  it("half a configuration, a bad entity secret, mainnet, or two relayers at once fail closed", () => {
    for (const drop of ["CIRCLE_API_KEY", "RELAYER_WALLET_ID", "RELAYER_WALLET_ADDRESS"]) {
      const e = circleEnv();
      delete e[drop];
      expect(() => loadConfig(e)).toThrow(new RegExp(drop));
    }
    expect(() => loadConfig({ ...circleEnv(), CIRCLE_ENTITY_SECRET: "x".repeat(64) })).toThrow(/CIRCLE_ENTITY_SECRET/);
    expect(() => loadConfig({ ...circleEnv(), CIRCLE_BLOCKCHAIN: "ARC" })).toThrow(/CIRCLE_BLOCKCHAIN/);
    expect(() => loadConfig({ ...circleEnv(), RELAYER_PRIVATE_KEY: generatePrivateKey() })).toThrow(/RELAYER_PRIVATE_KEY/);
    expect(() => loadConfig({ ...circleEnv(), CIRCLE_WEBHOOK_PUBLIC_KEY_ID: "../x" })).toThrow(/CIRCLE_WEBHOOK_PUBLIC_KEY_ID/);
  });
});

describe("wallet generation", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("creates a wallet set and an EOA wallet with a fresh valid ciphertext per request; the profile is in the set name", async () => {
    const circle = fakeCircle({ entitySecretHex: SECRET_HEX });
    const w = await generateRelayerWallet({ api: circle, entitySecret: new Secret(SECRET_HEX), profile: "sandbox", blockchain: "ARC-TESTNET", runId: "r1" });
    expect(w).toMatchObject({ profile: "sandbox", walletSetId: "ws-0000-aaaa", walletId: "wallet-0001", blockchain: "ARC-TESTNET" });
    expect((circle.walletSets[0] as { name: string }).name).toBe("symbolon-sandbox-relayer");
    expect(new Set(circle.ciphertextsSeen).size).toBe(2);
  });

  it("is idempotent for a run id (same keys) and distinct per profile", async () => {
    const a = fakeCircle({ entitySecretHex: SECRET_HEX });
    await generateRelayerWallet({ api: a, entitySecret: new Secret(SECRET_HEX), profile: "production", blockchain: "ARC-TESTNET", runId: "r1" });
    await generateRelayerWallet({ api: a, entitySecret: new Secret(SECRET_HEX), profile: "production", blockchain: "ARC-TESTNET", runId: "r1" });
    await generateRelayerWallet({ api: a, entitySecret: new Secret(SECRET_HEX), profile: "sandbox", blockchain: "ARC-TESTNET", runId: "r1" });
    const keys = (a.walletSets as Array<{ idempotencyKey: string }>).map((s) => s.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("refuses an unsupported (mainnet / unverified) blockchain", async () => {
    await expect(generateRelayerWallet({ api: fakeCircle({ entitySecretHex: SECRET_HEX }), entitySecret: new Secret(SECRET_HEX), profile: "production", blockchain: "ARC" })).rejects.toThrow(RangeError);
  });

  it("CLI: entity-secret writes a new mode-600 file outside the repo, prints no secret, and never overwrites", async () => {
    const dir = mkdtempSync(join(tmpdir(), "symbolon-es-"));
    dirs.push(dir);
    const out: string[] = [];
    const file = join(dir, "entity-secret.txt");
    expect(await runGenerateWallet(["entity-secret", "--out", file], {}, { out: (l) => out.push(l) })).toBe(0);
    const secret = readFileSync(file, "utf8").trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(out.join("\n")).not.toContain(secret);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await runGenerateWallet(["entity-secret", "--out", file], {}, { out: (l) => out.push(l) })).toBe(2);
    expect(readFileSync(file, "utf8").trim()).toBe(secret);
    const inRepo = join(dir, "sub", "x.txt");
    expect(await runGenerateWallet(["entity-secret", "--out", inRepo], {}, { out: (l) => out.push(l), repoRoot: dir })).toBe(2);
    expect(existsSync(inRepo)).toBe(false);
  });

  it("CLI: wallet prints only ids and the address and reads credentials from the environment, never from a file", async () => {
    const out: string[] = [];
    const circle = fakeCircle({ entitySecretHex: SECRET_HEX });
    const env = { CIRCLE_API_KEY: "TEST_API_KEY:aaaa:bbbb", CIRCLE_ENTITY_SECRET: SECRET_HEX };
    expect(await runGenerateWallet(["wallet", "--profile", "production"], env, { out: (l) => out.push(l), api: circle })).toBe(0);
    expect(out.join("\n")).toContain("RELAYER_WALLET_ID=wallet-0001");
    expect(out.join("\n")).toContain("RELAYER_WALLET_ADDRESS=0x00000000000000000000000000000000000000aa");
    expect(out.join("\n")).not.toContain(SECRET_HEX);
    expect(out.join("\n")).not.toContain("TEST_API_KEY");
    expect(await runGenerateWallet(["wallet", "--profile", "staging"], env, { out: () => undefined, api: circle })).toBe(2);
    expect(await runGenerateWallet(["wallet", "--profile", "sandbox"], {}, { out: () => undefined, api: circle })).toBe(2);
  });
});
