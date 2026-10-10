import canonicalize from "canonicalize";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JcsError, hashJcs, isWellFormedString, jcs, keccak256Utf8, sha256Utf8 } from "../src/index";

const cu = (...units: number[]) => String.fromCharCode(...units);

/** Both implementations either produce the same text or both refuse the input. */
function outcome(f: () => string | undefined): string {
  try {
    return `ok:${String(f())}`;
  } catch {
    return "throws";
  }
}

describe("jcs: RFC 8785 examples (expected values from the RFC text)", () => {
  it("serializes numbers per ECMAScript Number::toString (§3.2.2.3)", () => {
    const parsed: unknown = JSON.parse("[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]");
    expect(jcs(parsed)).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27]");
  });

  it("sorts keys by UTF-16 code units (§3.2.3 example order)", () => {
    const input: Record<string, string> = {};
    for (const k of [cu(0x20ac), "\r", cu(0xfb33), "1", cu(0xd83d, 0xde00), cu(0x80), cu(0xf6)]) input[k] = "x";
    // Compare the text: Object.keys() would list the integer-like key "1" first whatever the text says.
    const expectedOrder = ["\\r", "1", cu(0x80), cu(0xf6), cu(0x20ac), cu(0xd83d, 0xde00), cu(0xfb33)];
    expect(jcs(input)).toBe(`{${expectedOrder.map((k) => `"${k}":"x"`).join(",")}}`);
  });

  it("orders an astral key before U+FF61 (UTF-16, not code point order)", () => {
    expect(jcs({ [cu(0xff61)]: 1, [cu(0xd800, 0xdc00)]: 2 })).toBe(`{"${cu(0xd800, 0xdc00)}":2,"${cu(0xff61)}":1}`);
  });

  it("escapes only what JSON.stringify escapes, lowercase hex", () => {
    expect(jcs(cu(0x0f, 0x0a, 0x7f, 0x2028))).toBe(`"\\u000f\\n${cu(0x7f, 0x2028)}"`);
  });

  it("writes -0 as 0 and drops insignificant whitespace", () => {
    expect(jcs(JSON.parse(' { "b" : [ -0 , 1.0 ] , "a" : { } } '))).toBe('{"a":{},"b":[0,1]}');
  });
});

describe("jcs: refuses anything that is not plain JSON", () => {
  const bad: Array<[string, unknown]> = [
    ["bigint (amounts are strings)", { amount: 1n }],
    ["NaN", [Number.NaN]],
    ["Infinity", { x: Number.POSITIVE_INFINITY }],
    ["undefined array element", [1, undefined]],
    ["top-level undefined", undefined],
    ["function", { f: () => 1 }],
    ["symbol", [Symbol("s")]],
    ["Date", { at: new Date(0) }],
    ["Map", new Map()],
    ["class instance", new (class Foo {})()],
    ["lone high surrogate value", cu(0xd800)],
    ["lone low surrogate key", { [cu(0xdc00)]: 1 }],
    ["symbol-keyed property", { [Symbol("k")]: 1 }],
  ];
  it.each(bad)("rejects %s", (_name, value) => {
    expect(() => jcs(value)).toThrow(JcsError);
  });

  it("rejects cycles but allows shared (acyclic) references", () => {
    const shared = { a: 1 };
    expect(jcs({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jcs(cyclic)).toThrow(/cycle/);
  });

  it("omits undefined members exactly like JSON.stringify", () => {
    const v = { a: 1, b: undefined, c: { d: undefined } };
    expect(jcs(v)).toBe('{"a":1,"c":{}}');
    expect(hashJcs(v)).toBe(hashJcs(JSON.parse(JSON.stringify(v))));
  });

  it("reports the path of the offending value", () => {
    expect(() => jcs({ a: [{ b: 1n }] })).toThrow(/\$\.a\[0\]\.b/);
  });

  it("accepts null-prototype objects", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.z = 1;
    o.a = true;
    expect(jcs(o)).toBe('{"a":true,"z":1}');
  });
});

describe("jcs: agrees with the independent `canonicalize` package", () => {
  it("on arbitrary well-formed JSON values", () => {
    fc.assert(
      fc.property(fc.jsonValue({ stringUnit: "grapheme" }), (v) => {
        expect(jcs(v)).toBe(canonicalize(v));
      }),
      { numRuns: 500 },
    );
  });

  it("on arbitrary strings, including lone surrogates (both accept or both refuse)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        expect(outcome(() => jcs({ [s]: s }))).toBe(outcome(() => canonicalize({ [s]: s })));
      }),
      { numRuns: 500 },
    );
  });

  it("is idempotent: jcs(parse(jcs(v))) === jcs(v)", () => {
    fc.assert(
      fc.property(fc.jsonValue({ stringUnit: "grapheme" }), (v) => {
        const once = jcs(v);
        expect(jcs(JSON.parse(once))).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});

describe("hash helpers", () => {
  it("match well-known digests of the empty string", () => {
    expect(keccak256Utf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(sha256Utf8("")).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashJcs is independent of key order", () => {
    expect(hashJcs({ a: 1, b: [2, { d: 3, c: 4 }] })).toBe(hashJcs({ b: [2, { c: 4, d: 3 }], a: 1 }));
  });

  it("refuses to hash a lone surrogate instead of replacing it with U+FFFD", () => {
    expect(() => keccak256Utf8(`a${cu(0xd800)}`)).toThrow(JcsError);
    expect(() => sha256Utf8(cu(0xdfff))).toThrow(JcsError);
    expect(isWellFormedString(cu(0xd83d, 0xde00))).toBe(true);
    expect(isWellFormedString(cu(0xde00, 0xd83d))).toBe(false);
  });
});
