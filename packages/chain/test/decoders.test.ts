// Node-free decoder tests: logs are built with viem's topic/ABI encoders from the compiled ABI. These complement
// anvil.integration.test.ts (real node output) by covering every event in the ABI, including ones that suite does
// not emit (payee change, signer rotation, withdraw), and property-testing Released/Withdrawn.
import fc from "fast-check";
import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ChainError, MAX_UINT256, decodeVaultLog, decodeVaultLogs, money, symbolonVaultAbi, type RawLog, type VaultEvent } from "../src/index";
import { encodeVaultLog } from "./helpers/encode-log";

const VAULT = getAddress(`0x${"5a".repeat(20)}`);
const OTHER = getAddress(`0x${"6b".repeat(20)}`);
const A = getAddress(`0x${"a1".repeat(20)}`);
const B = getAddress(`0x${"b2".repeat(20)}`);
const C = getAddress(`0x${"c3".repeat(20)}`);
const H1: Hex = `0x${"11".repeat(32)}`;
const H2: Hex = `0x${"22".repeat(32)}`;
const H3: Hex = `0x${"33".repeat(32)}`;

function raw(eventName: string, args: Record<string, unknown>, over: Partial<RawLog> = {}): RawLog {
  const { topics, data } = encodeVaultLog(eventName, args);
  return { address: VAULT, topics, data, blockNumber: 10n, transactionHash: H3, logIndex: 0, removed: false, ...over };
}

const opts = { vault: VAULT, decimals: 6 };

const cases: { name: string; args: Record<string, unknown>; expected: VaultEvent }[] = [
  { name: "ConfigChanged", args: { configHash: H1 }, expected: { name: "ConfigChanged", configHash: H1 } },
  {
    name: "EngagementRegistered",
    args: { engagementId: H1, owner: A, payee: B, cap: 100_000_000n, start: 1_790_000_000n, end: 1_800_000_000n, termsHash: H2 },
    expected: { name: "EngagementRegistered", engagementId: H1, owner: A, payee: B, cap: money(100_000_000n, 6), start: 1_790_000_000n, end: 1_800_000_000n, termsHash: H2 },
  },
  { name: "EngagementClosed", args: { engagementId: H1 }, expected: { name: "EngagementClosed", engagementId: H1 } },
  {
    name: "Released",
    args: { intentId: H1, engagementId: H2, payee: B, amount: 12_345_678n, receiptHash: H3 },
    expected: { name: "Released", intentId: H1, engagementId: H2, payee: B, amount: money(12_345_678n, 6), receiptHash: H3 },
  },
  {
    name: "PayeeChangeProposed",
    args: { engagementId: H1, oldPayee: A, newPayee: B, eta: 1_790_172_800n },
    expected: { name: "PayeeChangeProposed", engagementId: H1, oldPayee: A, newPayee: B, eta: 1_790_172_800n },
  },
  { name: "PayeeChangeExecuted", args: { engagementId: H1, oldPayee: A, newPayee: B }, expected: { name: "PayeeChangeExecuted", engagementId: H1, oldPayee: A, newPayee: B } },
  { name: "VaultPaused", args: { by: C }, expected: { name: "VaultPaused", by: C } },
  { name: "VaultUnpaused", args: { by: C }, expected: { name: "VaultUnpaused", by: C } },
  { name: "KernelSignerProposed", args: { next: A, eta: 1_790_086_400n }, expected: { name: "KernelSignerProposed", next: A, eta: 1_790_086_400n } },
  { name: "KernelSignerRotated", args: { previous: A, next: B }, expected: { name: "KernelSignerRotated", previous: A, next: B } },
  { name: "GuardianChanged", args: { previous: A, next: B }, expected: { name: "GuardianChanged", previous: A, next: B } },
  { name: "Withdrawn", args: { to: A, amount: 7n }, expected: { name: "Withdrawn", to: A, amount: money(7n, 6) } },
  { name: "EIP712DomainChanged", args: {}, expected: { name: "EIP712DomainChanged" } },
];

function code(fn: () => unknown): string {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    if (e instanceof ChainError) return e.code;
    throw e;
  }
}

describe("every vault event decodes to its typed shape", () => {
  it("the table covers every event in the compiled ABI (a new event fails this until a decoder is added)", () => {
    const abiEvents = symbolonVaultAbi.filter((x) => x.type === "event").map((x) => x.name).sort();
    expect(cases.map((c) => c.name).sort()).toEqual(abiEvents);
  });

  it.each(cases)("$name", ({ name, args, expected }) => {
    const decoded = decodeVaultLog(raw(name, args), opts);
    expect(decoded.event).toEqual(expected);
    expect(decoded.meta).toEqual({ blockNumber: 10n, transactionHash: H3, logIndex: 0 });
  });

  it.each(cases)("$name: dropping or adding a topic is refused", ({ name, args }) => {
    const l = raw(name, args);
    if (l.topics.length > 1) expect(code(() => decodeVaultLog({ ...l, topics: l.topics.slice(0, -1) }, opts))).toBe("BAD_LOG");
    expect(code(() => decodeVaultLog({ ...l, topics: [...l.topics, H1] }, opts))).toBe("BAD_LOG");
  });

  it("selectors are the ABI's: VaultPaused, not the spec's Paused (QUESTIONS WP-07 item 3)", () => {
    expect(symbolonVaultAbi.some((x) => x.type === "event" && (x.name as string) === "Paused")).toBe(false);
    expect(code(() => decodeVaultLog(raw("VaultPaused", { by: C }), opts))).toBe("no-throw");
  });
});

describe("decodeVaultLogs", () => {
  it("decodes the vault's logs in order and ignores other contracts' logs by address only", () => {
    const logs = [
      raw("ConfigChanged", { configHash: H1 }, { logIndex: 0 }),
      raw("Withdrawn", { to: A, amount: 1n }, { address: OTHER, logIndex: 1 }), // look-alike from another contract: skipped
      raw("Released", { intentId: H1, engagementId: H2, payee: B, amount: 5n, receiptHash: H3 }, { logIndex: 2 }),
    ];
    expect(decodeVaultLogs(logs, opts).map((d) => [d.event.name, d.meta.logIndex])).toEqual([
      ["ConfigChanged", 0],
      ["Released", 2],
    ]);
  });

  it("is not lenient: one bad vault log fails the whole batch", () => {
    const logs = [raw("ConfigChanged", { configHash: H1 }), { ...raw("ConfigChanged", { configHash: H1 }), data: "0x01" as Hex }];
    expect(code(() => decodeVaultLogs(logs, opts))).toBe("BAD_LOG");
  });

  it("non-canonical encodings are refused: dirty address padding and trailing data bytes", () => {
    const l = raw("VaultPaused", { by: C });
    const dirty = `0xff${(l.topics[1] as string).slice(4)}` as Hex; // high byte of the padded address topic
    expect(code(() => decodeVaultLog({ ...l, topics: [l.topics[0] as Hex, dirty] }, opts))).toBe("BAD_LOG");
    const w = raw("Withdrawn", { to: A, amount: 1n });
    expect(code(() => decodeVaultLog({ ...w, data: `${w.data}00` as Hex }, opts))).toBe("BAD_LOG");
    expect(code(() => decodeVaultLog(l, opts))).toBe("no-throw"); // control
  });

  it("an unknown selector from the vault is UNKNOWN_EVENT, not skipped", () => {
    const l = raw("ConfigChanged", { configHash: H1 });
    expect(code(() => decodeVaultLogs([{ ...l, topics: [H2, H1] }], opts))).toBe("UNKNOWN_EVENT");
  });

  it("address comparison is case-insensitive but exact", () => {
    const l = raw("VaultPaused", { by: C });
    expect(code(() => decodeVaultLog({ ...l, address: VAULT.toLowerCase() as Address }, opts))).toBe("no-throw");
    expect(code(() => decodeVaultLog({ ...l, address: OTHER }, opts))).toBe("BAD_LOG");
    expect(code(() => decodeVaultLog(l, { vault: "0x1234" as Address, decimals: 6 }))).toBe("BAD_LOG");
  });
});

describe("decimals handling", () => {
  it("amounts take the verified decimals; invalid decimals are refused", () => {
    const l = raw("Released", { intentId: H1, engagementId: H2, payee: B, amount: 5n, receiptHash: H3 });
    expect(decodeVaultLog(l, { vault: VAULT, decimals: 18 }).event).toMatchObject({ amount: { units: 5n, decimals: 18 } });
    expect(code(() => decodeVaultLog(l, { vault: VAULT, decimals: 37 }))).toBe("INVALID_DECIMALS");
    expect(code(() => decodeVaultLog(l, { vault: VAULT, decimals: 6.5 }))).toBe("INVALID_DECIMALS");
  });
});

describe("properties (1,000 runs)", () => {
  const hex32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => `0x${Buffer.from(b).toString("hex")}` as Hex);
  const address = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => getAddress(`0x${Buffer.from(b).toString("hex")}`));
  const uint256 = fc.oneof(fc.bigInt({ min: 0n, max: MAX_UINT256 }), fc.constantFrom(0n, 1n, MAX_UINT256));

  it("decode(encode(Released)) returns the same fields for arbitrary values", () => {
    fc.assert(
      fc.property(hex32, hex32, address, uint256, hex32, fc.integer({ min: 0, max: 36 }), (intentId, engagementId, payee, amount, receiptHash, decimals) => {
        const ev = decodeVaultLog(raw("Released", { intentId, engagementId, payee, amount, receiptHash }), { vault: VAULT, decimals }).event;
        return ev.name === "Released" && ev.intentId === intentId && ev.engagementId === engagementId && ev.payee === payee && ev.amount.units === amount && ev.amount.decimals === decimals && ev.receiptHash === receiptHash;
      }),
      { numRuns: 1000 },
    );
  });

  it("flipping any single bit of the data word changes the decoded amount or is refused (never the same result)", () => {
    fc.assert(
      fc.property(uint256, fc.integer({ min: 0, max: 255 }), (amount, bit) => {
        const base = raw("Withdrawn", { to: A, amount });
        const original = decodeVaultLog(base, opts).event;
        const word = BigInt(base.data) ^ (1n << BigInt(bit));
        const tampered = { ...base, data: `0x${word.toString(16).padStart(64, "0")}` as Hex };
        try {
          return JSON.stringify(decodeVaultLog(tampered, opts).event, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) !==
            JSON.stringify(original, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
        } catch (e) {
          return e instanceof ChainError;
        }
      }),
      { numRuns: 1000 },
    );
  });
});
