// Delta-debugs the REAL extractor request against Gemini: captures the request extractInvoice builds, then swaps one piece at a time
// (system prompt, schema keywords, messages) and prints only HTTP status and message. Pauses between calls to stay under the free-tier rate limit.
//   $env:GEMINI_API_KEY='...'
//   node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./packages/blast-radius/scripts/register-ts.mjs scripts/gemini-probe2.ts <model>
import { BudgetedLlm, CostModel, InMemoryBudgetLedger, MemoryCallCache, extractInvoice, ProviderError } from "../packages/extractor/src/index.ts";
import type { LlmClient, LlmRequest } from "../packages/extractor/src/index.ts";
import { toOpenApiSchema } from "../packages/extractor/src/llm/gemini.ts";

const key = process.env["GEMINI_API_KEY"] ?? "";
const model = process.argv[2] ?? "gemini-3-flash-preview";
if (key.length < 20) throw new Error("set GEMINI_API_KEY");

let captured: LlmRequest | null = null;
const capture: LlmClient = {
  complete(r) {
    captured ??= r;
    return Promise.reject(new ProviderError("captured", false));
  },
};
const llm = new BudgetedLlm({
  inner: capture,
  ledger: new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 1_000_000n, perPrincipalDailyCapMicroUsd: 1_000_000n, day: () => "2026-10-18" }),
  cache: new MemoryCallCache(4),
  costModel: new CostModel({ [model]: { inPerMTok: 0n, outPerMTok: 0n } }),
  principalHash: "probe",
});
await extractInvoice("INVOICE\nInvoice number: X-1\nTotal due: 1.00 USDC\nPay to wallet: 0x27F3f18Ba7E9EC099dfCD278388ec3Aa03C1750B\n", { modelA: model, modelB: null, decimals: 6, parseEligibleCurrencies: ["USDC"] }, { llm });
const req = captured as LlmRequest | null;
if (req === null) throw new Error("no request captured");
const tool = req.tools.find((t) => t.name === "submit_extraction")!;
console.log(`captured: system ${String(req.system.length)} chars, ${String(req.messages.length)} message(s), tools ${req.tools.map((t) => t.name).join("+")}, maxOutputTokens ${String(req.maxOutputTokens)}, schema ${JSON.stringify(tool.inputSchema).length} chars`);

const strip = (n: unknown, keys: string[]): unknown => {
  if (Array.isArray(n)) return n.map((x) => strip(x, keys));
  if (typeof n !== "object" || n === null) return n;
  return Object.fromEntries(Object.entries(n).filter(([k]) => !keys.includes(k)).map(([k, v]) => [k, strip(v, keys)]));
};
const body = (o: { system?: string; schema?: unknown; field?: string; tools?: unknown; messages?: unknown }): Record<string, unknown> => ({
  systemInstruction: { parts: [{ text: o.system ?? req.system }] },
  contents: o.messages ?? req.messages.map((m) => ({ role: "user", parts: [{ text: m.role === "user" ? m.text : "" }] })),
  tools: o.tools ?? [{ functionDeclarations: [{ name: tool.name, description: tool.description, [o.field ?? "parametersJsonSchema"]: o.schema ?? tool.inputSchema }] }],
  toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
  generationConfig: { maxOutputTokens: req.maxOutputTokens, temperature: 0 },
});
const both = [tool, ...req.tools.filter((t) => t.name !== tool.name)];
const variants: Array<[string, Record<string, unknown>]> = [
  ["A real request exactly (submit tool only)", body({})],
  ["B system prompt replaced by one line", body({ system: "Extract the fields." })],
  ["C schema without pattern", body({ schema: strip(tool.inputSchema, ["pattern"]) })],
  ["D schema without pattern/maxLength/maxItems/minimum/maximum", body({ schema: strip(tool.inputSchema, ["pattern", "maxLength", "maxItems", "minimum", "maximum"]) })],
  ["E schema without additionalProperties", body({ schema: strip(tool.inputSchema, ["additionalProperties"]) })],
  ["F both tools (as the extractor sends them)", body({ tools: [{ functionDeclarations: both.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }] })],
  ["G sanitised parameters (OpenAPI style)", body({ schema: toOpenApiSchema(tool.inputSchema), field: "parameters" })],
];
for (const [label, b] of variants) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(b) });
  const j: unknown = await res.json().catch(() => null);
  const e = (j as { error?: { message?: string } } | null)?.error;
  console.log(`${label}: HTTP ${String(res.status)} ${res.ok ? "ok" : String(e?.message ?? "").slice(0, 160)}`);
  await new Promise((r) => setTimeout(r, 14_000));
}
