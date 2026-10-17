// SEC-03, 04, 05, 07, 08, 09, 10 and the coverage cross-check for 12, 13, 14 (docs/13 section 4.6, docs/14). Every test drives the REAL component
// the finding is about; only the network edges (an LLM provider, an RPC) are stubs. A SEC test is a release gate: it is never weakened to go green.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetExhaustedError, BudgetedLlm, CostModel, InMemoryBudgetLedger, MemoryCallCache, extractInvoice } from "../../extractor/src/index";
import type { LlmClient, LlmRequest, LlmResponse } from "../../extractor/src/index";
import { normalizeUntrusted, untrusted } from "../../schemas/src/index";
import { evaluateBootGuards } from "../../../services/kernel/src/boot";
import { ConcurrencyGate, MAX_ATTEMPT_BYTES, SlidingWindow, checkAttemptText, defaultLimits, degradeLevel, ipHash } from "../../../services/kernel/src/challenge/limits";
import { createLogger, errorFields } from "../../../services/kernel/src/log";
import { dbSuiteEnabled, openTestDb } from "../../../services/kernel/test/helpers/pgdb";
// @ts-expect-error plain ESM script without declarations
import { scan } from "../../../scripts/web-env-check.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const NODE_FLAGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", pathToFileURL(join(ROOT, "packages/blast-radius/scripts/register-ts.mjs")).href];

// ---- SEC-03 (RT-04): budget exhaustion fails closed -------------------------------------------------------------------------------------------
describe("SEC-03: budget exhaustion fails closed to replay", () => {
  const PRICES = new CostModel({ "model-a": { inPerMTok: 3_000_000n, outPerMTok: 15_000_000n }, "model-b": { inPerMTok: 1_000_000n, outPerMTok: 5_000_000n } });
  const counting = (): { client: LlmClient; calls: LlmRequest[] } => {
    const calls: LlmRequest[] = [];
    const client: LlmClient = { complete: (r: LlmRequest): Promise<LlmResponse> => { calls.push(r); return Promise.resolve({ toolCalls: [], text: null, usage: { tokensIn: 10, tokensOut: 5 } }); } };
    return { client, calls };
  };

  it("an exhausted budget denies the call BEFORE the provider is touched, and extraction yields no intent (no silent weaker path)", async () => {
    const { client, calls } = counting();
    const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 0n, perPrincipalDailyCapMicroUsd: 0n, day: () => "2026-10-17" });
    const llm = new BudgetedLlm({ inner: client, ledger, cache: new MemoryCallCache(), costModel: PRICES, principalHash: "p" });
    const r = await extractInvoice("Invoice 1\nTotal 10 USDC", { modelA: "model-a", modelB: "model-b", decimals: 6 }, { llm });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("BUDGET_EXHAUSTED");
      expect(r.failure.disposition === "ESCALATE" || r.failure.disposition === "HOLD").toBe(true); // never "proceed"
    }
    expect(calls).toHaveLength(0);
  });

  it("an unpriced model cannot be budgeted, so it is denied rather than called", async () => {
    const { client, calls } = counting();
    const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 10_000_000n, perPrincipalDailyCapMicroUsd: 10_000_000n, day: () => "d" });
    const llm = new BudgetedLlm({ inner: client, ledger, cache: new MemoryCallCache(), costModel: new CostModel({}), principalHash: "p" });
    await expect(llm.call({ role: "extractor_a", model: "model-a", system: "s", messages: [{ role: "user", text: "x" }], tools: [], toolChoice: { type: "any" }, maxOutputTokens: 10 })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(0);
  });

  it("an identical request is a cache hit: it never bills again", async () => {
    const { client, calls } = counting();
    const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 10_000_000n, perPrincipalDailyCapMicroUsd: 10_000_000n, day: () => "d" });
    const llm = new BudgetedLlm({ inner: client, ledger, cache: new MemoryCallCache(), costModel: PRICES, principalHash: "p" });
    const req: LlmRequest = { role: "extractor_a", model: "model-a", system: "s", messages: [{ role: "user", text: "same" }], tools: [], toolChoice: { type: "any" }, maxOutputTokens: 100 };
    await llm.call(req);
    const spent = ledger.spentToday();
    const again = await llm.call(req);
    expect(again.cacheHit).toBe(true);
    expect(calls).toHaveLength(1);
    expect(ledger.spentToday()).toBe(spent);
  });

  it("the degrade ladder: 80 % of the budget turns free-form off (L1), 100 % or the kill switch is replay-only (L2)", () => {
    const base = { enabled: true, budgetUsedBp: 0, llmConfigured: true, backendHealthy: true };
    expect(degradeLevel(base)).toBe("L0");
    expect(degradeLevel({ ...base, budgetUsedBp: 8000 })).toBe("L1");
    expect(degradeLevel({ ...base, budgetUsedBp: 10_000 })).toBe("L2");
    expect(degradeLevel({ ...base, enabled: false })).toBe("L2");
  });
});

// ---- SEC-04 (RT-05, RT-09): attack traffic never reaches traction; cross-profile rows are refused ------------------------------------------
describe.skipIf(!dbSuiteEnabled("sec04"))("SEC-04: attack traffic never reaches traction views; cross-profile rows refused (real Postgres)", () => {
  let sandbox: ReturnType<typeof openTestDb>;
  let production: ReturnType<typeof openTestDb>;
  beforeAll(() => {
    sandbox = openTestDb("sandbox");
    production = openTestDb("production");
  }, 120_000);
  afterAll(async () => {
    await sandbox.close();
    await production.close();
  }, 120_000);

  const attempt = (): [string, ...unknown[]] => [
    `insert into challenge_attempts (scenario_id, source, attack_id, ip_hash, text_hash, text_length, excerpt, extraction, verdict, reasons, checks_fired, oracle_result, oracle_predicates, benign_control, publishable)
     values ('S-A', 'oneclick', 'ATK-02', $1, $2, 0, '', '{}'::jsonb, 'REJECT', '{}', '{}', 'NO_LOSS', '{}', false, false)`,
    `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`,
  ];

  it("challenge attempts live only in a sandbox database: the production database refuses them", async () => {
    const [sql, ...vals] = attempt();
    await sandbox.db.query("insert into challenge_scenarios (scenario_id, spec, oracle_version) values ('S-A', '{}'::jsonb, 'oracle-v1') on conflict do nothing");
    await sandbox.db.query(sql, vals);
    await expect(production.db.query("insert into challenge_scenarios (scenario_id, spec, oracle_version) values ('S-A', '{}'::jsonb, 'oracle-v1')")).rejects.toThrow(/sandbox/i);
    await expect(production.db.query(sql, vals)).rejects.toThrow();
  });

  it("pilot tenants are refused in a sandbox database, and challenge tenants in a production one", async () => {
    const t = (kind: string, id: string) => ["insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash) values ($1, 'x', $2, $3, 31337, 'local', $4, '{}'::jsonb, $5)", id, `0x${"aa".repeat(20)}`, `0x${"bb".repeat(20)}`, kind, `0x${"cc".repeat(32)}`] as const;
    const [s1, ...v1] = t("pilot", "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    await expect(sandbox.db.query(s1, v1)).rejects.toThrow();
    const [s2, ...v2] = t("challenge", "9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8");
    await expect(production.db.query(s2, v2)).rejects.toThrow();
  });

  it("a sandbox full of challenge attempts and challenge tenants leaves the traction views at zero", async () => {
    await sandbox.db.query("insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash) values ('9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8', 'c', $1, $2, 31337, 'local', 'challenge', '{}'::jsonb, $3)", [`0x${"aa".repeat(20)}`, `0x${"bb".repeat(20)}`, `0x${"cc".repeat(32)}`]);
    const stats = await sandbox.db.query<{ businesses: string }>("select businesses::text from public_pilot_stats");
    expect(stats.rows.every((r) => r.businesses === "0")).toBe(true);
    const sum = await sandbox.db.query<{ businesses_onboarded: string; real_payments: string; mainnet_value_base_units: string; testnet_value_base_units: string }>("select businesses_onboarded::text, real_payments::text, mainnet_value_base_units::text, testnet_value_base_units::text from public_traction_summary");
    expect(sum.rows[0]).toEqual({ businesses_onboarded: "0", real_payments: "0", mainnet_value_base_units: "0", testnet_value_base_units: "0" });
  });
});

// ---- SEC-05 (RT-05): each boot guard refuses; the process exits before it listens ------------------------------------------------------------
describe("SEC-05: the sandbox kernel refuses to boot unless every isolation condition holds", () => {
  const SIGNER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const SIGNER_ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const GOOD: Record<string, string> = {
    KERNEL_PROFILE: "sandbox", NETWORK: "testnet", EVIDENCE_MODE: "fixtures",
    DATABASE_URL: "postgres://postgres@sandbox-db.example:5432/postgres", SERVICE_TOKEN_SECRET: "a-sec05-service-token-secret-0123456789abcdef",
    KERNEL_SIGNER_PRIVATE_KEY: SIGNER, CHALLENGE_IP_SALT: "a-sec05-ip-salt-0123456789abcdef", CHALLENGE_LLM_DAILY_BUDGET_USD: "5",
  };
  const rules = (over: Record<string, string | undefined>): string[] => evaluateBootGuards({ ...GOOD, ...over }).map((v) => v.rule);

  it("the good environment passes (so each refusal below is caused by exactly its own change)", () => {
    expect(evaluateBootGuards(GOOD)).toEqual([]);
  });

  it.each([
    ["1: NETWORK=mainnet", { NETWORK: "mainnet" }, "G1"],
    ["2: the signer is a production signer", { PROD_SIGNER_ADDRESSES: SIGNER_ADDR }, "G2"],
    ["3: a PROD_* variable is present", { PROD_DATABASE_PASSWORD: "x-sec05-value-0123456789" }, "G3"],
    ["3: an ARC_MAINNET_* variable is present", { ARC_MAINNET_CHAIN_ID: "5042" }, "G3"],
    ["4: the database is the production host", { PROD_SUPABASE_HOST: "sandbox-db.example" }, "G4"],
    ["5: live evidence in the sandbox", { EVIDENCE_MODE: "live" }, "G5"],
    ["6: no IP salt", { CHALLENGE_IP_SALT: undefined }, "G6"],
    ["6: no daily budget", { CHALLENGE_LLM_DAILY_BUDGET_USD: undefined }, "G6"],
    ["profile unset", { KERNEL_PROFILE: undefined }, "G0"],
  ] as const)("refuses (%s)", (_name, over, rule) => {
    expect(rules(over as Record<string, string | undefined>)).toContain(rule);
  });

  it("the process exits non-zero BEFORE it listens (real process, three violations)", () => {
    for (const over of [{ NETWORK: "mainnet" }, { EVIDENCE_MODE: "live" }, { CHALLENGE_IP_SALT: "" }]) {
      const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], ...GOOD, ...over, PORT: "0" };
      const r = spawnSync(process.execPath, [...NODE_FLAGS, join(ROOT, "services/kernel/src/main.ts")], { env, encoding: "utf8", timeout: 60_000, cwd: ROOT });
      expect(r.status, JSON.stringify(over)).not.toBe(0);
      expect(r.stdout).toContain("kernel.boot_failed");
      expect(r.stdout).not.toContain("kernel.listening");
    }
  }, 180_000);
});

// ---- SEC-07 (RT-26): no secrets in logs, responses or the web bundle sources -----------------------------------------------------------------
describe("SEC-07: canary secrets never appear", () => {
  const CANARY = "CANARY-sec07-0123456789abcdef-secret";
  it("the logger redacts a planted canary in messages, fields and error paths", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: { write: (l) => void lines.push(l) }, secrets: [CANARY] });
    log.info("event.one", { reasonCode: `leak ${CANARY}` });
    log.error("event.two", { ...errorFields(new Error(`connection failed postgres://u:${CANARY}@h/db`)) });
    log.warn(`event.three ${CANARY}`, {});
    expect(lines.length).toBe(3);
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("apps/web references no payment/signing secret name and no secret-looking public variable", () => {
    expect(scan(join(ROOT, "apps/web"))).toEqual([]);
  });

  it("a generated .env template ships placeholders only (no real-looking key)", async () => {
    // @ts-expect-error plain ESM script without declarations
    const mod = (await import("../../../scripts/env-init.mjs")) as { kernelEnv(o: { serviceSecret: string; ipSalt: string }): string; mainnetKernelEnv(o: { serviceSecret: string }): string };
    for (const text of [mod.kernelEnv({ serviceSecret: "s".repeat(43), ipSalt: "i".repeat(43) }), mod.mainnetKernelEnv({ serviceSecret: "s".repeat(43) })]) {
      expect(text).not.toMatch(/\b0x[0-9a-fA-F]{64}\b/);
      expect(text).not.toMatch(/sk-ant-[A-Za-z0-9_-]{10,}/);
      expect(text).toMatch(/PASTE_[A-Z_]+_HERE/);
    }
  });
});

// ---- SEC-08 (RT-04): rate limits and input size ---------------------------------------------------------------------------------------------
describe("SEC-08: rate limits and input size hold", () => {
  it("5 free-form attempts an hour and 30 a day per salted IP, 60 one-click an hour; the next is refused with a Retry-After", () => {
    let t = 0;
    const l = defaultLimits(() => t);
    for (let i = 0; i < 5; i++) expect(l.freeFormHour.hit("ip").ok).toBe(true);
    const sixth = l.freeFormHour.hit("ip");
    expect(sixth.ok).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) l.freeFormDay.hit("ip");
    expect(l.freeFormDay.hit("ip").ok).toBe(false);
    for (let i = 0; i < 60; i++) l.oneClickHour.hit("ip");
    expect(l.oneClickHour.hit("ip").ok).toBe(false);
    t += 3_600_001;
    expect(l.freeFormHour.hit("ip").ok).toBe(true);
  });
  it("at most 3 run at once, 20 wait, the 24th is refused", async () => {
    const g = new ConcurrencyGate(3, 20);
    for (let i = 0; i < 3; i++) expect((await g.acquire()).ok).toBe(true);
    for (let i = 0; i < 20; i++) void g.acquire();
    await Promise.resolve();
    expect(await g.acquire()).toEqual({ ok: false, reason: "QUEUE_FULL" });
  });
  it("4096 bytes pass, 4097 are refused before any model call; limits are keyed on salted hashes, never raw addresses", () => {
    expect(checkAttemptText("a".repeat(MAX_ATTEMPT_BYTES)).ok).toBe(true);
    expect(checkAttemptText("a".repeat(MAX_ATTEMPT_BYTES + 1))).toEqual({ ok: false, code: "TOO_LARGE" });
    const h = ipHash("203.0.113.9", "salt");
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).not.toContain("203.0.113.9");
    expect(new SlidingWindow(1, 1000, () => 0).hit(h).ok).toBe(true);
  });
});

// ---- SEC-09 (RT-03): hostile and binary input is rejected or bounded without parsing ------------------------------------------------------------
describe("SEC-09: hostile input is rejected or bounded", () => {
  const COMBINING = String.fromCharCode(0x0301);
  it.each([
    ["NUL bytes", "invoice\u0000total"],
    ["an invalid UTF-8 replacement", "bad�bytes"],
    ["100k combining marks", `a${COMBINING.repeat(100_000)}`],
    ["a repeated-text bomb", "AB".repeat(60_000)],
    ["deeply nested JSON text", `${"[".repeat(50_000)}${"]".repeat(50_000)}`],
    ["a binary-looking blob", Array.from({ length: 5000 }, (_, i) => String.fromCharCode(i % 32)).join("")],
  ])("%s is refused at the door, within a fixed time", (_n, text) => {
    const t0 = performance.now();
    const r = checkAttemptText(text);
    expect(r.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(250);
  });
  it("text that passes the door is normalised in bounded time and never parsed as a format", () => {
    const text = `a${COMBINING.repeat(1500)}`; // 4 KiB of combining marks
    expect(checkAttemptText(text).ok).toBe(true);
    const t0 = performance.now();
    const n = normalizeUntrusted(untrusted(text));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(typeof n.normalized).toBe("string");
  });
});

// ---- SEC-10 (RT-11, RT-32): the replay bundle verifies, and one flipped byte fails it ---------------------------------------------------------
describe("SEC-10: replay bundle verifies; tampering fails", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sec10-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const verify = (path: string) => spawnSync(process.execPath, [...NODE_FLAGS, join(ROOT, "scripts/verify-bundle.ts"), path], { encoding: "utf8", cwd: ROOT, timeout: 60_000 });

  it("the committed bundle passes", () => {
    const r = verify(join(ROOT, "replay-data/bundle.json"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PASS");
  });
  it.each([
    ["the git revision", (b: Record<string, unknown>) => { b["gitSha"] = String(b["gitSha"]).replace(/.$/, (c) => (c === "0" ? "1" : "0")); }],
    ["a result in the attack matrix", (b: Record<string, unknown>) => { const m = b["attackMatrix"] as { totals: { lossTrials: number }[] }; m.totals[0]!.lossTrials += 1; }],
    ["the build time", (b: Record<string, unknown>) => { b["builtAt"] = "2000-01-01T00:00:00Z"; }],
  ])("flipping %s fails verification", (_what, mutate) => {
    const bundle = JSON.parse(readFileSync(join(ROOT, "replay-data/bundle.json"), "utf8")) as Record<string, unknown>;
    mutate(bundle);
    const p = join(dir, "tampered.json");
    writeFileSync(p, JSON.stringify(bundle));
    const r = verify(p);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/FAIL/);
  });
});

// ---- SEC-12, 13, 14: exercised by named tests elsewhere; this proves they still exist and still assert the property --------------------------------
describe("SEC-12/13/14 coverage cross-check", () => {
  const needs: [string, string, RegExp[]][] = [
    ["SEC-12 webhook", "services/kernel/test/circle/webhook.local.test.ts", [/SEC-12/, /signature/i, /replay|duplicate/i]],
    ["SEC-13 WYSIWYS", "packages/receipts/test/approval.test.ts", [/checkWysiwys/, /fc\.assert|fast-check/, /signedModel|renderModel/]],
    ["SEC-14 service tokens", "services/kernel/test/token.test.ts", [/SEC-14/, /BAD_MAC/, /WRONG_AUDIENCE/, /EXPIRED/, /REPLAYED/]],
  ];
  it.each(needs)("%s is asserted in %s", (_id, file, patterns) => {
    const p = join(ROOT, file);
    expect(existsSync(p), file).toBe(true);
    const text = readFileSync(p, "utf8");
    for (const re of patterns) expect(text, `${file} lost ${String(re)}`).toMatch(re);
  });
});
