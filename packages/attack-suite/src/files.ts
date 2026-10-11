// Serialisation of the committed fixture set. Hostile text must stay inert and reviewable in diffs, so the
// writer emits PURE ASCII JSON: every character outside printable ASCII, and < > & (which could be read as
// markup if a viewer rendered the file), is written as a \uXXXX escape. Zero-width characters, bidi
// controls and tag characters therefore show up as visible escapes instead of hiding in a diff.
import { sha256Utf8 } from "@symbolon/schemas";
import { buildApplicability } from "./applicability";
import { buildHonest } from "./honest";
import { INJECTION_LIBRARY } from "./injections";
import { injectionContext } from "./attacks/injection";
import { buildAllAttacks, BASE_SEED } from "./registry";
import { TERMS_INJECTIONS } from "./terms-injections";
import { ATTACK_IDS } from "./types";
import { ATTACKER, ATTACKER_2, CHAIN_ID, CLOCK_START, LOOKALIKE_PAYEE, OWNER, TENANT_ID, UNREGISTERED_VENDOR, VAULT, WORLD, WORLD_VERSION, worldMilestone } from "./world";

export const GENERATOR_VERSION = "attack-fixtures/1" as const;

export function asciiJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return `${text.replace(/[^\n\x20-\x7e]|[<>&]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

/** True when the text is pure printable ASCII (plus newlines) with no markup-significant characters. */
export function isInertAscii(text: string): boolean {
  return /^[\n\x20-\x7e]*$/.test(text) && !/[<>&]/.test(text);
}

function worldFile() {
  return {
    schema: "attack-world/1",
    version: WORLD_VERSION,
    note: "UNSIGNED templates: engagements have null signatures and status DRAFT. The harness signs them with throwaway sandbox keys and registers them on the sandbox vault (WP-23/WP-32). Addresses are derived from labels and have no known private key.",
    chainId: CHAIN_ID,
    clockStart: CLOCK_START,
    tenantId: TENANT_ID,
    addresses: { owner: OWNER, vault: VAULT, attacker: ATTACKER, attacker2: ATTACKER_2, lookalikePayee: LOOKALIKE_PAYEE, unregisteredVendor: UNREGISTERED_VENDOR },
    scenarios: Object.values(WORLD).map((s) => ({
      scenarioId: s.scenarioId,
      payeeLabel: s.payeeLabel,
      lookalikeLabel: s.lookalikeLabel,
      category: s.category,
      milestoneAmounts: Object.fromEntries(s.milestones.map((m) => [m.slug, worldMilestone(s, m.slug).amount.toString()])),
      template: s.template,
    })),
  };
}

function librariesFiles() {
  const w = WORLD["S-A"];
  const ctx = injectionContext(w.payeeLabel, worldMilestone(w, "concept").amount, w.payee);
  return {
    injections: {
      schema: "injection-library/1",
      note: "HOSTILE TEXT BY DESIGN. Inert data; never render or execute. Samples use the sandbox attacker address, which has no known key.",
      payloads: INJECTION_LIBRARY.map((p) => ({
        id: p.id,
        technique: p.technique,
        placement: p.placement,
        obfuscation: p.obfuscation,
        goal: p.goal,
        kernelShouldFlag: p.kernelShouldFlag,
        revealedPhrase: p.revealedPhrase,
        sample: p.render(ctx),
      })),
    },
    terms: {
      schema: "terms-injection-library/1",
      note: "Each case is built into ATK-21 steps; see attacks/ATK-21.json for the full documents.",
      cases: TERMS_INJECTIONS.map((t) => ({ id: t.id, kind: t.kind, scenarioId: t.scenarioId })),
    },
  };
}

/** Every committed file, path (relative to packages/attack-suite/fixtures) -> content. Deterministic. */
export function buildFixtureFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("world.json", asciiJson(worldFile()));
  for (const a of buildAllAttacks(BASE_SEED)) files.set(`attacks/${a.attackId}.json`, asciiJson(a));
  const honest = buildHonest(BASE_SEED);
  files.set("honest/benign-controls.json", asciiJson({ schema: "honest-set/1", items: honest.filter((h) => h.group === "benign-control") }));
  files.set("honest/discount-honest.json", asciiJson({ schema: "honest-set/1", items: honest.filter((h) => h.group === "discount-honest") }));
  const libs = librariesFiles();
  files.set("libraries/injections.json", asciiJson(libs.injections));
  files.set("libraries/terms-injections.json", asciiJson(libs.terms));
  files.set("applicability.json", asciiJson(buildApplicability()));
  const hashes: Record<string, string> = {};
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) hashes[path] = sha256Utf8(content);
  files.set(
    "MANIFEST.json",
    asciiJson({ schema: "fixture-manifest/1", generator: GENERATOR_VERSION, seed: BASE_SEED, attacks: ATTACK_IDS.length, files: hashes }),
  );
  return files;
}
