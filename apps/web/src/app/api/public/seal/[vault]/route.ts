// The Seal badge (SVG). App origin only (denied on the challenge profile, INV-16). The state comes from the certificate
// service (live) or the replay bundle (labelled RECORDED); when neither has a certificate the seal is blank, never "valid".
import { getCertificate, isAddress } from "@/server/public-data";
import { renderSealSvg } from "@/lib/seal";
import type { SealInput } from "@/lib/seal";

export const dynamic = "force-dynamic";

const HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export async function GET(_req: Request, ctx: { params: Promise<{ vault: string }> }): Promise<Response> {
  const { vault } = await ctx.params;
  if (!isAddress(vault)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const r = await getCertificate(vault);
  let input: SealInput;
  if (r.source === "UNAVAILABLE") {
    input = { state: "NOT_COMPUTED", bound: null, horizonLabel: null, blockNumber: null, source: null };
  } else {
    const v = r.data.view;
    const h = v.horizons.find((x) => x.label === "24h") ?? v.horizons[0];
    const label = v.status.label;
    input = {
      state: label,
      bound: h?.valueDisplay ?? null,
      horizonLabel: h?.label ?? null,
      blockNumber: v.asOf.blockNumber,
      source: r.source,
    };
  }
  return new Response(renderSealSvg(input), { headers: HEADERS });
}
