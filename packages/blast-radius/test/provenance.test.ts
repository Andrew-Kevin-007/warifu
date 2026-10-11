// Provenance of results files: every guard has a positive control; a missing code hash is never a match.
import { describe, expect, it } from "vitest";
import { ProvenanceError, codeMatch, parseProvenance } from "../src/provenance";

const H = `0x${"ab".repeat(32)}`;
const good = {
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  gitDirty: false,
  seeds: [1, 2],
  modelIds: [] as string[],
  promptHashes: [] as string[],
  vaultRuntimeCodeHash: null as string | null,
  tools: { node: "v24.11.1" },
};
const with_ = (o: Record<string, unknown>): unknown => ({ ...good, ...o });

describe("parseProvenance", () => {
  it("accepts a closed-form result (no model, no vault)", () => {
    expect(parseProvenance(good).vaultRuntimeCodeHash).toBeNull();
  });
  it("accepts a simulator result with a code hash", () => {
    expect(parseProvenance(with_({ vaultRuntimeCodeHash: H })).vaultRuntimeCodeHash).toBe(H);
  });
  it("accepts an LLM result that names its model and prompts", () => {
    expect(() => parseProvenance(with_({ modelIds: ["claude-x"], promptHashes: [H] }))).not.toThrow();
  });

  const refused: readonly [string, unknown][] = [
    ["a short git sha", with_({ gitSha: "abc123" })],
    ["an uppercase git sha", with_({ gitSha: "0123456789ABCDEF0123456789ABCDEF01234567" })],
    ["a missing git sha", with_({ gitSha: undefined })],
    ["a non-integer seed", with_({ seeds: [1.5] })],
    ["a negative seed", with_({ seeds: [-1] })],
    ["a malformed code hash", with_({ vaultRuntimeCodeHash: "0x1234" })],
    ["a missing code hash field (must be explicit null)", with_({ vaultRuntimeCodeHash: undefined })],
    ["models without prompts", with_({ modelIds: ["m"] })],
    ["prompts without models", with_({ promptHashes: [H] })],
    ["a malformed prompt hash", with_({ modelIds: ["m"], promptHashes: ["deadbeef"] })],
    ["an unknown field", with_({ extra: true })],
    ["null", null],
  ];
  for (const [name, input] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => parseProvenance(input)).toThrow(ProvenanceError);
    });
  }
});

describe("codeMatch", () => {
  const withHash = parseProvenance(with_({ vaultRuntimeCodeHash: H }));
  it("MATCH only when both hashes exist and are equal (case-insensitive on the deployed side)", () => {
    expect(codeMatch(withHash, H)).toBe("MATCH");
    expect(codeMatch(withHash, H.toUpperCase().replace("0X", "0x"))).toBe("MATCH");
  });
  it("MISMATCH when they differ", () => {
    expect(codeMatch(withHash, `0x${"cd".repeat(32)}`)).toBe("MISMATCH");
  });
  it("a result without a code hash validates nothing", () => {
    expect(codeMatch(parseProvenance(good), H)).toBe("NOT_VALIDATED_FOR_THIS_DEPLOYMENT");
  });
  it("an unknown deployed hash validates nothing", () => {
    expect(codeMatch(withHash, null)).toBe("NOT_VALIDATED_FOR_THIS_DEPLOYMENT");
  });
});
