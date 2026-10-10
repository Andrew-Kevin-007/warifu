import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AddressSchema,
  AmountSchema,
  Hex32Schema,
  HexBytesSchema,
  ISODateSchema,
  ISODateTimeSchema,
  MAX_UINT256,
  MAX_UINT64,
  PositiveAmountSchema,
  SignedBaseUnitsSchema,
  Uint256StringSchema,
  Uint64StringSchema,
  UUIDSchema,
  epochSecondsFromIso,
  isChecksumAddress,
  isoFromEpochSeconds,
  text,
} from "../src/index";

const MAX_EPOCH = 253402300799; // 9999-12-31T23:59:59Z

describe("addresses (EIP-55, K-01)", () => {
  // Valid checksummed examples from the EIP-55 specification.
  const eip55 = [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];
  it.each(eip55)("accepts %s", (a) => {
    expect(AddressSchema.safeParse(a).success).toBe(true);
  });

  it("rejects a wrong-case (non-checksummed) spelling of a mixed-case address", () => {
    expect(isChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
    expect(isChecksumAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED")).toBe(false);
    expect(isChecksumAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe(false);
  });

  it("rejects wrong lengths and missing prefix", () => {
    for (const a of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA", "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "", "0x"]) {
      expect(AddressSchema.safeParse(a).success).toBe(false);
    }
  });
});

describe("hex", () => {
  it("Hex32 is lowercase, 0x-prefixed, 32 bytes", () => {
    expect(Hex32Schema.safeParse(`0x${"ab".repeat(32)}`).success).toBe(true);
    expect(Hex32Schema.safeParse(`0x${"AB".repeat(32)}`).success).toBe(false);
    expect(Hex32Schema.safeParse(`0x${"ab".repeat(31)}`).success).toBe(false);
    expect(Hex32Schema.safeParse("ab".repeat(32)).success).toBe(false);
  });

  it("HexBytes are whole lowercase bytes up to 4 KiB", () => {
    expect(HexBytesSchema.safeParse("0x").success).toBe(true);
    expect(HexBytesSchema.safeParse(`0x${"00".repeat(4096)}`).success).toBe(true);
    expect(HexBytesSchema.safeParse(`0x${"00".repeat(4097)}`).success).toBe(false);
    expect(HexBytesSchema.safeParse("0xabc").success).toBe(false);
  });
});

describe("integer strings", () => {
  it("uint256 / uint64 bounds are exact", () => {
    expect(Uint256StringSchema.safeParse(MAX_UINT256.toString()).success).toBe(true);
    expect(Uint256StringSchema.safeParse((MAX_UINT256 + 1n).toString()).success).toBe(false);
    expect(Uint64StringSchema.safeParse(MAX_UINT64.toString()).success).toBe(true);
    expect(Uint64StringSchema.safeParse((MAX_UINT64 + 1n).toString()).success).toBe(false);
  });

  it("one value has one spelling: no leading zeros, signs, spaces or decimals", () => {
    for (const s of ["01", "+1", "-1", " 1", "1 ", "1.0", "1e3", "0x10", ""]) {
      expect(Uint256StringSchema.safeParse(s).success, s).toBe(false);
      expect(AmountSchema.safeParse(s).success, s).toBe(false);
    }
    expect(SignedBaseUnitsSchema.safeParse("-0").success).toBe(false);
    expect(SignedBaseUnitsSchema.safeParse("-5").success).toBe(true);
  });

  it("K-01 amount is at most 30 digits; positive amounts exclude 0", () => {
    expect(AmountSchema.safeParse("9".repeat(30)).success).toBe(true);
    expect(AmountSchema.safeParse("9".repeat(31)).success).toBe(false);
    expect(PositiveAmountSchema.safeParse("0").success).toBe(false);
    expect(PositiveAmountSchema.safeParse("1").success).toBe(true);
  });
});

describe("time: pure calendar math (no Date in src)", () => {
  it("known instants", () => {
    expect(epochSecondsFromIso("1970-01-01T00:00:00Z")).toBe(0n);
    expect(epochSecondsFromIso("2000-01-01T00:00:00Z")).toBe(946684800n);
    expect(epochSecondsFromIso("2026-10-05T00:00:00Z")).toBe(1791158400n);
    expect(epochSecondsFromIso("9999-12-31T23:59:59Z")).toBe(BigInt(MAX_EPOCH));
    expect(isoFromEpochSeconds(0n)).toBe("1970-01-01T00:00:00Z");
    expect(isoFromEpochSeconds(951782400n)).toBe("2000-02-29T00:00:00Z");
  });

  it("agrees with Date (test-side oracle) and round-trips over the whole range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_EPOCH }), (s) => {
        const iso = isoFromEpochSeconds(BigInt(s));
        expect(iso).toBe(new Date(s * 1000).toISOString().replace(".000Z", "Z"));
        expect(epochSecondsFromIso(iso)).toBe(BigInt(s));
      }),
      { numRuns: 2000 },
    );
  });

  it("rejects non-canonical or impossible date-times", () => {
    for (const s of [
      "2023-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-10-05T24:00:00Z",
      "2026-10-05T23:60:00Z",
      "2026-10-05T23:59:60Z",
      "2026-10-05T10:15:00.000Z",
      "2026-10-05T10:15:00+00:00",
      "2026-10-05 10:15:00Z",
      "1969-12-31T23:59:59Z",
      "2026-10-05t10:15:00z",
    ]) {
      expect(ISODateTimeSchema.safeParse(s).success, s).toBe(false);
    }
    expect(ISODateTimeSchema.safeParse("2024-02-29T23:59:59Z").success).toBe(true);
    expect(ISODateTimeSchema.safeParse("2000-02-29T00:00:00Z").success).toBe(true);
    expect(() => epochSecondsFromIso("2023-02-29T00:00:00Z")).toThrow(RangeError);
    expect(() => isoFromEpochSeconds(-1n)).toThrow(RangeError);
    expect(() => isoFromEpochSeconds(BigInt(MAX_EPOCH) + 1n)).toThrow(RangeError);
  });

  it("ISODate validates the calendar", () => {
    expect(ISODateSchema.safeParse("2026-11-04").success).toBe(true);
    expect(ISODateSchema.safeParse("2026-11-31").success).toBe(false);
    expect(ISODateSchema.safeParse("2026-1-04").success).toBe(false);
  });
});

describe("ids and text", () => {
  it("UUID: lowercase RFC 9562", () => {
    expect(UUIDSchema.safeParse("7c9e6679-7425-40de-944b-e07fc1f90ae7").success).toBe(true);
    expect(UUIDSchema.safeParse("7C9E6679-7425-40DE-944B-E07FC1F90AE7").success).toBe(false);
    expect(UUIDSchema.safeParse("7c9e6679-7425-00de-944b-e07fc1f90ae7").success).toBe(false);
  });

  it("text(max) bounds length and refuses lone surrogates", () => {
    expect(text(3).safeParse("abc").success).toBe(true);
    expect(text(3).safeParse("abcd").success).toBe(false);
    expect(text(10).safeParse(`a${String.fromCharCode(0xd800)}`).success).toBe(false);
  });
});
