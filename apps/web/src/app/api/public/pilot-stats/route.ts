import { kernelCall } from "@/server/kernel-client";

export const dynamic = "force-dynamic";

const EXCLUDES = ["demo tenants", "challenge attempts", "house attackers", "internal self-payments"];

// Pilot stats come only from the kernel's `public_pilot_stats` view (tenants.kind='pilot', INV-17). If the kernel is not
// reachable this reports "unavailable" instead of inventing a number; demo, challenge and house traffic are never counted.
export async function GET(): Promise<Response> {
  const r = await kernelCall<{ stats: unknown[]; countsExclude: string[] }>("/v1/pilot-stats");
  if (r.ok) return Response.json({ source: "LIVE", ...r.data }, { headers: { "Cache-Control": "no-store" } });
  return Response.json(
    { source: "UNAVAILABLE", reason: "the kernel is not reachable from this deployment", countsExclude: EXCLUDES },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
