import { proxyPost } from "@/server/owner-proxy";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!/^0x[0-9a-f]{64}$/.test(id)) return Response.json({ error: { code: "BAD_REQUEST" } }, { status: 400 });
  return proxyPost(req, `/v1/engagements/${id}/sign`);
}
