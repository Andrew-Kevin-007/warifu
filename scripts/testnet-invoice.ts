// Submit one invoice to the kernel the web app talks to (apps/web/.env.local), for the first real testnet payment (handoff 5b).
// The web build has no document upload or extraction UI, so this stores the invoice text through POST /v1/documents and submits the
// proposal through POST /v1/intents with the same HMAC client the web tier uses. The "extraction" is entered by hand and labelled
// `manual-entry-*`: no model read this invoice, and the receipt says so.
//   node --env-file=apps/web/.env.local --experimental-transform-types --disable-warning=ExperimentalWarning \
//     --import ./packages/blast-radius/scripts/register-ts.mjs scripts/testnet-invoice.ts \
//     --engagement 0x... --milestone 0x... --payee 0x... --amount 1000000
import { createHash, randomBytes } from "node:crypto";
import { kernelCall } from "../apps/web/src/server/kernel-client.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = arg(name);
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
};

const engagementId = need("engagement");
const milestoneId = need("milestone");
const payee = need("payee");
const baseUnits = BigInt(arg("amount") ?? "1000000");
const tenantId = process.env["WEB_SVC_TENANT_ID"] ?? "";
if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error("WEB_SVC_TENANT_ID is not set in apps/web/.env.local");

const printed = `${(baseUnits / 1_000_000n).toString()}.${(baseUnits % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
const invoiceNumber = `INV-${String((randomBytes(4).readUInt32BE(0) % 900000) + 100000)}`;
const text = [
  `INVOICE ${invoiceNumber}`,
  "Kevin second wallet",
  "First testnet payment (internal: our own wallets, not traction)",
  `Pay to: ${payee}`,
  `Total: ${printed} USDC`,
  "",
].join("\n");

const doc = await kernelCall<{ documentId: string; docHash: string }>("/v1/documents", { method: "POST", body: { text, mime: "text/plain" } });
if (!doc.ok) throw new Error(`document post failed: ${String(doc.status)} ${doc.code}`);

const H = (s: string): string => `0x${createHash("sha256").update(s).digest("hex")}`;
const ex = (confidence: number) => ({
  docType: "INVOICE",
  invoiceNumber,
  issueDate: new Date().toISOString().slice(0, 10),
  dueDate: null,
  payee: { legalName: "Kevin second wallet", walletAddress: payee, claimsAddressChange: false },
  amount: { printed, currencyPrinted: "USDC", decimalSeparatorGuess: ".", parsedBaseUnits: baseUnits.toString(), decimals: 6 },
  references: { engagementId: null, milestoneId: null, poNumber: null },
  statedTerms: { raw: null, netDays: null, earlyPay: null, ambiguous: false },
  lineItems: [{ description: "First testnet payment", amountPrinted: printed }],
  anomalies: [],
  confidence,
});

const intent = {
  schemaVersion: 1,
  tenantId,
  documentId: doc.data.documentId,
  docHash: doc.data.docHash,
  extraction: {
    a: ex(0.95),
    b: ex(0.92),
    modelA: "manual-entry-a",
    modelB: "manual-entry-b",
    promptHashA: H("manual entry, no model"),
    promptHashB: H("manual entry, no model"),
  },
  consensus: { status: "AGREE", diffs: [] },
  engagementId,
  milestoneId,
  timingProposal: null,
  planSelection: null,
  agentRecommendation: null,
  submittedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
};

const r = await kernelCall<Record<string, unknown>>("/v1/intents", { method: "POST", body: intent, idempotencyKey: H(invoiceNumber).slice(2, 34) });
if (!r.ok) {
  console.log("intent refused by the kernel:", r.status, r.code, JSON.stringify(r.detail ?? null).slice(0, 400));
  process.exit(1);
}
console.log(JSON.stringify(r.data, null, 2).slice(0, 1500));
