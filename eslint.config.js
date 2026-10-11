// Flat ESLint config. The "purity" blocks below implement AGENTS.md prime directives 2 & 3
// (INV-8/9/10). They are enforced in CI and unit-tested in test/boundaries.test.ts.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NODE_BUILTINS = [
  "node:*", "fs", "fs/*", "path", "os", "net", "http", "https", "http2", "dgram", "dns",
  "child_process", "worker_threads", "cluster", "crypto", "vm", "tls", "stream", "zlib", "readline",
];

// Globals/calls that make code non-deterministic or perform I/O.
const IMPURE_GLOBALS = ["Date", "fetch", "process", "setTimeout", "setInterval", "setImmediate",
  "queueMicrotask", "XMLHttpRequest", "WebSocket", "performance", "crypto", "require", "parseFloat"]
  .map((name) => ({ name, message: `Forbidden in pure/money code (AGENTS.md §0): ${name}. Inject via KernelContext.` }));

// v2 (INV-15, RT-01): untrusted text is inert. No HTML sinks anywhere in apps/web.
const HTML_SINK_SYNTAX = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is forbidden (INV-15). Render untrusted text via <UntrustedText> / text nodes.",
  },
  {
    selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]",
    message: "innerHTML/outerHTML assignment is forbidden (INV-15).",
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment)$/]",
    message: "HTML insertion APIs are forbidden (INV-15).",
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: "document.write is forbidden (INV-15).",
  },
  {
    selector: "Property[key.name='dangerouslySetInnerHTML']",
    message: "Passing dangerouslySetInnerHTML through props/spread is forbidden (INV-15).",
  },
];

// v2: wallet/signing libraries must never be reachable from the public `challenge` and `replay` code (INV-16, RT-05).
const WALLET_LIBS = ["wagmi", "wagmi/*", "@wagmi/*", "@rainbow-me/*", "@walletconnect/*", "@web3modal/*", "@reown/*", "ethers", "ethers/*", "viem/accounts", "@circle-fin/*"];

const MONEY_SYNTAX = [
  {
    selector: "CallExpression[callee.name='Number']",
    message: "Do not use Number(...) in money/pure code. Amounts are bigint base units (INV-10).",
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: "toFixed() on amounts is forbidden. Use bigint + declared decimals (INV-10).",
  },
  {
    selector: "CallExpression[callee.property.name='toLocaleString']",
    message: "Locale formatting is non-deterministic across runtimes; format with formatUnits in @symbolon/chain at the edge.",
  },
];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/coverage/**", "contracts/lib/**", "contracts/out/**", "docs/**", "kickoff/**", "test/fixtures/**", ".claude/worktrees/**"] }, // nested agent worktrees are other checkouts, not this tree
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.cjs", "*.config.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly", module: "readonly", require: "readonly" } },
  },

  // --- packages/kernel-core: PURE (no clock, randomness, I/O, env, LLM, web) -------------------
  {
    files: ["packages/kernel-core/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": ["error", ...IMPURE_GLOBALS],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Nondeterministic (INV-9)." },
        { object: "Date", property: "now", message: "Nondeterministic (INV-9). Time arrives via KernelContext.now." },
        { object: "crypto", property: "randomUUID", message: "Nondeterministic (INV-9)." },
      ],
      "no-restricted-syntax": ["error", ...MONEY_SYNTAX],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: NODE_BUILTINS, message: "kernel-core must not touch Node built-ins / I/O (INV-9)." },
            { group: ["@symbolon/extractor", "@symbolon/extractor/*", "@symbolon/web", "@symbolon/kernel-service", "@symbolon/chain", "@symbolon/chain/*"],
              message: "kernel-core must not import LLM, web, service or chain code (INV-8/9)." },
            { group: ["**/extractor/**", "**/apps/**", "**/services/**"], message: "Relative escape out of kernel-core is forbidden." },
            { group: ["viem/actions", "viem/clients", "ethers", "openai", "@anthropic-ai/*"], message: "No network/LLM clients in kernel-core." },
          ],
        },
      ],
    },
  },

  // --- money-handling packages: no floats, no `any` --------------------------------------------
  {
    files: ["packages/receipts/src/**/*.ts", "packages/chain/src/**/*.ts", "packages/policy/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": ["error", { name: "parseFloat", message: "No floats for money (INV-10)." }],
      "no-restricted-syntax": ["error", ...MONEY_SYNTAX.slice(0, 2)],
    },
  },

  // --- v2: packages/terms is PURE like kernel-core (INV-9/10/19) -------------------------------
  {
    files: ["packages/terms/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": ["error", ...IMPURE_GLOBALS],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Nondeterministic (INV-9)." },
        { object: "Date", property: "now", message: "Nondeterministic (INV-9). Time arrives as an argument." },
      ],
      "no-restricted-syntax": ["error", ...MONEY_SYNTAX],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: NODE_BUILTINS, message: "terms must not touch Node built-ins / I/O." },
            { group: ["@symbolon/extractor", "@symbolon/extractor/*", "@symbolon/web", "@symbolon/kernel-service", "@symbolon/chain", "@symbolon/chain/*", "viem", "viem/*", "ethers", "openai", "@anthropic-ai/*"],
              message: "terms may import only @symbolon/schemas (pure, bigint-only)." },
          ],
        },
      ],
    },
  },

  // --- v2: packages/oracle is PURE and independent (oracle-v1; docs/15 §2) ----------------------
  {
    files: ["packages/oracle/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": ["error", ...IMPURE_GLOBALS],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Nondeterministic (INV-9)." },
        { object: "Date", property: "now", message: "Nondeterministic (INV-9). Time arrives as an argument." },
      ],
      "no-restricted-syntax": ["error", ...MONEY_SYNTAX],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: NODE_BUILTINS, message: "oracle must not touch Node built-ins / I/O." },
            { group: ["@symbolon/kernel-core", "@symbolon/kernel-core/*", "@symbolon/terms", "@symbolon/terms/*", "@symbolon/policy", "@symbolon/policy/*", "@symbolon/receipts", "@symbolon/receipts/*", "@symbolon/extractor", "@symbolon/extractor/*", "@symbolon/chain", "@symbolon/chain/*", "@symbolon/web", "@symbolon/kernel-service", "viem", "viem/*", "ethers", "openai", "@anthropic-ai/*"],
              message: "oracle may import only @symbolon/schemas (it is the independent judge)." },
          ],
        },
      ],
    },
  },

  // --- v2: untrusted text is inert in apps/web (INV-15; SEC-06) -------------------------------------
  {
    files: ["apps/web/src/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": ["error", ...HTML_SINK_SYNTAX],
    },
  },

  // --- v2: public challenge/replay code has no wallet or signing code (INV-16) ----------------------
  {
    files: ["apps/web/src/challenge/**/*.{ts,tsx}", "apps/web/src/replay/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: WALLET_LIBS, message: "challenge/replay code must contain no wallet or signing code (INV-16)." },
            { group: ["**/wallet/**", "**/wallet"], message: "challenge/replay code must not import apps/web/src/wallet (INV-16)." },
          ],
        },
      ],
      "no-restricted-globals": ["error", { name: "localStorage", message: "challenge origin sets no cookies/storage." }, { name: "sessionStorage", message: "challenge origin sets no cookies/storage." }],
    },
  },
);
