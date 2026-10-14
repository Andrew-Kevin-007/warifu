import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { recheckHolds } from "../../src/release/scheduler";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { openReleaseWorld } from "../helpers/release-world";
import type { ReleaseWorld } from "../helpers/release-world";
import { call } from "../helpers/world";

const out = (x: unknown): void => appendFileSync("D:/symbolon/explore.txt", `${JSON.stringify(x, null, 1)}\n`);

describe.skipIf(!dbSuiteEnabled("explore"))("explore", () => {
  let r: ReleaseWorld;
  beforeAll(async () => {
    r = await openReleaseWorld();
  }, 120_000);
  afterAll(async () => {
    await r.close();
  });
  it("dump", async () => {
    const a = await r.submit();
    out([a.status, a.json.decision?.verdict, a.json.decision?.reasons, a.json.error]);
    await r.ack();
    const n = await recheckHolds(r.release(), r.tenantId, { milestoneId: r.milestone });
    const g = await call(r.app(), "GET", `/v1/intents/${a.json.intentId}`, r.token());
    out([n, g.status, g.json.decision, g.json.release]);
  });
});
