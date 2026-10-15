// Mainnet configuration (V-03). The chain id and the Circle identifier used here are TEST values, not Arc's or Circle's:
// the real ones are operator-supplied from the docs, and main.ts compares the id with the live node before anything runs.
// Throwaway keys only. Each negative case starts from a passing mainnet production environment and breaks ONE rule.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { evaluateBootGuards } from "../src/boot";
import { loadConfig } from "../src/config";
import { checkCircleBlockchain, generateRelayerWallet } from "../src/circle/wallet";
import { Secret } from "../src/secret";
import { fakeCircle } from "./helpers/circle-fakes";

const MAINNET_TEST_ID = "990001";
const SECRET_HEX = randomBytes(32).toString("hex");

const mainnet = (): Record<string, string> => ({
  KERNEL_PROFILE: "production",
  NETWORK: "mainnet",
  ARC_MAINNET_CHAIN_ID: MAINNET_TEST_ID,
  ARC_MAINNET_RPC_URL: "https://mainnet-rpc.example.invalid/",
  DATABASE_URL: "postgres://kernel@db.prod.example.test:5432/symbolon",
  SERVICE_TOKEN_SECRET: randomBytes(32).toString("hex"),
  KERNEL_SIGNER_PRIVATE_KEY: generatePrivateKey(),
  EVIDENCE_MODE: "live",
});
const circle = (): Record<string, string> => ({
  CIRCLE_API_KEY: "TEST_API_KEY:0123456789abcdef:0123456789abcdef",
  CIRCLE_ENTITY_SECRET: SECRET_HEX,
  RELAYER_WALLET_ID: "wallet-0001",
  RELAYER_WALLET_ADDRESS: "0x00000000000000000000000000000000000000AA",
});

describe("mainnet config (V-03)", () => {
  it("a complete production mainnet environment loads (positive control)", () => {
    const c = loadConfig(mainnet());
    expect(c.network).toBe("mainnet");
    expect(c.profile).toBe("production");
    expect(c.evidenceMode).toBe("live");
  });

  it.each<[string, (e: Record<string, string>) => void, RegExp]>([
    ["no chain id", (e) => delete e["ARC_MAINNET_CHAIN_ID"], /ARC_MAINNET_CHAIN_ID/],
    ["chain id is the testnet id", (e) => (e["ARC_MAINNET_CHAIN_ID"] = "5042002"), /ARC_MAINNET_CHAIN_ID/],
    ["chain id is not decimal", (e) => (e["ARC_MAINNET_CHAIN_ID"] = "0x1"), /ARC_MAINNET_CHAIN_ID/],
    ["no mainnet RPC", (e) => delete e["ARC_MAINNET_RPC_URL"], /ARC_MAINNET_RPC_URL/],
    ["a stray testnet RPC", (e) => (e["ARC_RPC_URL"] = "https://rpc.example.invalid/"), /ARC_RPC_URL/],
    ["fixtures evidence", (e) => (e["EVIDENCE_MODE"] = "fixtures"), /EVIDENCE_MODE/],
    ["a scheduler test clock", (e) => (e["TEST_CLOCK_OFFSET_SECONDS"] = "60"), /TEST_CLOCK_OFFSET_SECONDS/],
    ["a raw-key relayer", (e) => (e["RELAYER_PRIVATE_KEY"] = generatePrivateKey()), /RELAYER_PRIVATE_KEY/],
    ["the sandbox profile", (e) => (e["KERNEL_PROFILE"] = "sandbox"), /NETWORK|G1/],
  ])("refuses mainnet with %s", (_name, breakIt, why) => {
    const e = mainnet();
    breakIt(e);
    expect(() => loadConfig(e)).toThrow(why);
  });

  it("boot G3: ARC_MAINNET_* variables are refused in the sandbox like PROD_*/MAINNET_*", () => {
    const sandboxish = { ...mainnet(), KERNEL_PROFILE: "sandbox", NETWORK: "testnet" };
    expect(evaluateBootGuards(sandboxish).map((v) => `${v.rule}:${v.variable}`)).toEqual(expect.arrayContaining(["G3:ARC_MAINNET_CHAIN_ID", "G3:ARC_MAINNET_RPC_URL"]));
  });

  it("Circle on mainnet: the identifier is never defaulted and never a testnet one", () => {
    expect(() => loadConfig({ ...mainnet(), ...circle() })).toThrow(/CIRCLE_BLOCKCHAIN/);
    expect(() => loadConfig({ ...mainnet(), ...circle(), CIRCLE_BLOCKCHAIN: "ARC-TESTNET" })).toThrow(/CIRCLE_BLOCKCHAIN/);
    expect(() => loadConfig({ ...mainnet(), ...circle(), CIRCLE_BLOCKCHAIN: "ETH" })).toThrow(/CIRCLE_BLOCKCHAIN/);
    expect(loadConfig({ ...mainnet(), ...circle(), CIRCLE_BLOCKCHAIN: "ARC" }).circle?.blockchain).toBe("ARC");
  });

  it("checkCircleBlockchain: testnet accepts only ARC-TESTNET; mainnet only an Arc non-test identifier", () => {
    expect(checkCircleBlockchain("ARC-TESTNET", "testnet")).toBe("ARC-TESTNET");
    for (const b of ["ARC", "ARC-MAINNET", "arc-testnet", ""]) expect(() => checkCircleBlockchain(b, "testnet"), b).toThrow(RangeError);
    for (const b of ["ARC", "ARC-MAINNET"]) expect(checkCircleBlockchain(b, "mainnet")).toBe(b);
    for (const b of ["ARC-TESTNET", "ARC-TEST", "ETH", "ARC-", "arc", "", "ARC-MAINNET; drop"]) expect(() => checkCircleBlockchain(b, "mainnet"), b).toThrow(RangeError);
  });

  it("wallet generation for mainnet needs the network named and a mainnet identifier", async () => {
    const api = fakeCircle({ entitySecretHex: SECRET_HEX });
    await expect(generateRelayerWallet({ api, entitySecret: new Secret(SECRET_HEX), profile: "production", blockchain: "ARC" })).rejects.toThrow(RangeError);
    await expect(generateRelayerWallet({ api, entitySecret: new Secret(SECRET_HEX), profile: "production", blockchain: "ARC-TESTNET", network: "mainnet" })).rejects.toThrow(RangeError);
    const w = await generateRelayerWallet({ api, entitySecret: new Secret(SECRET_HEX), profile: "production", blockchain: "ARC", network: "mainnet", runId: "m1" });
    expect(w.blockchain).toBe("ARC");
  });
});
