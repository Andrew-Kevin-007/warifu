// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// Rules implemented (RFC 8785 §3.2):
// - object members sorted by their names as arrays of UTF-16 code units, no insignificant whitespace;
// - strings serialized as by ECMAScript JSON.stringify (\b \f \n \r \t \" \\ short escapes, other
//   U+0000..U+001F as lowercase \u00xx, everything else literal), and they must be well-formed
//   UTF-16 (I-JSON, RFC 7493): a lone surrogate is an error;
// - numbers serialized as by ECMAScript Number.prototype.toString (RFC 8785 §3.2.2.3 defers to it);
//   NaN and ±Infinity are errors; -0 serializes as 0.
//
// Symbolon conventions on top of RFC 8785 (docs/05 §1): amounts are decimal strings, so a `bigint`
// is an error here (convert explicitly); anything that is not plain JSON data (Date, Map, class
// instances, functions, symbols, cycles) is an error rather than being coerced. Object members whose
// value is `undefined` are omitted, exactly like JSON.stringify, so `hash(x)` equals
// `hash(JSON.parse(JSON.stringify(x)))`. `undefined` inside an array is an error.

export class JcsError extends Error {
  override readonly name = "JcsError";
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
  }
}

/** True iff `s` contains no lone (unpaired) UTF-16 surrogate. */
export function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return false;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function serializeString(s: string, path: string): string {
  if (!isWellFormedString(s)) throw new JcsError("lone UTF-16 surrogate in string", path);
  return JSON.stringify(s);
}

function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) throw new JcsError(`non-finite number ${String(n)}`, path);
  // ECMAScript Number::toString; JSON.stringify(-0) === "0" as RFC 8785 requires.
  return JSON.stringify(n);
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value, path);
    case "bigint":
      throw new JcsError("bigint is not JSON; encode amounts as decimal strings", path);
    case "undefined":
      throw new JcsError("undefined is not JSON", path);
    case "function":
    case "symbol":
      throw new JcsError(`${typeof value} is not JSON`, path);
    case "object":
      break;
  }
  const obj = value as object;
  if (ancestors.has(obj)) throw new JcsError("cycle", path);
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        const item: unknown = obj[i];
        if (item === undefined) throw new JcsError("undefined array element", `${path}[${i}]`);
        parts.push(serialize(item, `${path}[${i}]`, ancestors));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(obj)) {
      throw new JcsError(`non-plain object (${Object.prototype.toString.call(obj)})`, path);
    }
    if (Object.getOwnPropertySymbols(obj).length > 0) throw new JcsError("symbol-keyed property", path);
    // Default sort compares UTF-16 code units, which is exactly RFC 8785 §3.2.3.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      const childPath = `${path}.${key}`;
      parts.push(`${serializeString(key, childPath)}:${serialize(v, childPath, ancestors)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

/** Canonical JSON text of `value` per RFC 8785. Throws `JcsError` on anything that is not JSON. */
export function jcs(value: unknown): string {
  return serialize(value, "$", new Set());
}
