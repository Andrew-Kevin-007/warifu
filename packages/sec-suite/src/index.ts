// @symbolon/sec-suite — SEC-01..14 live here (WP-37). See docs/13_TEST_PLAN.md §4.6 for the contract.
export const PACKAGE_NAME = "@symbolon/sec-suite" as const;

/**
 * Every SEC test and where it is exercised (repo-relative paths). `sec:local` runs this package; the files outside it are run by `pnpm test`.
 * A test that stops existing fails the tracker test, so a SEC item can never be dropped silently.
 */
export const SEC_TESTS = [
  { id: "SEC-01", what: "XSS corpus renders inert on every public route", sandbox: true, exercisedIn: ["apps/web/test/sec01-xss.test.ts", "apps/web/test/untrusted-text.test.ts"] },
  { id: "SEC-02", what: "SSRF corpus denied; challenge profile makes zero outbound requests", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec02-ssrf.test.ts"] },
  { id: "SEC-03", what: "Budget exhaustion fails closed to replay", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts", "services/kernel/test/challenge/ledger.local.test.ts"] },
  { id: "SEC-04", what: "Attack traffic never reaches traction views; cross-profile rows refused", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts"] },
  { id: "SEC-05", what: "Each of the 7 boot guards refuses to start", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts", "services/kernel/test/boot.test.ts"] },
  { id: "SEC-06", what: "CSP/headers/downloads; lint ban on HTML sinks", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-static.test.ts", "apps/web/test/security.test.ts", "apps/web/test/csp-profiles.test.ts"] },
  { id: "SEC-07", what: "No secrets in bundle/responses/logs (canary)", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts", "scripts/web-env-check.mjs"] },
  { id: "SEC-08", what: "Rate limits and input size", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts", "services/kernel/test/challenge/limits.test.ts", "services/kernel/test/challenge/service.local.test.ts"] },
  { id: "SEC-09", what: "Hostile/binary input rejected without parsing", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts"] },
  { id: "SEC-10", what: "Replay bundle verifies; tamper fails; backend-killed render", sandbox: true, exercisedIn: ["packages/sec-suite/test/sec-platform.test.ts", "apps/web/test/challenge-proxy.test.ts"] },
  { id: "SEC-11", what: "Swarm hygiene (static): deny rules, lifecycle scripts, placeholder env", sandbox: false, exercisedIn: ["packages/sec-suite/test/sec-static.test.ts"] },
  { id: "SEC-12", what: "Webhook signature/window/idempotency", sandbox: false, exercisedIn: ["services/kernel/test/circle/webhook.local.test.ts"] },
  { id: "SEC-13", what: "WYSIWYS: rendered model == signed typed data (production app only; the challenge origin has no wallet code)", sandbox: false, exercisedIn: ["packages/receipts/test/approval.test.ts"] },
  { id: "SEC-14", what: "Service tokens: expiry/audience/tenant/replay/MAC", sandbox: true, exercisedIn: ["services/kernel/test/token.test.ts", "services/kernel/test/token-replay.local.test.ts"] },
] as const;
