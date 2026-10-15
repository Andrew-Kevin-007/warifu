// SEC-05 (profile guards, local profile) and RT-31 secret hygiene. Throwaway keys are generated per run; nothing here is a
// real credential. Each negative case starts from a passing sandbox (or production) environment and breaks ONE rule.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { assertBootGuards, evaluateBootGuards, BootError } from "../src/boot";
import type { EnvLike } from "../src/boot";
import { loadConfig } from "../src/config";

const secret = (): string => randomBytes(32).toString("hex");
const signerKey = generatePrivateKey();

const production = (): Record<string, string> => ({
  KERNEL_PROFILE: "production",
  NETWORK: "testnet",
  DATABASE_URL: "postgres://kernel@db.prod.example.test:5432/symbolon",
  SERVICE_TOKEN_SECRET: secret(),
  KERNEL_SIGNER_PRIVATE_KEY: generatePrivateKey(),
  EVIDENCE_MODE: "live",
});
const sandbox = (): Record<string, string> => ({
  KERNEL_PROFILE: "sandbox",
  NETWORK: "testnet",
  DATABASE_URL: "postgres://kernel@db.sandbox.example.test:5432/symbolon",
  SERVICE_TOKEN_SECRET: secret(),
  KERNEL_SIGNER_PRIVATE_KEY: signerKey,
  EVIDENCE_MODE: "fixtures",
  CHALLENGE_LLM_DAILY_BUDGET_USD: "5",
  CHALLENGE_IP_SALT: randomBytes(16).toString("hex"),
  PROD_SIGNER_ADDRESSES: privateKeyToAccount(generatePrivateKey()).address,
  PROD_SUPABASE_HOST: "db.prod.example.test",
});
const rules = (env: EnvLike): string[] => evaluateBootGuards(env).map((v) => `${v.rule}:${v.variable}`);

describe("boot guards (INV-16, RT-05, docs/15 s3)", () => {
  it("passes for a sound production and a sound sandbox environment (positive controls)", () => {
    expect(rules(production())).toEqual([]);
    expect(rules(sandbox())).toEqual([]);
    expect(loadConfig(sandbox()).profile).toBe("sandbox");
    expect(loadConfig(production()).profile).toBe("production");
  });

  it("G0: no profile, or an unknown profile, does not boot (there is no default)", () => {
    const e = production();
    delete e["KERNEL_PROFILE"];
    expect(rules(e)).toEqual(["G0:KERNEL_PROFILE"]);
    expect(rules({ ...production(), KERNEL_PROFILE: "staging" })).toEqual(["G0:KERNEL_PROFILE"]);
    expect(rules({ ...production(), KERNEL_PROFILE: "Sandbox" })).toEqual(["G0:KERNEL_PROFILE"]);
  });

  it("G1: the sandbox refuses mainnet and anything that is not testnet/local", () => {
    for (const n of ["mainnet", "MAINNET", "", "arc"]) expect(rules({ ...sandbox(), NETWORK: n }), n).toContain("G1:NETWORK");
    expect(rules({ ...sandbox(), NETWORK: "local" })).toEqual([]);
    // production mainnet is allowed only with its own chain id and RPC (test/mainnet-config.test.ts); bare NETWORK=mainnet fails closed
    expect(() => loadConfig({ ...production(), NETWORK: "mainnet" })).toThrow(/mainnet/);
  });

  it("G2: the sandbox refuses a production signer address (case-insensitive) and a bad key", () => {
    const prodAddr = privateKeyToAccount(signerKey).address;
    expect(rules({ ...sandbox(), PROD_SIGNER_ADDRESSES: `0x0000000000000000000000000000000000000001, ${prodAddr.toLowerCase()}` })).toContain("G2:KERNEL_SIGNER_PRIVATE_KEY");
    expect(rules({ ...sandbox(), KERNEL_SIGNER_PRIVATE_KEY: "0x1234" })).toContain("G2:KERNEL_SIGNER_PRIVATE_KEY");
    const e = sandbox();
    delete e["KERNEL_SIGNER_PRIVATE_KEY"];
    expect(rules(e)).toContain("G2:KERNEL_SIGNER_PRIVATE_KEY");
    const guardian = generatePrivateKey();
    expect(rules({ ...sandbox(), GUARDIAN_PRIVATE_KEY: guardian, PROD_SIGNER_ADDRESSES: privateKeyToAccount(guardian).address })).toContain("G2:GUARDIAN_PRIVATE_KEY");
  });

  it("G3: any PROD_* or MAINNET_* variable other than the two denylists stops the sandbox", () => {
    for (const name of ["PROD_SERVICE_TOKEN_SECRET", "PROD_CIRCLE_API_KEY", "MAINNET_RPC_URL", "PROD_SIGNER_ADDRESS"]) {
      expect(rules({ ...sandbox(), [name]: "x" }), name).toContain(`G3:${name}`);
    }
    expect(rules(sandbox())).not.toContain("G3:PROD_SIGNER_ADDRESSES");
  });

  it("G4: the sandbox refuses the production database host (and its subdomains), by DATABASE_URL or SUPABASE_URL", () => {
    expect(rules({ ...sandbox(), DATABASE_URL: "postgres://k@db.prod.example.test:5432/x" })).toContain("G4:DATABASE_URL");
    expect(rules({ ...sandbox(), DATABASE_URL: "postgres://k@DB.PROD.EXAMPLE.TEST:5432/x" })).toContain("G4:DATABASE_URL");
    expect(rules({ ...sandbox(), SUPABASE_URL: "https://eu.db.prod.example.test" })).toContain("G4:SUPABASE_URL");
    expect(rules({ ...sandbox(), DATABASE_URL: "not a url" })).toContain("G4:DATABASE_URL");
  });

  it("G5: the sandbox needs fixtures evidence; production must not use fixtures", () => {
    expect(rules({ ...sandbox(), EVIDENCE_MODE: "live" })).toContain("G5:EVIDENCE_MODE");
    const e = sandbox();
    delete e["EVIDENCE_MODE"];
    expect(rules(e)).toContain("G5:EVIDENCE_MODE");
    expect(rules({ ...production(), EVIDENCE_MODE: "fixtures" })).toContain("G5:EVIDENCE_MODE");
  });

  it("G6: the sandbox needs a positive LLM budget and an IP salt", () => {
    for (const b of ["", "0", "0.0", "-1", "five", "5usd"]) expect(rules({ ...sandbox(), CHALLENGE_LLM_DAILY_BUDGET_USD: b }), b).toContain("G6:CHALLENGE_LLM_DAILY_BUDGET_USD");
    expect(rules({ ...sandbox(), CHALLENGE_IP_SALT: "short" })).toContain("G6:CHALLENGE_IP_SALT");
  });

  it("G8: the token secret is required, long enough, not a placeholder and not a signing key", () => {
    const e = production();
    delete e["SERVICE_TOKEN_SECRET"];
    expect(rules(e)).toContain("G8:SERVICE_TOKEN_SECRET");
    expect(rules({ ...production(), SERVICE_TOKEN_SECRET: "short" })).toContain("G8:SERVICE_TOKEN_SECRET");
    expect(rules({ ...production(), SERVICE_TOKEN_SECRET: "changeme".padEnd(40, " ") })).toContain("G8:SERVICE_TOKEN_SECRET");
    const key = generatePrivateKey();
    expect(rules({ ...production(), SERVICE_TOKEN_SECRET: key, KERNEL_SIGNER_PRIVATE_KEY: key })).toContain("G8:SERVICE_TOKEN_SECRET");
    const nodb = production();
    delete nodb["DATABASE_URL"];
    expect(rules(nodb)).toContain("G8:DATABASE_URL");
  });

  it("G9: production refuses challenge switches", () => {
    expect(rules({ ...production(), CHALLENGE_ENABLED: "true" })).toContain("G9:CHALLENGE_ENABLED");
    expect(rules({ ...production(), CHALLENGE_IP_SALT: "x".repeat(20) })).toContain("G9:CHALLENGE_IP_SALT");
  });

  it("assertBootGuards throws a BootError that names rules and variables but never a value", () => {
    const key = generatePrivateKey();
    const env = { ...sandbox(), KERNEL_SIGNER_PRIVATE_KEY: key, NETWORK: "mainnet", SERVICE_TOKEN_SECRET: key };
    let caught: unknown;
    try {
      assertBootGuards(env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BootError);
    const text = String((caught as Error).message) + JSON.stringify((caught as BootError).violations);
    expect(text).not.toContain(key);
    expect(text).toContain("G1");
  });

  it("the loaded config never prints a secret (String, JSON, template literal)", () => {
    const env = production();
    const c = loadConfig(env);
    const dump = `${String(c.serviceTokenSecret)} ${JSON.stringify(c)} ${String(c.databaseUrl)} ${String(c.kernelSignerKey)}`;
    expect(dump).not.toContain(env["SERVICE_TOKEN_SECRET"] as string);
    expect(dump).not.toContain(env["KERNEL_SIGNER_PRIVATE_KEY"] as string);
    expect(dump).not.toContain("db.prod.example.test");
    expect(c.serviceTokenSecret.reveal()).toBe(env["SERVICE_TOKEN_SECRET"]);
  });

  it("the sandbox accepts no blobs (plain text only)", () => {
    expect(loadConfig(sandbox()).maxBlobBytes).toBe(0);
    expect(loadConfig(production()).maxBlobBytes).toBeGreaterThan(0);
  });
});

describe("G10 and the secret inventory (SEC-07 review findings)", () => {
  it("refuses any configured secret shorter than 16 characters, including ones not in the old list", () => {
    for (const name of ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "CIRCLE_WEBHOOK_SECRET", "SOMETHING_NEW_SECRET", "MY_API_KEY"]) {
      expect(rules({ ...production(), [name]: "short" }), name).toContain(`G10:${name}`);
      expect(rules({ ...production(), [name]: "x".repeat(16) }), `${name} ok`).toEqual([]);
    }
    expect(rules({ ...production(), CIRCLE_WEBHOOK_PUBLIC_KEY_ID: "id" })).toEqual([]); // a public id is not a secret
  });

  it("refuses a short database password", () => {
    expect(rules({ ...production(), DATABASE_URL: "postgres://kernel:hunter2@db.prod.example.test:5432/x" })).toContain("G10:DATABASE_URL");
    expect(rules({ ...production(), DATABASE_URL: `postgres://kernel:${"p".repeat(20)}@db.prod.example.test:5432/x` })).toEqual([]);
  });

  it("the redaction list holds the URL, userinfo, password and user, raw and URL-decoded, and every other configured secret", () => {
    const pw = "p@ss/w0rd:with%chars-1234";
    const env: Record<string, string> = {
      ...production(),
      DATABASE_URL: `postgres://kernel_user:${encodeURIComponent(pw)}@db.prod.example.test:5432/x`,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
      ANTHROPIC_API_KEY: "anthropic-key-0123456789",
      CIRCLE_API_KEY: "circle-api-key-0123456789",
      CIRCLE_ENTITY_SECRET: "ab".repeat(32), // a complete, valid Circle configuration (WP-11 rejects half of one)
      RELAYER_WALLET_ID: "wallet-0001",
      RELAYER_WALLET_ADDRESS: "0x00000000000000000000000000000000000000aa",
      GITHUB_TOKEN: "github-token-0123456789",
    };
    const list = loadConfig(env).logSecrets.map((s) => s.reveal());
    for (const must of [pw, encodeURIComponent(pw), `kernel_user:${pw}`, `kernel_user:${encodeURIComponent(pw)}`, "kernel_user", ...Object.entries(env).filter(([k, v]) => v.length >= 16 && k !== "RELAYER_WALLET_ADDRESS").map(([, v]) => v)]) {
      expect(list, must).toContain(must);
    }
  });
});

describe("G11: the scheduler test clock exists only outside production (WP-14)", () => {
  it("refuses TEST_CLOCK_OFFSET_SECONDS under the production profile and under NODE_ENV=production, allows it in the sandbox", () => {
    expect(rules({ ...production(), TEST_CLOCK_OFFSET_SECONDS: "3600" })).toEqual(["G11:TEST_CLOCK_OFFSET_SECONDS"]);
    expect(rules({ ...sandbox(), NODE_ENV: "production", TEST_CLOCK_OFFSET_SECONDS: "3600" })).toEqual(["G11:TEST_CLOCK_OFFSET_SECONDS"]);
    expect(rules({ ...sandbox(), TEST_CLOCK_OFFSET_SECONDS: "3600" })).toEqual([]);
    expect(() => loadConfig({ ...production(), TEST_CLOCK_OFFSET_SECONDS: "3600" })).toThrow();
    expect(loadConfig({ ...sandbox(), TEST_CLOCK_OFFSET_SECONDS: "3600" }).scheduler.testClockOffsetSeconds).toBe(3600);
  });
});
