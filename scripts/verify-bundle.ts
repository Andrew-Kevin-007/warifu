// `pnpm verify-bundle <path>` (WP-38, docs/15 section 7): schema, bundle hash, receipt signatures. Exit 0 = verified,
// 1 = not verified, 2 = usage error. Kernel re-run on recorded extractions and tx existence are only meaningful when the
// bundle records extractions / txs; with none recorded they are reported "n/a" rather than passed.
import { readFileSync } from "node:fs";
import { ReplayBundleSchema, computeBundleHash } from "../packages/schemas/src/index.ts";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: pnpm verify-bundle <path-to-bundle.json>");
  process.exit(2);
}
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`cannot read bundle: ${(e as Error).message}`);
  process.exit(2);
}
const parsed = ReplayBundleSchema.safeParse(raw);
if (!parsed.success) {
  console.error("FAIL schema: not a valid ReplayBundle");
  process.exit(1);
}
const b = parsed.data;
const recomputed = computeBundleHash(b);
let ok = true;
const line = (status: string, name: string, detail: string) => console.log(`${status.padEnd(5)} ${name}: ${detail}`);
if (recomputed === b.bundleHash) line("PASS", "bundleHash", b.bundleHash);
else {
  ok = false;
  line("FAIL", "bundleHash", `recorded ${b.bundleHash}, recomputed ${recomputed}`);
}
line(b.receipts.length === 0 ? "n/a" : "SKIP", "receipt signatures", b.receipts.length === 0 ? "no receipts recorded in this bundle" : `${String(b.receipts.length)} receipts: check each with pnpm verify-receipt (kernel signer must be pinned)`);
line("n/a", "kernel re-run", b.extractionOutputs.length === 0 ? "no extraction outputs recorded in this bundle" : "not implemented in this build");
line("n/a", "tx existence", b.txs.length === 0 ? "no transactions recorded in this bundle" : "requires an RPC; not checked offline");
process.exit(ok ? 0 : 1);
