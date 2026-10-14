// Structural guards for the approval screen (INV-20) that unit tests on the packages cannot see.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("../src/wallet/ApprovalPanel.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/intents/[id]/page.tsx", import.meta.url), "utf8");

describe("approval screen structure", () => {
  it("disables Sign unless checkWysiwys passed", () => {
    expect(panel).toMatch(/checkWysiwys\(model\.value, view/);
    expect(panel).toMatch(/const canSign = wysiwys\.ok &&/);
  });
  it("renders the model it checked, and shows raw typed data and its hash", () => {
    expect(panel).toContain("renderModel(view)");
    expect(panel).toContain("typedDataHash");
    expect(panel).toContain("JSON.stringify(v.typedData");
  });
  it("never shows model prose inside the approval panel (INV-20)", () => {
    expect(panel).not.toMatch(/advisory/i);
  });
  it("places the advisory note in its own section after the approval section, collapsed via AdvisoryNote", () => {
    expect(page.indexOf("<ApprovalPanel")).toBeGreaterThan(-1);
    expect(page.indexOf("<AdvisoryNote")).toBeGreaterThan(page.indexOf("<ApprovalPanel"));
  });
  it("has no bulk approve path", () => {
    expect(panel).not.toMatch(/approveAll|bulk|selectAll/i);
  });
  it("uses no HTML sink", () => {
    for (const src of [panel, page]) expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});
