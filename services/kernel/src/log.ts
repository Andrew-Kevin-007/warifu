// Structured JSON logs (docs/02 section 9, SEC-07, INV-15). One object per line. Rules enforced here, not by convention:
//  - values are primitives only; strings are truncated (MAX_FIELD) so a document body cannot ride in a field;
//  - fields with sensitive names are dropped, whatever their value;
//  - untrusted text enters a log only through untrustedField() = escaped excerpt + length + sha256 (toLogSafe);
//  - every configured secret string is replaced by [redacted] in the final line (canary test, SEC-07).
import { toLogSafe } from "@symbolon/schemas";
import type { Untrusted } from "@symbolon/schemas";

export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue | undefined>>;
export type LogLevel = "info" | "warn" | "error";

export const MAX_FIELD = 200;

// Keys that may carry content or credentials. Summaries of content (hash, length, bytes, count) are fine to log.
const SENSITIVE_KEY =
  /text|body|raw|payload|authorization|auth|token|secret|password|private|apikey|signature|cookie|cred|url|dsn|conn|^key$|_key$|key$|^(err|error|message|msg|stack|cause|reason_text)$/i;
const SAFE_SUFFIX = /(hash|length|len|bytes|count)$/i;

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
export function untrustedField(u: Untrusted<string> | string): string {
  return toLogSafe(u);
}

function clip(s: string): string {
  return s.length <= MAX_FIELD ? s : `${s.slice(0, MAX_FIELD)}...(truncated ${s.length - MAX_FIELD})`;
}

export function scrubFields(fields: LogFields, redact: (s: string) => string = (s) => s): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k) && !SAFE_SUFFIX.test(k)) {
      out[k] = "[dropped]";
      continue;
    }
    // Redact BEFORE clipping: truncation must not cut a secret in half and leave an unmatched prefix behind.
    out[k] = typeof v === "string" ? clip(redact(v)) : v;
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
