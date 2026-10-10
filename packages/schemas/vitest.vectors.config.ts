// Generator run, not a test run: writes vectors/*.json and json-schema/*.schema.json (scripts/write-vectors.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/write-vectors.ts"], environment: "node" },
});
