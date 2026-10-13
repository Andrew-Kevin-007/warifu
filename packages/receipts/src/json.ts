// Strict reading of a receipt file (the verify-receipt CLI and /audit read untrusted bytes).
//
// A file is accepted only if it is:
//   - at most MAX_RECEIPT_FILE_BYTES long;
//   - well-formed UTF-8 with no byte-order mark (a flipped byte can never decode to U+FFFD and slip through);
//   - valid JSON, in which no object repeats a member name. JSON.parse keeps the LAST duplicate, other readers keep
//     the first, so a file with a repeated key could "verify" as one receipt and read as another.
// Everything else is the schema's job: after this the value is still untrusted data.
import { err, ok, type Result } from "./result";

export const MAX_RECEIPT_FILE_BYTES = 1_048_576;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The first repeated member name in any object of `text` (already known to be valid JSON), or null. */
export function findDuplicateKey(text: string): string | null {
  // A small scanner over the token stream: `stack` holds one Set of member names per open object (null per array).
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (expectKey && top !== null && top !== undefined) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return null;
}

/** UTF-8 bytes (or text) -> JSON value, or a typed refusal. Never throws. */
export function parseReceiptJson(input: string | Uint8Array): Result<unknown> {
  let text: string;
  if (typeof input === "string") {
    text = input;
    if (new TextEncoder().encode(text).length > MAX_RECEIPT_FILE_BYTES) return err("RECEIPT_INVALID", "input is larger than the receipt size limit");
  } else {
    if (input.length > MAX_RECEIPT_FILE_BYTES) return err("RECEIPT_INVALID", "input is larger than the receipt size limit");
    try {
      text = STRICT_UTF8.decode(input);
    } catch {
      return err("RECEIPT_INVALID", "input is not well-formed UTF-8");
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err("RECEIPT_INVALID", "input is not valid JSON");
  }
  const dup = findDuplicateKey(text);
  if (dup !== null) return err("RECEIPT_INVALID", "an object repeats a member name");
  return ok(value);
}
