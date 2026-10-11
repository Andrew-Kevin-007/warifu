// Currency handling for the extractor (finding "currency confusion"): EXACT matching against a closed allow-list.
//
// No case folding ("usdc" is not "USDC"), no NFKC folding (look-alike characters never match), no substring
// matches ("USD" is not found inside "USDC" or the reverse), and a bare "$" is never assumed to be USDC.
// Whether a printed currency maps to the vault token (K-07, `policy.currency.treatUsdAsUsdc`) is the KERNEL's
// decision; the extractor only emits base units when the operator has listed the exact printed spelling as
// parse-eligible (default: "USDC" only). Everything else yields parsedBaseUnits=null plus a flag.
export const KNOWN_CURRENCY_TOKENS: readonly string[] = ["USDC", "USD", "US$", "EURC", "EUR", "GBP", "$", "€", "£"];

/** Default parse-eligible spellings: only the token symbol itself. */
export const DEFAULT_PARSE_ELIGIBLE: readonly string[] = ["USDC"];

/** Exact equality against the closed list. */
export function isKnownCurrencyToken(s: string): boolean {
  return KNOWN_CURRENCY_TOKENS.some((k) => k === s);
}

/** Exact equality against the operator's parse-eligible list (which must itself be a subset of the known list). */
export function isParseEligible(s: string, eligible: readonly string[] = DEFAULT_PARSE_ELIGIBLE): boolean {
  return eligible.some((k) => k === s) && isKnownCurrencyToken(s);
}

/** Known tokens, longest first, for left-to-right matching. */
export const KNOWN_TOKENS_LONGEST_FIRST: readonly string[] = [...KNOWN_CURRENCY_TOKENS].sort((a, b) => b.length - a.length);

/** Regex alternation source of the known tokens (escaped), longest first. */
export function currencyAlternation(): string {
  return KNOWN_TOKENS_LONGEST_FIRST.map((t) => t.replace(/[$]/g, "\\$")).join("|");
}
