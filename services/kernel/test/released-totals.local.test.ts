// WP-05 merge: loadReleasedTotals now also counts the tenant's RELEASE decisions in the same rolling 24 h window as the
// payee count (K-12 velocity.maxReleasesPerDay, ctx.released.tenantCountDay). Real Postgres (V-15: "local"); synthetic rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadReleasedTotals } from "../src/db/repo";
import { T_PILOT, insertDecisionChain, insertTenant } from "./db/fixtures";
import { dbSuiteEnabled, openTestDb, run } from "./helpers/pgdb";
import type { TestDb } from "./helpers/pgdb";

const enabled = dbSuiteEnabled("released-totals.local");

describe.skipIf(!enabled)("local: released totals for K-12", () => {
  let t: TestDb;
  beforeAll(() => {
    t = openTestDb("production");
    insertTenant(t.name, { id: T_PILOT, kind: "pilot" });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  }, 120_000);

  it("tenantCountDay counts RELEASE decisions of the last 24 h for every payee; a HOLD, an older release and the re-evaluated decision do not count", async () => {
    const first = insertDecisionChain(t.name, { tenantId: T_PILOT, amount: 1n });
    insertDecisionChain(t.name, { tenantId: T_PILOT, amount: 2n });
    insertDecisionChain(t.name, { tenantId: T_PILOT, amount: 4n, verdict: "HOLD" });
    const old = insertDecisionChain(t.name, { tenantId: T_PILOT, amount: 8n });
    run(t.name, `update decisions set created_at = now() - interval '25 hours' where decision_id = '${old.decisionId}';`);
    const now = `${new Date(Date.now() + 1_000).toISOString().slice(0, 19)}Z`;
    const totals = await loadReleasedTotals(t.db, T_PILOT, now, null, null, null);
    expect([totals.tenantCountDay, totals.tenantDay]).toEqual([2, 3n]);
    expect((await loadReleasedTotals(t.db, T_PILOT, now, null, null, first.decisionId)).tenantCountDay).toBe(1);
  });
});
