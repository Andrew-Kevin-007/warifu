import { challengePost } from "@/server/challenge-proxy";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return challengePost(req, "/v1/challenge/attempts");
}
