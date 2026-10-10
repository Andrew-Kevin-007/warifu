# contracts/ (owner: CONTRACTS — WP-07, WP-08)

Spec: `docs/06_CONTRACTS_AND_CIRCLE.md` Part A (13-step `release` order, ring buffer, `hourlyCap`).
Read `https://docs.arc.io/arc/references/evm-differences.md` before writing a line.

Setup (once):
1. Install Arc Foundry per `docs/00_START_HERE.md` (`arc-forge`, `arc-cast`, `arc-anvil`).
2. `cd contracts && arc-forge install OpenZeppelin/openzeppelin-contracts` (pin a release tag; record it in `docs/CHANGELOG_SWARM.md`).
3. `arc-forge build && arc-forge test`.

Rules: custom errors, NatSpec, `SafeERC20`, `ReentrancyGuard`, EIP-712 via OZ, no `tx.origin`, no unbounded loops.
Never hardcode token addresses; write `deployments/<network>.json` from the docs' contract-addresses page.
