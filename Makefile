.PHONY: install verify lint typecheck test web-env claude-check claims-lint sec-local kickoff contracts-test attack clean sync-docs

install:
	pnpm install --frozen-lockfile

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

web-env:
	pnpm test:web-env

# Contracts use Arc Foundry (arc-forge). See docs/00_START_HERE.md for install.
contracts-test:
	cd contracts && arc-forge build && arc-forge test --fuzz-runs 5000

# Attack suite regression (wired up by WP-23).
attack:
	pnpm --filter @symbolon/attack-suite run attack

# v2: routing/hygiene drift check (SEC-11 static), wording lint (DEC-012), SEC suite tracker.
claude-check:
	pnpm claude:check

claims-lint:
	pnpm claims:lint

sec-local:
	pnpm sec:local

# Regenerate kickoff prompts and .claude/agents/* from docs/10 and docs/17.
kickoff:
	python3 scripts/gen-kickoff.py

verify: lint typecheck test web-env claude-check claims-lint
	@echo "make verify: OK (contracts-test, claims generation, lbc verify and sandbox SEC run separately; see docs/13 §5)"

clean:
	rm -rf node_modules */*/node_modules coverage
