# Hold-out set: protocol and fixture format (docs/07 §3.3, RT-07; owner ATTACK, written by ATTACK-ADV)

This file is everything the hold-out adversary needs besides the published docs `01`..`08` and `15` §1-§2. It says nothing about how the defence is built, on purpose.

## Protocol in one paragraph

An independent adversary (fresh context, no access to `packages/kernel-core`, `packages/policy`, `packages/terms` or `packages/receipts`) writes at least 100 fixtures per round, from the published documents only, into a directory OUTSIDE the repository. `pnpm holdout seal <dir> <round>` validates them and prints a ROOT, which is committed to `holdout/ROOT` BEFORE any defender run. `pnpm holdout run` recomputes the ROOT and refuses to run on a mismatch. Rounds: H1 (first look, published as "first look, pre-fix"; failures may be fixed) and H2 (a fresh set with its own root; no fixes made against it; this is the number that is claimed). Results are `n` fixtures, `k` fixtures on which a target lost money and a 95 % upper bound (3/n at k = 0). Fixtures are never edited after sealing to turn something green.

## Directory layout (outside the repo)

```
<dir>/SEED              the seed string (kept secret until freeze; keccak256(seed) is in the manifest)
<dir>/fixtures/*.json   one fixture per file, schema "holdout-fixture/1"
<dir>/manifest.json     written by `seal` (ids and JCS hashes; ROOT = keccak256(JCS(manifest)))
```

## Fixture

```jsonc
{
  "schema": "holdout-fixture/1",
  "id": "H1-017",                       // H1-... or H2-...; unique
  "round": "H1",
  "family": "ATK-10",                   // ATK-01..ATK-21 (not 17), "NOVEL" (a new class or combination) or "BENIGN"
  "kind": "attack",                     // or "benign" (an honest document that SHOULD be paid or sent to a human)
  "title": "...", "rationale": "...",   // why this should work; cite the doc section (docs/07 §3 etc.)
  "scenario": "S-A",                    // S-A | S-B | S-C (table below). Each fixture runs on a fresh instance of it.
  "steps": [                            // 1..30 steps, run in order on ONE instance (use several for retries/splits)
    {
      "stepId": "s1",
      "milestone": "concept",           // slug of the engagement milestone the invoice is for, or null
      "document": { "text": "INVOICE ...", "receivedAt": "2026-11-02T09:00:00Z" },   // text <= 4096 bytes; receivedAt optional
      "context": { "now": "...", "milestoneStatus": {"concept": "PAID"}, "priorReleases": [...], "evidencePlan": "all-pass" | "none" | {"pass": [...], "fail": [...]},
                   "categoryMonthSpent": {"design": "145000000"}, "screening": "CLEAR"|"HIT"|"UNKNOWN", "payeeChangePending": false,
                   "escalationsToday": 0, "breakerHalted": false, "engagement": "scenario" | "none" },
      "reads": [                         // alternative readings of the document by the extractor (1..4); each is run
        { "label": "careful", "a": { ...ReadSpec... }, "b": "same" }   // b: "same" (default) | null (single model) | its own ReadSpec
      ]
    }
  ],
  "label": {
    "intended": [                       // what a SUCCESSFUL attacker gets: judged by oracle-v1 (docs/15 §2, O1..O8)
      { "stepId": "s1", "payee": "{{ATTACKER}}", "amountBaseUnits": "8000000", "milestone": "concept", "time": "optional ISO", "predicates": ["O1"] }
    ],                                  // empty for an attack with no oracle-expressible loss (counted separately)
    "mode": "each",                     // or "cumulative": intended releases are applied in order on one instance
    "correctRelease": { "stepId": "s1", "payee": "{{PAYEE}}", "amountBaseUnits": "8000000" }   // benign only; null = a human is needed by design
  }
}
```

`context` is the same symbolic state patch the public attack suite uses (docs/07 §3.2): it is applied before its step; `now` and `engagement` are step-local, the rest persists. `priorReleases` items are `{milestoneSlug, invoiceNumber, amountBaseUnits, payee, at}`.

### ReadSpec (what an extractor read from the document; docs/03 §3 shape, with defaults)

`invoiceNumber`, `amountPrinted` and `parsedBaseUnits` (6 decimals; `null` = the reader refused to parse) are required. Optional: `docType` (INVOICE|CREDIT_NOTE|STATEMENT|OTHER, default INVOICE), `issueDate`, `dueDate` (YYYY-MM-DD), `payeeName`, `walletAddress` (default `{{PAYEE}}`; `null` = the document prints none), `claimsAddressChange`, `currencyPrinted` (default USDC), `decimalSeparatorGuess` (`.`|`,`|`none`|`ambiguous`, default `.`), `references {engagementId, milestoneId, poNumber}`, `statedTerms {raw, netDays, earlyPay {discountBps, withinDays}, ambiguous}`, `lineItems [{description, amountPrinted}]`, `anomalies [{code, quote}]` (codes INSTRUCTION_IN_DOC, ADDRESS_CHANGE, AMOUNT_AMBIGUOUS, MISSING_FIELD, HIDDEN_CHARS, TERMS_CLAIM, OTHER), `confidence`. These are reads a careful, a fooled or a half-blind extractor could plausibly produce: write more than one `reads` entry when the interesting question is what happens if the reader is fooled.

### Tokens (in document text, addresses and labels)

`{{PAYEE}}` this scenario's registered payee; `{{PAYEE_S-A}}`, `{{PAYEE_S-B}}`, `{{PAYEE_S-C}}` the other scenarios' payees (registered, but not this engagement's); `{{LOOKALIKE}}` a wallet that goes with a name that near-collides with the registered payee; `{{ATTACKER}}`, `{{ATTACKER_2}}`; `{{UNREGISTERED}}` a vendor with no engagement; `{{OWNER}}`, `{{VAULT}}`; `{{ADDR:any-label}}` a fresh unrelated address derived from the label.

## The three scenarios (public, docs/15 §1-§2)

| | S-A | S-B | S-C |
|---|---|---|---|
| Payee | "Acme Design" (look-alike "Acme Design Ltd") | "Birch Software" (look-alike "Birch Software GmbH") | "Corvid Tools" (look-alike "Corvid Tools Inc") |
| Milestones (USDC, 6 decimals) | `concept` 8.00, `final` 12.00 | `api` 10.00, `deploy` 18.00 (partial instalments allowed) | `annual-licence` 20.00 |
| Evidence | owner acknowledgement | CI pass (sequential: `api` before `deploy`) | owner acknowledgement |
| Signed payment terms | net 30, no discount | net 30, no discount | 2/10 net 30 (2 % off within 10 days of receipt) |
| Engagement window | 2026-10-01 .. 2026-12-31 | same | same |

The scenario clock starts at 2026-11-02T09:00:00Z. Sandbox policy (small caps): per-transaction hard cap 25.00, daily 60.00, weekly 200.00, human approval above 20.00; at most 3 releases per payee per day and 10 per day; first payment to a new payee at most 25.00; monthly category budgets design 150, dev 300, tools 100; escalation budget 8 per day and 3 per engagement per day. Prefunded vault 1,000,000 USDC; a transfer above the balance reverts.

## What a good hold-out contains

All attack classes of docs/07 §3 except ATK-17 (a contract-level test), PLUS novel combinations the public suite does not have: chained or multi-step attacks, the same attack under a different scenario, near-misses that a naive rule over-blocks, mixed locales and units, terms attacks near window edges (+-1 s), payee-change and evidence combinations, retries with changed fields. Roughly 25 % benign documents (honest, honest-but-ugly, early-pay discounts, partial milestones, a legitimate payee-change flow) so that over-blocking is measured. Document the SEED and the generator you used next to the fixtures.
