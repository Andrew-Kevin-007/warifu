// IP parsing and classification (docs/04 K-09, RT-02): every spelling of a private/loopback/metadata address must parse to the
// same numeric value as its dotted form, and every non-global block must classify as non-global. Pure; no network.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyAddress, classifyHostLiteral, classifyIPv4, parseIPv4Legacy, parseIPv4Strict, parseIPv6 } from "../../src/evidence/ssrf/ip";

const v4 = (s: string): number => parseIPv4Strict(s) as number;

describe("IPv4 legacy spellings all collapse to one value", () => {
  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["0X7F000001", "127.0.0.1"],
    ["017700000001", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["127.0.1", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0177.0.0.01", "127.0.0.1"],
    ["0x7f.0x0.0x0.0x1", "127.0.0.1"],
    ["0xa9fea9fe", "169.254.169.254"],
    ["2852039166", "169.254.169.254"],
    ["0251.0376.0251.0376", "169.254.169.254"],
    ["0", "0.0.0.0"],
    ["0x", "0.0.0.0"],
    ["4294967295", "255.255.255.255"],
    ["10.1", "10.0.0.1"],
  ])("%s means %s", (spelling, dotted) => {
    expect(parseIPv4Legacy(spelling)).toBe(v4(dotted));
  });

  it.each(["", ".", "1.2.3.4.5", "256.0.0.1", "1.2.3.256", "4294967296", "0x100000000", "09", "0xg", "1..2", "-1", "1.2.3.", " 1.2.3.4", "1.2.3.4 ", "0b11"])("rejects %j", (s) => {
    expect(parseIPv4Legacy(s)).toBeNull();
  });

  it("strict dotted-decimal refuses leading zeros and short forms", () => {
    for (const s of ["01.2.3.4", "1.2.3", "1.2.3.4.5", "1.2.3.04", "256.1.1.1", "1.2.3.4a"]) expect(parseIPv4Strict(s)).toBeNull();
  });

  it("property: every numeric spelling of an address classifies exactly like its dotted form", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
        const hex = `0x${n.toString(16)}`;
        const dec = String(n);
        const oct = `0${n.toString(8)}`;
        const want = classifyIPv4(n);
        for (const spelling of [dotted, hex, dec, oct]) {
          expect(parseIPv4Legacy(spelling)).toBe(n);
          const verdict = classifyHostLiteral(spelling);
          expect(verdict.kind === "ip" && verdict.global).toBe(want.global);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("IPv4 classification", () => {
  it.each([
    ["0.0.0.0", "this-network"],
    ["0.255.255.255", "this-network"],
    ["10.0.0.0", "rfc1918"],
    ["10.255.255.255", "rfc1918"],
    ["100.64.0.0", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local"],
    ["169.254.0.1", "link-local"],
    ["172.16.0.0", "rfc1918"],
    ["172.31.255.255", "rfc1918"],
    ["192.0.0.1", "ietf-protocol"],
    ["192.0.2.7", "documentation"],
    ["192.88.99.1", "6to4-relay"],
    ["192.168.0.1", "rfc1918"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
  ])("%s is non-global (%s)", (addr, reason) => {
    const c = classifyIPv4(v4(addr));
    expect(c.global).toBe(false);
    expect(c.reason).toBe(reason);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "169.253.255.255", "169.255.0.0", "192.0.1.1", "198.17.255.255", "198.20.0.0", "223.255.255.255"])("%s is global", (addr) => {
    expect(classifyIPv4(v4(addr)).global).toBe(true);
  });
});

describe("IPv6 parsing", () => {
  it("parses compressed, full, mixed and embedded-IPv4 forms to the same value", () => {
    expect(parseIPv6("::1")).toBe(1n);
    expect(parseIPv6("0:0:0:0:0:0:0:1")).toBe(1n);
    expect(parseIPv6("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(1n);
    expect(parseIPv6("::")).toBe(0n);
    expect(parseIPv6("::ffff:127.0.0.1")).toBe(parseIPv6("::ffff:7f00:1"));
    expect(parseIPv6("2001:db8::1")).toBe(parseIPv6("2001:0db8:0:0:0:0:0:1"));
    expect(parseIPv6("1::")).toBe(1n << 112n);
  });

  it.each(["", ":", ":::", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::", "g::1", "::1%eth0", "[::1]", "::1.2.3", "1.2.3.4", "::ffff:1.2.3.256", "::ffff:01.2.3.4", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:"])("rejects %j", (s) => {
    expect(parseIPv6(s)).toBeNull();
  });
});

describe("IPv6 classification (allow-list: only 2000::/3 minus special blocks is global)", () => {
  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "ipv4-mapped"],
    ["::ffff:8.8.8.8", "ipv4-mapped"], // mapped is denied even when the embedded address is public: never unwrapped
    ["::ffff:7f00:1", "ipv4-mapped"],
    ["::127.0.0.1", "not-global-unicast"], // deprecated IPv4-compatible
    ["64:ff9b::7f00:1", "nat64"],
    ["fc00::1", "unique-local"],
    ["fd00:ec2::254", "unique-local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique-local"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", "not-global-unicast"],
    ["ff02::1", "multicast"],
    ["2001::1", "ietf-protocol"], // Teredo
    ["2001:1::1", "ietf-protocol"],
    ["2001:db8::1", "documentation"],
    ["2002:7f00:1::", "6to4"],
    ["3fff::1", "documentation"],
    ["100::1", "not-global-unicast"],
    ["4000::1", "not-global-unicast"],
    ["8000::1", "not-global-unicast"],
  ])("%s is non-global (%s)", (addr, reason) => {
    const v = classifyAddress(addr);
    expect(v.kind).toBe("ip");
    if (v.kind === "ip") {
      expect(v.global).toBe(false);
      expect(v.reason).toBe(reason);
    }
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2001:200::1", "3ffe::1"])("%s is global", (addr) => {
    const v = classifyAddress(addr);
    expect(v.kind === "ip" && v.global).toBe(true);
  });

  it("a DNS answer that is not an address is invalid (callers deny it)", () => {
    for (const s of ["", "localhost", "not-an-ip", "1.2.3", "01.2.3.4", "0x7f000001", "2130706433", "::g"]) expect(classifyAddress(s).kind).toBe("invalid");
  });
});

describe("host-position literals", () => {
  it("brackets are required for IPv6 and any legacy IPv4 spelling is classified", () => {
    expect(classifyHostLiteral("[::1]")).toMatchObject({ kind: "ip", global: false });
    expect(classifyHostLiteral("::1").kind).toBe("invalid");
    expect(classifyHostLiteral("[::1").kind).toBe("invalid");
    expect(classifyHostLiteral("0x7f.1")).toMatchObject({ kind: "ip", family: 4, global: false });
    expect(classifyHostLiteral("8.8.8.8")).toMatchObject({ kind: "ip", family: 4, global: true });
  });
});
