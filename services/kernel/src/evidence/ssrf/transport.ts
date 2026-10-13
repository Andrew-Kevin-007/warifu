// The real network edge of the guard: a Transport that connects to the PINNED IP, sets Host and TLS SNI/verification to the
// name, and enforces the byte cap while streaming. Optionally the connection is tunnelled through a deny-by-default egress
// proxy (HTTP CONNECT to ip:443): the proxy is where the infrastructure-level allowlist lives, so a bug here still cannot
// reach an internal address. Certificates are always verified against the NAME; verification is never switched off.
//
// This file is the only place that touches sockets for evidence. It has no way to be handed a hostname to resolve: a request
// carries an IP the guard already classified.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import { lookup } from "node:dns/promises";
import type { PinnedRequest, Resolver, Transport, TransportResponse } from "./guard";

export interface EgressProxy {
  readonly host: string;
  readonly port: number;
}

/** The https.request seam: tests replace it, production uses node's. */
export type HttpsRequestFn = typeof httpsRequest;

export interface TransportOptions {
  readonly proxy?: EgressProxy | null;
  readonly httpsRequestFn?: HttpsRequestFn;
  /** Used for the proxy CONNECT hop only. */
  readonly httpRequestFn?: typeof httpRequest;
  readonly userAgent?: string;
}

const USER_AGENT = "symbolon-evidence/1";

/** `[v6]:443` or `v4:443`: the CONNECT authority for a pinned IP. */
export function connectAuthority(ip: string): string {
  return ip.includes(":") ? `[${ip}]:443` : `${ip}:443`;
}

function tunnel(o: TransportOptions, proxy: EgressProxy, ip: string, signal: AbortSignal): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const req = (o.httpRequestFn ?? httpRequest)({ host: proxy.host, port: proxy.port, method: "CONNECT", path: connectAuthority(ip), headers: { host: connectAuthority(ip) }, signal });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error("proxy refused"));
        return;
      }
      resolve(socket);
    });
    req.once("response", (res) => {
      res.resume();
      reject(new Error("proxy did not tunnel"));
    });
    req.once("error", reject);
    req.end();
  });
}

export function createPinnedHttpsTransport(o: TransportOptions = {}): Transport {
  const doRequest = o.httpsRequestFn ?? httpsRequest;
  return {
    async get(req: PinnedRequest): Promise<TransportResponse> {
      const base: HttpsRequestOptions = {
        method: "GET",
        host: req.ip, // connect to the pinned address, never to the name
        port: 443,
        servername: req.host, // SNI and certificate verification use the NAME
        path: req.path,
        headers: { ...req.headers, host: req.host, "user-agent": o.userAgent ?? USER_AGENT, connection: "close" },
        agent: false,
        signal: req.signal,
        rejectUnauthorized: true,
      };
      let opts = base;
      if (o.proxy !== undefined && o.proxy !== null) {
        const sock = await tunnel(o, o.proxy, req.ip, req.signal);
        opts = { ...base, createConnection: () => tlsConnect({ socket: sock, servername: req.host, rejectUnauthorized: true }) };
      }
      return await new Promise<TransportResponse>((resolve, reject) => {
        const r = doRequest(opts, (res) => {
          const chunks: Uint8Array[] = [];
          let total = 0;
          let truncated = false;
          const header = res.headers["location"];
          const location = typeof header === "string" ? header : null;
          res.on("data", (c: Uint8Array) => {
            if (truncated) return;
            const room = req.maxBodyBytes - total;
            if (c.byteLength > room) {
              if (room > 0) chunks.push(c.subarray(0, room));
              total = req.maxBodyBytes;
              truncated = true;
              res.destroy(); // stop reading: the cap is a hard cap, not a suggestion
              resolve({ status: res.statusCode ?? 0, location, body: Buffer.concat(chunks), truncated: true });
              return;
            }
            chunks.push(c);
            total += c.byteLength;
          });
          res.once("end", () => {
            if (!truncated) resolve({ status: res.statusCode ?? 0, location, body: Buffer.concat(chunks), truncated: false });
          });
          res.once("error", (e) => {
            if (!truncated) reject(e);
          });
        });
        r.once("error", reject);
        r.end();
      });
    },
  };
}

/** The system resolver, all answers, in the order returned (verbatim). The guard classifies every one. */
export const systemResolver: Resolver = {
  async resolve(host) {
    const answers = await lookup(host, { all: true, verbatim: true });
    return answers.map((a) => a.address);
  },
};
