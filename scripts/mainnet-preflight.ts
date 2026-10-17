// pnpm mainnet:preflight [env-file] [--online]
// READ-ONLY check of a production/mainnet kernel configuration before the first real deploy (docs/DEPLOY_MAINNET.md). It never sends a
// transaction and never prints a value: variables are reported by name and rule only. Placeholders (PASTE_*_HERE) count as "not set".
//
//   offline  the kernel's own boot guards and mainnet rules (services/kernel/src/boot.ts, config.ts), the required production variables,
//            and the operator's values compared with the docs-sourced facts in docs/VERIFY_LOG.md (V-03 resolution): a difference is a WARN
//            for you to confirm against the docs page, because nothing in this repo hardcodes a mainnet fact.
//   --online eth_chainId against ARC_MAINNET_RPC_URL (must equal ARC_MAINNET_CHAIN_ID), eth_call decimals() on the vault's token
//            (must be 6, never the 18 of native gas), eth_getCode on the vault (must be a contract). Read calls only.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { BootError } from "../services/kernel/src/boot";
import { ConfigError, loadConfig } from "../services/kernel/src/config";
import { placeholderNames, stripPlaceholders } from "../services/kernel/src/env";

// Facts read from the official docs on 2026-10-17 (docs/VERIFY_LOG.md, V-03 resolution). Used ONLY to compare; never as a default.
const DOCS = { chainId: "5042", rpc: "https://rpc.mainnet.arc.io", usdc: "0x3600000000000000000000000000000000000000", usdcDecimals: 6, circleBlockchain: "ARC" } as const;

type Status = "PASS" | "WARN" | "FAIL";
interface Check {
  readonly status: Status;
  readonly name: string;
  readonly detail: string;
}
const checks: Check[] = [];
const add = (status: Status, name: string, detail = ""): void => void checks.push({ status, name, detail });

const args = process.argv.slice(2).filter((a) => a !== "--");
const online = args.includes("--online");
const file = resolve(args.find((a) => !a.startsWith("--")) ?? "services/kernel/.env.mainnet.local");

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000), redirect: "error" });
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error !== undefined) throw new Error(`${method} returned an error`);
  return j.result;
}

async function main(): Promise<void> {
  if (!existsSync(file)) {
    add("FAIL", "env file", `not found: ${file} (create it with: pnpm env:init -- --mainnet)`);
    return;
  }
  const raw = parseEnv(readFileSync(file, "utf8")) as Record<string, string | undefined>;
  const pending = placeholderNames(raw);
  const env = stripPlaceholders(raw);
  add(pending.length === 0 ? "PASS" : "FAIL", "placeholders", pending.length === 0 ? "every PASTE_*_HERE value has been replaced" : `still to paste: ${pending.join(", ")}`);

  // 1. the kernel's own rules (profile, mainnet-only-in-production, secrets, relayer exclusivity, Circle identifier ...)
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try {
    cfg = loadConfig(env);
    add("PASS", "kernel config + boot guards", "loadConfig accepted this environment");
  } catch (e) {
    const why = e instanceof BootError ? e.violations.map((v) => `${v.rule}:${v.variable}`).join(", ") : e instanceof ConfigError ? e.message : "unexpected error";
    add("FAIL", "kernel config + boot guards", why);
  }
  if (cfg !== null) {
    add(cfg.profile === "production" && cfg.network === "mainnet" ? "PASS" : "FAIL", "profile and network", `profile=${cfg.profile} network=${cfg.network} (mainnet runs only in the production profile)`);
    add(cfg.circle !== null ? "PASS" : "FAIL", "Circle relayer", cfg.circle !== null ? "API key, entity secret and relayer wallet are configured" : "mainnet submits only through the Circle relayer (RELAYER_PRIVATE_KEY is refused); without it nothing is submitted");
    add(cfg.guardianKey !== null ? "PASS" : "WARN", "guardian", cfg.guardianKey !== null ? "pause-only key configured" : "no guardian key: the breaker halts the kernel but cannot pause the vault");
    add(cfg.evidenceMode === "live" ? "PASS" : "FAIL", "evidence mode", `EVIDENCE_MODE=${cfg.evidenceMode} (production is live)`);
    add(cfg.scheduler.testClockOffsetSeconds === null ? "PASS" : "FAIL", "scheduler test clock", cfg.scheduler.testClockOffsetSeconds === null ? "none" : "TEST_CLOCK_OFFSET_SECONDS must be unset in production");
  }

  // 2. the operator's values against the docs-sourced facts (warn, never default)
  const chainId = env["ARC_MAINNET_CHAIN_ID"];
  add(chainId === DOCS.chainId ? "PASS" : "WARN", "chain id vs docs", chainId === DOCS.chainId ? `matches the docs value ${DOCS.chainId}` : `differs from the docs value ${DOCS.chainId}: confirm on https://docs.arc.io/arc/references/rpc-endpoints.md`);
  const url = env["ARC_MAINNET_RPC_URL"] ?? "";
  add(url === DOCS.rpc ? "PASS" : "WARN", "RPC vs docs", url === DOCS.rpc ? "uses the public docs endpoint (rate-limited: use a dedicated provider for production traffic)" : "not the public docs endpoint: fine if it is your own provider, confirm it is Arc mainnet");
  add((env["CIRCLE_BLOCKCHAIN"] ?? "") === DOCS.circleBlockchain ? "PASS" : "WARN", "Circle identifier vs docs", `CIRCLE_BLOCKCHAIN should be ${DOCS.circleBlockchain} on mainnet`);
  add(env["ARC_RPC_URL"] === undefined || env["ARC_RPC_URL"] === "" ? "PASS" : "FAIL", "testnet RPC unset", "ARC_RPC_URL must be unset on mainnet so a testnet endpoint cannot be picked up");
  const start = Number.parseInt(env["INDEXER_START_BLOCK"] ?? "0", 10);
  add(start > 0 ? "PASS" : "FAIL", "indexer start block", start > 0 ? "set (the vault deployment block)" : "INDEXER_START_BLOCK must be the vault's deployment block; 0 scans from genesis and misses the balance identity (V-60)");

  // 3. the deployment file
  const dep = resolve("deployments/mainnet.json");
  let vault = "";
  let token = "";
  if (!existsSync(dep)) add("FAIL", "deployments/mainnet.json", "missing: deploy the vault first (docs/DEPLOY_MAINNET.md step 2)");
  else {
    try {
      const j = JSON.parse(readFileSync(dep, "utf8")) as { production?: { vault?: string; token?: string } } & Record<string, unknown>;
      vault = j.production?.vault ?? "";
      token = j.production?.token ?? "";
      add(/^0x[0-9a-fA-F]{40}$/.test(vault) ? "PASS" : "FAIL", "production vault address", /^0x[0-9a-fA-F]{40}$/.test(vault) ? "present" : "missing or malformed under production.vault");
      add(token.toLowerCase() === DOCS.usdc ? "PASS" : "WARN", "token vs docs", token.toLowerCase() === DOCS.usdc ? "is the docs USDC address" : `differs from the docs USDC address ${DOCS.usdc}: confirm on https://docs.arc.io/arc/references/contract-addresses.md`);
      add(j["sandbox"] === undefined ? "PASS" : "FAIL", "no sandbox on mainnet", j["sandbox"] === undefined ? "mainnet file has no sandbox group" : "a mainnet deployment file must not list a sandbox vault (INV-16)");
    } catch {
      add("FAIL", "deployments/mainnet.json", "not valid JSON");
    }
  }

  // 4. read-only checks against the live chain
  if (!online) {
    add("WARN", "live chain checks", "skipped: run again with --online once the RPC and vault are known");
    return;
  }
  if (url === "") return void add("FAIL", "live chain checks", "ARC_MAINNET_RPC_URL is not set");
  try {
    const id = Number.parseInt(String(await rpc(url, "eth_chainId", [])), 16);
    add(String(id) === chainId ? "PASS" : "FAIL", "live chain id", String(id) === chainId ? "the node reports the configured chain id" : `the node reports ${String(id)}, the configuration says ${chainId ?? "unset"} (the kernel would refuse to boot)`);
    if (/^0x[0-9a-fA-F]{40}$/.test(token)) {
      const dec = Number.parseInt(String(await rpc(url, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"])), 16);
      add(dec === DOCS.usdcDecimals ? "PASS" : "FAIL", "token decimals on chain", dec === DOCS.usdcDecimals ? "6 (the ERC-20 interface, not the 18 of native gas)" : `${String(dec)}: the vault and kernel expect 6`);
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(vault)) {
      const code = String(await rpc(url, "eth_getCode", [vault, "latest"]));
      add(code !== "0x" && code.length > 2 ? "PASS" : "FAIL", "vault code on chain", code !== "0x" && code.length > 2 ? "a contract is deployed at the vault address" : "no contract at the vault address");
    }
  } catch {
    add("FAIL", "live chain checks", "the RPC did not answer (read-only calls only; nothing was sent)");
  }
}

await main();
const mark: Record<Status, string> = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
for (const c of checks) console.log(`${mark[c.status]}  ${c.name}${c.detail === "" ? "" : `: ${c.detail}`}`);
const fails = checks.filter((c) => c.status === "FAIL").length;
const warns = checks.filter((c) => c.status === "WARN").length;
console.log(`\n${fails === 0 ? "READY" : "NOT READY"}: ${String(fails)} blocking, ${String(warns)} to confirm. Nothing was sent; no value was printed.`);
process.exitCode = fails === 0 ? 0 : 1;
