import { defineConfig } from "vitest/config";

export default defineConfig({
  // Lets tests import the real React components (JSX) instead of re-implementing them; apps/web's own build is unaffected.
  // (apps/web's tsconfig says `jsx: preserve` for Next; tests need the transformed form, so it is pinned here.)
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20_000,
    // Fixture setup (a throwaway Postgres database, a local anvil chain) is slow when the whole suite runs at once; the default 10 s
    // produced false failures that pass in isolation.
    hookTimeout: 90_000,
    coverage: {
      provider: "v8",
      include: ["packages/kernel-core/src/**", "packages/terms/src/**"], // docs/13 §2: same 100 % branch bar for packages/terms
      thresholds: { branches: 100 }, // enforced only via `pnpm test --coverage`; see docs/13_TEST_PLAN.md
    },
  },
});
