import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../src/lib/brand";

const SRC = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mdx?)$/.test(e)) out.push(p);
  }
  return out;
}

describe("public brand (docs/BRAND_AND_IDEA.md)", () => {
  it("uses the new name and keeps the old one only as BRAND.formerName", () => {
    expect(BRAND.name).toBe("Warifu");
    expect(BRAND.formerName).toBe("Symbolon");
  });

  it("no public page, route or component source contains the old public name as a literal", () => {
    // `@symbolon/*` imports, symbolonDomain/symbolonVaultAbi and the lowercase 'symbolon' target id are internal identifiers and stay.
    const offenders: string[] = [];
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components")), join(SRC, "lib", "brand.ts")]) {
      const text = readFileSync(f, "utf8");
      if (f.endsWith("brand.ts")) continue; // the single declaration of the former name
      if (/\bSymbolon\b|\bSYMBOLON\b/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the former name is rendered only by the /about footnote component", () => {
    const users: string[] = [];
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))]) {
      if (/BRAND\.formerName/.test(readFileSync(f, "utf8"))) users.push(f.replace(/\\/g, "/").split("/src/")[1] ?? f);
    }
    expect(users).toEqual(["components/about/SectionName.tsx"]);
  });
});
