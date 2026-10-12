// Structured JSON logs (docs/02 section 9, SEC-07, INV-15). One object per line. Rules enforced here, not by convention:
//  - ALLOWLIST: only the keys in ALLOWED_KEYS (and keys ending Hash / Length / Bytes / Count / Id / Ms) are logged; every
//    other key is dropped (a denylist always misses a name) and counted in logStats.dropped;
//  - every allowed key has a value shape: ids and hashes must look like ids/hashes, counts are non-negative integers,
//    enums are closed; a value of the wrong shape becomes "[invalid]", so free text cannot ride under an allowed key;
//  - untrusted text enters a log only as `excerpt`, whose type (LogExcerpt) only untrustedField() produces
//    (escaped excerpt + length + sha256, toLogSafe), and whose runtime shape is checked again;
//  - every configured secret string (and its encodings) is replaced by [redacted] in each value and in the final line.
import { toLogSafe } from "@symbolon/schemas";
import type { Untrusted } from "@symbolon/schemas";

declare const LOG_EXCERPT: unique symbol;
/** Output of untrustedField(): the only thing the `excerpt` key accepts. A plain string is a type error. */
export type LogExcerpt = string & { readonly [LOG_EXCERPT]: true };

export type LogValue = string | number | boolean | null;
export interface LogFields {
  readonly excerpt?: LogExcerpt;
  /** Any other key is accepted by the type but dropped at runtime unless it is on the allowlist. */
  readonly [key: string]: LogValue | undefined;
}
export type LogLevel = "info" | "warn" | "error";

export const MAX_FIELD = 200;

const INT = (v: LogValue): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^(0x)?[0-9a-fA-F]{8,64}$/;
const ID = (v: LogValue): boolean => typeof v === "string" && (UUID.test(v) || (HEX.test(v) && (!v.startsWith("0x") || v.length === 42 || v.length === 66)));
const HASH = (v: LogValue): boolean => typeof v === "string" && /^(0x)?[0-9a-f]{64}$/.test(v);
const ENUM =
  (...allowed: string[]) =>
  (v: LogValue): boolean =>
    typeof v === "string" && allowed.includes(v);
const CODE = (max: number) => (v: LogValue): boolean => typeof v === "string" && new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${String(max - 1)}}$`).test(v);

/** Closed set of loggable keys and the value shape each accepts. */
const ALLOWED_KEYS: Readonly<Record<string, (v: LogValue) => boolean>> = {
  intentId: ID,
  decisionId: ID,
  receiptHash: HASH,
  tenantId: ID,
  engagementId: ID,
  milestoneId: ID,
  route: (v) => typeof v === "string" && /^[A-Za-z0-9/_:.-]{1,100}$/.test(v),
  method: ENUM("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"),
  status: (v) => INT(v) && (v as number) >= 100 && (v as number) <= 599,
  durationMs: INT,
  profile: ENUM("production", "sandbox"),
  errClass: CODE(60),
  errCode: CODE(40),
  verdict: ENUM("RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY"),
  reasonCode: CODE(40),
  checkId: (v) => typeof v === "string" && /^K-\d{2}$/.test(v),
  count: INT,
};
const ALLOWED_SUFFIX: ReadonlyArray<readonly [RegExp, (v: LogValue) => boolean]> = [
  [/Hash$/, HASH],
  [/(Length|Bytes|Count|Ms)$/, INT],
  [/Id$/, ID],
];
// toLogSafe: a JSON-quoted excerpt, then " (len=N, sha256=...)".
const EXCERPT_SHAPE = /^"(?:[^"\\]|\\.)*" \(len=\d+, sha256=(?:0x[0-9a-f]{64}|n\/a\(ill-formed\))\)$/;

/** Dev-only counter of keys that were dropped (key names are clipped and restricted to a safe alphabet). */
export const logStats = { dropped: new Map<string, number>() };

function noteDropped(key: string): void {
  const k = /^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : "(unprintable)";
  logStats.dropped.set(k, (logStats.dropped.get(k) ?? 0) + 1);
}

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * What may be logged about a caught error: its class and a short machine code, never its message, stack or cause
 * (a pg, fetch or Circle error message can carry the connection string, a header or a response body).
 */
export function errorFields(e: unknown): { errClass: string; errCode: string } {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  return {
    errClass: /^[A-Za-z0-9_]{1,60}$/.test(cls) ? cls : "Error",
    errCode: typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "none",
  };
}

const MIN_REDACT = 8;

/**
 * Every spelling of a secret that can reach a JSON log line: raw, JSON-escaped (quotes, backslashes and control
 * characters are escaped inside the encoded line), percent-encoded, hex (both cases), and base64 / base64url at each of
 * the three byte alignments (a secret embedded in a longer base64 string starts at any offset), padding stripped.
 */
export function secretVariants(secret: string): string[] {
  const out = new Set<string>();
  const add = (v: string): void => {
    if (v.length >= MIN_REDACT) out.add(v);
  };
  add(secret);
  add(JSON.stringify(secret).slice(1, -1));
  add(encodeURIComponent(secret));
  const bytes = Buffer.from(secret, "utf8");
  add(bytes.toString("hex"));
  add(bytes.toString("hex").toUpperCase());
  const start = [0, 2, 3];
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64").replace(/=+$/, "");
    const total = k + bytes.length;
    const cut = total % 3 === 0 ? 0 : 1; // the last char of a partial final group mixes in zero padding bits
    const stable = b64.slice(start[k] ?? 0, b64.length - cut);
    add(stable);
    add(stable.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...out];
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  /** Exact secret strings that must never appear in a log line (>= 8 characters are honoured). */
  readonly secrets?: readonly string[];
  readonly clock?: () => number;
}

/** Escaped excerpt + length + sha256 of untrusted text: the only form in which it may be logged. */
export function untrustedField(u: Untrusted<string> | string): LogExcerpt {
  return toLogSafe(u) as LogExcerpt;
}

function clip(s: string): string {
  return s.length <= MAX_FIELD ? s : `${s.slice(0, MAX_FIELD)}...(truncated ${s.length - MAX_FIELD})`;
}

export function scrubFields(fields: LogFields, redact: (s: string) => string = (s) => s): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let valid: ((x: LogValue) => boolean) | undefined;
    if (k === "excerpt") valid = (x) => typeof x === "string" && EXCERPT_SHAPE.test(x);
    else if (Object.hasOwn(ALLOWED_KEYS, k)) valid = ALLOWED_KEYS[k];
    else valid = ALLOWED_SUFFIX.find(([re]) => re.test(k))?.[1];
    if (valid === undefined) {
      noteDropped(k);
      continue;
    }
    if (!valid(v)) {
      out[k] = "[invalid]";
      continue;
    }
    // Redact BEFORE clipping: truncation must not cut a secret in half and leave an unmatched prefix behind.
    // (An excerpt is already bounded by toLogSafe; clipping would cut off its length/hash trailer.)
    out[k] = typeof v === "string" ? (k === "excerpt" ? redact(v) : clip(redact(v))) : v;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink: LogSink = options.sink ?? { write: (line) => void process.stdout.write(line) };
  const secrets = [...new Set((options.secrets ?? []).filter((s) => s.length >= MIN_REDACT).flatMap(secretVariants))].sort((a, b) => b.length - a.length);
  const clock = options.clock ?? (() => Date.now());
  const redact = (t: string): string => {
    let r = t;
    for (const x of secrets) r = r.split(x).join("[redacted]");
    return r;
  };
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line = redact(JSON.stringify({ at: new Date(clock()).toISOString(), level, event: clip(redact(event)), ...scrubFields(fields, redact) }));
    sink.write(`${line}\n`);
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
