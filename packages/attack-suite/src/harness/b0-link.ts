// "Linking" the vendored arc-escrow route (docs/07 §6: record the vendoring diff). The upstream file is kept byte for
// byte in vendor/arc-escrow/original/. The file the harness executes (vendor/arc-escrow/linked/) is derived from it by
// exactly two kinds of change, both made here and both re-derived by a test, so the diff is provable, not asserted:
//   1. one header line (`// @ts-nocheck ...`) so the upstream file, which uses `any` and Next types, is not compiled
//      against our strict config;
//   2. every import specifier that points at the network edges (or at the app's `@/` alias) is rewritten to the
//      stub or to the verbatim vendored sibling. No other byte of the route changes.

export const LINK_HEADER = "// @ts-nocheck -- vendored upstream code (circlefin/arc-escrow, see vendor/arc-escrow/VENDOR.md); import specifiers re-pointed only\n";

/** Upstream specifier -> specifier from vendor/arc-escrow/linked/. Edges map to stubs/, `amount` to the verbatim copy. */
export const SPECIFIER_MAP: Readonly<Record<string, string>> = Object.freeze({
  "next/server": "../stubs/next-server",
  "@/lib/utils/openAIClient": "../stubs/openai-client",
  "@/lib/utils/openai-error-handler": "../stubs/openai-error-handler",
  "@/lib/supabase/server-client": "../stubs/supabase-server-client",
  "@/lib/utils/smart-contract-platform-client": "../stubs/circle-contract-sdk",
  "@/app/services/agreement.service": "../stubs/agreement-service",
  "@/lib/utils/amount": "../original/amount",
  "@/lib/utils/developer-controlled-wallets-client": "../stubs/circle-developer-sdk",
});

const IMPORT_RE = new RegExp('(from\\s+")([^"]+)(")', "g");

/** Imports the original route declares (used by the test to prove the map is complete). */
export function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[2] as string);
}

export function linkRoute(original: string): string {
  const linked = original.replace(IMPORT_RE, (_all, pre: string, spec: string, post: string) => {
    const to = SPECIFIER_MAP[spec];
    if (to === undefined) throw new RangeError(`vendored route imports ${spec}, which has no stub or vendored sibling`);
    return `${pre}${to}${post}`;
  });
  return LINK_HEADER + linked;
}
