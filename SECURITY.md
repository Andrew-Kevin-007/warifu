# Security policy — DRAFT (Kevin: review, fill the contact, then publish; see docs/15 §9)

> Intent, not a legal commitment. Symbolon is a hackathon project. The public challenge runs on **testnet only**, holds **no real funds**, offers **no cash prize**, and uses a deployment that shares nothing with any pilot (INV-16).

## Scope for good-faith testing
- In scope: the public challenge origin (`/challenge` and the sandbox service behind it), the sandbox vault(s) on the Arc testnet, the open-source code in this repository.
- Out of scope: third-party services (Circle, Arc RPC providers, Supabase, Vercel, Anthropic), denial-of-service beyond the limits posted on the challenge page, social engineering of people, attempts to read other users' data, and any non-synthetic data. **Do not submit real invoices or personal data.**

## Rules of the game
- Stay inside the posted rate limits (they exist to cap cost, not to hide anything).
- Do not exfiltrate data or pivot to other systems. If you find a way to reach the production deployment from the sandbox, stop and tell us.
- Attack traffic is not customer traffic: the challenge never counts toward product traction.

## Reporting a real flaw
**Primary channel:** GitHub private vulnerability reporting on this repository (Security tab → "Report a vulnerability"). *(DRAFT note: GitHub offers this on public repositories; Kevin enables it when the repo goes public at submission.)*
**Secondary channel:** email **p1legendary7+symbolon-security@gmail.com**.
Include steps to reproduce. We aim to acknowledge within 3 days. With your consent we will credit you in the changelog. Reports about real flaws (as opposed to scored challenge attempts) are very welcome.

## What we claim, and what we do not
We state loss bounds as **"calculated from on-chain state and empirically tested"** with the assumptions and exclusions listed beside every number (`docs/16`). The contracts are **unaudited**. We do not claim that the system cannot be broken or that funds cannot be lost; we publish the bound, its assumptions and our test results so you can check them.
