import { getReceipt } from "@/server/public-data";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }): Promise<Response> {
  const { hash } = await ctx.params;
  const r = await getReceipt(hash.toLowerCase());
  if (r.source === "UNAVAILABLE") return Response.json({ error: { code: "NOT_FOUND", message: r.reason } }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json({ source: r.source, ...r.data.signed, tx: r.data.tx, ...(r.data.unit === undefined ? {} : { unit: r.data.unit }) }, { headers: { "Cache-Control": "no-store" } });
}
