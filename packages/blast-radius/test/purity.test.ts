// bounds.ts must stay pure (docs/16 §1.5, AGENTS.md §0.2/0.3): bigint math only, no clock, randomness, I/O,
// env, floats, or imports. This reads the source text, with negative controls proving the scanner bites.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORBIDDEN: readonly [string, RegExp][] = [
  ["Date", /\bDate\b/],
  ["Math.random", /\bMath\.random\b/],
  ["Math (any helper: bigint code has no use for it)", /\bMath\./],
  ["process / env", /\bprocess\b/],
  ["fetch / network", /\bfetch\s*\(/],
  ["Number(", /\bNumber\s*\(/],
  ["parseFloat/parseInt", /\bparse(Float|Int)\b/],
  ["toFixed / toLocaleString", /\.(toFixed|toLocaleString)\s*\(/],
  ["import / require", /^\s*import\s|\brequire\s*\(/m],
  ["dynamic import", /\bimport\s*\(/],
  ["any", /:\s*any\b|\bas any\b|<any>/],
  ["eval / Function", /\beval\s*\(|\bnew Function\b/],
  ["timers", /\b(setTimeout|setInterval|performance)\b/],
  ["number literal with a decimal point", /(?<![\w.])\d+\.\d+(?![\w.])/],
];

function scan(src: string): string[] {
  // strip comments and string literals so prose about "Date" does not trip the scanner
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  return FORBIDDEN.filter(([, re]) => re.test(code)).map(([name]) => name);
}

const BOUNDS = fileURLToPath(new URL("../src/bounds.ts", import.meta.url));
const WINDOWED = fileURLToPath(new URL("../src/windowed.ts", import.meta.url));

describe("pure bigint modules", () => {
  it("bounds.ts contains no impure or floating-point construct", () => {
    expect(scan(readFileSync(BOUNDS, "utf8"))).toEqual([]);
  });
  it("windowed.ts contains no impure or floating-point construct and imports only ./bounds", () => {
    const src = readFileSync(WINDOWED, "utf8");
    const imports = src.match(/^\s*import\s[^;]*;/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/from "\.\/bounds";$/);
    expect(scan(src.replace(imports[0] as string, ""))).toEqual([]);
  });
  it("negative controls: the scanner flags each forbidden construct", () => {
    expect(scan("const t = Date.now();")).toContain("Date");
    expect(scan("const r = Math.random();")).toContain("Math.random");
    expect(scan("const x = Number(a);")).toContain("Number(");
    expect(scan("import fs from 'node:fs';")).toContain("import / require");
    expect(scan("const e = process.env.X;")).toContain("process / env");
    expect(scan("const y = 1.5;")).toContain("number literal with a decimal point");
    expect(scan("const z = (a as any);")).toContain("any");
    expect(scan("// Date in a comment is fine\nconst a = 1n;")).toEqual([]);
    expect(scan('const s = "Date.now() inside a string";')).toEqual([]);
  });
});
