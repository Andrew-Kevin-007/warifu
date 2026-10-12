// Text helpers: binary detection (INV-23), UTF-8 length, invoice-number normalization (K-04).
import { describe, expect, it } from "vitest";
import { ENCODED_RUN_LIMIT, binaryKind, normalizeInvoiceNumber, utf8ByteLength } from "../src/index";

describe("binaryKind", () => {
  it.each([
    ["plain invoice text\twith tabs\nand lines\r\n", null],
    ["Data: 2026-10-01 (Portuguese 'data' = date)", null],
    ["one replacement char � or two �� is still text", null],
    ["a".repeat(ENCODED_RUN_LIMIT - 1), null],
    ["https://invoice.example.com/i/acct_123/test_abc?x=1", null],
    ["nul\u0000byte", "NUL"],
    ["lone \uD800 surrogate", "LONE_SURROGATE"],
    ["bell\u0007", "CONTROL"],
    ["vertical\u000Btab", "CONTROL"],
    ["escape\u001b[0m", "CONTROL"],
    ["del\u007f", "CONTROL"],
    ["c1\u0085", "CONTROL"],
    ["mis-decoded ��� binary", "REPLACEMENT_RUN"],
    ["see data:application/pdf;base64,JVBERi0= here", "DATA_URI"],
    ["DATA:image/png,abc", "DATA_URI"],
    ["A".repeat(ENCODED_RUN_LIMIT), "ENCODED_RUN"],
    [`0x${"ab".repeat(300)}`, "ENCODED_RUN"],
  ])("%j -> %s", (s, kind) => {
    expect(binaryKind(s)).toBe(kind);
  });
});

describe("utf8ByteLength", () => {
  it("counts 1/2/3/4-byte code points", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("\uD800")).toBe(3);
    expect(utf8ByteLength("aé€😀")).toBe(10);
  });
});

describe("normalizeInvoiceNumber", () => {
  it.each([
    ["INV-0042", "INV0042"],
    ["inv 0042", "INV0042"],
    ["0042", "42"],
    ["000", ""],
    ["#12/34-a", "1234A"],
    ["ＩＮＶ－４２", "INV42"], // full-width
    ["straße-1", "STRASSE1"],
    ["Инв-7", "7"], // non-Latin letters do not survive (collapses more, fail closed for dedupe)
  ])("%j -> %j", (input, expected) => {
    expect(normalizeInvoiceNumber(input)).toBe(expected);
  });

  it("returns null when NFKC expansion exceeds 128 characters", () => {
    expect(normalizeInvoiceNumber("ﬃ".repeat(43))).toBeNull(); // 129 characters
    expect(normalizeInvoiceNumber("ﬃ".repeat(42))).toHaveLength(126);
  });
});
