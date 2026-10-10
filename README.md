# Symbolon

**An evidence-gated treasury kernel for agent-run payments on Arc — plus Blast Radius, which computes (and empirically attacks) the maximum loss if the agent is compromised.**

> LLM extracts and proposes. A deterministic kernel decides. An on-chain vault enforces. Every release carries a signed, replayable receipt.

> **Don't trust the agent. Bound it. Prove it. Invite attack.**

Status: **scaffold (v2 pack)**. Specs live in [`docs/`](docs/00_START_HERE.md) (start with [`docs/CHANGES_V2.md`](docs/CHANGES_V2.md) if you used v1). Agent rules: [`AGENTS.md`](AGENTS.md). Kickoff prompts (each prints its Claude model/effort): [`kickoff/`](kickoff/ORCHESTRATOR.md). Security policy draft: [`SECURITY.md`](SECURITY.md).

## Quick start
```bash
corepack enable
pnpm install
make verify        # lint (purity + boundaries) · typecheck · tests · web-env guard
```

## Layout
```
apps/web/            Next.js app — zero payment secrets (INV-11)
services/kernel/     Hono kernel service — all secrets live here
packages/schemas     Zod, JCS, EIP-712 types, vectors   (spine root)
packages/kernel-core Pure deterministic checks K-01..K-16 (no clock, no I/O, no LLM)
packages/terms       Pure payment-terms math: amountDue, discount window, APR, feasiblePlans (v2)
packages/policy      Policy loader + hash + vault consistency
packages/receipts    JCS -> keccak -> EIP-712 receipts + verifier CLI
packages/chain       Money, ABIs, decoders, Arc config
packages/extractor   LLM extraction / timing / explainer (advisory only)
packages/attack-suite  ATK-01..24 + baselines B0/B1/B2 + hold-out + honest corpus
packages/blast-radius  Closed-form bounds, T3 simulator, red-team loop, Loss Bound Certificate
packages/sec-suite   SEC-01..14 platform-security tests, XSS/SSRF corpora (v2)
contracts/           SymbolonVault (Arc Foundry)
supabase/migrations/ append-only (0002_v2.sql adds kinds, budget ledger, challenge, certificates, replay)
.claude/             per-role model/effort files (generated from docs/17) + settings (deny secret reads)
kickoff/             one prompt per work package, with MODEL / EFFORT / LAUNCH at the top
```

## What `make verify` enforces
- **Purity (INV-8/9/10):** `kernel-core` may not use `Date`, `Math.random`, `fetch`, `process`, Node built-ins, `Number()`, `parseFloat`, `toFixed`, or `any`; money packages may not use floats.
- **Boundaries:** dependency-cruiser forbids kernel-core → extractor/web/services/chain, web → services, packages → apps/services, cycles.
- **Secrets:** `pnpm test:web-env` fails if `apps/web` references Circle/kernel/guardian secrets, a 64-hex key, or a secret-looking `NEXT_PUBLIC_*` variable.
- **Untrusted text is inert (INV-15):** `apps/web` may not use `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`; challenge/replay code may not import wallet code (INV-16). `terms` is pure like `kernel-core`.
- **Claude Code config (SEC-11):** `pnpm claude:check` fails if `.claude/agents/*`, `settings.json` or a kickoff header drifts from `docs/17`; CI also fails if generated files are stale.
- **Wording (DEC-012):** `pnpm claims:lint` fails on overclaiming words in README, SECURITY.md and `apps/web/src`.

License: Apache-2.0.
