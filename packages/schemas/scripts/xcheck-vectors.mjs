#!/usr/bin/env node
/* global process, console, URL */
// Independent second implementation for packages/schemas/vectors/*.json (WP-01 acceptance; docs/QUESTIONS.md
// "Second implementation of the EIP-712/JCS vectors without Foundry"). Plain JavaScript on purpose: it imports
// NOTHING from packages/schemas/src. JCS comes from `canonicalize` (RFC 8785), hashing and EIP-712 from `ethers`
// (TypedDataEncoder), and the preimage rules (termsHash, certHash, bundleHash) and normalizeUntrusted are
// re-implemented here from the docs, not copied from the TypeScript.
//
// Usage: node scripts/xcheck-vectors.mjs [vectorsDir]     (default: ../vectors next to this script)
//        node scripts/xcheck-vectors.mjs -                (read {"<file>.json": <content>, ...} from stdin)
// Prints a JSON summary; exit 0 only if every check passed and every category ran at least once.
import canonicalize from "canonicalize";
import { TypedDataEncoder, formatUnits, id, keccak256, sha256, toUtf8Bytes } from "ethers";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["jcs.json", "hashes.json", "eip712.json", "approval.json", "lbc.json", "untrusted.json", "money.json"];

function loadVectors(arg) {
  if (arg === "-") return JSON.parse(readFileSync(0, "utf8"));
  const dir = arg ?? fileURLToPath(new URL("../vectors/", import.meta.url));
  const present = new Set(readdirSync(dir));
  const out = {};
  for (const f of FILES) if (present.has(f)) out[f] = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return out;
}

const k256 = (text) => keccak256(toUtf8Bytes(text));
const counts = {};
const failures = [];

function check(category, name, ok, detail) {
  counts[category] = (counts[category] ?? 0) + 1;
  if (!ok) failures.push({ category, name, detail });
}

function eq(category, name, actual, expected) {
  check(category, name, actual === expected, actual === expected ? undefined : { actual, expected });
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- preimage rules, written from the docs -----------------------------------------------------------
// docs/05 §2: termsHash = keccak256(JCS(terms without signatures)); preimage = {engagementId, owner, payee,
// payeeLabel, currency, currencyDecimals, cap, start, end, sequential, milestones (incl. evidenceSpec),
// paymentTerms, nonce}. Milestones are the signed terms, so their mutable `status` is not part of it.
function termsPreimage(e) {
  return {
    engagementId: e.engagementId,
    owner: e.owner,
    payee: e.payee,
    payeeLabel: e.payeeLabel,
    currency: e.currency,
    currencyDecimals: e.currencyDecimals,
    cap: e.capBaseUnits,
    start: e.start,
    end: e.end,
    sequential: e.sequential,
    milestones: e.milestones.map(({ status: _status, ...signed }) => signed),
    paymentTerms: e.paymentTerms,
    nonce: e.nonce,
  };
}

// docs/16 §3: certHash covers the certificate minus certHash, publisher and validity.
function certPreimage(c) {
  const { certHash: _h, publisher: _p, validity: _v, ...rest } = c;
  return rest;
}

// docs/15 §7: bundleHash covers the bundle minus bundleHash.
function bundlePreimage(b) {
  const { bundleHash: _h, ...rest } = b;
  return rest;
}

// --- normalizeUntrusted, written from docs/03 §2 guardrail 7 + the SCHEMAS extension list -----------------
// Different algorithm from src/untrusted.ts: CRLF folded up front, then a code-point iterator with range tables.
const RANGES = {
  control: [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f]],
  zeroWidth: [[0x200b, 0x200d], [0xfeff, 0xfeff], [0x2060, 0x2064], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x180e, 0x180e], [0xe0000, 0xe007f]],
  bidi: [[0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0x061c, 0x061c]],
};

function normalize(s) {
  const c = { control: 0, zeroWidth: 0, bidi: 0, invalid: 0 };
  let out = "";
  for (const ch of s.split("\r\n").join("\n")) {
    const cp = ch.codePointAt(0);
    if (ch.length === 1 && cp >= 0xd800 && cp <= 0xdfff) {
      c.invalid++;
      continue;
    }
    const cat = Object.keys(RANGES).find((key) => RANGES[key].some(([lo, hi]) => cp >= lo && cp <= hi));
    if (cat === undefined) out += ch;
    else c[cat]++;
  }
  return { normalized: out, removedCount: c.control + c.zeroWidth + c.bidi + c.invalid, counts: c };
}

// Exact decimal value of a display string or an ethers formatUnits result, as a canonical string.
function canonicalDecimal(s) {
  const plain = s.replace(/,/g, "");
  const [i, f = ""] = plain.split(".");
  const frac = f.replace(/0+$/, "");
  return frac.length > 0 ? `${i}.${frac}` : i;
}

function typesWithoutDomain(td) {
  return { [td.primaryType]: td.types[td.primaryType] };
}

const EIP712_DOMAIN_FIELDS = "name:string,version:string,chainId:uint256,verifyingContract:address";

// --- checks per file -------------------------------------------------------------------------------------
function checkJcs(v) {
  for (const c of v.cases) {
    const canonical = canonicalize(JSON.parse(c.input));
    eq("jcs", `${c.name}: canonical`, canonical, c.canonical);
    eq("jcs", `${c.name}: keccak256`, k256(c.canonical), c.keccak256);
    eq("jcs", `${c.name}: sha256`, sha256(toUtf8Bytes(c.canonical)), c.sha256);
  }
  for (const c of v.errors) check("jcsErrors", `${c.name}: rejected`, throws(() => canonicalize(JSON.parse(c.input))));
}

function checkHashes(v) {
  for (const c of v.cases) {
    let preimage;
    switch (c.kind) {
      case "jcs":
        preimage = canonicalize(c.input);
        break;
      case "utf8":
        preimage = c.input;
        break;
      case "termsHash":
        preimage = canonicalize(termsPreimage(c.input));
        eq("hashes", `${c.name}: engagement.termsHash`, c.input.termsHash, c.hash);
        break;
      case "certHash":
        preimage = canonicalize(certPreimage(c.input));
        eq("hashes", `${c.name}: certificate.certHash`, c.input.certHash, c.hash);
        break;
      case "bundleHash":
        preimage = canonicalize(bundlePreimage(c.input));
        eq("hashes", `${c.name}: bundle.bundleHash`, c.input.bundleHash, c.hash);
        break;
      default:
        check("hashes", `${c.name}: known kind`, false, { kind: c.kind });
        continue;
    }
    eq("hashes", `${c.name}: preimage`, preimage, c.preimage);
    eq("hashes", `${c.name}: hash`, k256(preimage), c.hash);
  }
}

function checkEip712(v) {
  const digests = new Map();
  for (const c of v.cases) {
    const td = c.typedData;
    eq("eip712", `${c.name}: primaryType`, td.primaryType, c.primaryType);
    eq("eip712", `${c.name}: EIP712Domain type`, td.types.EIP712Domain.map((f) => `${f.name}:${f.type}`).join(","), EIP712_DOMAIN_FIELDS);
    const types = typesWithoutDomain(td);
    const encoder = TypedDataEncoder.from(types);
    eq("eip712", `${c.name}: encodeType`, encoder.encodeType(c.primaryType), c.encodeType);
    eq("eip712", `${c.name}: typeHash`, id(c.encodeType), c.typeHash);
    eq("eip712", `${c.name}: domainSeparator`, TypedDataEncoder.hashDomain(td.domain), c.domainSeparator);
    eq("eip712", `${c.name}: structHash`, encoder.hashStruct(c.primaryType, td.message), c.structHash);
    eq("eip712", `${c.name}: digest`, TypedDataEncoder.hash(td.domain, types, td.message), c.digest);
    digests.set(c.name, c.digest);
  }
  const base = digests.get("OwnerApproval");
  for (const name of ["OwnerApproval/domain-chainId-1", "OwnerApproval/domain-other-vault"]) {
    check("eip712", `${name}: differs from OwnerApproval`, digests.has(name) && base !== undefined && digests.get(name) !== base);
  }
}

function checkApproval(v) {
  const view = v.view;
  const td = view.typedData;
  eq("approval", "typedDataJcs", canonicalize(td), v.typedDataJcs);
  eq("approval", "typedDataHash", k256(v.typedDataJcs), v.typedDataHash);
  eq("approval", "view.typedDataHash", view.typedDataHash, v.typedDataHash);
  eq("approval", "digest", TypedDataEncoder.hash(td.domain, typesWithoutDomain(td), td.message), v.digest);
  eq("approval", "message.intentId", td.message.intentId, view.intentId);
  eq("approval", "message.receiptHash", td.message.receiptHash, view.receiptHash);
  eq("approval", "message.amount", td.message.amount, view.releaseBaseUnits);
  eq("approval", "message.deadline", td.message.deadline, String(Date.parse(view.expiresAt) / 1000));
  eq("approval", "display.gross", canonicalDecimal(view.display.gross), canonicalDecimal(formatUnits(view.grossBaseUnits, view.decimals)));
  eq("approval", "display.release", canonicalDecimal(view.display.release), canonicalDecimal(formatUnits(view.releaseBaseUnits, view.decimals)));
}

function checkLbc(v) {
  const pre = canonicalize(certPreimage(v.certificate));
  eq("lbc", "preimageJcs", pre, v.preimageJcs);
  eq("lbc", "certHash", k256(pre), v.certHash);
  eq("lbc", "certificate.certHash", v.certificate.certHash, v.certHash);
  for (const variant of v.variants) {
    const h = k256(canonicalize(certPreimage(variant.certificate)));
    eq("lbc", `${variant.name}: certHash`, h, variant.certHash);
    eq("lbc", `${variant.name}: certificate.certHash`, variant.certificate.certHash, variant.certHash);
    const same = variant.expect.startsWith("same");
    check("lbc", `${variant.name}: ${variant.expect}`, same ? h === v.certHash : h !== v.certHash);
  }
}

function checkUntrusted(v) {
  for (const c of v.normalize) {
    const r = normalize(c.input);
    eq("normalize", `${c.name}: normalized`, r.normalized, c.normalized);
    eq("normalize", `${c.name}: removedCount`, r.removedCount, c.removedCount);
    eq("normalize", `${c.name}: counts`, JSON.stringify(r.counts), JSON.stringify(c.counts));
  }
}

function checkMoney(v) {
  for (const c of v.cases) {
    const name = `${c.units}/${c.decimals}${c.options ? ` ${JSON.stringify(c.options)}` : ""}`;
    eq("money", `${name}: value`, canonicalDecimal(c.expected), canonicalDecimal(formatUnits(c.units, c.decimals)));
    const grouping = c.options?.grouping ?? true;
    const intPart = c.expected.replace(/^-/, "").split(".")[0];
    check("money", `${name}: grouping`, grouping ? /^\d{1,3}(,\d{3})*$/.test(intPart) : /^\d+$/.test(intPart), { expected: c.expected });
    const fracLen = (c.expected.split(".")[1] ?? "").length;
    const minFrac = Math.min(c.options?.minFractionDigits ?? 2, c.decimals);
    check("money", `${name}: fraction digits`, fracLen >= minFrac && fracLen <= c.decimals, { expected: c.expected, minFrac });
  }
}

const CHECKERS = {
  "jcs.json": [checkJcs, ["jcs", "jcsErrors"]],
  "hashes.json": [checkHashes, ["hashes"]],
  "eip712.json": [checkEip712, ["eip712"]],
  "approval.json": [checkApproval, ["approval"]],
  "lbc.json": [checkLbc, ["lbc"]],
  "untrusted.json": [checkUntrusted, ["normalize"]],
  "money.json": [checkMoney, ["money"]],
};

const vectors = loadVectors(process.argv[2]);
for (const file of FILES) {
  const [fn, categories] = CHECKERS[file];
  if (!(file in vectors)) {
    failures.push({ category: "files", name: `${file}: missing` });
    continue;
  }
  try {
    fn(vectors[file]);
  } catch (err) {
    failures.push({ category: "files", name: `${file}: checker threw`, detail: String(err) });
  }
  for (const cat of categories) if (!counts[cat]) failures.push({ category: cat, name: "no checks ran" });
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ ok: failures.length === 0, total, counts, failures }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
