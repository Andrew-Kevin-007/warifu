// Two clean builds must produce byte-identical SymbolonVault code (docs/06 A.5 Build.t.sol / CI step, docs/16 §5.3).
// Usage (from contracts/):  node script/check-reproducible-build.mjs
// FORGE_BIN selects the binary (default `forge`; CI sets `arc-forge`). Exit 0 = identical, 1 = different, 2 = error.
// Builds go to two fresh temp directories with --force, so neither the cache nor the normal out/ is reused.
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

const forge = process.env.FORGE_BIN || "forge";
const say = (s) => process.stdout.write(`${s}\n`);
const fail = (code, s) => {
  process.stderr.write(`${s}\n`);
  process.exit(code);
};

function build(label) {
  const dir = mkdtempSync(join(tmpdir(), `symbolon-repro-${label}-`));
  const out = join(dir, "out");
  const cache = join(dir, "cache");
  const r = spawnSync(forge, ["build", "--force", "--skip", "test", "--skip", "script", "--out", out, "--cache-path", cache], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.error || r.status !== 0) {
    fail(2, `build ${label} failed: ${r.error ? r.error.message : r.stderr}`);
  }
  const art = JSON.parse(readFileSync(join(out, "SymbolonVault.sol", "SymbolonVault.json"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return {
    runtime: art.deployedBytecode.object,
    creation: art.bytecode.object,
    immutableReferences: JSON.stringify(art.deployedBytecode.immutableReferences),
    settings: art.metadata.settings,
    compiler: art.metadata.compiler.version,
  };
}

const a = build("a");
const b = build("b");
const sha256 = (hex) => createHash("sha256").update(Buffer.from(hex.replace(/^0x/, ""), "hex")).digest("hex");
const same = a.runtime === b.runtime && a.creation === b.creation && a.immutableReferences === b.immutableReferences;

say(
  JSON.stringify(
    {
      identical: same,
      compiler: a.compiler,
      evmVersion: a.settings.evmVersion,
      metadata: a.settings.metadata,
      runtimeBytes: (a.runtime.length - 2) / 2,
      runtimeSha256: sha256(a.runtime), // sha256 of the artifact code with zeroed immutables (not keccak)
    },
    null,
    2,
  ),
);
if (a.settings.metadata?.bytecodeHash !== "none" || a.settings.metadata?.appendCBOR !== false) {
  fail(1, "foundry.toml must set bytecode_hash = \"none\" and cbor_metadata = false");
}
if (!same) fail(1, "two clean builds differ");
