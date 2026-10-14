// Source guards for this package: fixtures and generators must be deterministic, offline and must never touch the
// hold-out set (docs/07 §3.3; AGENTS.md §1). Every guard has a negative control (QUESTIONS: A5 rule).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

// Built by concatenation so that this file does not match its own scan.
const NONDETERMINISM = [`Math.${"random"}`, `Date.${"now"}`, `new ${"Date"}`, `performance.${"now"}`, `crypto.${"randomUUID"}`, `crypto.${"getRandomValues"}`];
const HOLDOUT = [`symbolon-${"holdout"}`, `holdout${"/fixtures"}`, `holdout${"\\fixtures"}`, `../${"holdout"}`];
const NET_OR_ENV = [`from "node:${"http"}"`, `from "node:${"https"}"`, `from "node:${"net"}"`, `process.${"env"}`, `${"fetch"}(`, `${"XMLHttpRequest"}`, `${"WebSocket"}`, `${"eval"}(`, `new ${"Function"}`, `${"innerHTML"}`, `${"dangerouslySetInnerHTML"}`];

export function violations(files: Array<{ path: string; text: string }>, needles: string[]): string[] {
  return files.flatMap((f) => needles.filter((n) => f.text.includes(n)).map((n) => `${f.path}: ${n}`));
}

const isHarness = (path: string): boolean => path.split(/[\\/]/).includes("harness");
const externalImports = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1] as string).filter((i) => !i.startsWith("."));

const src = sources(join(PKG, "src")).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const evidenceStubs = join(PKG, "src", "evidence-stubs.ts");

describe("source guards", () => {
  it("src has no clock, no unseeded randomness", () => {
    expect(violations(src, NONDETERMINISM)).toEqual([]);
  });

  it("src, scripts and tests never reference the hold-out directory", () => {
    const everything = [...src, ...sources(join(PKG, "scripts")), ...sources(join(PKG, "test"))].map((path) => (typeof path === "string" ? { path, text: readFileSync(path, "utf8") } : path));
    expect(violations(everything, HOLDOUT)).toEqual([]);
  });

  it("only the local evidence stub touches the network, and nothing evaluates or renders hostile text", () => {
    const rest = src.filter((f) => f.path !== evidenceStubs);
    const v = violations(rest, NET_OR_ENV);
    expect(v).toEqual([]);
    const stub = src.find((f) => f.path === evidenceStubs)?.text ?? "";
    expect(stub).toContain('"127.0.0.1"'); // loopback only
    expect(violations([{ path: "stub", text: stub }], [`${"eval"}(`, `new ${"Function"}`, `${"innerHTML"}`, `process.${"env"}`, `${"fetch"}(`])).toEqual([]);
  });

  it("negative control: the scan flags planted violations", () => {
    const planted = [{ path: "planted.ts", text: `const x = Math.${"random"}(); const d = new ${"Date"}(); read("../${"holdout"}/a"); ${"eval"}(s);` }];
    expect(violations(planted, NONDETERMINISM)).toHaveLength(2);
    expect(violations(planted, HOLDOUT)).toHaveLength(1);
    expect(violations(planted, NET_OR_ENV)).toHaveLength(1);
  });

  it("the fixture layer (everything outside src/harness) imports only schemas and zod (no defender package, no oracle)", () => {
    for (const f of src.filter((x) => !isHarness(x.path))) {
      for (const i of externalImports(f.text)) {
        expect(["@symbolon/schemas", "zod", "node:http", "node:net"], `${f.path}: ${i}`).toContain(i);
      }
    }
  });

  it("the harness imports only schemas, zod, the oracle, and kernel-core and policy (symbolon-unit.ts alone) or the extractor (honest-parser.ts alone)", () => {
    const harness = src.filter((x) => isHarness(x.path));
    expect(harness.length).toBeGreaterThan(5);
    for (const f of harness) {
      const allowed = ["@symbolon/schemas", "zod", "@symbolon/oracle"];
      if (f.path.endsWith("symbolon-unit.ts")) allowed.push("@symbolon/kernel-core", "@symbolon/policy");
      if (f.path.endsWith("symbolon-human.ts")) allowed.push("@symbolon/kernel-core", "@symbolon/receipts"); // WP-23 follow-up: digest ranking, WYSIWYS comparator
      if (f.path.endsWith("honest-parser.ts")) allowed.push("@symbolon/extractor"); // WP-24: the zero-LLM readers, checked against the honest corpus
      for (const i of externalImports(f.text)) expect(allowed, `${f.path}: ${i}`).toContain(i);
    }
  });

  it("negative control: the import scan flags a planted defender import in a fixture-layer file", () => {
    expect(externalImports(`import x from "@symbolon/kernel-core"; import y from "./a";`)).toEqual(["@symbolon/kernel-core"]);
  });
});
