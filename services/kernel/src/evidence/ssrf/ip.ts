// IP literal parsing and the "is this a global unicast address" decision (docs/04 K-09, RT-02).
//
// Pure string/integer code. Two jobs:
//   1. parse EVERY spelling a connect() or a URL library might accept (dotted, decimal, octal, hex, short forms for IPv4;
//      compressed, mapped and embedded-IPv4 forms for IPv6) so no spelling can slip past a textual check;
//   2. decide whether the resulting address is global. IPv4 uses a deny list of every special-purpose block (IANA registry);
//      IPv6 uses an ALLOW list: only 2000::/3 is considered, minus the special-purpose blocks inside it. Anything we do not
//      positively know to be global is non-global (fail closed).
// IPv4-mapped addresses (::ffff:0:0/96) and the other IPv4-in-IPv6 transition forms are denied outright rather than unwrapped.

/** Parse one inet_aton-style part: decimal, 0-prefixed octal, or 0x-prefixed hex. Null when it is none of those. */
function parseV4Part(p: string): bigint | null {
  if (p === "") return null;
  if (/^0[xX][0-9a-fA-F]*$/.test(p)) return p.length === 2 ? 0n : BigInt(p);
  if (/^0[0-7]*$/.test(p)) return p === "0" ? 0n : BigInt(`0o${p.slice(1)}`);
  if (/^[1-9][0-9]*$/.test(p)) return BigInt(p);
  return null;
}

/**
 * IPv4 in any legacy spelling accepted by inet_aton / the WHATWG "IPv4 parser": 1 to 4 dot-separated parts, each decimal,
 * octal (leading 0) or hex (0x); the last part fills all remaining bytes. Returns the 32-bit value, or null.
 * Examples that all mean 127.0.0.1: "127.0.0.1", "2130706433", "0x7f000001", "017700000001", "127.1", "0x7f.1", "0177.0.0.01".
 */
export function parseIPv4Legacy(s: string): number | null {
  const parts = s.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: bigint[] = [];
  for (const p of parts) {
    const v = parseV4Part(p);
    if (v === null) return null;
    vals.push(v);
  }
  const last = vals[vals.length - 1] as bigint;
  const head = vals.slice(0, -1);
  for (const h of head) if (h > 255n) return null;
  const lastBytes = 4 - head.length;
  if (last >= 1n << BigInt(8 * lastBytes)) return null;
  let n = last;
  head.forEach((h, i) => {
    n += h << BigInt(8 * (3 - i));
  });
  return Number(n);
}

/** Strict dotted-decimal IPv4 only (what may legally appear as the tail of an IPv6 literal, and what a DNS answer looks like). */
export function parseIPv4Strict(s: string): number | null {
  const m = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(s);
  if (m === null) return null;
  const o = m.slice(1).map((x) => Number.parseInt(x, 10));
  if (o.some((x) => x > 255)) return null;
  return ((o[0] as number) * 2 ** 24 + (o[1] as number) * 2 ** 16 + (o[2] as number) * 2 ** 8 + (o[3] as number)) >>> 0;
}

/** IPv6 text to a 128-bit value, or null. Zone ids ("%eth0") and brackets are NOT accepted here. */
export function parseIPv6(s: string): bigint | null {
  if (s.length < 2 || s.length > 45 || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let text = s;
  let tail: bigint[] = [];
  // an embedded dotted IPv4 tail takes the place of the last two groups
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = parseIPv4Strict(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [BigInt(v4 >>> 16), BigInt(v4 & 0xffff)];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const dbl = text.split("::");
  if (dbl.length > 2) return null;
  const groups = (x: string): string[] => (x === "" ? [] : x.split(":"));
  const left = groups(dbl[0] as string);
  const right = dbl.length === 2 ? groups(dbl[1] as string) : [];
  const total = left.length + right.length;
  if (dbl.length === 1 ? total !== 8 : total > 7) return null;
  const all = dbl.length === 1 ? left : [...left, ...Array<string>(8 - total).fill("0"), ...right];
  if (all.length !== 8) return null;
  const words: bigint[] = [];
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    words.push(BigInt(`0x${g}`));
  }
  if (tail.length === 2) {
    words[6] = tail[0] as bigint;
    words[7] = tail[1] as bigint;
  }
  return words.reduce((acc, w) => (acc << 16n) | w, 0n);
}

// --- IPv4: special-purpose blocks that are NOT globally routable ------------------------------------------------------------
const V4_BLOCKS: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "rfc1918"],
  ["100.64.0.0", 10, "cgnat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"], // includes the 169.254.169.254 metadata address
  ["172.16.0.0", 12, "rfc1918"],
  ["192.0.0.0", 24, "ietf-protocol"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4-relay"],
  ["192.168.0.0", 16, "rfc1918"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"], // includes 255.255.255.255
];

export interface Classified {
  readonly global: boolean;
  readonly reason: string;
}

export function classifyIPv4(v: number): Classified {
  for (const [base, bits, label] of V4_BLOCKS) {
    const b = parseIPv4Strict(base) as number;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    if (((v & mask) >>> 0) === ((b & mask) >>> 0)) return { global: false, reason: label };
  }
  return { global: true, reason: "global" };
}

// --- IPv6 --------------------------------------------------------------------------------------------------------------------
/** True when the top `prefix` bits of v equal those of `base` (base given as a full 128-bit value). */
const inV6 = (v: bigint, base: bigint, prefix: number): boolean => v >> BigInt(128 - prefix) === base >> BigInt(128 - prefix);
const hi = (word: bigint): bigint => word << 112n;

export function classifyIPv6(v: bigint): Classified {
  if (v === 0n) return { global: false, reason: "unspecified" };
  if (v === 1n) return { global: false, reason: "loopback" };
  if (inV6(v, 0xffffn << 32n, 96)) return { global: false, reason: "ipv4-mapped" }; // ::ffff:0:0/96 (denied, never unwrapped)
  if (!inV6(v, hi(0x2000n), 3)) {
    if (inV6(v, hi(0xfc00n), 7)) return { global: false, reason: "unique-local" };
    if (inV6(v, hi(0xfe80n), 10)) return { global: false, reason: "link-local" };
    if (inV6(v, hi(0xff00n), 8)) return { global: false, reason: "multicast" };
    if (inV6(v, (0x64n << 112n) | (0xff9bn << 96n), 96)) return { global: false, reason: "nat64" };
    return { global: false, reason: "not-global-unicast" }; // ::/8 (IPv4-compatible), fec0::/10, everything else outside 2000::/3
  }
  if (inV6(v, hi(0x2001n), 23)) return { global: false, reason: "ietf-protocol" }; // Teredo, benchmarking, ORCHID, ...
  if (inV6(v, (0x2001n << 112n) | (0x0db8n << 96n), 32)) return { global: false, reason: "documentation" };
  if (inV6(v, hi(0x2002n), 16)) return { global: false, reason: "6to4" };
  if (inV6(v, hi(0x3fffn), 20)) return { global: false, reason: "documentation" };
  return { global: true, reason: "global" };
}

export type IpVerdict =
  | { readonly kind: "invalid" }
  | { readonly kind: "ip"; readonly family: 4 | 6; readonly global: boolean; readonly reason: string };

/** Parse a DNS-answer style address (strict dotted IPv4 or IPv6) and classify it. Anything unparseable is "invalid" (denied by callers). */
export function classifyAddress(s: string): IpVerdict {
  const v4 = parseIPv4Strict(s);
  if (v4 !== null) return { kind: "ip", family: 4, ...classifyIPv4(v4) };
  const v6 = parseIPv6(s);
  if (v6 !== null) return { kind: "ip", family: 6, ...classifyIPv6(v6) };
  return { kind: "invalid" };
}

/** Parse a URL-host-position literal (brackets for IPv6, any legacy IPv4 spelling) and classify it. */
export function classifyHostLiteral(host: string): IpVerdict {
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) return { kind: "invalid" };
    const v6 = parseIPv6(host.slice(1, -1));
    return v6 === null ? { kind: "invalid" } : { kind: "ip", family: 6, ...classifyIPv6(v6) };
  }
  const v4 = parseIPv4Legacy(host);
  return v4 === null ? { kind: "invalid" } : { kind: "ip", family: 4, ...classifyIPv4(v4) };
}
