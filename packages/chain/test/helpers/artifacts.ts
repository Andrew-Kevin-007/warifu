// Locate and (if missing) build the forge artifacts. contracts/ is CONTRACTS-owned; this only reads out/.
// If forge is unavailable and there is no artifact, tests FAIL with a clear message rather than skipping.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");
export const VAULT_ARTIFACT = resolve(CONTRACTS_DIR, "out/SymbolonVault.sol/SymbolonVault.json");
export const MOCK_USDC_ARTIFACT = resolve(CONTRACTS_DIR, "out/Mocks.sol/MockUSDC.json");

export function ensureArtifacts(): void {
  if (existsSync(VAULT_ARTIFACT) && existsSync(MOCK_USDC_ARTIFACT)) return;
  const forge = process.env.FORGE_BIN ?? "forge";
  const r = spawnSync(forge, ["build"], {
    cwd: CONTRACTS_DIR,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_OFFLINE: "true" },
    timeout: 300_000,
  });
  if (r.error || r.status !== 0 || !existsSync(VAULT_ARTIFACT) || !existsSync(MOCK_USDC_ARTIFACT)) {
    throw new Error(
      `contracts/out is missing and \`forge build\` failed (set FORGE_BIN, init submodules: git submodule update --init contracts/lib/forge-std contracts/lib/openzeppelin-contracts): ${r.error?.message ?? r.stderr.slice(0, 500)}`,
    );
  }
}

export interface Artifact {
  readonly abi: readonly unknown[];
  readonly bytecode: { readonly object: `0x${string}` };
}

export function readArtifact(path: string): Artifact {
  ensureArtifacts();
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}
