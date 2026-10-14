import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const dynamic = "force-dynamic";

// Committed closed-form vs exhaustive-enumeration campaign (packages/blast-radius/results). RECORDED.
export function GET(): Response {
  try {
    const p = join(resolve(process.cwd(), "..", ".."), "packages", "blast-radius", "results", "blast-closed-form.json");
    const json: unknown = JSON.parse(readFileSync(p, "utf8"));
    return Response.json({ source: "RECORDED", results: json }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ source: "UNAVAILABLE", reason: "no recorded blast-radius results" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
