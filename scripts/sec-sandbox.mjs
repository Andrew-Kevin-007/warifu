#!/usr/bin/env node
// pnpm sec:sandbox — runs SEC-01..10 and SEC-14 against the DEPLOYED sandbox (docs/13 §4.6, WP-37).
// Not part of `make verify` (it needs the deployed sandbox). Until WP-37 lands it refuses to pretend:
// it lists the set and exits 3 ("not implemented"), never 0.
import { pathToFileURL } from "node:url";

export const SANDBOX_SET = ["SEC-01", "SEC-02", "SEC-03", "SEC-04", "SEC-05", "SEC-06", "SEC-07", "SEC-08", "SEC-09", "SEC-10", "SEC-14"];

export function main(env = process.env) {
  if (!env.SANDBOX_URL) {
    console.error("sec:sandbox: set SANDBOX_URL to the deployed sandbox origin (never a production origin).");
    return 2;
  }
  console.error(`sec:sandbox: target ${env.SANDBOX_URL}\nSet: ${SANDBOX_SET.join(", ")}\nNOT IMPLEMENTED YET (WP-37). Exiting 3 so this cannot be mistaken for a pass.`);
  return 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
