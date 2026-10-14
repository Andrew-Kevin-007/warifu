import { loadAttackMatrix, loadBundle } from "@/server/recorded";

export const dynamic = "force-dynamic";

// Public, sanitized: the committed harness output. Source is always RECORDED (the harness is not a live service).
export function GET(): Response {
  const matrix = loadAttackMatrix();
  if (matrix === null) return Response.json({ source: "UNAVAILABLE", reason: "no recorded attack matrix" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const b = loadBundle();
  return Response.json(
    { source: "RECORDED", bundleHash: b?.bundleHash ?? null, builtAt: b?.builtAt ?? null, mode: matrix.mode, totals: matrix.totals, honest: matrix.honest, holdout: matrix.holdout, limitations: matrix.limitations },
    { headers: { "Cache-Control": "no-store" } },
  );
}
