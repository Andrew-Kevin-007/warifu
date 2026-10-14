import { getCertificate } from "@/server/public-data";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ vault: string }> }): Promise<Response> {
  const { vault } = await ctx.params;
  const r = await getCertificate(vault);
  if (r.source === "UNAVAILABLE") return Response.json({ error: { code: "NOT_FOUND", message: r.reason } }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json({ source: r.source, certificate: r.data.certificate, view: r.data.view, verification: r.data.verification }, { headers: { "Cache-Control": "no-store" } });
}
