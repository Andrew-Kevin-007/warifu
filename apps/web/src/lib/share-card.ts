// Share card (plain SVG, no dependency). Inputs are enum values, a hash and a line chosen from the fixed phrase bank, so no
// untrusted text can reach the image (INV-15). The card is copy plus a pointer to the evidence; /audit/<hash> is the evidence.
import { BRAND, KANJI_FONT } from "./brand";

export interface CardInput {
  readonly verdict: string;
  readonly reasonCode: string | null;
  readonly receiptHash: string;
  readonly line: string;
  readonly source: "LIVE" | "RECORDED";
}

const HASH_RE = /^0x[0-9a-f]{64}$/;
const VERDICT_RE = /^(RELEASE|HOLD|ESCALATE|REJECT|REPLAY)$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Greedy word wrap on a fixed character budget; the line comes from our own bank so this is for layout only. */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/)) {
    if (cur.length > 0 && cur.length + 1 + w.length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur.length === 0 ? w : `${cur} ${w}`;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function renderCardSvg(i: CardInput): string {
  if (!HASH_RE.test(i.receiptHash) || !VERDICT_RE.test(i.verdict)) throw new RangeError("card inputs must be a receipt hash and a verdict");
  const code = i.reasonCode !== null && CODE_RE.test(i.reasonCode) ? i.reasonCode : null;
  const accent = i.verdict === "RELEASE" ? "#2d6a4f" : "#b3202a";
  const lines = wrap(i.line, 44).slice(0, 4);
  const serif = "Georgia, 'Times New Roman', serif";
  const mono = "Menlo, Consolas, monospace";
  const sans = "Helvetica, Arial, sans-serif";
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(`${BRAND.name}: ${i.verdict}${code !== null ? `, ${code}` : ""}. ${i.line}`)}">`);
  o.push(`<rect width="1200" height="630" fill="#faf7f2"/>`);
  o.push(`<rect x="40" y="40" width="1120" height="550" rx="18" fill="#ffffff" stroke="#d9d4ca" stroke-width="2"/>`);
  o.push(`<rect x="80" y="80" width="150" height="150" rx="16" fill="none" stroke="${accent}" stroke-width="8"/>`);
  o.push(`<text x="155" y="148" text-anchor="middle" font-family="${KANJI_FONT}" font-size="54" font-weight="700" fill="${accent}">${esc(BRAND.kanji.slice(0, 1))}</text>`);
  o.push(`<text x="155" y="206" text-anchor="middle" font-family="${KANJI_FONT}" font-size="54" font-weight="700" fill="${accent}">${esc(BRAND.kanji.slice(1))}</text>`);
  o.push(`<text x="270" y="130" font-family="${sans}" font-size="28" fill="#555555">${esc(BRAND.name)} ${esc(BRAND.kanji)}: ${esc(BRAND.tagline)}</text>`);
  o.push(`<text x="270" y="200" font-family="${sans}" font-size="52" font-weight="700" fill="${accent}">${esc(i.verdict)}${code !== null ? ` · ${esc(code)}` : ""}</text>`);
  lines.forEach((l, n) => {
    o.push(`<text x="80" y="${320 + n * 54}" font-family="${serif}" font-size="42" fill="#1f1f1f">${esc(l)}</text>`);
  });
  o.push(`<text x="80" y="540" font-family="${mono}" font-size="20" fill="#555555">receipt ${esc(i.receiptHash.slice(0, 34))}</text>`);
  o.push(`<text x="80" y="568" font-family="${mono}" font-size="20" fill="#555555">${esc(i.receiptHash.slice(34))}</text>`);
  o.push(`<text x="1120" y="568" text-anchor="end" font-family="${sans}" font-size="20" fill="#777777">${esc(i.source === "RECORDED" ? "RECORDED | " : "")}verify at /audit</text>`);
  o.push(`</svg>`);
  return o.join("");
}
