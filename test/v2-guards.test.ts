import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM scripts without types
import { check } from "../scripts/check-claude-config.mjs";
// @ts-expect-error plain ESM scripts without types
import { lintText } from "../scripts/claims-lint.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: ROOT });
async function rulesHit(code: string, filePath: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  return (res?.messages ?? []).map((m) => m.ruleId ?? "parse-error");
}

describe("packages/terms purity lint (INV-9/10/19)", () => {
  const f = "packages/terms/src/probe.ts";
  it("clean bigint math passes", async () => {
    expect(await rulesHit("export const d = (g: bigint, bps: bigint): bigint => (g * bps) / 10000n;\n", f)).toEqual([]);
  });
  it.each([
    ["Date.now()", "export const t = () => Date.now();\n", "no-restricted-globals"],
    ["Math.random", "export const r = () => Math.random();\n", "no-restricted-properties"],
    ["Number()", "export const n = (s: string) => Number(s);\n", "no-restricted-syntax"],
    ["viem import", "import { parseUnits } from 'viem';\nexport const p = parseUnits;\n", "no-restricted-imports"],
    ["extractor import", "import { PACKAGE_NAME } from '@symbolon/extractor';\nexport const x = PACKAGE_NAME;\n", "no-restricted-imports"],
  ])("rejects %s", async (_l, code, rule) => {
    expect(await rulesHit(code, f)).toContain(rule);
  });
});

describe("packages/oracle purity and independence (oracle-v1)", () => {
  const f = "packages/oracle/src/probe.ts";
  it("clean predicate code passes", async () => {
    expect(await rulesHit("export const o1 = (paid: bigint, owed: bigint): boolean => paid > owed;\n", f)).toEqual([]);
  });
  it.each([
    ["Date.now()", "export const t = () => Date.now();\n", "no-restricted-globals"],
    ["kernel-core import", "import { PACKAGE_NAME } from '@symbolon/kernel-core';\nexport const x = PACKAGE_NAME;\n", "no-restricted-imports"],
    ["terms import", "import { PACKAGE_NAME } from '@symbolon/terms';\nexport const x = PACKAGE_NAME;\n", "no-restricted-imports"],
    ["viem import", "import { parseUnits } from 'viem';\nexport const p = parseUnits;\n", "no-restricted-imports"],
    ["Number()", "export const n = (s: string) => Number(s);\n", "no-restricted-syntax"],
  ])("rejects %s", async (_l, code, rule) => {
    expect(await rulesHit(code, f)).toContain(rule);
  });
});

describe("dependency-cruiser boundary rules for the oracle", () => {
  const cruise = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "dc-"));
    cpSync(join(ROOT, "tsconfig.base.json"), join(dir, "tsconfig.base.json"));
    for (const d of ["packages", "services"]) mkdirSync(join(dir, d), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    const r = spawnSync(join(ROOT, "node_modules/.bin/depcruise"), ["--config", join(ROOT, ".dependency-cruiser.cjs"), "packages", "services"], {
      cwd: dir,
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });
    return r;
  };
  it("a defender package importing the oracle is a violation", () => {
    const r = cruise({
      "packages/oracle/src/index.ts": "export const o = 1;\n",
      "packages/kernel-core/src/a.ts": "import { o } from '../../oracle/src/index';\nexport const a = o;\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/oracle-is-independent/);
  });
  it("the oracle importing a defender package is a violation", () => {
    const r = cruise({
      "packages/terms/src/index.ts": "export const t = 1;\n",
      "packages/oracle/src/index.ts": "import { t } from '../../terms/src/index';\nexport const o = t;\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/oracle-is-pure/);
  });
  it("terms importing a non-schemas package is a violation (terms-is-pure)", () => {
    const r = cruise({
      "packages/chain/src/index.ts": "export const c = 1;\n",
      "packages/terms/src/index.ts": "import { c } from '../../chain/src/index';\nexport const t = c;\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/terms-is-pure/);
  });
  it("the challenge orchestrator and the attack suite may import the oracle", () => {
    const r = cruise({
      "packages/oracle/src/index.ts": "export const o = 1;\n",
      "packages/attack-suite/src/a.ts": "import { o } from '../../oracle/src/index';\nexport const a = o;\n",
      "services/kernel/src/challenge/c.ts": "import { o } from '../../../../packages/oracle/src/index';\nexport const c = o;\n",
    });
    expect(r.stdout + r.stderr).not.toMatch(/oracle-is-/);
  });
});

describe("challenge/replay surface has no wallet code (INV-16)", () => {
  it.each([
    ["wagmi", "import { useAccount } from 'wagmi';\nexport const a = useAccount;\n"],
    ["walletconnect", "import x from '@walletconnect/ethereum-provider';\nexport const a = x;\n"],
    ["wallet dir", "import { sign } from '../wallet/sign';\nexport const a = sign;\n"],
  ])("rejects %s in apps/web/src/challenge", async (_l, code) => {
    expect(await rulesHit(code, "apps/web/src/challenge/probe.ts")).toContain("no-restricted-imports");
  });
  it("allows wagmi in the app profile", async () => {
    expect(await rulesHit("import { useAccount } from 'wagmi';\nexport const a = useAccount;\n", "apps/web/src/wallet/probe.ts")).toEqual([]);
  });
});

describe("claims lint (DEC-012 / INV-18)", () => {
  it.each([
    "Symbolon is provably safe.",
    "Our bound is proven.",
    "Funds are guaranteed.",
    "This vault is unhackable.",
    "An unbreakable treasury.",
    "100% secure",
    "A risk-free treasury",
    "The contract has been audited.",
  ])("flags %j", (s) => {
    expect(lintText(s).length).toBeGreaterThan(0);
  });
  it.each([
    "Bound it. Prove it. Invite attack.",
    "The vault is unaudited.",
    "This is not audited.",
    "We make no guarantees.",
    "We can't guarantee anything beyond the stated assumptions.",
    "Calculated from on-chain state and empirically tested; 0 violations in 500 trials.",
  ])("accepts %j", (s) => {
    expect(lintText(s)).toEqual([]);
  });
  it("honours the reviewed opt-out on the same or previous line", () => {
    expect(lintText("guaranteed <!-- claims-lint-allow: quoting the rule -->")).toEqual([]);
    expect(lintText("<!-- claims-lint-allow: quoting the rule -->\nguaranteed")).toEqual([]);
    expect(lintText("ok\n\nguaranteed").length).toBe(1);
  });
});

describe("claude config check (SEC-11 static / WP-39)", () => {
  const clone = () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    for (const p of ["docs/17_MODEL_AND_EFFORT_ROUTING.md", ".claude", "kickoff"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
    return dir;
  };
  it("the real repo config is consistent", () => {
    expect(check(ROOT)).toEqual([]);
  });
  it("detects a drifted agent file", () => {
    const dir = clone();
    const p = join(dir, ".claude/agents/kernel-core.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("effort: xhigh", "effort: medium"));
    expect(check(dir).join("\n")).toMatch(/kernel-core\.md: effort medium != routing xhigh/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("detects a missing deny rule and a global effort override", () => {
    const dir = clone();
    const p = join(dir, ".claude/settings.json");
    const s = JSON.parse(readFileSync(p, "utf8"));
    s.permissions.deny = s.permissions.deny.filter((r: string) => r !== "Read(**/.env.local)");
    s.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    writeFileSync(p, JSON.stringify(s));
    const msg = check(dir).join("\n");
    expect(msg).toMatch(/deny missing Read\(\*\*\/\.env\.local\)/);
    expect(msg).toMatch(/CLAUDE_CODE_EFFORT_LEVEL must not be set/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("detects a deny rule that would hide .env.example", () => {
    const dir = clone();
    const p = join(dir, ".claude/settings.json");
    const s = JSON.parse(readFileSync(p, "utf8"));
    s.permissions.deny.push("Read(**/.env.*)");
    writeFileSync(p, JSON.stringify(s));
    expect(check(dir).join("\n")).toMatch(/would also block \.env\.example/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects 'max' effort in the routing block", () => {
    const dir = clone();
    const p = join(dir, "docs/17_MODEL_AND_EFFORT_ROUTING.md");
    writeFileSync(p, readFileSync(p, "utf8").replace('"SEC": {"model": "opus", "effort": "xhigh"}', '"SEC": {"model": "opus", "effort": "max"}'));
    expect(check(dir).join("\n")).toMatch(/role SEC: illegal effort "max"/);
    rmSync(dir, { recursive: true, force: true });
  });
});
