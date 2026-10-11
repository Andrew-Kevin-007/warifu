// loadPolicy / normalizePolicy: schema, defaults, loader rules, canonical form, policyHash, immutability.
// Every refusal has a positive control (the same policy with only that rule satisfied loads).
import { describe, expect, it } from "vitest";
import { jcs, keccak256Utf8 } from "@symbolon/schemas";
import {
  POLICY_DEFAULTS,
  REQUIRED_POLICY_KEYS,
  applyPolicyDefaults,
  categoryBudget,
  loadPolicy,
  normalizePolicy,
  policyHash,
} from "../src/index";
import { MINIMAL_YAML, SPEC_YAML, USDC, clone, expectPolicyError, minimalJson, specJson } from "./helpers";

/** docs/04 §7 policy in canonical JCS form, written out by hand (keys sorted by UTF-16 code unit). */
const SPEC_CANONICAL_TEXT =
  '{"caps":{"dailyCap":"200.000000","hourlyCap":"25.000000","humanApprovalAbove":"50.000000","perTxHardCap":"100.000000","weeklyCap":"600.000000"},' +
  '"categories":{"design":"150.000000","dev":"300.000000","tools":"100.000000"},' +
  '"currency":{"code":"USDC","decimals":6,"treatUsdAsUsdc":true},' +
  '"escalation":{"maxPerDay":8,"maxPerEngagementPerDay":3},' +
  '"evidence":{"allowOwnerOverride":true,"freshnessHours":72,"urlAllowlist":["https://*.vercel.app","https://edithstudio.vercel.app"]},' +
  '"extraction":{"allowSingle":false},"limits":{"maxDocChars":20000},' +
  '"newPayee":{"alwaysHuman":true,"firstPaymentMax":"25.000000"},' +
  '"reconciliation":{"ackWindowHours":72},"reserve":{"floor":"10.000000","lookaheadDays":14},' +
  '"screening":{"required":false,"staleAfterHours":24},"tenant":"edith-studio",' +
  '"timing":{"allowImmediate":true,"defaultNetDays":30,"disputeWindowHours":0,"payBeforeDueBufferHours":24,"windowSafetyMarginMinutes":60},' +
  '"treasury":{"costOfCapitalBps":0},' +
  '"velocity":{"maxAmountPerPayeePerDay":"150.000000","maxReleasesPerDay":10,"maxReleasesPerPayeePerDay":3},"version":1}';

function withPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = clone(obj);
  const parts = path.split(".");
  let cur = out as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  const last = parts[parts.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return out;
}

describe("loadPolicy: the docs/04 §7 example", () => {
  const loaded = loadPolicy(SPEC_YAML);

  it("loads, and its canonical JCS text equals the hand-written canonical text", () => {
    expect(jcs(loaded.policy)).toBe(SPEC_CANONICAL_TEXT);
    expect(loaded.policyHash).toBe(keccak256Utf8(SPEC_CANONICAL_TEXT));
  });

  it("has a pinned policyHash (changes only if canonicalization changes: then this is a breaking change)", () => {
    expect(loaded.policyHash).toMatchInlineSnapshot(`"0x2ec740a8765d3c7260797e4981e96f61269c387d97bb0eab44c3b08b666f547c"`);
  });

  it("converts every amount to bigint base units", () => {
    expect(loaded.decimals).toBe(6);
    expect(loaded.amounts).toMatchObject({
      perTxHardCap: 100n * USDC,
      dailyCap: 200n * USDC,
      hourlyCap: 25n * USDC,
      weeklyCap: 600n * USDC,
      humanApprovalAbove: 50n * USDC,
      maxAmountPerPayeePerDay: 150n * USDC,
      firstPaymentMax: 25n * USDC,
      reserveFloor: 10n * USDC,
    });
    expect(categoryBudget(loaded, "design")).toBe(150n * USDC);
    expect(categoryBudget(loaded, "dev")).toBe(300n * USDC);
  });

  it("category lookups cannot reach the prototype chain", () => {
    expect(Object.getPrototypeOf(loaded.amounts.categories)).toBeNull();
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "missing"]) {
      expect(categoryBudget(loaded, k)).toBeUndefined();
      expect(loaded.amounts.categories[k]).toBeUndefined();
    }
  });

  it("is deep-frozen (a policy cannot drift from its hash after loading)", () => {
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.policy.caps)).toBe(true);
    expect(Object.isFrozen(loaded.policy.evidence.urlAllowlist)).toBe(true);
    expect(Object.isFrozen(loaded.amounts.categories)).toBe(true);
    expect(() => {
      (loaded.policy.caps as { perTxHardCap: string }).perTxHardCap = "1000000.000000";
    }).toThrow(TypeError);
    expect(() => {
      (loaded.amounts as { perTxHardCap: bigint }).perTxHardCap = 1n;
    }).toThrow(TypeError);
    expect(() => {
      (loaded.policy.evidence.urlAllowlist as string[]).push("https://evil.example");
    }).toThrow(TypeError);
  });

  it("YAML and the equivalent JSON object give the same policy and hash", () => {
    const fromJson = normalizePolicy(specJson());
    expect(fromJson.policy).toEqual(loaded.policy);
    expect(fromJson.policyHash).toBe(loaded.policyHash);
    expect(policyHash(specJson())).toBe(loaded.policyHash);
  });

  it("CRLF line endings and a leading BOM do not change the hash", () => {
    expect(loadPolicy(SPEC_YAML.replace(/\n/g, "\r\n")).policyHash).toBe(loaded.policyHash);
    expect(loadPolicy(String.fromCharCode(0xfeff) + SPEC_YAML).policyHash).toBe(loaded.policyHash);
  });

  it("is idempotent: normalizing the canonical policy again changes nothing", () => {
    const again = normalizePolicy(loaded.policy);
    expect(again.policy).toEqual(loaded.policy);
    expect(again.policyHash).toBe(loaded.policyHash);
    expect(keccak256Utf8(jcs(loaded.policy))).toBe(loaded.policyHash);
  });
});

describe("defaults (docs/04 §7)", () => {
  it("a minimal policy loads with every default filled in", () => {
    const p = loadPolicy(MINIMAL_YAML);
    const spec = loadPolicy(SPEC_YAML).policy;
    for (const section of ["velocity", "newPayee", "reserve", "timing", "treasury", "escalation", "limits", "extraction", "screening", "reconciliation"] as const) {
      expect(p.policy[section], section).toEqual(spec[section]);
    }
    expect(p.policy.evidence).toEqual({ freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: [] });
    expect(p.policy.caps.hourlyCap).toBeUndefined();
    expect(p.amounts.hourlyCap).toBe(0n);
    expect(normalizePolicy(minimalJson()).policyHash).toBe(p.policyHash);
  });

  it("v2 keys have the documented defaults when a v1 policy omits them", () => {
    let v1 = specJson();
    for (const k of ["treasury", "escalation", "limits"]) v1 = withPath(v1, k, undefined);
    v1 = withPath(v1, "timing.defaultNetDays", undefined);
    v1 = withPath(v1, "timing.windowSafetyMarginMinutes", undefined);
    const p = normalizePolicy(v1);
    expect(p.policy.treasury.costOfCapitalBps).toBe(0);
    expect(p.policy.escalation).toEqual({ maxPerDay: 8, maxPerEngagementPerDay: 3 });
    expect(p.policy.limits.maxDocChars).toBe(20000);
    expect(p.policy.timing.defaultNetDays).toBe(30);
    expect(p.policy.timing.windowSafetyMarginMinutes).toBe(60);
    // Omitting a key is the same policy as writing its default value: same hash.
    expect(p.policyHash).toBe(normalizePolicy(specJson()).policyHash);
  });

  it("a partial section keeps its given keys and defaults the rest", () => {
    const p = normalizePolicy({ ...minimalJson(), timing: { disputeWindowHours: 12 } });
    expect(p.policy.timing).toEqual({ ...POLICY_DEFAULTS.timing, disputeWindowHours: 12 });
  });

  it("a given list replaces the default list (no merging of allowlists)", () => {
    const p = normalizePolicy({ ...minimalJson(), evidence: { urlAllowlist: ["https://example.com"] } });
    expect(p.policy.evidence.urlAllowlist).toEqual(["https://example.com"]);
    expect(p.policy.evidence.freshnessHours).toBe(72);
  });

  it("POLICY_DEFAULTS is frozen and applyPolicyDefaults never aliases it", () => {
    expect(Object.isFrozen(POLICY_DEFAULTS.timing)).toBe(true);
    expect(Object.isFrozen(POLICY_DEFAULTS.evidence.urlAllowlist)).toBe(true);
    const filled = applyPolicyDefaults(minimalJson()) as { evidence: { urlAllowlist: string[] } };
    filled.evidence.urlAllowlist.push("https://example.com");
    expect(POLICY_DEFAULTS.evidence.urlAllowlist).toEqual([]);
  });

  it("required keys have no default", () => {
    expect([...REQUIRED_POLICY_KEYS]).toEqual(["version", "tenant", "currency", "caps", "categories"]);
    for (const k of REQUIRED_POLICY_KEYS) {
      expectPolicyError(() => normalizePolicy(withPath(minimalJson(), k, undefined)), "SCHEMA_INVALID", k);
    }
    expect(() => normalizePolicy(minimalJson())).not.toThrow(); // control
  });

  it("every cap except hourlyCap is required", () => {
    for (const k of ["perTxHardCap", "dailyCap", "weeklyCap", "humanApprovalAbove"]) {
      expectPolicyError(() => normalizePolicy(withPath(minimalJson(), `caps.${k}`, undefined)), "SCHEMA_INVALID", `caps.${k}`);
    }
    expect(normalizePolicy(withPath(specJson(), "caps.hourlyCap", undefined)).amounts.hourlyCap).toBe(0n);
  });
});

describe("schema: invalid policies are refused (SCHEMA_INVALID)", () => {
  const cases: Array<[string, string, unknown]> = [
    ["unknown top-level key", "extra", 1],
    ["typo in a cap name", "caps.perTxHardcap", "1"],
    ["unknown section key", "timing.payNow", true],
    ["amount written as a number (unquoted YAML)", "caps.perTxHardCap", 100],
    ["count written as a string", "velocity.maxReleasesPerDay", "10"],
    ["YAML 1.1 boolean spelling", "newPayee.alwaysHuman", "yes"],
    ["version 2", "version", 2],
    ["unsupported currency", "currency.code", "EUR"],
    ["uppercase tenant", "tenant", "Edith"],
    ["maxDocChars above the 20,000 hard cap", "limits.maxDocChars", 20001],
    ["negative count", "escalation.maxPerDay", -1],
    ["fractional count", "reserve.lookaheadDays", 1.5],
    ["costOfCapitalBps above range", "treasury.costOfCapitalBps", 1_000_001],
    ["section given as a scalar", "timing", 5],
    ["section given as a list", "caps", ["100"]],
    ["bad category key", "categories.Design", "1"],
    ["http allowlist entry", "evidence.urlAllowlist", ["http://example.com"]],
    ["allowlist entry with a path", "evidence.urlAllowlist", ["https://example.com/x"]],
    ["allowlist entry with userinfo", "evidence.urlAllowlist", ["https://u@example.com"]],
    ["negative amount", "reserve.floor", "-1"],
    ["amount with exponent", "caps.dailyCap", "1e3"],
  ];
  for (const [name, path, value] of cases) {
    it(name, () => {
      const root = path.split(".")[0] as string;
      expectPolicyError(() => normalizePolicy(withPath(specJson(), path, value)), "SCHEMA_INVALID", root);
    });
  }
  it("control: the unmodified spec policy is valid", () => {
    expect(() => normalizePolicy(specJson())).not.toThrow();
  });

  it("refuses non-mapping inputs and non-plain objects", () => {
    for (const v of [null, undefined, [], "policy", 5, true, new Map([["version", 1]])]) {
      expectPolicyError(() => normalizePolicy(v), "SCHEMA_INVALID");
    }
  });

  it("refuses an own __proto__ key in JSON input", () => {
    const polluted = JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(specJson()).slice(1)}`) as unknown;
    expectPolicyError(() => normalizePolicy(polluted), "SCHEMA_INVALID");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("reports every schema issue, not just the first", () => {
    const bad = withPath(withPath(specJson(), "version", 2), "caps.dailyCap", 5);
    const err = expectPolicyError(() => normalizePolicy(bad), "SCHEMA_INVALID");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["caps.dailyCap", "version"]);
  });

  it("an exception while reading the input fails closed (INTERNAL), never yields a policy", () => {
    const evil = { ...minimalJson() };
    Object.defineProperty(evil, "tenant", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expectPolicyError(() => normalizePolicy(evil), "INTERNAL");
  });
});

describe("loader rules beyond the schema (POLICY_INVALID)", () => {
  it("refuses amounts that would need rounding, listing every one", () => {
    const bad = withPath(withPath(specJson(), "caps.perTxHardCap", "1.0000001"), "categories.design", "0.0000005");
    const err = expectPolicyError(() => normalizePolicy(bad), "POLICY_INVALID");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["caps.perTxHardCap", "categories.design"]);
  });

  it("decimals 0: whole amounts only", () => {
    const zero = withPath(minimalJson(), "currency.decimals", 0);
    expect(normalizePolicy(zero).policy.caps.perTxHardCap).toBe("100");
    expectPolicyError(() => normalizePolicy(withPath(zero, "caps.perTxHardCap", "100.5")), "POLICY_INVALID", "caps.perTxHardCap");
  });

  it("refuses amounts above uint256 base units", () => {
    const big = withPath(withPath(minimalJson(), "currency.decimals", 60), "caps.weeklyCap", "1".repeat(30));
    expectPolicyError(() => normalizePolicy(big), "POLICY_INVALID", "caps.weeklyCap");
  });

  const goodPatterns = ["https://example.com", "https://*.example.com", "https://a-b.c-d.io", "https://xn--bcher-kva.example", "https://edithstudio.vercel.app", "https://*.vercel.app"];
  const badPatterns = [
    "https://*",
    "https://*.app",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://Example.com",
    "https://example.com:443",
    "https://example.com:8443",
    "https://a.*.example.com",
    "https://*example.com",
    "https://-bad.example.com",
    "https://bad-.example.com",
    "https://exa_mple.com",
    "https://example..com",
    `https://${"a".repeat(64)}.com`,
    `https://${Array.from({ length: 64 }, () => "abc").join(".")}.com`,
  ];
  it("accepts well-formed https origin patterns", () => {
    expect(normalizePolicy(withPath(specJson(), "evidence.urlAllowlist", goodPatterns)).policy.evidence.urlAllowlist).toEqual([...goodPatterns].sort());
  });
  for (const bad of badPatterns) {
    it(`refuses allowlist pattern ${bad.length > 60 ? `${bad.slice(0, 40)}...` : bad}`, () => {
      expectPolicyError(
        () => normalizePolicy(withPath(specJson(), "evidence.urlAllowlist", ["https://example.com", bad])),
        "POLICY_INVALID",
        "evidence.urlAllowlist[1]",
      );
    });
  }
  it("refuses duplicate allowlist entries", () => {
    expectPolicyError(
      () => normalizePolicy(withPath(specJson(), "evidence.urlAllowlist", ["https://example.com", "https://example.com"])),
      "POLICY_INVALID",
      "evidence.urlAllowlist[1]",
    );
  });
});

describe("canonical form: one value, one spelling", () => {
  const h = (p: Record<string, unknown>) => normalizePolicy(p).policyHash;

  it("amount spellings with the same value hash equally", () => {
    const a = h(withPath(minimalJson(), "caps.perTxHardCap", "100"));
    expect(h(withPath(minimalJson(), "caps.perTxHardCap", "100.0"))).toBe(a);
    expect(h(withPath(minimalJson(), "caps.perTxHardCap", "100.000000"))).toBe(a);
    expect(h(withPath(minimalJson(), "caps.perTxHardCap", "100.000001"))).not.toBe(a); // control: value differs
  });

  it("hourlyCap absent, \"0\" and \"0.000000\" are the same policy; \"0.000001\" is not", () => {
    const off = h(minimalJson());
    expect(h(withPath(minimalJson(), "caps.hourlyCap", "0"))).toBe(off);
    expect(h(withPath(minimalJson(), "caps.hourlyCap", "0.000000"))).toBe(off);
    const on = normalizePolicy(withPath(minimalJson(), "caps.hourlyCap", "0.000001"));
    expect(on.policyHash).not.toBe(off);
    expect(on.amounts.hourlyCap).toBe(1n);
    expect(on.policy.caps.hourlyCap).toBe("0.000001");
  });

  it("allowlist order does not matter", () => {
    const one = h(withPath(specJson(), "evidence.urlAllowlist", ["https://b.example.com", "https://a.example.com"]));
    expect(h(withPath(specJson(), "evidence.urlAllowlist", ["https://a.example.com", "https://b.example.com"]))).toBe(one);
  });

  it("key order does not matter (YAML with sections and keys in a different order)", () => {
    const reordered = [
      "reconciliation: { ackWindowHours: 72 }",
      "categories: { tools: \"100.000000\", dev: \"300.000000\", design: \"150.000000\" }",
      "caps: { humanApprovalAbove: \"50.000000\", weeklyCap: \"600.000000\", hourlyCap: \"25.000000\", dailyCap: \"200.000000\", perTxHardCap: \"100.000000\" }",
      "screening: { staleAfterHours: 24, required: false }",
      "evidence: { urlAllowlist: [\"https://edithstudio.vercel.app\", \"https://*.vercel.app\"], allowOwnerOverride: true, freshnessHours: 72 }",
      "tenant: edith-studio",
      "timing: { windowSafetyMarginMinutes: 60, defaultNetDays: 30, allowImmediate: true, payBeforeDueBufferHours: 24, disputeWindowHours: 0 }",
      "velocity: { maxAmountPerPayeePerDay: \"150.000000\", maxReleasesPerPayeePerDay: 3, maxReleasesPerDay: 10 }",
      "limits: { maxDocChars: 20000 }",
      "currency: { treatUsdAsUsdc: true, decimals: 6, code: USDC }",
      "escalation: { maxPerEngagementPerDay: 3, maxPerDay: 8 }",
      "newPayee: { alwaysHuman: true, firstPaymentMax: \"25.000000\" }",
      "extraction: { allowSingle: false }",
      "reserve: { lookaheadDays: 14, floor: \"10.000000\" }",
      "treasury: { costOfCapitalBps: 0 }",
      "version: 1",
      "",
    ].join("\n");
    expect(loadPolicy(reordered).policyHash).toBe(loadPolicy(SPEC_YAML).policyHash);
  });

  it("any value change changes the hash (controls for the equalities above)", () => {
    const base = h(specJson());
    const changes: Array<[string, unknown]> = [
      ["caps.perTxHardCap", "99.999999"],
      ["tenant", "edith-studio-2"],
      ["newPayee.alwaysHuman", false],
      ["timing.defaultNetDays", 31],
      ["reconciliation.ackWindowHours", 0.17],
      ["evidence.urlAllowlist", ["https://*.vercel.app"]],
      ["categories.ops", "1"],
    ];
    const seen = new Set([base]);
    for (const [path, value] of changes) {
      const hv = h(withPath(specJson(), path, value));
      expect(seen.has(hv), path).toBe(false);
      seen.add(hv);
    }
  });

  it("fractional hours survive canonically (0.17 for the 10-minute demo)", () => {
    const p = loadPolicy(SPEC_YAML.replace("ackWindowHours: 72", "ackWindowHours: 0.17"));
    expect(p.policy.reconciliation.ackWindowHours).toBe(0.17);
    expect(jcs(p.policy)).toContain('"ackWindowHours":0.17');
  });
});

describe("loadPolicy: YAML-level refusals surface with their codes", () => {
  it("passes YAML errors through", () => {
    expectPolicyError(() => loadPolicy(SPEC_YAML + "tenant: other\n"), "YAML_SYNTAX");
    expectPolicyError(() => loadPolicy(SPEC_YAML.replace("treasury: { costOfCapitalBps: 0 }", "treasury: &t { costOfCapitalBps: 0 }")), "YAML_FEATURE");
    expectPolicyError(() => loadPolicy(SPEC_YAML.replace("perTxHardCap: \"100.000000\"", "perTxHardCap: 100.000000")), "YAML_FEATURE");
    expectPolicyError(() => loadPolicy(SPEC_YAML.replace("perTxHardCap: \"100.000000\"", "perTxHardCap: 100")), "SCHEMA_INVALID", "caps.perTxHardCap");
    expectPolicyError(() => loadPolicy(5 as unknown as string), "INPUT_INVALID");
  });
});
