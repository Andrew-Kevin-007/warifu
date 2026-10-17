import { challengeGet } from "@/server/challenge-proxy";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return challengeGet("/v1/challenge/scenarios");
}
