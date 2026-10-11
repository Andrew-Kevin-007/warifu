// Strict, safe YAML reading for operator-controlled config (policy.yaml, sandbox overrides).
//
// The `yaml` package (2.8.1, pinned) parses; this module then walks the AST and accepts only a subset,
// building plain JSON values itself (never `toJS()`, so no Buffer/Date/Set/Map can appear):
// - exactly one document; no `%YAML`/`%TAG` directives; no parser errors or warnings;
// - the root is a mapping; mappings and sequences (block or flow) nest at most 8 deep;
// - no anchors, no aliases (so no `<<` merge keys and no billion-laughs), no explicit tags (`!!binary`, ...);
// - scalars are plain, 'single' or "double" quoted; block scalars (`|`, `>`) are refused;
// - map keys are strings (an unquoted `1:` is an int key and is refused) and never `__proto__`,
//   `constructor` or `prototype`;
// - numbers are written canonically: the source text must equal String(value) (refuses 0x10, 0o17, 1e3,
//   010, +5, -0, 1.50, .inf, .nan); booleans are exactly `true`/`false`; null (`~`, `null`, empty) is refused.
// The input must be at most 64 KiB, well-formed UTF-16, and free of control, zero-width and bidi characters
// (a reviewer must see the bytes that are loaded). Pure: no I/O, no clock.
import { isWellFormedString } from "@symbolon/schemas";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, Scalar } from "yaml";
import type { Node as YamlNode } from "yaml";
import { fail } from "./errors";

export const MAX_POLICY_SOURCE_CHARS = 65_536;
export const MAX_POLICY_DEPTH = 8;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Refused anywhere in the source: C0 controls except TAB/LF/CR, DEL, C1 controls, zero-width characters and
// joiners, LRM/RLM, bidi embeddings/overrides/isolates, word joiner and invisible operators; U+FEFF is refused
// anywhere but the very first character (a leading BOM is skipped by the parser).
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
];
const BOM = 0xfeff;

function isHidden(c: number): boolean {
  return HIDDEN_RANGES.some(([lo, hi]) => c >= lo && c <= hi);
}

export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function checkSource(text: unknown): string {
  if (typeof text !== "string") fail("INPUT_INVALID", "$", "policy source must be a string");
  if (text.length > MAX_POLICY_SOURCE_CHARS) {
    fail("INPUT_INVALID", "$", `policy source is longer than ${MAX_POLICY_SOURCE_CHARS} characters`);
  }
  if (!isWellFormedString(text)) fail("INPUT_INVALID", "$", "policy source contains a lone UTF-16 surrogate");
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isHidden(c) || (c === BOM && i > 0)) {
      const cp = c.toString(16).toUpperCase().padStart(4, "0");
      fail("INPUT_INVALID", "$", `line ${lineOf(text, i)}: control or invisible character U+${cp}`);
    }
  }
  return text;
}

/** Every node the parser composes carries a range; the offset becomes a 1-based line number. */
function where(src: string, node: { range?: unknown }): string {
  return `line ${lineOf(src, (node.range as readonly [number, number, number])[0])}: `;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 160);
}

function readScalar(src: string, node: Scalar, path: string): JsonValue {
  if (node.type !== Scalar.PLAIN && node.type !== Scalar.QUOTE_SINGLE && node.type !== Scalar.QUOTE_DOUBLE) {
    fail("YAML_FEATURE", path, `${where(src, node)}block scalars (| or >) are not accepted`);
  }
  const value: unknown = node.value;
  switch (typeof value) {
    case "string":
      return value;
    case "number": {
      // Quoted scalars are always strings in the core schema, so a number comes from a plain scalar.
      if (!Number.isFinite(value) || node.source !== String(value)) {
        fail("YAML_FEATURE", path, `${where(src, node)}numbers must be written canonically (e.g. 20000, 0.17)`);
      }
      return value;
    }
    case "boolean": {
      if (node.source !== "true" && node.source !== "false") {
        fail("YAML_FEATURE", path, `${where(src, node)}booleans must be written exactly as true or false`);
      }
      return value;
    }
    default:
      // null (`~`, `null`, an empty value); anything else cannot appear without a tag, and tags are refused.
      return fail("YAML_FEATURE", path, `${where(src, node)}null / empty values are not accepted`);
  }
}

function checkNodeMeta(src: string, node: YamlNode, path: string): void {
  if (node.anchor !== undefined) fail("YAML_FEATURE", path, `${where(src, node)}anchors (&) are not accepted`);
  if (node.tag !== undefined) fail("YAML_FEATURE", path, `${where(src, node)}explicit tags (!, !!) are not accepted`);
}

function readKey(src: string, key: unknown, path: string): string {
  if (isAlias(key)) fail("YAML_FEATURE", path, `${where(src, key)}aliases (*) are not accepted`);
  if (!isScalar(key)) fail("YAML_FEATURE", path, "map keys must be plain or quoted strings");
  checkNodeMeta(src, key, path);
  const k = readScalar(src, key, path);
  if (typeof k !== "string") fail("YAML_FEATURE", path, `${where(src, key)}map keys must be strings (quote them)`);
  if (FORBIDDEN_KEYS.has(k)) fail("YAML_FEATURE", path, `${where(src, key)}key "${k}" is not accepted`);
  return k;
}

function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "$" ? key : `${path}.${key}`;
}

function readNode(src: string, node: unknown, path: string, depth: number): JsonValue {
  if (isAlias(node)) fail("YAML_FEATURE", path, `${where(src, node)}aliases (*) are not accepted`);
  if (isScalar(node)) {
    checkNodeMeta(src, node, path);
    return readScalar(src, node, path);
  }
  if (isMap(node) || isSeq(node)) {
    checkNodeMeta(src, node, path);
    if (depth >= MAX_POLICY_DEPTH) fail("YAML_FEATURE", path, `nesting deeper than ${MAX_POLICY_DEPTH} levels`);
    if (isSeq(node)) return node.items.map((item, i) => readNode(src, item, child(path, i), depth + 1));
    const out: { [key: string]: JsonValue } = {};
    for (const pair of node.items) {
      const key = readKey(src, pair.key, path);
      if (pair.value === null) fail("YAML_FEATURE", child(path, key), "a key without a value is not accepted");
      out[key] = readNode(src, pair.value, child(path, key), depth + 1);
    }
    return out;
  }
  return fail("YAML_FEATURE", path, "unsupported YAML node");
}

/**
 * Parse operator-controlled YAML into a plain JSON object under the rules in the header.
 * Throws PolicyError (INPUT_INVALID | YAML_SYNTAX | YAML_FEATURE); never returns partial data.
 */
export function parseStrictYaml(text: string): { [key: string]: JsonValue } {
  const src = checkSource(text);
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(src, {
      version: "1.2",
      schema: "core",
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      intAsBigInt: false,
    });
  } catch (e) {
    // e.g. RangeError on pathological nesting: refuse, do not crash the caller with a raw error.
    return fail("YAML_SYNTAX", "$", `YAML parser failed: ${oneLine(String(e))}`);
  }
  if (docs.length !== 1) fail("YAML_FEATURE", "$", `expected exactly one YAML document, found ${docs.length}`);
  const doc = docs[0] as (typeof docs)[number];
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    fail("YAML_SYNTAX", "$", `${firstError.code}: ${oneLine(firstError.message)}`);
  }
  const firstWarning = doc.warnings[0];
  if (firstWarning !== undefined) {
    fail("YAML_FEATURE", "$", `${firstWarning.code}: ${oneLine(firstWarning.message)}`);
  }
  // Parsed documents always carry directives; if a future parser version did not, the property access
  // throws and the caller's fail-closed wrapper turns it into a PolicyError.
  const directives = doc.directives as NonNullable<typeof doc.directives>;
  if (directives.yaml.explicit === true) fail("YAML_FEATURE", "$", "%YAML directives are not accepted");
  if (Object.keys(directives.tags).some((handle) => handle !== "!!")) {
    fail("YAML_FEATURE", "$", "%TAG directives are not accepted");
  }
  if (!isMap(doc.contents)) fail("YAML_FEATURE", "$", "the document root must be a mapping");
  return readNode(src, doc.contents, "$", 0) as { [key: string]: JsonValue };
}
