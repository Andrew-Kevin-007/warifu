// Share card image for one public receipt. App origin only (INV-16). A receipt that is not public renders no card (404),
// never a made-up one.
import { getReceipt, isHex32 } from "@/server/public-data";
import { niceTry } from "@/lib/nice-try";
import { renderCardSvg } from "@/lib/share-card";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ receiptHash: string }> }): Promise<Response> {
  const hash = (await ctx.params).receiptHash.toLowerCase();
  if (!isHex32(hash)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const r = await getReceipt(hash);
  if (r.source === "UNAVAILABLE") return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const d = r.data.signed.receipt.decision;
  const n = niceTry({ verdict: d.verdict, reasons: d.reasons, receiptHash: hash });
  const svg = renderCardSvg({ verdict: d.verdict, reasonCode: n.reasonCode, receiptHash: hash, line: n.line, source: r.source });
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
