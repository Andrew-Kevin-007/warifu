import { proxyPost } from "@/server/owner-proxy";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return proxyPost(req, "/v1/approvals");
}
