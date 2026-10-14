import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Utf8 } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { asciiJson, buildFixtureFiles, isInertAscii } from "../src/files";
import { ATTACK_IDS } from "../src/types";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const WRITE = process.env.ATTACK_FIXTURES_WRITE === "1";

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(relative(FIXTURES, p).split("\\").join("/"));
  }
  return out.sort();
}

/** Paths whose content differs, plus paths present on one side only. Pure, so it can be tested with a plant. */
export function diffFileSets(expected: ReadonlyMap<string, string>, actual: ReadonlyMap<string, string>): string[] {
  const bad: string[] = [];
  for (const [path, content] of expected) if (actual.get(path) !== content) bad.push(path);
  for (const path of actual.keys()) if (!expected.has(path)) bad.push(path);
  return bad.sort();
}

const generated = buildFixtureFiles();

if (WRITE) {
  for (const [path, content] of generated) {
    const target = join(FIXTURES, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

describe("committed fixture files", () => {
  it("are exactly what the generators produce (no hand edits, no stale files)", () => {
    const onDisk = new Map<string, string>();
    for (const path of listFiles(FIXTURES)) onDisk.set(path, readFileSync(join(FIXTURES, path), "utf8"));
    expect(diffFileSets(generated, onDisk)).toEqual([]);
  });

  it("the drift check detects a changed file, a missing file and an extra file (negative control)", () => {
    const planted = new Map(generated);
    planted.set("attacks/ATK-02.json", `${planted.get("attacks/ATK-02.json") ?? ""} `);
    expect(diffFileSets(generated, planted)).toEqual(["attacks/ATK-02.json"]);
    const missing = new Map(generated);
    missing.delete("world.json");
    expect(diffFileSets(generated, missing)).toEqual(["world.json"]);
    const extra = new Map(generated);
    extra.set("attacks/ATK-99.json", "{}");
    expect(diffFileSets(generated, extra)).toEqual(["attacks/ATK-99.json"]);
  });

  it("generation is deterministic", () => {
    const again = buildFixtureFiles();
    expect(diffFileSets(generated, again)).toEqual([]);
  });

  it("contains one file per attack, the honest sets, both libraries, applicability and a manifest", () => {
    for (const id of ATTACK_IDS) expect(generated.has(`attacks/${id}.json`)).toBe(true);
    for (const p of ["world.json", "honest/benign-controls.json", "honest/discount-honest.json", "honest/general.json", "honest/ugly.json", "libraries/injections.json", "libraries/terms-injections.json", "applicability.json", "MANIFEST.json"]) {
      expect(generated.has(p), p).toBe(true);
    }
  });

  it("the manifest lists the SHA-256 of every other file", () => {
    const manifest = JSON.parse(generated.get("MANIFEST.json") ?? "{}") as { files: Record<string, string> };
    const others = [...generated.keys()].filter((p) => p !== "MANIFEST.json").sort();
    expect(Object.keys(manifest.files).sort()).toEqual(others);
    for (const p of others) expect(manifest.files[p]).toBe(sha256Utf8(generated.get(p) ?? ""));
  });
});

describe("hostile text stays inert in the files", () => {
  it("every file is pure printable ASCII with no markup characters, so hidden characters show as visible escapes", () => {
    for (const [path, content] of generated) expect(isInertAscii(content), path).toBe(true);
  });

  it("the check is not vacuous: it rejects non-ASCII, markup and control characters", () => {
    expect(isInertAscii("plain ascii\n")).toBe(true);
    expect(isInertAscii("zero\u200bwidth")).toBe(false);
    expect(isInertAscii("<script>")).toBe(false);
    expect(isInertAscii("a & b")).toBe(false);
    expect(isInertAscii("tab\there")).toBe(false);
  });

  it("asciiJson escapes zero-width, bidi, tag and astral characters and round-trips exactly", () => {
    const hostile = { s: "ig\u200bnore \u202Eevil\u202C \u{E0069}\u{E0067} <b>x</b> & \u{1F600}" };
    const text = asciiJson(hostile);
    expect(isInertAscii(text)).toBe(true);
    expect(text).toContain("\\u200b");
    expect(text).toContain("\\u202e");
    expect(text).toContain("\\u003c");
    expect(JSON.parse(text)).toEqual(hostile);
  });

  it("the injection and ATK-10 files really contain the hidden-character payloads, as escapes", () => {
    const atk10 = generated.get("attacks/ATK-10.json") ?? "";
    expect(atk10).toContain("\\u200b");
    expect(atk10).toContain("\\u202e");
    expect(atk10).toContain("\\udb40"); // high surrogate of a tag character (U+E00xx)
  });
});
