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
const SENSITIVE_KEY = /text|body|raw|payload|authorization|token|secret|password|private|apikey|signature|cookie|^key$|_key$|key$/i;
const SAFE_SUFFIX = /(hash|length|len|bytes|count)$/i;

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
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

export function scrubFields(fields: LogFields): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k) && !SAFE_SUFFIX.test(k)) {
      out[k] = "[dropped]";
      continue;
    }
    out[k] = typeof v === "string" ? clip(v) : v;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink: LogSink = options.sink ?? { write: (line) => void process.stdout.write(line) };
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
  const clock = options.clock ?? (() => Date.now());
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    let line = JSON.stringify({ at: new Date(clock()).toISOString(), level, event: clip(event), ...scrubFields(fields) });
    for (const s of secrets) line = line.split(s).join("[redacted]");
    sink.write(`${line}\n`);
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
