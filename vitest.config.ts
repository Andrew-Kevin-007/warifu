import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["packages/kernel-core/src/**", "packages/terms/src/**"], // docs/13 §2: same 100 % branch bar for packages/terms
      thresholds: { branches: 100 }, // enforced only via `pnpm test --coverage`; see docs/13_TEST_PLAN.md
    },
  },
});
