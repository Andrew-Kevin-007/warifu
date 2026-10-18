# Real Arc testnet evidence (2026-10-18)

Three real payments on **Arc testnet** (chain 5042002) through the vault `0x00B513896E67C73fC407780cF8568fdc81596c82`. They are **internal**: between wallets we control, never counted as traction. Each file here is the kernel's signed receipt for the release; anyone can check it without trusting us.

| # | What ran | Receipt file | Release tx (explorer) | Block |
|---|---|---|---|---|
| 1 | Invoice fields entered by hand; plain testnet relayer key | `receipt-1-first-payment-hand-entered-plain-relayer.json` | [`0x6f9997fc…8b0b`](https://explorer.testnet.arc.io/tx/0x6f9997fc1e7d6254ca4e065c7841dbd79e401aac055c1ea7deb919159acf8b0b) | 67753497 |
| 2 | Invoice fields entered by hand; **Circle developer-controlled wallet** as relayer | `receipt-2-circle-wallet-relayer-hand-entered.json` | [`0xb7c63057…b397`](https://explorer.testnet.arc.io/tx/0xb7c63057c1864f5807b8c40b3897cf62cb30ce88709b1e84340b7afbf625b397) | 67757800 |
| 3 | **Two Gemini models read the invoice** (free tier); kernel escalated it as a near duplicate; the owner approved; Circle wallet released | `receipt-3-ai-read-gemini-circle-wallet-relayer.json` | [`0x7350f7d8…b3b9b`](https://explorer.testnet.arc.io/tx/0x7350f7d8f899962ab7aa5da4443ea32318a8f352cbdbb44ffb07a61bb4bb3b9b) | 67761548 |

A model only proposes. The kernel decided every payment and the vault enforced it; no model output is a release condition.

## Verify a receipt yourself

**In the browser:** open `/audit`, paste the file's contents into "Paste a signed receipt instead of fetching it from this server", enter the vault address above, and press "Verify in this browser".

**On the command line** (checks schema, hash, EIP-712 signature, the vault's kernel signer, and the vault's `Released` event on chain). Public Arc RPCs refuse wide `eth_getLogs` ranges, so give a start block a little before the release:

```
pnpm verify-receipt docs/evidence/receipt-1-first-payment-hand-entered-plain-relayer.json --vault 0x00B513896E67C73fC407780cF8568fdc81596c82 --rpc https://rpc.testnet.arc.io --from-block 67753400 --log-range 4000
pnpm verify-receipt docs/evidence/receipt-2-circle-wallet-relayer-hand-entered.json      --vault 0x00B513896E67C73fC407780cF8568fdc81596c82 --rpc https://rpc.testnet.arc.io --from-block 67757700 --log-range 4000
pnpm verify-receipt docs/evidence/receipt-3-ai-read-gemini-circle-wallet-relayer.json    --vault 0x00B513896E67C73fC407780cF8568fdc81596c82 --rpc https://rpc.testnet.arc.io --from-block 67761400 --log-range 4000
```

Exit code 0 means verified. All three printed `RESULT: VERIFIED` when run on 2026-10-18. The public RPC also rate-limits long scans, so a very early `--from-block` can fail with an anchor error; that is the RPC, not the receipt.

Findings from this run are in `docs/VERIFY_LOG.md`.
