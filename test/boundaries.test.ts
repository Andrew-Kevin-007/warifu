import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: ROOT });

async function rulesHit(code: string, filePath: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  return (res?.messages ?? []).map((m) => m.ruleId ?? "parse-error");
}

describe("kernel-core purity lint (INV-8/9/10)", () => {
  const f = "packages/kernel-core/src/probe.ts";

  it("clean pure code passes", async () => {
    expect(await rulesHit("export const add = (a: bigint, b: bigint): bigint => a + b;\n", f)).toEqual([]);
  });

  it.each([
    ["Date.now()", "export const t = () => Date.now();\n", "no-restricted-globals"],
    ["new Date()", "export const t = () => new Date();\n", "no-restricted-globals"],
    ["Math.random", "export const r = () => Math.random();\n", "no-restricted-properties"],
    ["fetch", "export const g = () => fetch('https://x');\n", "no-restricted-globals"],
    ["process.env", "export const e = () => process.env.X;\n", "no-restricted-globals"],
    ["parseFloat", "export const p = (s: string) => parseFloat(s);\n", "no-restricted-globals"],
    ["Number()", "export const n = (s: string) => Number(s);\n", "no-restricted-syntax"],
    ["toFixed", "export const t = (x: bigint) => (x as unknown as number).toFixed(2);\n", "no-restricted-syntax"],
    ["node:fs import", "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n", "no-restricted-imports"],
    ["extractor import", "import { PACKAGE_NAME } from '@symbolon/extractor';\nexport const x = PACKAGE_NAME;\n", "no-restricted-imports"],
    ["any", "export const a = (x: any) => x;\n", "@typescript-eslint/no-explicit-any"],
  ])("rejects %s", async (_label, code, rule) => {
    expect(await rulesHit(code, f)).toContain(rule);
  });

  it("the same code is allowed outside kernel-core (rules are scoped)", async () => {
    expect(await rulesHit("export const t = () => Date.now();\n", "services/kernel/src/probe.ts")).toEqual([]);
  });
});

describe("money-package lint", () => {
  it("rejects parseFloat in receipts", async () => {
    expect(await rulesHit("export const p = (s: string) => parseFloat(s);\n", "packages/receipts/src/probe.ts")).toContain(
      "no-restricted-globals",
    );
  });
});

describe("web-env guard (INV-11)", () => {
  const run = (root: string) =>
    spawnSync("node", [join(ROOT, "scripts/web-env-check.mjs"), "--root", root], { encoding: "utf8" });

  it("passes a clean web tree, incl. NEXT_PUBLIC_KERNEL_URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-ok-"));
    writeFileSync(join(dir, "a.ts"), "export const u = process.env.NEXT_PUBLIC_KERNEL_URL;\n");
    expect(run(dir).status).toBe(0);
  });

  it.each([
    ["CIRCLE_API_KEY", "const k = process.env.CIRCLE_API_KEY;\n"],
    ["KERNEL_SIGNER_PRIVATE_KEY", "const k = process.env.KERNEL_SIGNER_PRIVATE_KEY;\n"],
    ["SERVICE_TOKEN_SECRET", "const k = process.env.SERVICE_TOKEN_SECRET;\n"],
    ["64-hex key", `const k = "0x${"ab".repeat(32)}";\n`],
    ["circle sdk import", "import { x } from '@circle-fin/developer-controlled-wallets';\n"],
    ["secret-looking public var", "const k = process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;\n"],
    ["public token var", "const k = process.env.NEXT_PUBLIC_SERVICE_TOKEN;\n"],
  ])("fails on %s", (_l, code) => {
    const dir = mkdtempSync(join(tmpdir(), "web-bad-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "bad.ts"), code);
    expect(run(dir).status).toBe(1);
  });

  it("the real apps/web tree is clean", () => {
    expect(() => execFileSync("node", [join(ROOT, "scripts/web-env-check.mjs")], { cwd: ROOT })).not.toThrow();
  });
});
