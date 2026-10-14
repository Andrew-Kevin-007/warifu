// Same-origin mutation proxy for owner/payee actions (TB-1/TB-2). Owner and payee actions never rely on a session: the
// kernel verifies the EIP-712 signature carried in the body. This layer only (a) keeps the HMAC service token and kernel
// URL on the server, (b) refuses cross-origin and oversized posts, (c) passes the kernel's status and error code through.
import { kernelCall } from "./kernel-client";

const MAX_BODY_BYTES = 16 * 1024;

export async function proxyPost(req: Request, path: string): Promise<Response> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin === null || host === null || new URL(origin).host !== host) {
    return Response.json({ error: { code: "BAD_ORIGIN" } }, { status: 403 });
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: { code: "TOO_LARGE" } }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: { code: "BAD_REQUEST" } }, { status: 400 });
  }
  const key = req.headers.get("idempotency-key");
  const r = await kernelCall<unknown>(path, { method: "POST", body, ...(key !== null && /^[A-Za-z0-9_-]{8,80}$/.test(key) ? { idempotencyKey: key } : {}) });
  if (r.ok) return Response.json(r.data, { status: r.status, headers: { "Cache-Control": "no-store" } });
  return Response.json({ error: { code: r.code } }, { status: r.status >= 400 && r.status < 600 ? r.status : 502, headers: { "Cache-Control": "no-store" } });
}
