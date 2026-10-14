# Brand and idea upgrade (Kevin, 2026-10-14 night; supersedes the public name "Symbolon")

## Why
Another Tameion project is also called "Symbolon" (payables on Arc; AduAkorful/symbolon, symbolon-app.vercel.app). Two products with the same name, same track and a similar pitch confuse judges. Our repo, package names (`@symbolon/*`) and spec ids stay as they are; only the PUBLIC brand changes.

## Name: Warifu (割符)
- Warifu = a *split tally*: a token broken in two so that only the two matching halves prove the agreement. Used in medieval Japan, including as a merchant's bill of exchange. Same idea as the Greek symbolon, so the whole motif (two halves that fit; non-fit = REJECT; hollow = no claim) survives untouched.
- Pronounced "wah-ree-foo". Say it with the kanji once on the About page, not everywhere.
- Fallbacks if it fails a check (domain, GitHub, trademark): **Tegata** (手形, Edo-era bill/promissory note), **Hanko**.
- Single source of truth in code: `apps/web/src/lib/brand.ts` (`BRAND.name`, `BRAND.kanji`, `BRAND.tagline`, `BRAND.repoSlug`). Docs/README use the same strings. One edit renames everything public.
- NOT renamed: workspace packages, env vars, spec ids (INV/K/ATK), DB identifiers, EIP-712 domain name (changing it would change every signature and vector; if the domain *display* name must change, it is a schemas RFC, not a find/replace).

## One-line pitch
**Warifu is the treasurer that cannot be sweet-talked.** An AI agent reads your invoices; a deterministic kernel and an on-chain vault decide; every "no" comes with a reason a human can read; and anyone can try to talk it into paying the wrong person.

Spine (unchanged): *Don't trust the agent. Bound it. Prove it. Invite attack.*

## The three upgrades (each makes one word of the spine visible, funny, and shareable)
1. **The Seal (Prove it).** A live, embeddable trust badge per vault: a red hanko stamp that reflects the vault's Loss Bound Certificate state (VALID = intact seal with the recomputed bound and an "as of block N" caption; STALE = cracked seal; UNVERIFIED = blank seal "not computed"). Served as SVG from a public route, links to `/certificate/<vault>`. Vendors see it on every invoice/e-mail footer; clicking recomputes. No number on the badge except one read from the certificate document at render time.
2. **Nice try cards (Bound it).** Every REJECT/HOLD gets a human one-liner templated from reason codes (never LLM prose, never next to Approve) and a shareable card: "A PDF asked me to pay a different wallet. Nice try." + verdict, reason code, receipt hash, link to `/audit/<hash>`. Dry, not cruel; never reproduce attacker text (Untrusted). A bank of >= 3 phrasings per reason code, chosen deterministically from the receipt hash so the same receipt always shows the same line.
3. **The Dojo (Invite attack).** The public challenge reframed: you are trying to sweet-talk the treasurer. Scoreboard headline "Times the treasurer was sweet-talked: N" (N from `public_challenge_stats`, never hand-typed; zero is allowed to be funny and honest), attempt counter, "ranks" by oracle-scored attempts. Challenge origin stays no-wallet, no-3D, Stills only (INV-16/17).

## Voice
Dry, short, a little mischievous, never smug about security. Respectful use of the Japanese references: accurate, no caricature, no fake kanji decoration, no "samurai/ninja" clichés. No banned words (proven, provably, guaranteed, audited, unhackable, unbreakable, 100% secure, risk-free). No hand-typed numbers. Funny lines are labelled as copy, never as evidence.

## Motif mapping (design lane)
Two halves that fit = RELEASE; non-fit = REJECT; hollow = no claim. Periwinkle stipple half = agent proposal; black chrome half = signed engagement. The hanko is the third object: the *vault's* mark of the recomputed bound. Existing procedural-three object family and Stills-first rule stand.

## Build list
- BRAND: `lib/brand.ts`; rename all public copy, metadata, OG, README title, docs front matter, deploy notes; keep internal names. Tests: grep-based test that no public page contains the old name except the allowed "(formerly Symbolon)" footnote on About.
- SEAL: `/api/public/seal/[vault]` (SVG, `Cache-Control: public, max-age=60`), `/seal/[vault]` embed docs page with copy-paste snippet, state from the certificate service (replay bundle fallback, labelled).
- NICE-TRY: `lib/nice-try.ts` (phrase banks per reason code; pure; deterministic choice from receipt hash; unit tests incl. every reason code covered), `/share/[receiptHash]` page + `/api/public/share/[receiptHash]/card.svg` card; never echoes untrusted text.
- DOJO: copy + scoreboard component bodies in the design kit; live wiring waits for WP-32.
