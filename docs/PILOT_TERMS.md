# Symbolon pilot terms (one page) — DRAFT for Kevin's review

> Not legal or financial advice. A plain-language agreement for a hackathon-grade pilot. Kevin reviews and edits before the first pilot sees it (`docs/09` §6, §9). Placeholders in `{braces}` are filled per pilot.

**Between:** {pilot name / handle} ("you") and Kevin Andrew A, building Symbolon for the Tameion hackathon ("me").
**Date:** {date} · **Network you chose:** {testnet | mainnet}

## 1. What this is
Symbolon reads a contractor invoice and proposes a payment. A deterministic checker and an on-chain vault decide whether it is released: right payee, right amount, evidence of delivery, within your caps. This is a pilot of hackathon software, free during Tameion.

## 2. No warranty
The software is provided as it is. It is unaudited. I do not promise that it is free of bugs or that it will stop every wrong payment. The limits and the calculated loss bound I show you come with listed assumptions and exclusions; read them before you rely on them.

## 3. You keep custody
You own the vault and fund it with your own USDC. I never hold, receive or move your funds, and I do not have a key to your vault. You can pause the vault or withdraw at any time.

## 4. Caps
We agree the caps together before the first payment: {per-payment cap, default ≤ 50 USDC} and {daily cap}. Please keep amounts small. The caps live in the vault, so they apply even if the AI misreads an invoice.

## 5. Your payee
Your payee signs the engagement (payee wallet, amounts, milestones) before any invoice is processed. Payments only go to that signed wallet. I will not onboard payees in sanctioned jurisdictions.

## 6. Your data
Invoices may contain personal data. Documents are stored as hashes plus redactable text, and raw invoice text is not written to logs. Your pilot data is private by default. On request I will delete your documents, and the on-chain records that remain contain no document text.

## 7. Publishing
Nothing about you is published unless you say yes below. If you agree, I publish anonymized statistics and explorer links for the payments. A quote or name appears only with your separate, explicit consent, and I will never invent one.
- Publish anonymized stats and explorer links: **{Y / N}**
- Quote / name permission: **{Y / N}** (quote: "{only the words you approved}")

## 8. Not financial, tax or legal advice
Moving USDC can carry tax and reporting duties where you live. Check with a qualified adviser. I am not providing financial, legal or tax advice.

## 9. Ending the pilot
Either of us can stop at any time, with a message. You can withdraw the vault balance yourself whenever you like.

## 10. Contact
{Kevin's contact for pilots — Kevin to fill; use his own address, not a session or login address}

Agreed by you (a reply message saying "agreed" is enough): ____________________
