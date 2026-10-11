// Usage (from anywhere): node packages/chain/scripts/gen-abi.mjs [--check]
//   (no flag) writes src/abi/symbolonVault.ts from contracts/out
//   --check   exits 1 if the committed file differs from what the artifact would produce
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_RELATIVE_PATH, abiFromArtifact, renderAbiModule } from "./abi-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const artifactPath = resolve(repoRoot, ARTIFACT_RELATIVE_PATH);
const outPath = resolve(here, "../src/abi/symbolonVault.ts");

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch (e) {
  console.error(`cannot read ${ARTIFACT_RELATIVE_PATH}: run \`forge build\` in contracts/ first (${e instanceof Error ? e.message : String(e)})`);
  process.exit(2);
}
const text = renderAbiModule(abiFromArtifact(artifact));

if (process.argv.includes("--check")) {
  const committed = readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
  if (committed !== text) {
    console.error("src/abi/symbolonVault.ts is stale: run `pnpm --filter @symbolon/chain abi:gen` and commit the result");
    process.exit(1);
  }
  console.log("symbolonVault ABI matches", ARTIFACT_RELATIVE_PATH);
} else {
  writeFileSync(outPath, text);
  console.log("wrote", outPath);
}
