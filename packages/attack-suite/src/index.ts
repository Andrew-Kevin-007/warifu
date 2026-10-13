// @symbolon/attack-suite — fixtures, generators and baselines for ATK-01..24 (owner: ATTACK).
// WP-22 provides: seeded fixture/generator layer, the three canonical scenarios, the injection and
// terms-injection libraries, the flood generator, the 12 spec-named honest fixtures and applicability.json.
// The harness, B1 target, oracle wiring and report are WP-23; the wider honest corpus is WP-24; B0/B2 and the
// hold-out runner are WP-36.
export const PACKAGE_NAME = "@symbolon/attack-suite" as const;

export * from "./types";
export * from "./prng";
export * from "./ids";
export * from "./time";
export * from "./money-format";
export * from "./templates";
export * from "./terms-ref";
export * from "./world";
export * from "./injections";
export * from "./terms-injections";
export * from "./flood";
export * from "./honest";
export * from "./applicability";
export * from "./registry";
export * from "./files";
export * from "./stats";
export * from "./harness/index";
export { ATTACK_META } from "./attack-meta";
export { injectionContext } from "./attacks/injection";
export { buildSignedView } from "./attacks/human";
