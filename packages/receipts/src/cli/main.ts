// Entry point run by bin/verify-receipt.mjs. Side effects only: argv in, exit code out.
import { nodeIo } from "./node-io";
import { runCli } from "./run";

process.exitCode = await runCli(process.argv.slice(2), nodeIo);
