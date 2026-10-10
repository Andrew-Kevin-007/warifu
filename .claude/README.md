# .claude/ — model/effort routing and agent hygiene (WP-39, docs/17, DEC-017)

| File | What | Source of truth |
|---|---|---|
| `agents/<role>.md` | One subagent definition per role with `model:` and `effort:` frontmatter | **Generated** by `python3 scripts/gen-kickoff.py` from the ```json routing``` block in `docs/17_MODEL_AND_EFFORT_ROUTING.md`. Do not edit by hand. |
| `settings.json` | `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (helper subagents default to Sonnet) + deny rules for secret files | Hand-maintained; owned by ORCH with SEC. Checked by `node scripts/check-claude-config.mjs` (SEC-11). |
| `settings.local.json` | Your personal overrides | git-ignored. Never put keys in it. |

**What the deny rules are and are not.** `Read(...)` rules stop the Read tool from opening `.env*` secret files. They do **not** stop a shell command like `cat .env.local`; Bash deny rules are best-effort pattern matches. The real control is DEC-017: agent sessions only ever hold throwaway **testnet** keys; real keys live only in the deployment secret store and in Kevin's head. Do not weaken this by pasting a key into a chat or `settings.local.json`.

**Do not set globally:** `CLAUDE_CODE_EFFORT_LEVEL` (it overrides every per-role effort) or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (it would downgrade the Opus roles). `max` effort is not used in this project.

**Launch lines** are printed at the top of every `kickoff/WP-nn_*.md`, for example `claude --model opus --effort xhigh`.
