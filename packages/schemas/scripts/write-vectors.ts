// Writes vectors/*.json and json-schema/*.schema.json. Runs under vitest (the TS sources use extensionless
// imports, which plain `node` cannot resolve): pnpm --filter @symbolon/schemas vectors
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildJsonSchemaFiles, buildVectors, serializeGenerated } from "./build-vectors";

const VECTORS_DIR = fileURLToPath(new URL("../vectors/", import.meta.url));
const JSON_SCHEMA_DIR = fileURLToPath(new URL("../json-schema/", import.meta.url));

function writeAll(dir: string, files: Record<string, unknown>, pattern: RegExp): number {
  mkdirSync(dir, { recursive: true });
  // Drop generated files that no longer have a source, so the directory mirrors the builder exactly.
  for (const f of readdirSync(dir)) if (pattern.test(f) && !(f in files)) rmSync(join(dir, f));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), serializeGenerated(value), "utf8");
  return Object.keys(files).length;
}

it("writes vectors and JSON Schema files", () => {
  expect(writeAll(VECTORS_DIR, buildVectors(), /\.json$/)).toBeGreaterThan(0);
  expect(writeAll(JSON_SCHEMA_DIR, buildJsonSchemaFiles(), /\.schema\.json$/)).toBeGreaterThan(0);
});
