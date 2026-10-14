export const dynamic = "force-dynamic";

// Pilot stats come only from the sanitized public_pilot_stats view (tenants.kind='pilot', INV-17). The kernel exposes no
// such route yet, so this reports "not available" instead of inventing a number; demo, challenge and house traffic are
// never counted.
export function GET(): Response {
  return Response.json(
    { source: "UNAVAILABLE", reason: "no pilot statistics are published by the kernel yet", countsExclude: ["demo tenants", "challenge attempts", "house attackers", "internal self-payments"] },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
