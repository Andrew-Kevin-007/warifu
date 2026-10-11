// Strict YAML reader: every refusal is paired with a positive control (the same document with only the
// refused feature removed parses), so a test cannot pass because the input was broken in some other way.
import { describe, expect, it } from "vitest";
import { MAX_POLICY_DEPTH, MAX_POLICY_SOURCE_CHARS, parseStrictYaml } from "../src/index";
import { SPEC_YAML, ch, expectPolicyError } from "./helpers";

function refusedAndControl(bad: string, good: string, code: "YAML_FEATURE" | "YAML_SYNTAX" | "INPUT_INVALID" = "YAML_FEATURE") {
  expectPolicyError(() => parseStrictYaml(bad), code);
  expect(() => parseStrictYaml(good)).not.toThrow();
}

describe("parseStrictYaml: accepted subset", () => {
  it("reads the docs/04 §7 example with JSON types (amounts stay strings)", () => {
    const v = parseStrictYaml(SPEC_YAML);
    expect(v["version"]).toBe(1);
    expect(v["tenant"]).toBe("edith-studio");
    expect(v["caps"]).toMatchObject({ perTxHardCap: "100.000000", hourlyCap: "25.000000" });
    expect(v["velocity"]).toMatchObject({ maxReleasesPerDay: 10, maxAmountPerPayeePerDay: "150.000000" });
    expect(v["newPayee"]).toMatchObject({ alwaysHuman: true });
    expect(v["evidence"]).toMatchObject({ urlAllowlist: ["https://*.vercel.app", "https://edithstudio.vercel.app"] });
  });

  it("keeps '#' inside quoted strings and drops comments", () => {
    expect(parseStrictYaml('a: "x#y" # comment\nb: \'p # q\'\n')).toEqual({ a: "x#y", b: "p # q" });
  });

  it("accepts block and flow collections, single and double quotes, CRLF, a leading BOM and '---'", () => {
    const lf = "a:\n  b: [1, 2]\n  c: { d: 'e' }\n";
    expect(parseStrictYaml(lf)).toEqual({ a: { b: [1, 2], c: { d: "e" } } });
    expect(parseStrictYaml(lf.replace(/\n/g, "\r\n"))).toEqual(parseStrictYaml(lf));
    expect(parseStrictYaml(ch(0xfeff) + lf)).toEqual(parseStrictYaml(lf));
    expect(parseStrictYaml("---\n" + lf)).toEqual(parseStrictYaml(lf));
    expect(parseStrictYaml(lf + "...\n")).toEqual(parseStrictYaml(lf));
  });

  it("accepts a TAB inside a quoted string and non-ASCII visible text", () => {
    expect(parseStrictYaml(`a: "x${ch(9)}y"\nb: "${ch(0xe9)}"\n`)).toEqual({ a: "x\ty", b: ch(0xe9) });
  });

  it("returns plain objects whose prototype is Object.prototype", () => {
    const v = parseStrictYaml("a: { b: 1 }\n");
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(v["a"])).toBe(Object.prototype);
  });
});

describe("parseStrictYaml: refused features (each with a positive control)", () => {
  it("anchors", () => refusedAndControl("a: &x 1\n", "a: 1\n"));
  it("anchors on collections", () => refusedAndControl("a: &x { b: 1 }\n", "a: { b: 1 }\n"));
  it("aliases, even to an undefined anchor", () => refusedAndControl("a: 1\nb: *x\n", "a: 1\nb: 1\n"));
  it("aliases to a defined anchor (refused at the anchor first, and at the alias)", () => {
    expectPolicyError(() => parseStrictYaml("a: &x 1\nb: *x\n"), "YAML_FEATURE");
  });
  it("merge keys (<<) need an alias and are refused", () => {
    refusedAndControl("base: &b { x: 1 }\nm:\n  <<: *b\n  y: 2\n", "base: { x: 1 }\nm:\n  x: 1\n  y: 2\n");
  });
  it("alias used as a key", () => refusedAndControl("? *k\n: 1\n", "k: 1\n"));
  it("explicit core tags", () => refusedAndControl("a: !!str 1\n", "a: '1'\n"));
  it("!!binary (would become a Buffer)", () => refusedAndControl("a: !!binary aGVsbG8=\n", "a: aGVsbG8=\n"));
  it("tags on collections", () => {
    refusedAndControl("a: !!map { x: 1 }\n", "a: { x: 1 }\n");
    refusedAndControl("a: !!seq [1]\n", "a: [1]\n");
    expectPolicyError(() => parseStrictYaml("a: !!set { x: 1 }\n"), "YAML_SYNTAX");
  });
  it("tags on keys", () => refusedAndControl("!!str a: 1\n", "a: 1\n"));
  it("custom tags (parser warning)", () => refusedAndControl("a: !custom x\n", "a: x\n"));
  it("%YAML directives", () => refusedAndControl("%YAML 1.2\n---\na: 1\n", "---\na: 1\n"));
  it("%TAG directives", () => refusedAndControl("%TAG !e! tag:example.com,2000:\n---\na: 1\n", "---\na: 1\n"));
  it("more than one document", () => refusedAndControl("a: 1\n---\nb: 2\n", "a: 1\nb: 2\n"));
  it("empty input and comment-only input", () => {
    expectPolicyError(() => parseStrictYaml(""), "YAML_FEATURE");
    expectPolicyError(() => parseStrictYaml("# nothing\n"), "YAML_FEATURE");
  });
  it("a root that is not a mapping", () => {
    refusedAndControl("- a\n- b\n", "a: [a, b]\n");
    refusedAndControl("just a string\n", "a: just a string\n");
  });
  it("block scalars", () => {
    refusedAndControl("a: |\n  text\n", "a: text\n");
    refusedAndControl("a: >-\n  text\n", "a: text\n");
  });
  it("null values in every spelling", () => {
    for (const v of ["~", "null", "Null", "NULL", ""]) refusedAndControl(`a: ${v}\n`, "a: x\n");
  });
  it("non-canonical numbers", () => {
    const cases: Array<[string, string]> = [
      ["0x10", "16"],
      ["0o17", "15"],
      ["1e3", "1000"],
      ["010", "10"],
      ["+5", "5"],
      ["-0", "0"],
      ["1.50", "1.5"],
      ["1.0", "1"],
      [".5", "0.5"],
      [".inf", "1"],
      ["-.inf", "1"],
      [".nan", "1"],
    ];
    for (const [bad, good] of cases) {
      refusedAndControl(`a: ${bad}\n`, `a: ${good}\n`);
      expect(parseStrictYaml(`a: ${good}\n`)["a"]).toBe(Number(good));
    }
  });
  it("booleans other than true/false", () => {
    for (const v of ["True", "TRUE", "False", "FALSE"]) refusedAndControl(`a: ${v}\n`, "a: true\n");
    expect(parseStrictYaml("a: false\n")["a"]).toBe(false);
  });
  it("YAML 1.1 booleans stay strings (no Norway problem)", () => {
    expect(parseStrictYaml("a: yes\nb: no\nc: on\nd: off\n")).toEqual({ a: "yes", b: "no", c: "on", d: "off" });
  });
  it("non-string keys", () => {
    refusedAndControl("1: x\n", '"1": x\n');
    refusedAndControl("true: x\n", '"true": x\n');
    refusedAndControl("~: x\n", '"~": x\n');
  });
  it("complex keys", () => refusedAndControl("? [a, b]\n: 1\n", "a: 1\n"));
  it("a key without any value", () => refusedAndControl("? a\n", "a: 1\n"));
  it("prototype-polluting keys, plain or quoted, at any depth", () => {
    for (const k of ["__proto__", "constructor", "prototype", '"__proto__"', "'constructor'"]) {
      refusedAndControl(`${k}: { x: 1 }\n`, "safe: { x: 1 }\n");
      refusedAndControl(`a: { ${k}: 1 }\n`, "a: { safe: 1 }\n");
    }
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
  it("duplicate keys", () => refusedAndControl("a: 1\na: 2\n", "a: 1\nb: 2\n", "YAML_SYNTAX"));
  it("tab indentation", () => refusedAndControl("a:\n\tb: 1\n", "a:\n  b: 1\n", "YAML_SYNTAX"));
  it("syntax errors", () => {
    refusedAndControl('a: "unterminated\n', 'a: "terminated"\n', "YAML_SYNTAX");
    refusedAndControl("a: [1, 2\n", "a: [1, 2]\n", "YAML_SYNTAX");
  });
});

describe("parseStrictYaml: nesting and size limits", () => {
  const nested = (levels: number): string => "a: " + "{ b: ".repeat(levels - 1) + "1" + " }".repeat(levels - 1) + "\n";
  it(`accepts ${MAX_POLICY_DEPTH} levels of collections and refuses ${MAX_POLICY_DEPTH + 1}`, () => {
    expect(() => parseStrictYaml(nested(MAX_POLICY_DEPTH))).not.toThrow();
    expectPolicyError(() => parseStrictYaml(nested(MAX_POLICY_DEPTH + 1)), "YAML_FEATURE");
  });
  it("refuses pathological nesting without crashing the caller", () => {
    expectPolicyError(() => parseStrictYaml("a: " + "[".repeat(20_000) + "]".repeat(20_000) + "\n"), "YAML_SYNTAX");
  });
  it(`accepts exactly ${MAX_POLICY_SOURCE_CHARS} characters and refuses one more`, () => {
    const base = "a: 1\n#";
    const atLimit = base + "x".repeat(MAX_POLICY_SOURCE_CHARS - base.length);
    expect(atLimit.length).toBe(MAX_POLICY_SOURCE_CHARS);
    expect(parseStrictYaml(atLimit)).toEqual({ a: 1 });
    expectPolicyError(() => parseStrictYaml(atLimit + "x"), "INPUT_INVALID");
  });
});

describe("parseStrictYaml: input hygiene", () => {
  it("refuses non-string input", () => {
    for (const v of [undefined, null, 5, {}, new Uint8Array([97, 58, 32, 49])]) {
      expectPolicyError(() => parseStrictYaml(v as unknown as string), "INPUT_INVALID");
    }
  });
  it("refuses a lone surrogate", () => refusedAndControl(`a: "${ch(0xd800)}"\n`, `a: "${ch(0xd83d)}${ch(0xde00)}"\n`, "INPUT_INVALID"));
  it("refuses control, zero-width and bidi characters anywhere (with the line number)", () => {
    const codes = [0x00, 0x07, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0x9f, 0x200b, 0x200d, 0x200e, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069];
    for (const c of codes) {
      const err = expectPolicyError(() => parseStrictYaml(`a: 1\nb: "x${ch(c)}y"\n`), "INPUT_INVALID");
      expect(err.message).toContain("line 2");
      expect(err.message).toContain(`U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    for (const c of [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0xa0, 0x2010, 0x2065, 0x206a]) {
      if (c === 0x0a || c === 0x0d) continue;
      expect(() => parseStrictYaml(`b: "x${ch(c)}y"\n`)).not.toThrow();
    }
  });
  it("refuses U+FEFF after the first character", () => refusedAndControl(`a: "x${ch(0xfeff)}"\n`, `${ch(0xfeff)}a: "x"\n`, "INPUT_INVALID"));
  it("reports the line of every refused anchor, alias and tag", () => {
    const err = expectPolicyError(() => parseStrictYaml("a: 1\nb: 2\nc: &x 3\nd: *x\ne: !!str 4\n"), "YAML_FEATURE");
    expect(err.issues.map((i) => i.message.slice(0, 7))).toEqual(["line 3:", "line 4:", "line 5:"]);
    expect(err.issues[0]?.message).toContain("anchors");
    expect(err.issues[1]?.message).toContain("aliases");
    expect(err.issues[2]?.message).toContain("tags");
  });
  it("reports nested paths, including sequence indices", () => {
    const err = expectPolicyError(() => parseStrictYaml("a:\n  b: [1, 0x2]\n"), "YAML_FEATURE");
    expect(err.issues[0]?.path).toBe("a.b[1]");
  });
});
