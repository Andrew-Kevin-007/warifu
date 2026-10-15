// `generate-wallet` command logic (WP-11), kept here so it is testable; services/kernel/scripts/generate-wallet.ts is the
// 3-line entry that supplies process.env / process.argv / stdout.
//
//   generate-wallet entity-secret --out <file>          write a new 32-byte entity secret (mode 600) to a NEW file you choose,
//                                                        outside the repo; prints only where it went, never the secret
//   generate-wallet wallet --profile production|sandbox  create a wallet set + EOA relayer wallet; prints ids and address
//
// The wallet command reads CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET from the PROCESS ENVIRONMENT (export them yourself); it never
// reads or writes .env.local. Use a different Circle API key and a different wallet set for the sandbox (INV-16).
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Secret } from "../secret";
import { createCircleHttpApi } from "./client";
import type { CircleApi } from "./client";
import { generateEntitySecret, isValidEntitySecret } from "./entity-secret";
import { generateRelayerWallet } from "./wallet";

export interface CliIo {
  readonly out: (line: string) => void;
  readonly api?: CircleApi; // tests inject a mocked network edge
  readonly repoRoot?: string;
}

export async function runGenerateWallet(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "entity-secret") {
    const out = flag("--out");
    if (out === undefined || out === "") {
      io.out("usage: generate-wallet entity-secret --out <new file outside the repo>");
      return 2;
    }
    const target = resolve(out);
    const rel = io.repoRoot === undefined ? null : relative(resolve(io.repoRoot), target);
    if (rel !== null && !rel.startsWith("..") && !isAbsolute(rel)) {
      io.out("refused: the entity secret must not be written inside the repository");
      return 2;
    }
    if (existsSync(target)) {
      io.out("refused: the file already exists (a secret is never overwritten)");
      return 2;
    }
    writeFileSync(target, `${generateEntitySecret()}\n`, { mode: 0o600, flag: "wx" });
    io.out(`entity secret written to ${target}. Register it with Circle (console or SDK, keep the recovery file), then export it as CIRCLE_ENTITY_SECRET.`);
    return 0;
  }
  if (cmd === "wallet") {
    const profile = flag("--profile");
    if (profile !== "production" && profile !== "sandbox") {
      io.out("usage: generate-wallet wallet --profile production|sandbox");
      return 2;
    }
    const apiKey = env["CIRCLE_API_KEY"] ?? "";
    const entitySecret = env["CIRCLE_ENTITY_SECRET"] ?? "";
    if (apiKey === "" || !isValidEntitySecret(entitySecret)) {
      io.out("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET (64 hex) must be set in the environment");
      return 2;
    }
    const api = io.api ?? createCircleHttpApi({ apiKey: new Secret(apiKey) });
    const network = env["NETWORK"] === "mainnet" ? "mainnet" : "testnet";
    const blockchain = env["CIRCLE_BLOCKCHAIN"] ?? (network === "mainnet" ? "" : "ARC-TESTNET");
    if (blockchain === "") {
      io.out("NETWORK=mainnet needs CIRCLE_BLOCKCHAIN set explicitly (Circle's Arc mainnet identifier)");
      return 2;
    }
    const w = await generateRelayerWallet({ api, entitySecret: new Secret(entitySecret), profile, blockchain, network });
    io.out(`RELAYER_WALLET_ID=${w.walletId}`);
    io.out(`RELAYER_WALLET_ADDRESS=${w.address}`);
    io.out(`# wallet set ${w.walletSetId} (${w.profile}, ${w.blockchain}). Fund the address with ${w.blockchain === "ARC-TESTNET" ? "testnet" : "a small amount of real"} USDC for gas, then add the two lines to your private env.`);
    return 0;
  }
  io.out("usage: generate-wallet entity-secret --out <file> | wallet --profile production|sandbox");
  return 2;
}
