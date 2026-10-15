// Single source of truth for the PUBLIC product name (docs/BRAND_AND_IDEA.md). One edit here renames every public surface.
// NOT renamed on purpose: workspace packages (@symbolon/*), env vars, spec ids, DB identifiers, the EIP-712 domain name.
// A display-name change of the EIP-712 domain would change every signature and test vector; that is a schemas RFC.

export const BRAND = Object.freeze({
  name: "Warifu",
  /** Shown once, on /about. Warifu = a split tally: a token broken in two so only the matching halves prove the agreement. */
  kanji: "割符",
  reading: "wah-ree-foo",
  tagline: "The treasurer that cannot be sweet-talked.",
  repoSlug: "warifu",
  /** The previous public name; may appear only in the "formerly" footnote on /about. */
  formerName: "Symbolon",
});

export type Brand = typeof BRAND;
