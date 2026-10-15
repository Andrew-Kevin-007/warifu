<!-- generated from docs/claims-templates/judge-copy.tmpl.md by scripts/claims.ts; edit the template -->
# /judge page copy (Warifu)

Short, dry, honest. Each card has a button that works without login and is served from the RECORDED replay bundle when live infrastructure is down. Numbers come from `results/claims.json`.

## Card 1: Watch it get fooled and not lose money
Copy: "Run attack ATK-10. The extractor is fooled. The kernel still says REJECT, and names the check. The naive pattern pays."
Footnote: "Attack suite: kernel 0 losses in 213 trials; naive baseline 92 losses in 168 trials (95% upper bound 61.27%, clopper-pearson). SIMULATED, unit mode, no model called."

## Card 2: Verify a receipt yourself
Copy: "Paste a receipt hash. Your browser recomputes the hash and checks the signature. Nothing is trusted from us."
Footnote: "Works offline with `pnpm verify-receipt`."

## Card 3: Recompute the loss bound
Copy: "Exclusions first, then the bound, then the assumptions. Run the command and get the same answer from the chain, or watch it go STALE."
Footnote: "Certificate status today: certificate not computed (no chain read in this build). A calculation under stated assumptions, not a proof."

## Card 4: Try to sweet-talk the treasurer
Copy: "Different origin, no wallet. Write your own invoice, up to 4 KiB, and see whether it pays the wrong person, the wrong amount, or twice."
Footnote: "Scoreboard: no challenge attempts recorded. Attack traffic is never traction."

## Card 5: See the real users
Copy: "Pilot businesses, payments and value, with explorer links. Pilot tenants only."
Footnote: "0 pilot rows, 0 real payments, 0 base units moved. Demo data is labelled and never counted."

## What this does not do
- It does not judge the quality of the work being paid for.
- It does not protect against a compromised owner key.
- It does not promise availability.
- The contracts are unaudited and testnet only.
- Treasury Planner and attack-suite figures are SIMULATED (0 model calls behind them).
- Hold-out: hold-out not run.
