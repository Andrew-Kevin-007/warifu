# 17 — MODEL & EFFORT ROUTING (which Claude, at what effort, for which work package)

> **Audience:** Kevin (launching sessions), ORCH (spawning subagents/workflows), every agent (know your own budget).
> **Status:** v2. Mechanisms below come from the official Claude Code docs (`code.claude.com/docs/en/model-config`, `/sub-agents`, `/workflows`, read 2026-10-10). Benchmark statements are **Anthropic's published numbers as relayed by third-party posts**; they are not independently verified here. Re-check with `/model` and `/effort` in your installed version before relying on any alias.

## 1. The rule in one sentence

**Spend the strongest model and the highest effort only where a bug costs money or breaks a trust claim; run everything that is well-specified and testable on Sonnet at medium/high; use `ultracode` only for named verification passes.**

Why this split (not "Opus xhigh + ultracode everywhere"):
- Anthropic's own claim, as reported: Sonnet 5.5 is within ~1–2 points of Opus 5.5 on most coding benchmarks (ahead on Terminal-Bench) but **Opus 5.5 is "clearly stronger at complex, open-ended work"**. Our money-critical code (EIP-712 digests, vault logic, kernel checks, signing flows, SSRF/XSS defenses) is exactly "adversarial and unforgiving", while WEB/DOCS/fixtures are "specced and scoped".
- Sonnet 5.5 costs half of Opus 5.5 per token (API list: $2/$10 vs $4/$20 per MTok, as reported). We have ~7 days and ~6 parallel lanes: **usage limits, not cleverness, are the binding constraint**.
- `ultracode` makes Claude plan a multi-agent workflow for *every* substantive task and "each request uses more tokens and takes longer… a session with ultracode on reaches a session or weekly limit sooner" (official docs). Great for audits, wasteful for routine WPs.
- `max` effort: the docs themselves say it "may show diminishing returns and is prone to overthinking, so test before adopting it broadly". **Do not use `max` in this project.**

## 2. Mechanisms (official, short)

| Need | How |
|---|---|
| Pick model for a session | `claude --model opus` / `/model sonnet` / `ANTHROPIC_MODEL` / `model` in settings. Aliases: `opus`, `sonnet`, `haiku`, `opusplan` (Opus in plan mode, Sonnet for execution). **On the Anthropic API/subscription `opus`→Opus 5.5 and `sonnet`→Sonnet 5.5; on Bedrock/Vertex/Foundry they resolve differently — pin full IDs there.** |
| Pick effort | `claude --effort <level>` where level is one of low, medium, high, xhigh, max (this session), `/effort <level>`, `CLAUDE_CODE_EFFORT_LEVEL` (overrides everything — **do not set it globally**), `effortLevel` setting (accepts low, medium, high or xhigh only). Opus 5.5 and Sonnet 5.5 **default to `medium`**. |
| Per-subagent model/effort | Frontmatter in `.claude/agents/<name>.md`: `model:` (`opus`, `sonnet`, `haiku`, full ID, or `inherit`) and `effort:`. Resolution order for a subagent's model: per-invocation parameter → definition `model` → `CLAUDE_CODE_SUBAGENT_MODEL` → main conversation's model. |
| Default subagents to Sonnet | `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (we set it in `.claude/settings.json`). Force it over frontmatter only with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (**don't**; it would downgrade the Opus roles). |
| Ultracode | `ultracode:` keyword inside a **typed** prompt = one task as a workflow. `/effort ultracode` = every substantive task (session-wide; **don't**). `claude --effort ultracode` also sets `xhigh`. The keyword does **not** trigger via `claude -p`, scheduled tasks, webhooks or PR-comment relays. Check `/workflows` before big runs; size guideline: `/config workflowSizeGuideline=small` (or `medium`). |
| Concurrency | default 20 concurrent subagents; workflows max 16 agents at a time. A hit on the claude.ai usage limit pauses a workflow (interactive sessions only; at most twice). |

## 3. Role defaults

| Role | Model | Effort | Rationale |
|---|---|---|---|
| ORCH | `opus` | `high` | planning, merge judgment, cross-doc consistency |
| SCHEMAS | `opus` | `xhigh` | spine root; JCS/EIP-712 vectors must be right once |
| KERNEL-CORE (incl. `packages/terms`) | `opus` | `xhigh` | pure money logic + property tests |
| CONTRACTS | `opus` | `xhigh` | immutable-ish code holding funds |
| SEC | `opus` | `xhigh` | adversarial reasoning; owns `packages/sec-suite` |
| VERIFIER | `opus` | `xhigh` | independent re-derivation; final passes use `ultracode:` |
| BLAST | `opus` | `high` | closed-form math + differential validation |
| CHAIN | `sonnet` | `high` | decimals/`Money` bugs are subtle but spec-bound |
| KERNEL-SVC | `sonnet` | `high` | big, well-specified service; money-critical WPs overridden below |
| AGENT | `sonnet` | `high` | prompts/evals/planner; spec-bound |
| ATTACK | `sonnet` | `high` | fixtures/generators; hold-out adversary is the separate role below |
| ATTACK-ADV | `opus` | `high` | independent hold-out adversary (fresh context, **no access to `packages/kernel-core`**); WP-36 |
| WEB | `sonnet` | `medium` | UI against a frozen API; safety-critical screens overridden below |
| DOCS | `sonnet` | `medium` | writing from specs |

## 4. Per-WP overrides (only where risk differs from the role default)

Machine-readable (the kickoff generator reads this block; keep valid JSON):

```json routing
{
  "roles": {
    "ORCH": {"model": "opus", "effort": "high"},
    "SCHEMAS": {"model": "opus", "effort": "xhigh"},
    "KERNEL-CORE": {"model": "opus", "effort": "xhigh"},
    "CONTRACTS": {"model": "opus", "effort": "xhigh"},
    "SEC": {"model": "opus", "effort": "xhigh"},
    "VERIFIER": {"model": "opus", "effort": "xhigh"},
    "BLAST": {"model": "opus", "effort": "high"},
    "CHAIN": {"model": "sonnet", "effort": "high"},
    "KERNEL-SVC": {"model": "sonnet", "effort": "high"},
    "AGENT": {"model": "sonnet", "effort": "high"},
    "ATTACK": {"model": "sonnet", "effort": "high"},
    "ATTACK-ADV": {"model": "opus", "effort": "high"},
    "WEB": {"model": "sonnet", "effort": "medium"},
    "DOCS": {"model": "sonnet", "effort": "medium"}
  },
  "wpOverrides": {
    "11": {"model": "opus", "effort": "xhigh", "why": "Circle adapter touches keys/signing"},
    "12": {"model": "opus", "effort": "high", "why": "EIP-712 engagement flows"},
    "13": {"model": "opus", "effort": "xhigh", "why": "SSRF guard on public input"},
    "14": {"model": "opus", "effort": "xhigh", "why": "attestation signer + release path + TOCTOU"},
    "15": {"model": "opus", "effort": "high", "why": "breaker/guardian safety logic"},
    "19": {"model": "sonnet", "effort": "high", "why": "WYSIWYS approval screen (INV-20)"},
    "20": {"model": "sonnet", "effort": "high", "why": "client-side verifier must be correct"},
    "24": {"model": "sonnet", "effort": "high", "why": "honest-corpus metrics must be sound"},
    "26": {"model": "opus", "effort": "high", "why": "differential validation + patch loop"},
    "32": {"model": "opus", "effort": "xhigh", "why": "public attack surface, isolation, abuse controls"},
    "33": {"model": "sonnet", "effort": "high", "why": "safe rendering of hostile text (INV-15)"},
    "34": {"model": "opus", "effort": "high", "why": "certificate soundness (INV-22)"},
    "35": {"model": "sonnet", "effort": "high", "why": "planner + simulated corpus"},
    "36": {"model": "opus", "effort": "high", "why": "independent hold-out adversary"},
    "37": {"model": "opus", "effort": "xhigh", "why": "security hardening + SEC suite"},
    "38": {"model": "sonnet", "effort": "medium", "why": "static replay bundle"}
  },
  "ultracodeWPs": ["29", "37"],
  "subagentDefault": "sonnet"
}
```

**Single source of truth.** The JSON block above drives everything: `python3 scripts/gen-kickoff.py` writes the `MODEL/EFFORT/LAUNCH` header of every `kickoff/WP-nn_*.md` **and** the `.claude/agents/<role>.md` files (`model:` / `effort:` frontmatter); `node scripts/check-claude-config.mjs` (part of `make verify`, SEC-11) fails if a role file, the settings file or a kickoff header drifts from it. Change the routing by editing this block and re-running the generator, never by hand-editing generated files.

## 5. Where `ultracode:` is allowed (typed prompts only)

| Pass | Who | When | Prompt starter |
|---|---|---|---|
| V-1/V-2/V-3 independent verification (WP-29) | VERIFIER | G3, G4, G5 | `ultracode: independently reproduce every claim in README + docs/13 §9 from a clean checkout; adversarially verify each finding before reporting` |
| SEC final sweep (WP-37) | SEC | G4 | `ultracode: run docs/14 RT checklist against the code; for every RT-xx mark FIXED/PARTIAL/OPEN with a test link` |
| Docs ↔ code ↔ tests consistency audit | ORCH | G2, G4, G5 | `ultracode: audit that every INV-n, K-xx, ATK-xx, SEC-xx, reason code and WP in docs has code + a test; list gaps` |
| v1 → v2 reconcile (one-off) | ORCH | now | see `kickoff/V2_RECONCILE.md` |

Everything else (feature WPs, UI, fixtures, docs) runs **without** ultracode.

## 6. Escalation and de-escalation rules

- **Escalate one WP, not the team.** If a Sonnet-owned WP fails VERIFIER twice, or an agent loops on the same failing test > 3 times, re-run *that WP* on `opus`/`xhigh`.
- **Never escalate to `max`.**
- **Burn guard.** ORCH checks usage at each wave boundary. If > 70 % of the weekly allowance is gone before Wed Oct 14: Opus `high` roles → `medium`, Sonnet `high` → `medium`, keep only CONTRACTS/SCHEMAS/KERNEL-CORE/SEC at `xhigh`, and stop all non-gate ultracode.
- **Don't change effort mid-WP casually:** changing effort invalidates the prompt cache (official docs), which costs tokens.
- Subagents spawned by an agent (explore/search/test-running) default to Sonnet via `CLAUDE_CODE_SUBAGENT_MODEL`; the explicit Opus role files in `.claude/agents/` override that.

## 7. Launch cheat-sheet (copy/paste, one terminal per worktree)

```bash
# Opus xhigh lanes (money-critical)
claude --model opus --effort xhigh      # SCHEMAS, KERNEL-CORE, CONTRACTS, SEC, VERIFIER, WP-11/13/14/32
# Opus high lanes
claude --model opus --effort high       # ORCH, BLAST, ATTACK-ADV, WP-12/15/26/34/36
# Sonnet high lanes
claude --model sonnet --effort high     # CHAIN, KERNEL-SVC, AGENT, ATTACK, WP-19/20/24/33/35
# Sonnet medium lanes
claude --model sonnet --effort medium   # WEB, DOCS, WP-21/38
# Optional: Opus plans, Sonnet executes (good for ORCH-driven feature work)
claude --model opusplan
```
Each `kickoff/WP-xx_*.md` already prints its exact `MODEL/EFFORT` line and launch command (generated from §4).

## 8. Honest caveats

- The comparative claims in §1 are from Anthropic's published benchmarks as relayed by third-party blogs plus one blogger's 48-run test (cost/speed only). **They are directional, not a guarantee for our codebase.** The routing is deliberately conservative: it puts the stronger model on the code where a mistake is irreversible and verifies the rest with tests.
- Plan limits differ (Pro/Max/Team/API). If you are on a smaller plan, move more roles to Sonnet and keep Opus for SCHEMAS, CONTRACTS, KERNEL-CORE, SEC only.
- Model aliases move over time. Pin full IDs (`claude-opus-5-5`, `claude-sonnet-5-5`) in `.claude/settings.json` if you need reproducibility across the week.
