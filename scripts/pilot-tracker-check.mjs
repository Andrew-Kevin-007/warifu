#!/usr/bin/env node
// WP-27: validates docs/pilots/pilot_tracker.csv against docs/pilots/README.md (spec: docs/09 §7, §9).
//   node scripts/pilot-tracker-check.mjs [file.csv]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COLUMNS = [
  "pilot_id", "name_handle", "segment", "channel", "first_contact_at", "stage", "network", "owner_wallet",
  "payees_count", "engagements_created", "invoices_processed", "real_payments", "value_base_units",
  "last_event_at", "consent_publish", "testimonial", "notes",
];
export const STAGES = ["CONTACTED", "REPLIED", "CALL_SCHEDULED", "ONBOARDED", "FIRST_INVOICE", "FIRST_RELEASE", "REPEAT"];
const SEGMENTS = ["S1", "S2", "S3", "S4", "S5", "S6"];
const COUNTS = ["payees_count", "engagements_created", "invoices_processed", "real_payments"];
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Minimal RFC-4180 parser (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const s = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const isCount = (v) => /^\d+$/.test(v);

/** @returns {string[]} human-readable problems; empty means valid */
export function validateTracker(text) {
  const rows = parseCsv(text);
  const problems = [];
  if (!rows.length) return ["file is empty (the header row is required)"];
  const [header, ...data] = rows;
  if (header.join(",") !== COLUMNS.join(",")) return [`header must be exactly: ${COLUMNS.join(",")}`];
  const seen = new Set();
  data.forEach((r, idx) => {
    const line = idx + 2;
    const bad = (m) => problems.push(`line ${line}: ${m}`);
    if (r.length !== COLUMNS.length) return bad(`expected ${COLUMNS.length} fields, got ${r.length}`);
    const o = Object.fromEntries(COLUMNS.map((c, i) => [c, r[i].trim()]));
    if (!o.pilot_id) bad("pilot_id is empty");
    else if (seen.has(o.pilot_id)) bad(`duplicate pilot_id ${o.pilot_id}`);
    seen.add(o.pilot_id);
    if (!SEGMENTS.includes(o.segment)) bad(`segment must be one of ${SEGMENTS.join(",")}`);
    if (!STAGES.includes(o.stage)) bad(`stage must be one of ${STAGES.join(",")}`);
    if (!ISO.test(o.first_contact_at)) bad("first_contact_at must be an ISO-8601 date or datetime");
    if (o.last_event_at && !ISO.test(o.last_event_at)) bad("last_event_at must be an ISO-8601 date or datetime");
    if (!["", "testnet", "mainnet"].includes(o.network)) bad("network must be testnet, mainnet or empty (never blended)");
    if (o.owner_wallet && !/^0x[0-9a-fA-F]{40}$/.test(o.owner_wallet)) bad("owner_wallet must be 0x + 40 hex characters");
    for (const c of COUNTS) if (!isCount(o[c])) bad(`${c} must be a non-negative integer`);
    if (!isCount(o.value_base_units)) bad("value_base_units must be a non-negative integer in base units (no decimals)");
    if (!["Y", "N"].includes(o.consent_publish)) bad("consent_publish must be Y or N");
    if (o.testimonial !== "N" && !/^Y: \S/.test(o.testimonial)) bad('testimonial must be "N" or "Y: <quote>"');
    if (o.testimonial.startsWith("Y") && o.consent_publish !== "Y") bad("a testimonial needs consent_publish=Y");

    const stageIdx = STAGES.indexOf(o.stage);
    const n = (c) => (isCount(o[c]) ? BigInt(o[c]) : 0n);
    if (stageIdx >= STAGES.indexOf("ONBOARDED") && !o.owner_wallet) bad("owner_wallet is required from ONBOARDED onward");
    if (stageIdx >= STAGES.indexOf("FIRST_INVOICE") && n("invoices_processed") < 1n) bad("FIRST_INVOICE or later needs invoices_processed >= 1");
    if (stageIdx >= STAGES.indexOf("FIRST_RELEASE") && n("real_payments") < 1n) bad("FIRST_RELEASE or later needs real_payments >= 1");
    if (o.stage === "REPEAT" && n("real_payments") < 2n) bad("REPEAT needs real_payments >= 2");
    if ((n("real_payments") > 0n || n("value_base_units") > 0n) && !o.network) bad("payments or value need a network (testnet and mainnet are never blended)");
    if (/\binternal\b/i.test(o.notes) && n("real_payments") > 0n) bad("internal flows are never real payments (docs/09 §2)");
    if (o.segment === "S6" && stageIdx >= STAGES.indexOf("ONBOARDED")) bad("S6 (challenge) is prospects only; re-segment once a real engagement exists");
  });
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(process.argv[2] ?? "docs/pilots/pilot_tracker.csv");
  const problems = validateTracker(readFileSync(file, "utf8"));
  if (problems.length) {
    console.error(`pilot-tracker-check: ${problems.length} problem(s) in ${file}`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("pilot-tracker-check: OK");
}
