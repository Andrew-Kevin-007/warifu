// @symbolon/sec-suite — SEC-01..14 live here (WP-37). See docs/13_TEST_PLAN.md §4.6 for the contract.
export const PACKAGE_NAME = "@symbolon/sec-suite" as const;

/** Status of every SEC test. Keep in sync with test/ — `sec:local` prints it. */
export const SEC_TESTS = [
  { id: "SEC-01", what: "XSS corpus renders inert on every public route", sandbox: true },
  { id: "SEC-02", what: "SSRF corpus denied; challenge profile makes zero outbound requests", sandbox: true },
  { id: "SEC-03", what: "Budget exhaustion fails closed to replay", sandbox: true },
  { id: "SEC-04", what: "Attack traffic never reaches traction views; cross-profile rows refused", sandbox: true },
  { id: "SEC-05", what: "Each of the 7 boot guards refuses to start", sandbox: true },
  { id: "SEC-06", what: "CSP/headers/downloads; lint ban on HTML sinks", sandbox: true },
  { id: "SEC-07", what: "No secrets in bundle/responses/logs (canary)", sandbox: true },
  { id: "SEC-08", what: "Rate limits and input size", sandbox: true },
  { id: "SEC-09", what: "Hostile/binary input rejected without parsing", sandbox: true },
  { id: "SEC-10", what: "Replay bundle verifies; tamper fails; backend-killed render", sandbox: true },
  { id: "SEC-11", what: "Swarm hygiene (static): deny rules, lifecycle scripts, placeholder env", sandbox: false },
  { id: "SEC-12", what: "Webhook signature/window/idempotency", sandbox: false },
  { id: "SEC-13", what: "WYSIWYS: rendered model == signed typed data (production app only; the challenge origin has no wallet code)", sandbox: false },
  { id: "SEC-14", what: "Service tokens: expiry/audience/tenant/replay/MAC", sandbox: true },
] as const;
