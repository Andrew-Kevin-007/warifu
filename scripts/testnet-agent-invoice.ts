// An AI model reads the invoice, then the kernel decides (handoff 5b, agent variant). Two different free-tier Gemini models read the invoice
// text independently (the extractor's own two-model, two-prompt design); their two readings go to the kernel as the proposal. The kernel
// re-derives every field itself and a model is never a release condition (INV-8): the models can only propose, and the verdict is the kernel's.
//   $env:GEMINI_API_KEY='...'   (this window only; never paste it anywhere)
//   node --env-file=apps/web/.env.local --experimental-transform-types --disable-warning=ExperimentalWarning \
//     --import ./packages/blast-radius/scripts/register-ts.mjs scripts/testnet-agent-invoice.ts \
//     --engagement 0x... --milestone 0x... --payee 0x... --modelA <id> --modelB <id> [--amount 1000000]
import { createHash, randomBytes } from "node:crypto";
import { kernelCall } from "../apps/web/src/server/kernel-client.ts";
import { BudgetedLlm, CostModel, InMemoryBudgetLedger, MemoryCallCache, createGeminiClient, extractInvoice } from "../packages/extractor/src/index.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = arg(name);
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
};

const apiKey = process.env["GEMINI_API_KEY"] ?? "";
if (apiKey.length < 20) throw new Error("GEMINI_API_KEY is not set in this window");
const engagementId = need("engagement");
const milestoneId = need("milestone");
const payee = need("payee");
const modelA = need("modelA");
const modelB = need("modelB");
const baseUnits = BigInt(arg("amount") ?? "1000000");
const tenantId = process.env["WEB_SVC_TENANT_ID"] ?? "";
if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error("WEB_SVC_TENANT_ID is not set in apps/web/.env.local");

const printed = `${(baseUnits / 1_000_000n).toString()}.${(baseUnits % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
const invoiceNumber = `DS-${String((randomBytes(4).readUInt32BE(0) % 900000) + 100000)}`;
const text = [
  "INVOICE",
  `Invoice number: ${invoiceNumber}`,
  "From: Kevin second wallet (design studio)",
  "To: Warifu testnet treasury",
  `Date: ${new Date().toISOString().slice(0, 10)}`,
  "",
  "Description                          Amount",
  `Design concept milestone             ${printed} USDC`,
  "",
  `Total due: ${printed} USDC`,
  `Pay to wallet: ${payee}`,
  "Network: Arc testnet",
  "Thank you for your business.",
  "",
].join("\n");

// Prints the HTTP status and Google's own error message for a refused call (never the key: it only travels in a header). The adapter itself
// hides provider text on purpose; this is for the operator running the script.
const debugFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body: unknown = await res.clone().json().catch(() => null);
    const e = (body as { error?: { status?: string; message?: string } } | null)?.error;
    console.log(`[gemini] HTTP ${String(res.status)} ${String(e?.status ?? "")} ${String(e?.message ?? "").slice(0, 300)}`);
  }
  return res;
};

// The free tier is free: the price table says so explicitly (the package assumes no prices); the in-memory ledger only caps token volume.
const prices = { [modelA]: { inPerMTok: 0n, outPerMTok: 0n }, [modelB]: { inPerMTok: 0n, outPerMTok: 0n } };
const llm = new BudgetedLlm({
  inner: createGeminiClient({ apiKey, fetch: debugFetch }),
  ledger: new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 1_000_000n, perPrincipalDailyCapMicroUsd: 1_000_000n, day: () => new Date().toISOString().slice(0, 10) }),
  cache: new MemoryCallCache(16),
  costModel: new CostModel(prices),
  principalHash: createHash("sha256").update("testnet-agent-invoice").digest("hex"),
});

const doc = await kernelCall<{ documentId: string; docHash: string }>("/v1/documents", { method: "POST", body: { text, mime: "text/plain" } });
if (!doc.ok) throw new Error(`document post failed: ${String(doc.status)} ${doc.code}`);

const r = await extractInvoice(text, { modelA, modelB, decimals: 6, parseEligibleCurrencies: ["USDC"] }, { llm });
if (!r.ok) {
  console.log("the models could not produce a usable reading:", r.failure.code, r.failure.disposition, r.failure.detail ?? "");
  process.exit(1);
}
const v = r.value;
const show = (label: string, e: typeof v.a | null) =>
  console.log(label, e === null ? "none" : `invoice ${e.invoiceNumber} | payee wallet ${e.payee.walletAddress} | printed ${e.amount.printed} ${e.amount.currencyPrinted} | base units ${e.amount.parsedBaseUnits} | confidence ${e.confidence}`);
show(`reading A (${v.modelA}):`, v.a);
show(`reading B (${v.modelB}):`, v.b);
console.log("consensus:", JSON.stringify(v.consensus).slice(0, 200));

const intent = {
  schemaVersion: 1,
  tenantId,
  documentId: doc.data.documentId,
  docHash: doc.data.docHash,
  extraction: { a: v.a, b: v.b, modelA: v.modelA, modelB: v.modelB, promptHashA: v.promptHashA, promptHashB: v.promptHashB },
  consensus: v.consensus,
  engagementId,
  milestoneId,
  timingProposal: null,
  planSelection: null,
  agentRecommendation: null,
  submittedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
};
const key = createHash("sha256").update(invoiceNumber).digest("hex").slice(0, 32);
const res = await kernelCall<{ intentId?: string; decision?: { verdict?: string; reasons?: string[] } }>("/v1/intents", { method: "POST", body: intent, idempotencyKey: key });
if (!res.ok) {
  console.log("intent refused by the kernel:", res.status, res.code, JSON.stringify(res.detail ?? null).slice(0, 500));
  process.exit(1);
}
console.log("intentId:", res.data.intentId);
console.log("verdict:", res.data.decision?.verdict, JSON.stringify(res.data.decision?.reasons ?? []));
