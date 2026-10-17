// Public challenge proxy (WP-33, docs/15): the browser talks to THIS origin only; this module forwards to the sandbox kernel with a
// short-lived service token the browser never sees. No cookies, no wallet code (INV-16). When the kernel is unreachable, or the
// challenge is at L2, the answer says so (source UNAVAILABLE, level L2) and the page falls back to the RECORDED replay (INV-21).
import { kernelCall } from "./kernel-client";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_CHARS = 8 * 1024; // 4 KiB of text, JSON-escaped, plus the envelope

function clientIp(req: Request): string | undefined {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = fwd !== undefined && fwd !== "" ? fwd : req.headers.get("x-real-ip") ?? undefined;
  return ip;
}

function unavailable(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ source: "UNAVAILABLE", level: "L2", code, reason: "the live challenge is not reachable right now; the recorded replay is shown instead", ...extra }, { status, headers: NO_STORE });
}

export async function challengeGet(path: string): Promise<Response> {
  const r = await kernelCall<unknown>(path);
  if (r.ok) return Response.json({ source: "LIVE", data: r.data }, { headers: NO_STORE });
  return r.status === 404 ? Response.json({ source: "LIVE", code: "NOT_FOUND" }, { status: 404, headers: NO_STORE }) : unavailable(503, r.code);
}

export async function challengePost(req: Request, path: string): Promise<Response> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin === null || host === null || new URL(origin).host !== host) return Response.json({ code: "BAD_ORIGIN" }, { status: 403, headers: NO_STORE });
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return Response.json({ code: "TOO_LARGE" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: "BAD_REQUEST" }, { status: 400, headers: NO_STORE });
  }
  const ip = clientIp(req);
  const r = await kernelCall<unknown>(path, { method: "POST", body, ...(ip === undefined ? {} : { clientIp: ip }) });
  if (r.ok) return Response.json({ source: "LIVE", data: r.data }, { status: r.status, headers: NO_STORE });
  const headers: Record<string, string> = { ...NO_STORE };
  if (r.retryAfter !== undefined) headers["Retry-After"] = String(r.retryAfter);
  // Pass the kernel's own verdict on the request through (rate limit, bad input, level), never a stack or a body of ours.
  if (r.status === 429 || r.status === 400 || r.status === 404 || r.status === 413 || r.status === 422) return Response.json({ source: "LIVE", code: r.code, detail: r.detail ?? {} }, { status: r.status, headers });
  if (r.status === 503 && r.detail?.["level"] !== undefined) return Response.json({ source: "LIVE", code: r.code, detail: r.detail }, { status: 503, headers });
  return unavailable(503, r.code, r.retryAfter === undefined ? {} : { retryAfter: r.retryAfter });
}
