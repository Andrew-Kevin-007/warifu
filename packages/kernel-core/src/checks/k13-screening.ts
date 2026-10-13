// K-13 COUNTERPARTY_SCREEN — HOLD / REJECT — P1 (P0 if V-01 clears) (docs/04 K-13; WP-05).
//   HIT (fresh or not, policy on or off)          => REJECT SCREEN_HIT (a known hit is never ignored)
//   screening disabled by policy                  => SKIP, visible in the receipt as SCREENING_DISABLED
//   no record / UNKNOWN / stale / dated after now => HOLD SCREENING_PENDING (the service triggers a screen)
//   CLEAR and fresh (<= screening.staleAfterHours) => PASS
// The screening record is assembled by the service (V-01: Circle Compliance Engine access is unverified).
import { epochSecondsFromIso } from "@symbolon/schemas";
import type { CheckResult } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "../context";
import { fail, pass, skip } from "../verdict";

export function checkK13(ctx: KernelContext, policy: LoadedPolicy): CheckResult {
  const s = ctx.screening;
  if (s !== null && s.status === "HIT") return fail("K-13", "REJECT", "SCREEN_HIT", "counterparty screening reported a hit");
  if (!policy.policy.screening.required) return skip("K-13", "SCREENING_DISABLED", "screening disabled by policy");
  if (s === null) return fail("K-13", "HOLD", "SCREENING_PENDING", "no screening record yet");
  const age = epochSecondsFromIso(ctx.now) - epochSecondsFromIso(s.checkedAt);
  if (age < 0n) return fail("K-13", "HOLD", "SCREENING_PENDING", "screening record is dated after now");
  if (age > BigInt(policy.policy.screening.staleAfterHours) * 3_600n) return fail("K-13", "HOLD", "SCREENING_PENDING", "screening record is stale");
  if (s.status !== "CLEAR") return fail("K-13", "HOLD", "SCREENING_PENDING", "screening status is not CLEAR");
  return pass("K-13", `screened CLEAR by ${s.provider}`);
}
