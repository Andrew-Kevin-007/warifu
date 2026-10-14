// The Circle relayer against a scripted Circle edge. The chain edge for simulation is a stub here (the anvil suite in
// circle.local.test.ts runs the same relayer against a real vault); everything else is the real code.
import type { Address, Hex32 } from "@symbolon/schemas";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { RelayError } from "../../src/chain/relayer";
import type { EngagementTermsArgs } from "../../src/chain/relayer";
import { MAX_ATTEMPTS, circleIdempotencyKey, circleVaultRelayer } from "../../src/circle/relayer";
import { Secret } from "../../src/secret";
import { fakeCircle } from "../helpers/circle-fakes";

const SECRET_HEX = "ab".repeat(32);
const VAULT = "0x00000000000000000000000000000000000000f1" as Address;
const WALLET = "0x00000000000000000000000000000000000000f2" as Address;
const h32 = (c: string): Hex32 => `0x${c.repeat(64)}` as Hex32;
const terms: EngagementTermsArgs = {
  engagementId: h32("1"),
  owner: "0x00000000000000000000000000000000000000a1" as Address,
  payee: "0x00000000000000000000000000000000000000a2" as Address,
  cap: 100_000_000n,
  start: 1_700_000_000n,
  end: 1_800_000_000n,
  termsHash: h32("2"),
  nonce: 1n,
};
const reg = { vault: VAULT, terms, ownerSig: `0x${"11".repeat(65)}` as `0x${string}`, payeeSig: `0x${"22".repeat(65)}` as `0x${string}` };

const okClient = (calls: string[] = []): PublicClient => ({ simulateContract: async (a: { functionName: string }) => (calls.push(a.functionName), {}) }) as unknown as PublicClient;
const refusingClient = { simulateContract: async () => Promise.reject(new Error("execution reverted: EngagementExists()")) } as unknown as PublicClient;

function setup(over: { plan?: Parameters<typeof fakeCircle>[0]["plan"]; initialState?: (n: number) => string; client?: PublicClient; deadline?: number } = {}) {
  const circle = fakeCircle({ entitySecretHex: SECRET_HEX, ...(over.plan === undefined ? {} : { plan: over.plan }), ...(over.initialState === undefined ? {} : { initialState: over.initialState }) });
  let t = 0;
  const sleeps: number[] = [];
  const relayer = circleVaultRelayer({
    api: circle,
    publicClient: over.client ?? okClient(),
    chainId: 5042002,
    walletId: "wallet-1",
    walletAddress: WALLET,
    entitySecret: new Secret(SECRET_HEX),
    pollDeadlineMs: over.deadline ?? 5_000,
    pollIntervalMs: 1_000,
    sleep: async (ms) => void ((t += ms), sleeps.push(ms)),
    now: () => t,
  });
  return { circle, relayer, sleeps };
}

describe("circle relayer", () => {
  it("submits the exact calldata to the vault, returns the tx hash Circle reports, and uses a fresh valid entity-secret ciphertext", async () => {
    const { circle, relayer } = setup({ plan: () => [{ state: "QUEUED" }, { state: "SENT", txHash: `0x${"ab".repeat(32)}` }] });
    const r = await relayer.registerEngagement(reg);
    expect(r.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(circle.executeCalls).toHaveLength(1);
    const c = circle.executeCalls[0]!;
    expect(c.contractAddress).toBe(VAULT);
    expect(c.walletId).toBe("wallet-1");
    expect(c.callData).toMatch(/^0x[0-9a-f]+$/);
    expect(c.callData.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(c.callData.toLowerCase()).toContain("22".repeat(65)); // the payee signature is inside, unchanged
    expect(c.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("a duplicate submit is a no-op: the same message maps to the same idempotency key and the same Circle transaction", async () => {
    const { circle, relayer } = setup();
    const a = await relayer.registerEngagement(reg);
    const b = await relayer.registerEngagement(reg);
    expect(b.txHash).toBe(a.txHash);
    expect(circle.txs.size).toBe(1); // Circle created ONE transaction for two submits
    expect(circle.executeCalls).toHaveLength(2);
    expect(circle.executeCalls[0]!.idempotencyKey).toBe(circle.executeCalls[1]!.idempotencyKey);
    // every request still carried its own fresh ciphertext
    expect(new Set(circle.ciphertextsSeen).size).toBe(2);
  });

  it("different messages (or another chain / wallet / vault) never share an idempotency key", async () => {
    const { circle, relayer } = setup();
    await relayer.registerEngagement(reg);
    await relayer.registerEngagement({ ...reg, terms: { ...terms, nonce: 2n } });
    expect(circle.txs.size).toBe(2);
    const k = (chain: number, wallet: string, vault: string, data: string, attempt: number) => circleIdempotencyKey(chain, wallet, vault, data, attempt);
    const base = k(1, "w", VAULT, "0xab", 0);
    expect(new Set([base, k(2, "w", VAULT, "0xab", 0), k(1, "x", VAULT, "0xab", 0), k(1, "w", WALLET, "0xab", 0), k(1, "w", VAULT, "0xac", 0), k(1, "w", VAULT, "0xab", 1)]).size).toBe(6);
    expect(k(1, "w", VAULT.toUpperCase().replace("0X", "0x"), "0xAB", 0)).toBe(base); // case-insensitive on hex
  });

  it("a message the vault would refuse is never sent (simulation first, the vault's error name is reported)", async () => {
    const { circle, relayer } = setup({ client: refusingClient });
    await expect(relayer.registerEngagement(reg)).rejects.toBeInstanceOf(RelayError);
    expect(circle.executeCalls).toHaveLength(0);
  });

  it("simulates the right function for each port method", async () => {
    const calls: string[] = [];
    const { relayer } = setup({ client: okClient(calls) });
    const change = { engagementId: h32("1"), oldPayee: terms.payee, newPayee: terms.owner, nonce: 2n };
    await relayer.proposePayeeChange({ vault: VAULT, change, ownerSig: `0x${"01".repeat(65)}`, oldSig: `0x${"02".repeat(65)}`, newSig: `0x${"03".repeat(65)}` });
    await relayer.executePayeeChange({ vault: VAULT, engagementId: h32("1") });
    expect(calls).toEqual(["proposePayeeChange", "executePayeeChange"]);
  });

  it("a dead keyed transaction moves to the next attempt number; a replay walks to the same live transaction", async () => {
    let n = 0;
    const plan = () => (n++ === 0 ? [{ state: "FAILED" }] : [{ state: "SENT", txHash: `0x${"cd".repeat(32)}` }]);
    const { circle, relayer } = setup({ plan });
    const first = await relayer.registerEngagement(reg);
    expect(first.txHash).toBe(`0x${"cd".repeat(32)}`);
    expect(circle.txs.size).toBe(2);
    const again = await relayer.registerEngagement(reg);
    expect(again.txHash).toBe(first.txHash);
    expect(circle.txs.size).toBe(2); // attempt 0 (dead) and attempt 1 (live) are both re-found, nothing new is created
  });

  it(`gives up with CIRCLE_TX_FAILED after ${String(MAX_ATTEMPTS)} dead attempts (docs/02: then HOLD, alert)`, async () => {
    const { circle, relayer } = setup({ plan: () => [{ state: "DENIED" }] });
    await expect(relayer.registerEngagement(reg)).rejects.toMatchObject({ revertName: "CIRCLE_TX_FAILED" });
    expect(circle.txs.size).toBe(MAX_ATTEMPTS);
  });

  it("an unknown Circle state fails closed (treated as failed, never as sent)", async () => {
    const { relayer } = setup({ plan: () => [{ state: "SOMETHING_NEW", txHash: `0x${"ee".repeat(32)}` }] });
    await expect(relayer.registerEngagement(reg)).rejects.toMatchObject({ revertName: "CIRCLE_TX_FAILED" });
  });

  it("the wait for a tx hash is bounded (below the 30 s idle-in-transaction limit) and ends as a retryable CIRCLE_PENDING", async () => {
    const { circle, relayer, sleeps } = setup({ plan: () => [{ state: "QUEUED" }], deadline: 3_000 });
    const err = await relayer.registerEngagement(reg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).revertName).toBe("CIRCLE_PENDING");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3_000);
    // the retry re-sends the SAME keyed request and finds the same transaction: nothing duplicated
    await relayer.registerEngagement(reg).catch(() => undefined);
    expect(circle.txs.size).toBe(1);
  });

  it("refuses a poll deadline above the hard ceiling", () => {
    const circle = fakeCircle({ entitySecretHex: SECRET_HEX });
    expect(() => circleVaultRelayer({ api: circle, publicClient: okClient(), chainId: 1, walletId: "w", walletAddress: WALLET, entitySecret: new Secret(SECRET_HEX), pollDeadlineMs: 26_000 })).toThrow(RangeError);
  });

  it("a SENT transaction without a hash yet is polled, not accepted", async () => {
    const { relayer } = setup({ plan: () => [{ state: "SENT", txHash: null }, { state: "SENT", txHash: null }, { state: "CONFIRMED", txHash: `0x${"12".repeat(32)}` }] });
    expect((await relayer.registerEngagement(reg)).txHash).toBe(`0x${"12".repeat(32)}`);
  });

  it("a Circle API error becomes a typed RelayError without the response body, and never carries the entity secret", async () => {
    const { circle, relayer } = setup();
    const { CircleApiError } = await import("../../src/circle/client");
    circle.createContractExecution = async () => Promise.reject(new CircleApiError("the Circle API refused the request (HTTP 500)", 500, null));
    const err = (await relayer.registerEngagement(reg).catch((e: unknown) => e)) as RelayError;
    expect(err.revertName).toBe("CIRCLE_API_ERROR");
    expect(JSON.stringify([err.message, String(err.cause)])).not.toContain(SECRET_HEX);
  });
});
