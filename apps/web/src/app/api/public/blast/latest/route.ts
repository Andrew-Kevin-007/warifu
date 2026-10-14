import { loadBlastClosedForm } from "@/server/recorded";

export const dynamic = "force-dynamic";

// Committed closed-form vs exhaustive-enumeration campaign (packages/blast-radius/results). RECORDED.
export function GET(): Response {
  return Response.json({ source: "RECORDED", results: loadBlastClosedForm() }, { headers: { "Cache-Control": "no-store" } });
}
