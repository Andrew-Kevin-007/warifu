#!/usr/bin/env node
// `pnpm verify-receipt <receipt.json | 0x<receiptHash>> [options]`. The logic is in src/cli/run.ts; this file only starts
// the TypeScript entry under tsx and passes the exit code through (0 verified, 1 not verified, 2 usage or input error).
// tsx is resolved from this package, so the command works from any working directory.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 2);
