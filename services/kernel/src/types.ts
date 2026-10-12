// Shared leaf types (no imports, so boot.ts <-> secrets.ts do not form a cycle).
export type EnvLike = Readonly<Record<string, string | undefined>>;

export const PROFILES = ["production", "sandbox"] as const;
export type Profile = (typeof PROFILES)[number];
