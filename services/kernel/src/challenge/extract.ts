// The sandbox extractor edge (docs/15 section 5): the visitor's plain text goes to the dual-model extractor behind the budget ledger
// and nothing else. This module is the ONLY place in services/ that reads a model key; it imports no signer, chain or release code
// (dependency-cruiser `extractor-cannot-reach-release-path`), and its output is two advisory readings that the kernel re-derives
// from and never trusts (INV-8).
//
// Prices are supplied by the operator (CHALLENGE_MODEL_PRICES): nothing here assumes what a provider charges (VERIFY V-22), and an
// unpriced model cannot be budgeted, so free-form stays off until the table exists.
import { BudgetedLlm, CostModel, DEFAULT_MODELS, MemoryCallCache, createAnthropicClient, extractInvoice, ruleRead } from "@symbolon/extractor";
import type { CallCache, ModelPrice } from "@symbolon/extractor";
import type { PgBudgetLedger } from "./ledger";
import type { ExtractOutcome } from "./service";

/** {"model-id": {"inPerMTok": "<micro-USD per million input tokens>", "outPerMTok": "<same, output>"}}; digits only. Throws on anything else. */
export function parsePrices(raw: string | undefined): Record<string, ModelPrice> {
  if (raw === undefined || raw.trim() === "") return {};
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("CHALLENGE_MODEL_PRICES must be a JSON object");
  const out: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(v)) {
    const o = p as { inPerMTok?: unknown; outPerMTok?: unknown };
    if (!/^[A-Za-z0-9._:/@-]{1,128}$/.test(model) || typeof o.inPerMTok !== "string" || typeof o.outPerMTok !== "string" || !/^[0-9]{1,15}$/.test(o.inPerMTok) || !/^[0-9]{1,15}$/.test(o.outPerMTok)) {
      throw new Error(`CHALLENGE_MODEL_PRICES: bad entry for ${model.slice(0, 40)}`);
    }
    out[model] = { inPerMTok: BigInt(o.inPerMTok), outPerMTok: BigInt(o.outPerMTok) };
  }
  return out;
}

/**
 * The keyless reader: the deterministic rule reader (no model, no network, no cost). One reading is cloned into the second slot because the
 * kernel compares two readings; the attempt is labelled "rules" everywhere, so nobody mistakes it for two independent models. Anything it cannot
 * read unambiguously is left null with an anomaly, which the kernel turns into a HOLD or an escalation.
 */
export function makeRuleReaderEdge(): (text: string, principalHash: string) => Promise<ExtractOutcome> {
  return (text) => {
    const r = ruleRead(text);
    if (!r.ok) return Promise.resolve({ ok: false, code: r.code, disposition: r.disposition });
    return Promise.resolve({ ok: true, a: r.value, b: structuredClone(r.value), reader: "rules" });
  };
}

export interface ExtractEdgeOptions {
  readonly apiKey: string;
  readonly ledger: PgBudgetLedger;
  readonly prices: Readonly<Record<string, ModelPrice>>;
  readonly fetchImpl?: typeof fetch;
  readonly modelA?: string;
  readonly modelB?: string | null;
  readonly cache?: CallCache;
}

/** null when the edge cannot work (no key, or a model has no price): the caller then reports free-form as off. */
export function makeExtractEdge(o: ExtractEdgeOptions): ((text: string, principalHash: string) => Promise<ExtractOutcome>) | null {
  const modelA = o.modelA ?? DEFAULT_MODELS.extractorA;
  const modelB = o.modelB === undefined ? DEFAULT_MODELS.extractorB : o.modelB;
  if (o.apiKey === "") return null;
  const cost = new CostModel(o.prices);
  if (!cost.has(modelA) || (modelB !== null && !cost.has(modelB))) return null;
  const inner = createAnthropicClient({ apiKey: o.apiKey, fetch: o.fetchImpl ?? fetch });
  const cache = o.cache ?? new MemoryCallCache(512);
  return async (text, principalHash) => {
    const llm = new BudgetedLlm({ inner, ledger: o.ledger, cache, costModel: cost, principalHash });
    // The sandbox policy treats a printed USD as USDC (docs/15 scenarios, `treatUsdAsUsdc`), so both spellings may yield base units; a bare "$" never does.
    const r = await extractInvoice(text, { modelA, modelB, decimals: 6, parseEligibleCurrencies: ["USDC", "USD"] }, { llm });
    if (r.ok) return { ok: true, a: r.value.a, b: r.value.b, reader: "model" };
    return { ok: false, code: r.failure.code, disposition: r.failure.disposition };
  };
}
