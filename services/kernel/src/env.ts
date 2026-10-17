// Placeholder handling for the operator's .env files. A value of the form PASTE_<NAME>_HERE is what the template ships with
// (.env.example, `pnpm env:init`): it means "the operator has not pasted this yet". Such a value is dropped, so the
// variable reads as unset and every feature that needs it stays off (or fails closed) with its normal "missing" message,
// instead of a placeholder string being mistaken for a real key.
import type { EnvLike } from "./types";

export const PLACEHOLDER_VALUE = /^PASTE_[A-Z0-9_]*_HERE$/;

export function isPlaceholder(value: string | undefined): boolean {
  return value !== undefined && PLACEHOLDER_VALUE.test(value.trim());
}

/** A copy of `env` without placeholder values. Never mutates its input. */
export function stripPlaceholders(env: EnvLike): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (!isPlaceholder(value)) out[name] = value;
  return out;
}

/** Names of the variables that still hold a placeholder: reported by name only, never by value. */
export function placeholderNames(env: EnvLike): string[] {
  return Object.entries(env)
    .filter(([, value]) => isPlaceholder(value))
    .map(([name]) => name)
    .sort();
}
