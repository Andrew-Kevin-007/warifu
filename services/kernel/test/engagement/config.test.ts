// WP-12 configuration: indexer defaults and bounds, and the relayer key's hygiene (a separate role from the kernel signer,
// never shorter than the 16-character secret floor). Throwaway keys only.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { evaluateBootGuards } from "../../src/boot";
import { loadConfig } from "../../src/config";

const base = (): Record<string, string> => ({
  KERNEL_PROFILE: "production",
  NETWORK: "testnet",
  DATABASE_URL: "postgres://kernel@db.prod.example.test:5432/symbolon",
  SERVICE_TOKEN_SECRET: randomBytes(32).toString("hex"),
  KERNEL_SIGNER_PRIVATE_KEY: generatePrivateKey(),
  EVIDENCE_MODE: "live",
});

describe("WP-12 config", () => {
  it("defaults: indexer on, depth 2, 5 s poll, start block 0, no relayer", () => {
    const c = loadConfig(base());
    expect(c.indexer).toEqual({ enabled: true, confirmations: 2, pollMs: 5000, startBlock: 0 });
    expect(c.relayerKey).toBeNull();
  });

  it("the depth, poll interval and start block are configurable and bounded", () => {
    const c = loadConfig({ ...base(), INDEXER_CONFIRMATIONS: "0", INDEXER_POLL_MS: "1000", INDEXER_START_BLOCK: "123456", INDEXER_ENABLED: "false" });
    expect(c.indexer).toEqual({ enabled: false, confirmations: 0, pollMs: 1000, startBlock: 123456 });
    expect(() => loadConfig({ ...base(), INDEXER_CONFIRMATIONS: "-1" })).toThrow(/INDEXER_CONFIRMATIONS/);
    expect(() => loadConfig({ ...base(), INDEXER_CONFIRMATIONS: "1001" })).toThrow(/INDEXER_CONFIRMATIONS/);
    expect(() => loadConfig({ ...base(), INDEXER_POLL_MS: "10" })).toThrow(/INDEXER_POLL_MS/);
    expect(() => loadConfig({ ...base(), INDEXER_START_BLOCK: "abc" })).toThrow(/INDEXER_START_BLOCK/);
  });

  it("the relayer key is wrapped as a secret, and may not be the kernel signer key", () => {
    const key = generatePrivateKey();
    const c = loadConfig({ ...base(), RELAYER_PRIVATE_KEY: key });
    expect(c.relayerKey?.reveal()).toBe(key);
    expect(String(c.relayerKey)).not.toContain(key.slice(2, 20));
    expect(c.logSecrets.map((s) => s.reveal())).toContain(key);
    const env = base();
    expect(() => loadConfig({ ...env, RELAYER_PRIVATE_KEY: env["KERNEL_SIGNER_PRIVATE_KEY"] as string })).toThrow(/RELAYER_PRIVATE_KEY/);
  });

  it("a short relayer key is refused by the secret-length boot guard", () => {
    const v = evaluateBootGuards({ ...base(), RELAYER_PRIVATE_KEY: "0x1234" });
    expect(v.map((x) => `${x.rule}:${x.variable}`)).toContain("G10:RELAYER_PRIVATE_KEY");
  });
});
