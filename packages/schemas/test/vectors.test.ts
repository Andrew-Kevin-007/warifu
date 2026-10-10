// The committed vectors are (1) exactly what this package computes today and (2) reproduced by an independent
// implementation (scripts/xcheck-vectors.mjs: ethers + canonicalize, no import from src/).
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VECTOR_FILES, buildJsonSchemaFiles, buildVectors, serializeGenerated } from "../scripts/build-vectors";

const VECTORS_DIR = new URL("../vectors/", import.meta.url);
const JSON_SCHEMA_DIR = new URL("../json-schema/", import.meta.url);
const XCHECK = fileURLToPath(new URL("../scripts/xcheck-vectors.mjs", import.meta.url));
const REGENERATE = "stale: run `pnpm --filter @symbolon/schemas vectors` and review the diff";

const readText = (dir: URL, name: string) => readFileSync(new URL(name, dir), "utf8");
const committed = () => Object.fromEntries(VECTOR_FILES.map((f) => [f, JSON.parse(readText(VECTORS_DIR, f)) as unknown]));

function xcheck(arg: string, input?: string) {
  const r = spawnSync(process.execPath, [XCHECK, arg], { encoding: "utf8", ...(input === undefined ? {} : { input }) });
  expect(r.error).toBeUndefined();
  return { status: r.status, report: JSON.parse(r.stdout) as { ok: boolean; counts: Record<string, number>; failures: Array<{ name: string }> } };
}

describe("committed files are fresh", () => {
  const built = buildVectors();
  it.each(VECTOR_FILES)("vectors/%s", (f) => {
    expect(readText(VECTORS_DIR, f), REGENERATE).toBe(serializeGenerated(built[f]));
  });

  it("json-schema/*.schema.json", () => {
    const files = buildJsonSchemaFiles();
    expect(readdirSync(JSON_SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort(), REGENERATE).toEqual(Object.keys(files).sort());
    for (const [name, value] of Object.entries(files)) expect(readText(JSON_SCHEMA_DIR, name), `${name} ${REGENERATE}`).toBe(serializeGenerated(value));
  });
});

describe("independent second implementation (ethers + canonicalize)", () => {
  it("reproduces every vector", () => {
    const { status, report } = xcheck(fileURLToPath(VECTORS_DIR));
    expect(report.failures).toEqual([]);
    expect(status).toBe(0);
    for (const cat of ["jcs", "jcsErrors", "hashes", "eip712", "approval", "lbc", "normalize", "money"]) {
      expect(report.counts[cat] ?? 0, cat).toBeGreaterThan(0);
    }
  });

  type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form tampering of parsed JSON
  const tamperings: Array<[string, (v: Mutable) => void, RegExp]> = [
    ["an EIP-712 digest", (v) => (v["eip712.json"].cases[0].digest = `0x${"00".repeat(32)}`), /digest/],
    ["a struct field order", (v) => v["eip712.json"].cases[2].typedData.types.OwnerApproval.reverse(), /encodeType|typeHash|structHash/],
    ["a JCS canonical text", (v) => (v["jcs.json"].cases[0].canonical += " "), /canonical/],
    ["a signed engagement term", (v) => (v["hashes.json"].cases[0].input.paymentTerms.netDays = 31), /termsHash\/with-earlyPay/],
    ["the certificate bounds", (v) => (v["lbc.json"].certificate.bounds.T2.loss = "1"), /certHash/],
    ["the approval amount", (v) => (v["approval.json"].view.typedData.message.amount = "1500000000"), /digest|typedData|amount/],
    ["a normalize count", (v) => (v["untrusted.json"].normalize[3].counts.zeroWidth = 3), /zero-width/],
    ["a display amount", (v) => (v["money.json"].cases[4].expected = "1,470.01"), /value/],
  ];

  it.each(tamperings)("detects tampering with %s", (_name, mutate, failureName) => {
    const v = committed() as Mutable;
    mutate(v);
    const { status, report } = xcheck("-", JSON.stringify(v));
    expect(status).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.name).join("\n")).toMatch(failureName);
  });

  it("accepts a milestone status change (status is outside termsHash)", () => {
    const v = committed() as Mutable;
    v["hashes.json"].cases[0].input.milestones[0].status = "PAID";
    expect(xcheck("-", JSON.stringify(v)).status).toBe(0);
  });
});
