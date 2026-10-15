// The Seal: a hanko-style SVG badge whose state is the vault's Loss Bound Certificate state (docs/BRAND_AND_IDEA.md).
// Pure: callers pass already-validated certificate fields. No untrusted text is accepted, and the only number on the badge
// is the formatted bound the certificate document itself carries (INV-18); nothing here computes or types a figure.
import { BRAND } from "./brand";

export type SealState = "VALID" | "STALE" | "MISMATCH" | "UNVERIFIED" | "NOT_COMPUTED";

export interface SealInput {
  readonly state: SealState;
  /** certificate's formatted bound for one horizon (from certificateView().horizons), e.g. "$1,250.00" */
  readonly bound: string | null;
  readonly horizonLabel: string | null;
  readonly blockNumber: number | null;
  readonly source: "LIVE" | "RECORDED" | null;
}

const BOUND_RE = /^\$[0-9][0-9,]*(\.[0-9]{1,18})?$/;
const HORIZON_RE = /^(1m|1h|6h|24h|48h|7d)$/;

const RED = "#b3202a";
const GREY = "#8a8a8a";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function sealCaption(state: SealState): string {
  switch (state) {
    case "VALID":
      return "INTACT";
    case "STALE":
      return "CRACKED: STALE";
    case "MISMATCH":
      return "CRACKED: MISMATCH";
    case "UNVERIFIED":
      return "NOT RECOMPUTED";
    case "NOT_COMPUTED":
      return "NOT COMPUTED";
    default: {
      const never: never = state;
      return never;
    }
  }
}

/** Plain text for the img alt / title; matches what the SVG shows. */
export function sealAlt(i: SealInput): string {
  const base = `${BRAND.name} seal: ${sealCaption(i.state)}`;
  return i.state === "VALID" && i.bound !== null && BOUND_RE.test(i.bound) ? `${base}, ${i.bound}` : base;
}

export function renderSealSvg(i: SealInput): string {
  const blank = i.state === "UNVERIFIED" || i.state === "NOT_COMPUTED";
  const cracked = i.state === "STALE" || i.state === "MISMATCH";
  const colour = blank ? GREY : RED;
  const showBound = i.state === "VALID" && i.bound !== null && BOUND_RE.test(i.bound);
  const horizon = i.horizonLabel !== null && HORIZON_RE.test(i.horizonLabel) ? i.horizonLabel : null;
  const block = !blank && i.blockNumber !== null && Number.isSafeInteger(i.blockNumber) && i.blockNumber >= 0 ? String(i.blockNumber) : null;
  const serif = "Georgia, 'Times New Roman', serif";
  const sans = "Helvetica, Arial, sans-serif";
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120" role="img" aria-label="${esc(sealAlt(i))}">`);
  o.push(`<title>${esc(sealAlt(i))}</title>`);
  o.push(`<rect x="0.5" y="0.5" width="319" height="119" rx="10" fill="#ffffff" stroke="#d9d9d9"/>`);
  o.push(`<g transform="translate(14 14)">`);
  o.push(`<rect x="2" y="2" width="88" height="88" rx="10" fill="none" stroke="${colour}" stroke-width="5"${blank ? ' stroke-dasharray="6 5"' : ""}/>`);
  if (!blank) {
    o.push(`<rect x="10" y="10" width="72" height="72" rx="6" fill="none" stroke="${colour}" stroke-width="1.5"/>`);
    o.push(`<text x="46" y="46" text-anchor="middle" font-family="${serif}" font-size="17" font-weight="700" fill="${colour}">${esc(BRAND.name.toUpperCase())}</text>`);
    o.push(`<text x="46" y="64" text-anchor="middle" font-family="${serif}" font-size="11" fill="${colour}">${cracked ? "cracked" : "intact"}</text>`);
  } else {
    o.push(`<text x="46" y="52" text-anchor="middle" font-family="${serif}" font-size="12" fill="${colour}">no claim</text>`);
  }
  if (cracked) {
    o.push(`<path d="M30 2 L42 24 L34 40 L52 58 L44 74 L58 92" fill="none" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/>`);
    o.push(`<path d="M30 2 L42 24 L34 40 L52 58 L44 74 L58 92" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>`);
  }
  o.push(`</g>`);
  const x = 118;
  o.push(`<text x="${x}" y="34" font-family="${sans}" font-size="12" fill="#555555">Loss bound certificate</text>`);
  o.push(`<text x="${x}" y="58" font-family="${sans}" font-size="18" font-weight="700" fill="${colour}">${esc(sealCaption(i.state))}</text>`);
  if (showBound && i.bound !== null) {
    o.push(`<text x="${x}" y="80" font-family="${sans}" font-size="13" fill="#222222">at most ${esc(i.bound)}${horizon !== null ? ` in ${esc(horizon)}` : ""}</text>`);
  } else if (blank) {
    o.push(`<text x="${x}" y="80" font-family="${sans}" font-size="13" fill="#555555">no bound is claimed</text>`);
  } else {
    o.push(`<text x="${x}" y="80" font-family="${sans}" font-size="13" fill="#555555">recompute before relying on it</text>`);
  }
  const foot: string[] = [];
  if (block !== null) foot.push(`as of block ${block}`);
  if (i.source === "RECORDED") foot.push("RECORDED");
  if (foot.length > 0) o.push(`<text x="${x}" y="102" font-family="${sans}" font-size="11" fill="#777777">${esc(foot.join(" | "))}</text>`);
  o.push(`</svg>`);
  return o.join("");
}
