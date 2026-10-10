#!/usr/bin/env node
// INV-11 static guard: apps/web must never reference payment/signing secrets.
// Usage: node scripts/web-env-check.mjs [--root <dir>]   (default: apps/web)
// This is a FLOOR, not the whole control. WEB must also add a runtime check (build the app with a
// scrubbed env and assert none of these names are readable) per docs/13_TEST_PLAN.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".turbo", "test"]);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|yml|yaml|env|example|html|sql)$/i;

// Names that must never appear in apps/web (lookbehind keeps NEXT_PUBLIC_KERNEL_URL legal).
const FORBIDDEN_NAMES =
  /(?<![A-Za-z0-9_])(CIRCLE_[A-Z_]+|KERNEL_[A-Z_]+|GUARDIAN_[A-Z_]+|RELAYER_[A-Z_]+|SERVICE_TOKEN_SECRET|SUPABASE_SERVICE_ROLE_KEY|ENTITY_SECRET)(?![A-Za-z0-9_])/;
// v2 (SEC-07): anything named NEXT_PUBLIC_* is inlined into the client bundle, so it must not look like a secret.
const PUBLIC_SECRET_NAME = /NEXT_PUBLIC_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PRIVATE)[A-Z0-9_]*/;
const PRIVATE_KEY_LIKE = /\b0x[0-9a-fA-F]{64}\b/;
const FORBIDDEN_IMPORTS = /from\s+["'](@circle-fin\/(developer-controlled-wallets|smart-contract-platform)|@symbolon\/kernel-service)["']/;

export function scan(root) {
  const findings = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (TEXT_EXT.test(entry) || entry.startsWith(".env")) {
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
          const m = line.match(FORBIDDEN_NAMES);
          if (m) findings.push({ file: p, line: i + 1, why: `forbidden secret name ${m[1]}` });
          const pm = line.match(PUBLIC_SECRET_NAME);
          if (pm) findings.push({ file: p, line: i + 1, why: `secret-looking public variable ${pm[0]} (inlined into the client bundle)` });
          if (PRIVATE_KEY_LIKE.test(line)) findings.push({ file: p, line: i + 1, why: "64-hex value (possible private key)" });
          if (FORBIDDEN_IMPORTS.test(line)) findings.push({ file: p, line: i + 1, why: "forbidden import (Circle server SDK / kernel service)" });
        });
      }
    }
  };
  walk(root);
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? process.argv[i + 1] : "apps/web");
  const findings = scan(root);
  if (findings.length) {
    console.error(`web-env-check: ${findings.length} violation(s) in ${root}`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.why}`);
    process.exit(1);
  }
  console.log(`web-env-check: OK (${root})`);
}
