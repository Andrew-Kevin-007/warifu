// Deterministic reader for payment-terms language ("2/10 net 30", "net 45", "pay within 10 days for 2% off", ...).
//
// Used only as a cross-check on the model's `statedTerms` (docs/03 §3). What the INVOICE claims is compared with
// the signed engagement terms by the kernel and NEVER adopted (INV-19), so a miss here costs a missed
// TERMS_MISMATCH escalation but can never change `amountDue`. Integer math only (basis points from decimal
// text, no floats). Patterns are applied to the normalized text as-is, so `raw` is always a verbatim substring.

export interface ParsedTerms {
  readonly found: boolean;
  /** Verbatim substring of the document (<= 256 chars) or null. */
  readonly raw: string | null;
  readonly netDays: number | null;
  readonly earlyPay: { readonly discountBps: number; readonly withinDays: number } | null;
  /** Conflicting, business-day, "today"-style or otherwise unclear language. */
  readonly ambiguous: boolean;
}

const PCT = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;
const DAYS_WORD = String.raw`(?:calendar\s+|business\s+|working\s+)?(?:days?|tage[n]?|jours?|d[ií]as|giorni)`;
const DISCOUNT_WORD = String.raw`(?:early[- ]pay(?:ment)?\s+)?(?:discount|off|skonto|rabatt|escompte|descuento|reduction)`;

interface Hit {
  readonly start: number;
  readonly end: number;
  readonly netDays?: number;
  readonly earlyPay?: { discountBps: number; withinDays: number };
  readonly ambiguous?: boolean;
}

/** "2" -> 200, "1.5" / "1,5" -> 150, "0.25" -> 25. null when out of range. */
export function percentToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const whole = Number.parseInt(m[1] ?? "0", 10);
  const frac = (m[2] ?? "").padEnd(2, "0");
  const bps = whole * 100 + Number.parseInt(frac === "" ? "0" : frac, 10);
  return bps <= 10_000 ? bps : null;
}

function int(s: string | undefined): number | null {
  if (s === undefined || !/^\d{1,3}$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

function scan(text: string): Hit[] {
  const hits: Hit[] = [];
  const push = (m: RegExpExecArray, h: Omit<Hit, "start" | "end">) => hits.push({ start: m.index, end: m.index + m[0].length, ...h });

  // Compact: "2/10 net 30", "2%/10 n/30", "1.5/15, net 45"
  for (const m of text.matchAll(new RegExp(String.raw`\b${PCT}\s*%?\s*\/\s*(\d{1,3})\s*[,;]?\s*(?:net|n)\s*[\/ ]?\s*(\d{1,3})\b`, "gi"))) {
    const bps = percentToBps(m[1] ?? "");
    const within = int(m[2]);
    const net = int(m[3]);
    if (bps === null || within === null || net === null) {
      push(m as RegExpExecArray, { ambiguous: true });
    } else {
      push(m as RegExpExecArray, { netDays: net, earlyPay: { discountBps: bps, withinDays: within } });
    }
  }
  // "pay within 10 days and get 2% off", "payment within 10 days for a 2% discount"
  for (const m of text.matchAll(
    new RegExp(String.raw`\b(?:pay(?:ment)?|paid|settle(?:d|ment)?|zahlung|paiement)\b[^.\n]{0,40}?\b(?:within|innerhalb\s+von|sous)\s*(\d{1,3})\s*${DAYS_WORD}[^.\n]{0,40}?${PCT}\s*%\s*${DISCOUNT_WORD}`, "gi"),
  )) {
    const within = int(m[1]);
    const bps = percentToBps(m[2] ?? "");
    push(m as RegExpExecArray, within !== null && bps !== null ? { earlyPay: { discountBps: bps, withinDays: within }, ambiguous: /business|working/i.test(m[0]) } : { ambiguous: true });
  }
  // "2% discount if paid within 10 days", "2 % Skonto bei Zahlung innerhalb von 10 Tagen"
  for (const m of text.matchAll(
    new RegExp(String.raw`\b${PCT}\s*%\s*${DISCOUNT_WORD}[^.\n]{0,60}?\b(?:within|in|innerhalb\s+von|sous)\s*(\d{1,3})\s*${DAYS_WORD}`, "gi"),
  )) {
    const bps = percentToBps(m[1] ?? "");
    const within = int(m[2]);
    push(m as RegExpExecArray, bps !== null && within !== null ? { earlyPay: { discountBps: bps, withinDays: within }, ambiguous: /business|working/i.test(m[0]) } : { ambiguous: true });
  }
  // "pay today for 8% off": an urgency-style claim with no real window.
  for (const m of text.matchAll(new RegExp(String.raw`\bpay\s+(?:today|now|immediately)\b[^.\n]{0,40}?${PCT}\s*%\s*(?:off|discount)`, "gi"))) {
    const bps = percentToBps(m[1] ?? "");
    push(m as RegExpExecArray, bps !== null ? { earlyPay: { discountBps: bps, withinDays: 0 }, ambiguous: true } : { ambiguous: true });
  }
  // Net terms: "net 30", "Net30 days"
  for (const m of text.matchAll(/\bnet\s*(\d{1,3})(?!\d|[.,]\d)(?:\s*days?)?/gi)) {
    const net = int(m[1]);
    push(m as RegExpExecArray, net !== null ? { netDays: net } : { ambiguous: true });
  }
  // "due within 30 days", "payable in 30 calendar days", "payment due in 30 business days"
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:payment\s+)?(?:due|payable|to\s+be\s+paid)\s+(?:in|within)\s+(\d{1,3})\s*${DAYS_WORD}`, "gi"))) {
    const net = int(m[1]);
    push(m as RegExpExecArray, net !== null ? { netDays: net, ambiguous: /business|working/i.test(m[0]) } : { ambiguous: true });
  }
  // "due on receipt", "payable immediately"
  for (const m of text.matchAll(/\b(?:due|payable)\s+(?:on|upon)\s+receipt\b|\bpayable\s+immediately\b/gi)) {
    push(m as RegExpExecArray, { netDays: 0 });
  }
  // German / French / Spanish: "Zahlungsziel: 30 Tage netto", "paiement sous 30 jours", "pago a 30 días"
  for (const m of text.matchAll(
    new RegExp(String.raw`\b(?:zahlungsziel|zahlbar|zahlungsfrist|zahlung|paiement|d[ée]lai\s+de\s+paiement|pago)\b[^.\n]{0,30}?(\d{1,3})\s*(?:tage[n]?|jours?|d[ií]as)(?:\s+(?:netto|net|neto))?`, "gi"),
  )) {
    const net = int(m[1]);
    // Skip when this is the "within N days" half of a discount sentence; those are caught above.
    if (/skonto|rabatt|escompte|descuento/i.test(text.slice(m.index, m.index + m[0].length + 40))) continue;
    push(m as RegExpExecArray, net !== null ? { netDays: net } : { ambiguous: true });
  }
  return hits;
}

/** Remove hits whose span lies inside an earlier, longer hit (e.g. the "net 30" inside "2/10 net 30"). */
function dropContained(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Hit[] = [];
  for (const h of sorted) {
    if (out.some((o) => h.start >= o.start && h.end <= o.end)) continue;
    out.push(h);
  }
  return out;
}

export function parseStatedTerms(normalizedText: string): ParsedTerms {
  const hits = dropContained(scan(normalizedText));
  if (hits.length === 0) return { found: false, raw: null, netDays: null, earlyPay: null, ambiguous: false };

  const nets = new Set<number>();
  const earlies = new Map<string, { discountBps: number; withinDays: number }>();
  let ambiguous = false;
  for (const h of hits) {
    if (h.ambiguous === true) ambiguous = true;
    if (h.netDays !== undefined) nets.add(h.netDays);
    if (h.earlyPay !== undefined) earlies.set(`${h.earlyPay.discountBps}/${h.earlyPay.withinDays}`, h.earlyPay);
  }
  if (nets.size > 1 || earlies.size > 1) ambiguous = true;

  const netDays = nets.size === 1 ? ([...nets][0] ?? null) : null;
  const earlyPay = earlies.size === 1 ? ([...earlies.values()][0] ?? null) : null;
  if (earlyPay !== null && netDays !== null && earlyPay.withinDays >= netDays) ambiguous = true;

  const first = hits[0];
  const last = hits[hits.length - 1];
  if (first === undefined || last === undefined) return { found: false, raw: null, netDays: null, earlyPay: null, ambiguous: false };
  let raw = normalizedText.slice(first.start, last.end);
  if (raw.length > 256) {
    raw = normalizedText.slice(first.start, first.end).slice(0, 256);
    ambiguous = true;
  }
  return { found: true, raw, netDays, earlyPay, ambiguous };
}
