// Finds which part of a Gemini request is refused: eight requests that add one feature at a time, printing only HTTP status and Google's message.
//   $env:GEMINI_API_KEY='...'
//   node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./packages/blast-radius/scripts/register-ts.mjs scripts/gemini-probe.ts <model>
import { extractorTools } from "../packages/extractor/src/tools.ts";
import { toOpenApiSchema } from "../packages/extractor/src/llm/gemini.ts";

const key = process.env["GEMINI_API_KEY"] ?? "";
const model = process.argv[2] ?? "gemini-3.8-flash";
if (key.length < 20) throw new Error("set GEMINI_API_KEY");
const real = extractorTools()[0]!;
const small = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
const user = { role: "user", parts: [{ text: "Invoice INV-1 total 1.00 USDC. Call the tool with a=INV-1." }] };
const sys = { parts: [{ text: "You extract fields." }] };
const decl = (schema: unknown, field: string) => [{ functionDeclarations: [{ name: "submit_extraction", description: "Submit fields.", [field]: schema }] }];
const tc = { functionCallingConfig: { mode: "ANY" } };
const tcOne = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_extraction"] } };

const variants: Array<[string, Record<string, unknown>]> = [
  ["1 plain text", { contents: [user] }],
  ["2 + systemInstruction", { contents: [user], systemInstruction: sys }],
  ["3 + tool (small schema, parametersJsonSchema)", { contents: [user], systemInstruction: sys, tools: decl(small, "parametersJsonSchema") }],
  ["4 + toolConfig ANY", { contents: [user], systemInstruction: sys, tools: decl(small, "parametersJsonSchema"), toolConfig: tc }],
  ["5 + allowedFunctionNames", { contents: [user], systemInstruction: sys, tools: decl(small, "parametersJsonSchema"), toolConfig: tcOne }],
  ["6 + generationConfig (maxOutputTokens, temperature 0)", { contents: [user], systemInstruction: sys, tools: decl(small, "parametersJsonSchema"), toolConfig: tcOne, generationConfig: { maxOutputTokens: 1024, temperature: 0 } }],
  ["7 real extractor schema, parametersJsonSchema", { contents: [user], systemInstruction: sys, tools: decl(real.inputSchema, "parametersJsonSchema"), toolConfig: tcOne }],
  ["8 real extractor schema, sanitised parameters", { contents: [user], systemInstruction: sys, tools: decl(toOpenApiSchema(real.inputSchema), "parameters"), toolConfig: tcOne }],
];

for (const [label, body] of variants) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const j: unknown = await res.json().catch(() => null);
  const e = (j as { error?: { message?: string } } | null)?.error;
  const parts = (j as { candidates?: Array<{ content?: { parts?: Array<{ functionCall?: unknown; text?: string }> } }> } | null)?.candidates?.[0]?.content?.parts ?? [];
  console.log(`${label}: HTTP ${String(res.status)} ${res.ok ? (parts.some((p) => p.functionCall !== undefined) ? "(function call returned)" : "(text returned)") : String(e?.message ?? "").slice(0, 200)}`);
}
