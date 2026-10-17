import { challengeGet } from "@/server/challenge-proxy";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ source: "LIVE", code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return challengeGet(`/v1/challenge/attempts/${id}`);
}
