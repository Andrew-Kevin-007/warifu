import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolonVaultAbi } from "../src/abi";
import { ARTIFACT_RELATIVE_PATH, abiFingerprint, abiFromArtifact, renderAbiModule } from "../scripts/abi-lib.mjs";
import { VAULT_ARTIFACT, ensureArtifacts } from "./helpers/artifacts";

const here = dirname(fileURLToPath(import.meta.url));

describe("vault ABI is sourced from contracts/out", () => {
  ensureArtifacts();
  const artifactAbi = abiFromArtifact(JSON.parse(readFileSync(VAULT_ARTIFACT, "utf8")));

  it("the committed ABI value deep-equals the compiled artifact", () => {
    expect(JSON.parse(JSON.stringify(symbolonVaultAbi))).toEqual(artifactAbi);
  });

  it("the committed src/abi/symbolonVault.ts is byte-identical to what gen-abi would write", () => {
    const committed = readFileSync(resolve(here, "../src/abi/symbolonVault.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(renderAbiModule(artifactAbi));
  });

  it("negative control: a changed ABI is detected (fingerprint and rendered text differ)", () => {
    const tampered = structuredClone(artifactAbi) as { type: string; name?: string }[];
    const fn = tampered.find((x) => x.type === "function" && x.name === "release");
    expect(fn).toBeDefined();
    if (fn !== undefined) fn.name = "releas3";
    expect(abiFingerprint(tampered)).not.toBe(abiFingerprint(artifactAbi));
    expect(renderAbiModule(tampered)).not.toBe(renderAbiModule(artifactAbi));
  });

  it("rejects an artifact without an ABI", () => {
    expect(() => abiFromArtifact({})).toThrow();
    expect(() => abiFromArtifact({ abi: [] })).toThrow();
    expect(ARTIFACT_RELATIVE_PATH).toBe("contracts/out/SymbolonVault.sol/SymbolonVault.json");
  });

  it("exposes the events and errors the decoders depend on (WP-07 names)", () => {
    const events = symbolonVaultAbi.filter((x) => x.type === "event").map((x) => x.name);
    for (const n of ["Released", "EngagementRegistered", "VaultPaused", "VaultUnpaused", "ConfigChanged"]) expect(events).toContain(n);
    const errors = symbolonVaultAbi.filter((x) => x.type === "error").map((x) => x.name);
    for (const n of ["PerTxCap", "DailyCap", "Paused", "BadKernelSig"]) expect(errors).toContain(n);
  });
});
