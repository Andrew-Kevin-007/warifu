import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { isPlaceholder, placeholderNames, stripPlaceholders } from "../src/env";
// @ts-expect-error plain ESM script without types
import { kernelEnv, webEnv } from "../../../scripts/env-init.mjs";

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=([^#\n]*?)\s*(#.*)?$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

describe("PASTE_*_HERE placeholders", () => {
  it("recognises only the template marker", () => {
    expect(isPlaceholder("PASTE_ANTHROPIC_API_KEY_HERE")).toBe(true);
    expect(isPlaceholder(" PASTE_X_HERE ")).toBe(true);
    expect(isPlaceholder("sk-ant-real")).toBe(false);
    expect(isPlaceholder("PASTE_lower_HERE")).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });

  it("drops placeholders without touching the input and reports names only", () => {
    const env = { A: "PASTE_A_HERE", B: "real-value-123456789", C: undefined };
    expect(stripPlaceholders(env)).toEqual({ B: "real-value-123456789", C: undefined });
    expect(env.A).toBe("PASTE_A_HERE");
    expect(placeholderNames(env)).toEqual(["A"]);
  });

  it("the generated kernel template boots the config guards as-is (placeholders read as unset) with a local DB", () => {
    const k = parse(kernelEnv({ serviceSecret: "s".repeat(43), ipSalt: "i".repeat(43) }));
    // Needs a signer to boot; every other placeholder (RPC, Circle, Anthropic, ...) is optional or checked later.
    const withSigner = { ...k, KERNEL_SIGNER_PRIVATE_KEY: "0x" + "ab".repeat(32), NETWORK: "local" };
    const cfg = loadConfig(stripPlaceholders(withSigner));
    expect(cfg.profile).toBe("sandbox");
    expect(cfg.circle).toBeNull();
    expect(cfg.relayerKey).toBeNull();
    expect(cfg.guardianKey).toBeNull();
    expect(cfg.githubToken).toBeNull();
  });

  it("without a pasted signer the kernel refuses to boot", () => {
    const k = parse(kernelEnv({ serviceSecret: "s".repeat(43), ipSalt: "i".repeat(43) }));
    expect(() => loadConfig(stripPlaceholders({ ...k, NETWORK: "local" }))).toThrow();
  });

  it("the web template shares the HMAC secret and carries no kernel or payment variable names", () => {
    const secret = "s".repeat(43);
    const k = parse(kernelEnv({ serviceSecret: secret, ipSalt: "i".repeat(43) }));
    const w = parse(webEnv({ serviceSecret: secret }));
    expect(w["WEB_SVC_SECRET"]).toBe(k["SERVICE_TOKEN_SECRET"]);
    expect(Object.keys(w).some((n) => /^(CIRCLE_|KERNEL_|GUARDIAN_|RELAYER_|SERVICE_TOKEN_SECRET)/.test(n))).toBe(false);
  });
});
