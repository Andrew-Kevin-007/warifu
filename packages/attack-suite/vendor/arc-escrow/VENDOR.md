# B0: circlefin/arc-escrow, vendored (WP-36, docs/07 §1 and §6)

Source: `https://github.com/circlefin/arc-escrow`, revision pinned in `COMMIT` (`d5006bc44518db7ee85ad9bc645646c04bf4c090`, the default branch head when vendored, 2026-10-14). Licence: Apache-2.0 (`LICENSE` kept; every upstream header kept). The files under `original/` are the upstream bytes (line endings normalised to LF; nothing else), never compiled or edited by us.

| File | What it is | sha256 |
|---|---|---|
| `original/validate-work.route.ts` | `app/api/contracts/validate-work/route.ts`: the release decision. Builds the validator prompt from the agreement's tasks, asks the model for `{valid, confidence, reasons}`, releases iff `valid && confidence === "HIGH"`, then calls `withdraw(uint256[])` through Circle's SDK. | `dd889f35be8e3998c9c5b7c23a62ab5a2ca8b03829b25b86ad3f28270ecfd3f3` |
| `original/amount.ts` | `lib/utils/amount.ts`, used by the route verbatim | `7c4c5d80b4f44bfedb703d43548ec7b58dc7baef0da38b3fb3ae11af057fe81e` |
| `original/RefundProtocol.sol` | `contracts/escrow_smart_contract/RefundProtocol.sol`: the escrow contract whose `withdraw()` the route calls. Not executed; its `withdraw` semantics are applied by `src/harness/b0.ts` (pays `amount - withdrawnAmount` to the payee fixed at `pay()` time). | `91f52759f610682fc3843ef78571c298d38a049e6a054a52ff21b80766aa15ac` |

## The vendoring diff (exactly this, re-derived by a test)

`linked/validate-work.route.ts` is `original/validate-work.route.ts` with (1) one header line `// @ts-nocheck ...` and (2) eight import specifiers re-pointed (`src/harness/b0-link.ts` `SPECIFIER_MAP`). No other byte changes. `test/baselines.test.ts` re-derives the file from the original and fails on any difference.

## What is stubbed (network edges only; `stubs/`, OURS)

| Upstream import | Stub | What it answers |
|---|---|---|
| `next/server` | `next-server.ts` | `NextResponse.json` returns `{status, body}` |
| `@/lib/utils/openAIClient` | `openai-client.ts` | the model call: a deterministic **SIMULATED** validator (same V1-V5 rules as B1, `LOW` rules answered as `MEDIUM`); no key, no paid call |
| `@/lib/utils/openai-error-handler` | `openai-error-handler.ts` | maps an exception to HTTP 500 (the original imports the openai SDK for its error classes) |
| `@/lib/supabase/server-client` | `supabase-server-client.ts` | one in-memory agreement and user; records the status update |
| `@/lib/utils/smart-contract-platform-client` | `circle-contract-sdk.ts` | a placeholder contract address |
| `@/lib/utils/developer-controlled-wallets-client` | `circle-developer-sdk.ts` | records the `withdraw(uint256[])` call (this is the release) |
| `@/app/services/agreement.service` | `agreement-service.ts` | records the transaction row |

Not stubbed: the route's own control flow, the prompt text, the `valid && confidence === "HIGH"` condition, `parseAmount`, the order of calls.

## Mapping our world onto its job/deliverable API (published; per-attack reasons in `fixtures/applicability.json`)

arc-escrow validates an **image deliverable** against **agreement tasks**; it is not an invoice processor. We map: signed engagement milestone = one escrow agreement (beneficiary and amount fixed at creation, as in `escrow/route.ts`); invoice document text = the uploaded file; milestone description = the agreement task. Consequences, by the pattern's design and reported, not hidden: no document can change who is paid or how much (so payee-swap and amount attacks cannot lose money here), and the pattern has no evidence gating, time window, caps, terms logic or velocity rules. The escrow contract makes a repeated `withdraw()` pay 0.

## Modelled, not executed

Faults (lost relay, provider timeout, blocklist revert) are modelled from `app/api/webhooks/circle/route.ts` at the pinned commit (status moves to CLOSED only on a COMPLETE webhook, FAILED sets LOCKED); that file is read, not vendored.

## Limits of this baseline

The model is SIMULATED, so B0's behaviour on prompt injection and forged deliverables reflects our reference rules, not gpt-4o. If a key and a budget exist, re-record the model answers (`--live-llm`, not built) and replace the simulated validator; nothing else changes.
