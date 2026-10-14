import { LiteInputError, auditLiteFromJson } from "@symbolon/blast-radius/lite";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4096;

// Blast Radius Lite: numbers in, closed-form report out. Pure computation; nothing is stored, no wallet or chain is read.
export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BYTES) return Response.json({ error: { code: "TOO_LARGE" } }, { status: 413 });
  try {
    return Response.json({ report: auditLiteFromJson(text) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof LiteInputError) return Response.json({ error: { code: "INVALID_INPUT", issues: e.issues.slice(0, 10) } }, { status: 400 });
    return Response.json({ error: { code: "ERROR" } }, { status: 500 });
  }
}
