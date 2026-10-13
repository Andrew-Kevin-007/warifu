// The thin Circle HTTP client against a mocked fetch (the network edge). Shapes asserted here are the shapes THIS code
// sends and accepts; whether Circle agrees is V-11/V-12/V-26 (docs/VERIFY_LOG.md).
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircleApiError, createCircleHttpApi, txPhase } from "../../src/circle/client";
import { encryptEntitySecret, generateEntitySecret, isValidEntitySecret, uuidFromMaterial } from "../../src/circle/entity-secret";
import { Secret } from "../../src/secret";

const KEY = new Secret("TEST_API_KEY:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb");

interface Seen {
  url: string;
  init: RequestInit;
}
function mockFetch(reply: (u: string) => { status?: number; body: unknown } | "throw"): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    const r = reply(url);
    if (r === "throw") throw new TypeError(`connect failed with key ${KEY.reveal()}`);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("circle http client", () => {
  it("only talks to https://api.circle.com (the key is never sent anywhere else)", () => {
    for (const baseUrl of ["http://api.circle.com", "https://api.circle.com.evil.test", "https://evil.test", "https://api-sandbox.circle.com"]) {
      expect(() => createCircleHttpApi({ apiKey: KEY, baseUrl })).toThrow(RangeError);
    }
  });

  it("creates a contract execution with bearer auth, a JSON body and no redirects", async () => {
    const { fetchImpl, seen } = mockFetch(() => ({ status: 201, body: { data: { id: "0d3c0b26-2b2e-4e0a-9d0e-111111111111", state: "INITIATED" } } }));
    const api = createCircleHttpApi({ apiKey: KEY, fetchImpl });
    const r = await api.createContractExecution({ idempotencyKey: "k", walletId: "w1", contractAddress: "0xabc", callData: "0x01", refId: "r", entitySecretCiphertext: "ct" });
    expect(r).toEqual({ id: "0d3c0b26-2b2e-4e0a-9d0e-111111111111", state: "INITIATED" });
    expect(seen[0]!.url).toBe("https://api.circle.com/v1/w3s/developer/transactions/contractExecution");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${KEY.reveal()}`);
    expect(seen[0]!.init.redirect).toBe("error");
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ idempotencyKey: "k", walletId: "w1", callData: "0x01", entitySecretCiphertext: "ct" });
  });

  it("normalizes the tx hash and drops a malformed one instead of passing it on", async () => {
    const good = `0x${"AB".repeat(32)}`;
    for (const [hash, want] of [[good, `0x${"ab".repeat(32)}`], ["0x1234", null], ["<script>alert(1)</script>", null], [undefined, null]] as const) {
      const { fetchImpl } = mockFetch(() => ({ body: { data: { transaction: { id: "tx-1", state: "SENT", txHash: hash } } } }));
      const t = await createCircleHttpApi({ apiKey: KEY, fetchImpl }).getTransaction("tx-1");
      expect(t.txHash).toBe(want);
    }
  });

  it("an error answer yields a CircleApiError with the status and numeric code only, never the response text or the key", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: { code: 156004, message: `bad key <img src=x onerror=alert(1)> ${KEY.reveal()}` } }));
    const err = (await createCircleHttpApi({ apiKey: KEY, fetchImpl }).getTransaction("tx-1").catch((e: unknown) => e)) as CircleApiError;
    expect(err).toBeInstanceOf(CircleApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe(156004);
    expect(`${err.message}${String(err.cause)}`).not.toContain("onerror");
    expect(`${err.message}${String(err.cause)}`).not.toContain(KEY.reveal());
  });

  it("a transport failure never leaks the key through the cause", async () => {
    const { fetchImpl } = mockFetch(() => "throw");
    const err = (await createCircleHttpApi({ apiKey: KEY, fetchImpl }).entityPublicKey().catch((e: unknown) => e)) as CircleApiError;
    expect(err.status).toBe(0);
    expect(`${err.message}${String(err.cause)}`).not.toContain(KEY.reveal());
  });

  it("an unexpected shape or hostile id is refused (fail closed)", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { data: { id: "../../etc/passwd", state: "INITIATED" } } }));
    await expect(createCircleHttpApi({ apiKey: KEY, fetchImpl }).createContractExecution({ idempotencyKey: "k", walletId: "w", contractAddress: "0x1", callData: "0x", refId: "r", entitySecretCiphertext: "c" })).rejects.toBeInstanceOf(CircleApiError);
    const api = createCircleHttpApi({ apiKey: KEY, fetchImpl: mockFetch(() => ({ body: "not json" })).fetchImpl });
    await expect(api.entityPublicKey()).rejects.toBeInstanceOf(CircleApiError);
    await expect(api.getTransaction("../x")).rejects.toBeInstanceOf(CircleApiError); // never reaches the network with an unsafe id
    await expect(api.notificationPublicKey("bad id")).rejects.toBeInstanceOf(CircleApiError);
  });

  it("txPhase: unknown states are failed, only SENT/CONFIRMED/COMPLETE count as on chain", () => {
    expect(["INITIATED", "QUEUED"].map(txPhase)).toEqual(["PENDING", "PENDING"]);
    expect(["SENT", "CONFIRMED", "COMPLETE"].map(txPhase)).toEqual(["ON_CHAIN", "ON_CHAIN", "ON_CHAIN"]);
    expect(["FAILED", "CANCELLED", "DENIED", "STUCK", "CLEARED", "", "complete", "NEW_STATE"].map(txPhase).every((p) => p === "FAILED")).toBe(true);
  });
});

describe("entity secret", () => {
  it("generates 32 random bytes of hex and validates the format", () => {
    const a = generateEntitySecret();
    expect(isValidEntitySecret(a)).toBe(true);
    expect(generateEntitySecret()).not.toBe(a);
    for (const bad of ["", "AB".repeat(32), "ab".repeat(31), "zz".repeat(32)]) expect(isValidEntitySecret(bad)).toBe(false);
    expect(() => generateEntitySecret(() => Buffer.alloc(16))).toThrow(RangeError);
  });

  it("the ciphertext is RSA-OAEP(SHA-256) of the 32 bytes, fresh every time, and never contains the secret", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const secret = new Secret(generateEntitySecret());
    const a = encryptEntitySecret(secret, pem);
    const b = encryptEntitySecret(secret, pem);
    expect(a).not.toBe(b);
    expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(a, "base64")).toString("hex")).toBe(secret.reveal());
    expect(a).not.toContain(secret.reveal());
    expect(() => encryptEntitySecret(new Secret("short"), pem)).toThrow(RangeError);
  });

  it("uuidFromMaterial is deterministic and v4-shaped", () => {
    expect(uuidFromMaterial("x")).toBe(uuidFromMaterial("x"));
    expect(uuidFromMaterial("x")).not.toBe(uuidFromMaterial("y"));
    expect(uuidFromMaterial("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
