// Per-request CSP nonce + security headers (WP-17, Next 16 `proxy` convention). No cookies are ever set here, and the
// `challenge` profile only serves its allow-listed public routes (INV-16).
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PROFILE, buildCsp, isRouteAllowed, securityHeaders } from "./lib/security";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!isRouteAllowed(PROFILE, pathname)) {
    const res = new NextResponse("Not found", { status: 404 });
    for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
    return res;
  }
  const nonce = btoa(crypto.randomUUID());
  const rpc = process.env.NEXT_PUBLIC_ARC_RPC_URL;
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV !== "production",
    profile: PROFILE,
    connectOrigins: rpc ? [new URL(rpc).origin] : [],
  });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
