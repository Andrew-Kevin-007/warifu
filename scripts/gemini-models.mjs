/* global fetch */
// Lists the Gemini model ids your free-tier key can call with generateContent (ids only; never prints the key).
//   $env:GEMINI_API_KEY='...'   (this window only; never paste it anywhere)
//   node scripts/gemini-models.mjs
const key = process.env.GEMINI_API_KEY ?? '';
if (key.length < 20) { console.error('set GEMINI_API_KEY first'); process.exit(2); }
const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
const j = await r.json().catch(() => null);
if (!r.ok) { console.error(`HTTP ${r.status} ${String(j?.error?.message ?? '').slice(0, 160)}`); process.exit(1); }
for (const m of j.models ?? []) if ((m.supportedGenerationMethods ?? []).includes('generateContent') && /gemini/i.test(m.name)) console.log(m.name.replace(/^models\//, ''));
