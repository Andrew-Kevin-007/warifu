// Word n-gram overlap, used by the ATK-24 explainer check (docs/07 §3: "automatic n-gram overlap check"):
// a human-facing explanation must not echo phrases from the untrusted document. Pure string work.

function words(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 0);
}

export function ngrams(text: string, n: number): Set<string> {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  const ws = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

/** The n-grams that appear in both texts. */
export function sharedNgrams(a: string, b: string, n: number): string[] {
  const nb = ngrams(b, n);
  return [...ngrams(a, n)].filter((g) => nb.has(g));
}
