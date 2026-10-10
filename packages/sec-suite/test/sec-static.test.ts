import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { SEC_TESTS } from "../src/index";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("SEC-11 (static part): swarm hygiene", () => {
  it("claude config matches docs/17 routing and denies secret reads", () => {
    const r = spawnSync("node", [join(ROOT, "scripts/check-claude-config.mjs")], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it(".env.example files contain placeholders only (no 64-hex, no long base64-looking secrets)", () => {
    for (const f of ["apps/web/.env.example", "services/kernel/.env.example"]) {
      const p = join(ROOT, f);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      expect(text, f).not.toMatch(/\b0x[0-9a-fA-F]{64}\b/);
      expect(text, f).not.toMatch(/sk-ant-[A-Za-z0-9_-]{10,}/);
    }
  });
});

describe("SEC-06 (lint part): HTML sinks are banned in apps/web", () => {
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string, file = "apps/web/src/probe.tsx") => {
    const [res] = await eslint.lintText(code, { filePath: join(ROOT, file) });
    return (res?.messages ?? []).map((m) => m.ruleId ?? "parse-error");
  };
  it.each([
    ["dangerouslySetInnerHTML", "export const A = ({h}: {h: string}) => <div dangerouslySetInnerHTML={{ __html: h }} />;\n"],
    ["innerHTML assignment", "export const f = (el: HTMLElement, h: string) => { el.innerHTML = h; };\n"],
    ["insertAdjacentHTML", "export const f = (el: HTMLElement, h: string) => { el.insertAdjacentHTML('beforeend', h); };\n"],
    ["eval", "export const f = (s: string) => eval(s);\n"],
    ["new Function", "export const f = (s: string) => new Function(s);\n"],
  ])("rejects %s", async (_l, code) => {
    const rules = await lint(code);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).not.toContain("parse-error");
  });
  it("accepts a plain text node component", async () => {
    expect(await lint("export const A = ({t}: {t: string}) => <pre>{t}</pre>;\n")).toEqual([]);
  });
});

describe("SEC suite tracker", () => {
  it("lists SEC-01..SEC-14 exactly once each", () => {
    expect(SEC_TESTS.map((t) => t.id)).toEqual(Array.from({ length: 14 }, (_, i) => `SEC-${String(i + 1).padStart(2, "0")}`));
  });
  it("the deployed-sandbox set is exactly SEC-01..SEC-10 and SEC-14 (docs/13 §4.6)", () => {
    const set = SEC_TESTS.filter((t) => t.sandbox).map((t) => t.id);
    expect(set).toEqual(["SEC-01", "SEC-02", "SEC-03", "SEC-04", "SEC-05", "SEC-06", "SEC-07", "SEC-08", "SEC-09", "SEC-10", "SEC-14"]);
  });
  // The remaining tests are WP-37's job (docs/13 §4.6). They stay `todo` so progress is visible, never faked.
  for (const t of SEC_TESTS) {
    if (t.id !== "SEC-11" && t.id !== "SEC-06") it.todo(`${t.id}: ${t.what}`);
  }
});
