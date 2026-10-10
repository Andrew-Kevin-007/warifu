import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM scripts without types
import { COLUMNS, parseCsv, validateTracker } from "../scripts/pilot-tracker-check.mjs";
// @ts-expect-error plain ESM scripts without types
import { lintText } from "../scripts/claims-lint.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const HEADER = COLUMNS.join(",");
const WALLET = "0x" + "ab".repeat(20);
const row = (o: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    pilot_id: "P-001", name_handle: "someone", segment: "S2", channel: "discord", first_contact_at: "2026-10-11",
    stage: "CONTACTED", network: "", owner_wallet: "", payees_count: "0", engagements_created: "0",
    invoices_processed: "0", real_payments: "0", value_base_units: "0", last_event_at: "", consent_publish: "N",
    testimonial: "N", notes: "", ...o,
  };
  return COLUMNS.map((c: string) => base[c]).join(",");
};
const check = (...rows: string[]) => validateTracker([HEADER, ...rows].join("\n") + "\n");

describe("pilot tracker validator (docs/09 §7, §9)", () => {
  it("the committed tracker is valid and holds no invented rows", () => {
    const text = read("docs/pilots/pilot_tracker.csv");
    expect(validateTracker(text)).toEqual([]);
    expect(parseCsv(text)).toHaveLength(1); // header only
  });
  it("accepts a consistent onboarded testnet pilot", () => {
    expect(check(row({ stage: "FIRST_RELEASE", network: "testnet", owner_wallet: WALLET, invoices_processed: "1", real_payments: "1", value_base_units: "25000000" }))).toEqual([]);
  });
  it("rejects a wrong header and an empty file", () => {
    expect(validateTracker("a,b\n")[0]).toMatch(/header must be exactly/);
    expect(validateTracker("")[0]).toMatch(/empty/);
  });
  it.each([
    ["bad stage", { stage: "WON" }, /stage must be/],
    ["bad segment", { segment: "S9" }, /segment must be/],
    ["bad date", { first_contact_at: "yesterday" }, /first_contact_at/],
    ["blended network", { network: "both" }, /network must be/],
    ["bad wallet", { stage: "ONBOARDED", owner_wallet: "0x123" }, /owner_wallet must be/],
    ["onboarded without wallet", { stage: "ONBOARDED" }, /owner_wallet is required/],
    ["decimal value", { value_base_units: "25.5" }, /base units/],
    ["negative count", { payees_count: "-1" }, /payees_count/],
    ["release without payment", { stage: "FIRST_RELEASE", owner_wallet: WALLET, invoices_processed: "1" }, /real_payments >= 1/],
    ["first invoice without invoice", { stage: "FIRST_INVOICE", owner_wallet: WALLET }, /invoices_processed >= 1/],
    ["repeat with one payment", { stage: "REPEAT", network: "testnet", owner_wallet: WALLET, invoices_processed: "1", real_payments: "1" }, /REPEAT needs/],
    ["value without network", { value_base_units: "5" }, /need a network/],
    ["internal counted as real", { network: "testnet", real_payments: "1", notes: "internal test" }, /internal flows/],
    ["quote without consent", { testimonial: "Y: great" }, /consent_publish=Y/],
    ["challenge participant onboarded", { segment: "S6", stage: "ONBOARDED", owner_wallet: WALLET }, /S6/],
  ])("rejects %s", (_l, over, re) => {
    expect(check(row(over as Record<string, string>)).join("\n")).toMatch(re as RegExp);
  });
  it("rejects duplicate ids and wrong field counts", () => {
    expect(check(row(), row()).join("\n")).toMatch(/duplicate pilot_id/);
    expect(check("P-002,only,three").join("\n")).toMatch(/expected 17 fields/);
  });
  it("parses quoted fields with commas and newlines", () => {
    expect(check(row({ notes: '"said ""maybe"", then\nreplied"' }))).toEqual([]);
  });
});

describe("pilot kit docs (DEC-012 wording, spec coverage)", () => {
  const files = ["docs/PILOT_KIT.md", "docs/PILOT_TERMS.md", "docs/pilots/README.md"];
  it.each(files)("%s passes the claims lint", (f) => {
    expect(lintText(read(f))).toEqual([]);
  });
  it("terms cover every item required by docs/09 §6", () => {
    const t = read("docs/PILOT_TERMS.md").toLowerCase();
    for (const k of ["no warranty", "you keep custody", "caps", "pause", "withdraw", "testnet", "mainnet", "delete", "anonymized", "not financial", "contact"]) {
      expect(t, k).toContain(k);
    }
  });
  it("kit carries the send gate, the hand-written first line rule and the INV-17 rule", () => {
    const k = read("docs/PILOT_KIT.md");
    expect(k).toMatch(/Kevin has approved the style/);
    expect(k).toMatch(/Hand-write line 1/);
    expect(k).toMatch(/prospects, not customers/);
    expect(k).toMatch(/never blended/);
  });
  it("kit and terms contain no typed traction numbers, only placeholders", () => {
    const k = read("docs/PILOT_KIT.md");
    expect(k).not.toMatch(/\b\d+\s+(?:businesses|real payments|pilots onboarded)\b/i);
  });
});
