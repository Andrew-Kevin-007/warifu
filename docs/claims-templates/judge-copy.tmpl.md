# /judge page copy (Warifu)

Short, dry, honest. Each card has a button that works without login and is served from the RECORDED replay bundle when live infrastructure is down. Numbers come from `results/claims.json`.

## Card 1: Watch it get fooled and not lose money
Copy: "Run attack ATK-10. The extractor is fooled. The kernel still says REJECT, and names the check. The naive pattern pays."
Footnote: "Attack suite: kernel {{atk.symbolon.loss_trials}}; naive baseline {{atk.b1.loss_trials}}. SIMULATED, unit mode, no model called."

## Card 2: Verify a receipt yourself
Copy: "Paste a receipt hash. Your browser recomputes the hash and checks the signature. Nothing is trusted from us."
Footnote: "Works offline with `pnpm verify-receipt`."

## Card 3: Recompute the loss bound
Copy: "Exclusions first, then the bound, then the assumptions. Run the command and get the same answer from the chain, or watch it go STALE."
Footnote: "Certificate status today: {{certificate}}. A calculation under stated assumptions, not a proof."

## Card 4: Try to sweet-talk the treasurer
Copy: "Different origin, no wallet. Write your own invoice, up to 4 KiB, and see whether it pays the wrong person, the wrong amount, or twice."
Footnote: "Scoreboard: {{challenge}}. Attack traffic is never traction."

## Card 5: See the real users
Copy: "Pilot businesses, payments and value, with explorer links. Pilot tenants only."
Footnote: "{{traction.pilot}}. Demo data is labelled and never counted."

## What this does not do
- It does not judge the quality of the work being paid for.
- It does not protect against a compromised owner key.
- It does not promise availability.
- The contracts are unaudited and testnet only.
- Treasury Planner and attack-suite figures are SIMULATED ({{llm.calls}} behind them).
- Hold-out: {{holdout}}.
