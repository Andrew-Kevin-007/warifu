// A tenant created by `pnpm kernel:tenant` stores its vault address lowercase; the kernel must still resolve it (found on the first
// real Arc testnet run: every dashboard read answered NO_VAULT).
import { describe, expect, it } from "vitest";
import { ContextError, resolveTenantVault } from "../src/context/build";
import type { Queryable } from "../src/db/pool";
import type { ChainReader } from "../src/chain/reader";

const VAULT = "0x00B513896E67C73fC407780cF8568fdc81596c82";

function db(vaultAddress: string | null): Queryable {
  return {
    query: async () => ({ rows: [{ id: "t", kind: "pilot", vault_address: vaultAddress, chain_id: "5042002", network: "testnet", policy: {}, policy_hash: "0x" }] }),
  } as unknown as Queryable;
}
const chain = { chainId: 5042002 } as unknown as ChainReader;

describe("resolveTenantVault", () => {
  it("accepts the lowercase address the tenant command stores and returns it checksummed", async () => {
    const r = await resolveTenantVault(db(VAULT.toLowerCase()), "t", chain);
    expect(r.vault).toBe(VAULT);
    expect(r.chainId).toBe(5042002);
  });

  it("still fails closed on a missing or malformed vault", async () => {
    await expect(resolveTenantVault(db(null), "t", chain)).rejects.toBeInstanceOf(ContextError);
    await expect(resolveTenantVault(db("0x1234"), "t", chain)).rejects.toMatchObject({ code: "NO_VAULT" });
  });
});
