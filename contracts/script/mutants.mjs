// Mutant catalogue for src/SymbolonVault.sol (WP-08). Consumed by script/mutation-check.mjs.
//
// Each entry is [id, find, replace]: `find` must occur EXACTLY once in the vault source; the runner applies the
// replacement to a scratch copy, runs the forge test suite, and requires a failing test. A mutant that does not
// compile is reported as INVALID (never as killed).
//
// Families (the id prefix): ctor, reg, close, rel, pc, ex, pause, signer, wd, guardian, view, cfg, roll.
//
// Not mutated on purpose (equivalent or unobservable; see contracts/README.md "Mutation testing"):
//   - SafeCast.toUint192 -> uint192(...): the constructor bounds perTxCap by uint192.max, so it never truncates.
//   - `a.payee` vs `e.payee` as the transfer target: step 6 makes them equal.
//   - nonReentrant on registerEngagement/proposePayeeChange: neither function makes a state-changing external call
//     (ERC-1271 checks are STATICCALLs).
// Every other branch, comparison, store, event and modifier in the contract has at least one mutant below.

/** @type {Array<[string, string, string]>} */
export const MUTANTS = [
  // ---- constructor ------------------------------------------------------------------------------------------
  ["ctor-token-zero", "address(token_) == address(0) || owner_ == address(0)", "owner_ == address(0)"],
  ["ctor-owner-zero", "|| owner_ == address(0) || kernelSigner_", "|| kernelSigner_"],
  ["ctor-kernel-zero", "kernelSigner_ == address(0)\n                || guardian_ == address(0)", "guardian_ == address(0)"],
  ["ctor-guardian-zero", "\n                || guardian_ == address(0)\n", "\n                || false\n"],
  ["ctor-pertx-zero", "if (perTxCap_ == 0 || dailyCap_ == 0 ||", "if (dailyCap_ == 0 ||"],
  ["ctor-daily-zero", "if (perTxCap_ == 0 || dailyCap_ == 0 ||", "if (perTxCap_ == 0 ||"],
  ["ctor-pertx-uint192", "|| perTxCap_ > type(uint192).max) revert InvalidConfig();", ") revert InvalidConfig();"],
  ["ctor-decimals", "tokenDecimals = IERC20Metadata(address(token_)).decimals();", "tokenDecimals = 6;"],
  ["ctor-pertx-assign", "perTxCap = perTxCap_;", "perTxCap = dailyCap_;"],
  ["ctor-daily-assign", "dailyCap = dailyCap_;", "dailyCap = perTxCap_;"],
  ["ctor-hourly-assign", "hourlyCap = hourlyCap_;", "hourlyCap = 0;"],
  ["ctor-threshold-assign", "humanThreshold = humanThreshold_;", "humanThreshold = perTxCap_;"],
  ["ctor-payee-delay-assign", "payeeChangeDelay = payeeChangeDelay_;", "payeeChangeDelay = signerChangeDelay_;"],
  ["ctor-signer-delay-assign", "signerChangeDelay = signerChangeDelay_;", "signerChangeDelay = payeeChangeDelay_;"],
  ["ctor-kernel-assign", "kernelSigner = kernelSigner_;", "kernelSigner = guardian_;"],
  ["ctor-guardian-assign", "guardian = guardian_;\n", "guardian = owner_;\n"],
  ["ctor-emit-config", "guardian = guardian_;\n\n        emit ConfigChanged(configHash());", "guardian = guardian_;\n"],

  // ---- registerEngagement -----------------------------------------------------------------------------------
  ["reg-owner-mismatch", "if (t.owner != owner) revert OwnerMismatch();", ""],
  ["reg-payee-zero", "if (t.payee == address(0)) revert ZeroAddress();", ""],
  ["reg-cap-zero", "if (t.cap == 0 || t.start > t.end) revert InvalidTerms();", "if (t.start > t.end) revert InvalidTerms();"],
  ["reg-start-eq-end", "t.start > t.end) revert InvalidTerms();", "t.start >= t.end) revert InvalidTerms();"],
  ["reg-start-after-end", "if (t.cap == 0 || t.start > t.end) revert InvalidTerms();", "if (t.cap == 0) revert InvalidTerms();"],
  ["reg-exists", "if (e.payee != address(0)) revert EngagementExists();", ""],
  [
    "reg-owner-sig",
    "bytes32 digest = engagementTermsDigest(t);\n        if (!SignatureChecker.isValidSignatureNowCalldata(owner, digest, ownerSig)) revert BadOwnerSig();",
    "bytes32 digest = engagementTermsDigest(t);",
  ],
  [
    "reg-payee-sig",
    "if (!SignatureChecker.isValidSignatureNowCalldata(t.payee, digest, payeeSig)) revert BadPayeeSig();",
    "",
  ],
  [
    "reg-payee-sig-wrong-signer",
    "isValidSignatureNowCalldata(t.payee, digest, payeeSig)) revert BadPayeeSig();",
    "isValidSignatureNowCalldata(owner, digest, payeeSig)) revert BadPayeeSig();",
  ],
  ["reg-nonce-store", "engagementNonce[t.engagementId] = t.nonce;", ""],
  ["reg-store-payee", "        e.payee = t.payee;\n        e.cap = t.cap;", "        e.cap = t.cap;"],
  ["reg-store-cap", "e.cap = t.cap;", ""],
  ["reg-store-start", "e.start = t.start;", ""],
  ["reg-store-end", "e.end = t.end;", ""],
  ["reg-store-termsHash", "e.termsHash = t.termsHash;", ""],
  ["reg-store-active", "e.active = true;", ""],
  ["reg-push", "engagementIds.push(t.engagementId);", ""],
  [
    "reg-emit",
    "emit EngagementRegistered(t.engagementId, t.owner, t.payee, t.cap, t.start, t.end, t.termsHash);",
    "",
  ],

  // ---- closeEngagement --------------------------------------------------------------------------------------
  ["close-only-owner", "function closeEngagement(bytes32 engagementId) external onlyOwner {", "function closeEngagement(bytes32 engagementId) external {"],
  ["close-active-check", "if (!e.active) revert NoEngagement();\n        e.active = false;", "e.active = false;"],
  ["close-set-inactive", "        e.active = false;\n        emit EngagementClosed(engagementId);", "        emit EngagementClosed(engagementId);"],
  ["close-emit", "emit EngagementClosed(engagementId);", ""],

  // ---- release: modifiers and the 13 steps -------------------------------------------------------------------
  ["rel-nonreentrant", ") external nonReentrant {\n        // 1", ") external {\n        // 1"],
  ["rel-1-paused", "if (paused) revert Paused();\n        // 2", "// 2"],
  ["rel-2-expired-inclusive", "if (a.deadline < block.timestamp) revert Expired();", "if (a.deadline <= block.timestamp) revert Expired();"],
  ["rel-2-expired-removed", "if (a.deadline < block.timestamp) revert Expired();", ""],
  ["rel-3-used-check", "if (used[a.intentId]) revert AlreadyUsed();", ""],
  ["rel-3-used-set", "used[a.intentId] = true;", ""],
  [
    "rel-4-kernel-sig",
    "if (!SignatureChecker.isValidSignatureNowCalldata(kernelSigner, attestationDigest(a), kernelSig)) {",
    "if (false) {",
  ],
  [
    "rel-4-kernel-sig-owner-as-signer",
    "isValidSignatureNowCalldata(kernelSigner, attestationDigest(a), kernelSig)) {",
    "isValidSignatureNowCalldata(owner, attestationDigest(a), kernelSig)) {",
  ],
  ["rel-5-active", "if (!e.active) revert NoEngagement();\n        // 6", "// 6"],
  ["rel-6-payee", "if (a.payee != e.payee) revert PayeeMismatch();", ""],
  ["rel-7-start-removed", "if (block.timestamp < e.start || block.timestamp > e.end) revert OutOfWindow();", "if (block.timestamp > e.end) revert OutOfWindow();"],
  ["rel-7-end-removed", "if (block.timestamp < e.start || block.timestamp > e.end) revert OutOfWindow();", "if (block.timestamp < e.start) revert OutOfWindow();"],
  ["rel-7-start-inclusive", "block.timestamp < e.start ||", "block.timestamp <= e.start ||"],
  ["rel-7-end-inclusive", "block.timestamp > e.end) revert OutOfWindow();", "block.timestamp >= e.end) revert OutOfWindow();"],
  ["rel-8-amount-zero", "if (a.amount == 0 || a.amount > perTxCap) revert PerTxCap();", "if (a.amount > perTxCap) revert PerTxCap();"],
  ["rel-8-pertx-inclusive", "a.amount > perTxCap) revert PerTxCap();", "a.amount >= perTxCap) revert PerTxCap();"],
  ["rel-8-pertx-removed", "if (a.amount == 0 || a.amount > perTxCap) revert PerTxCap();", "if (a.amount == 0) revert PerTxCap();"],
  ["rel-9-cap-inclusive", "if (e.released + a.amount > e.cap) revert EngagementCap();", "if (e.released + a.amount >= e.cap) revert EngagementCap();"],
  ["rel-9-cap-removed", "if (e.released + a.amount > e.cap) revert EngagementCap();", ""],
  ["rel-9-cap-ignores-released", "if (e.released + a.amount > e.cap) revert EngagementCap();", "if (a.amount > e.cap) revert EngagementCap();"],
  ["rel-10-rolling-removed", "_checkRolling(a.amount);", ""],
  ["rel-11-threshold-inclusive", "if (a.amount > humanThreshold) {", "if (a.amount >= humanThreshold) {"],
  ["rel-11-threshold-removed", "if (a.amount > humanThreshold) {", "if (false) {"],
  ["rel-11-approval-deadline-inclusive", "if (ref.deadline < block.timestamp) revert ApprovalExpired();", "if (ref.deadline <= block.timestamp) revert ApprovalExpired();"],
  ["rel-11-approval-deadline-removed", "if (ref.deadline < block.timestamp) revert ApprovalExpired();", ""],
  [
    "rel-11-approval-sig-removed",
    "if (!SignatureChecker.isValidSignatureNowCalldata(owner, approvalDigest, ownerApprovalSig)) {",
    "if (false) {",
  ],
  [
    "rel-11-approval-signer-is-kernel",
    "isValidSignatureNowCalldata(owner, approvalDigest, ownerApprovalSig)) {",
    "isValidSignatureNowCalldata(kernelSigner, approvalDigest, ownerApprovalSig)) {",
  ],
  [
    "rel-11-approval-not-bound-to-intent",
    "ownerApprovalDigest(a.intentId, ref.receiptHash, a.amount, ref.deadline);",
    "ownerApprovalDigest(bytes32(0), ref.receiptHash, a.amount, ref.deadline);",
  ],
  [
    "rel-11-approval-not-bound-to-amount",
    "ownerApprovalDigest(a.intentId, ref.receiptHash, a.amount, ref.deadline);",
    "ownerApprovalDigest(a.intentId, ref.receiptHash, humanThreshold, ref.deadline);",
  ],
  [
    "rel-11-approval-not-bound-to-receipt",
    "ownerApprovalDigest(a.intentId, ref.receiptHash, a.amount, ref.deadline);",
    "ownerApprovalDigest(a.intentId, a.receiptHash, a.amount, ref.deadline);",
  ],
  ["rel-12-released-effect", "e.released += a.amount;", ""],
  ["rel-12-ring-write", "ring[ringHead] = Rel({t: uint64(block.timestamp), amt: SafeCast.toUint192(a.amount)});", ""],
  ["rel-12-ring-time", "Rel({t: uint64(block.timestamp), amt:", "Rel({t: 0, amt:"],
  ["rel-12-ring-amount", "amt: SafeCast.toUint192(a.amount)});", "amt: 1});"],
  ["rel-12-ring-head-advance", "ringHead = uint8((uint256(ringHead) + 1) % RING_SIZE);", ""],
  ["rel-12-ring-head-modulus", "% RING_SIZE);\n        // 13", "% (RING_SIZE - 1));\n        // 13"],
  ["rel-13-transfer", "token.safeTransfer(e.payee, a.amount);\n        emit Released", "emit Released"],
  ["rel-13-transfer-to-caller", "token.safeTransfer(e.payee, a.amount);", "token.safeTransfer(msg.sender, a.amount);"],
  ["rel-13-emit", "emit Released(a.intentId, a.engagementId, e.payee, a.amount, a.receiptHash);", ""],
  ["rel-13-emit-amount", "emit Released(a.intentId, a.engagementId, e.payee, a.amount, a.receiptHash);", "emit Released(a.intentId, a.engagementId, e.payee, e.released, a.receiptHash);"],

  // ---- proposePayeeChange ------------------------------------------------------------------------------------
  [
    "pc-paused",
    "        if (paused) revert Paused();\n        Engagement storage e = engagements[pc.engagementId];",
    "        Engagement storage e = engagements[pc.engagementId];",
  ],
  ["pc-active", "if (!e.active) revert NoEngagement();\n        if (pc.oldPayee != e.payee) revert PayeeMismatch();", "if (pc.oldPayee != e.payee) revert PayeeMismatch();"],
  ["pc-old-payee", "if (pc.oldPayee != e.payee) revert PayeeMismatch();", ""],
  ["pc-new-zero", "if (pc.newPayee == address(0)) revert ZeroAddress();", ""],
  ["pc-new-is-old", "if (pc.newPayee == pc.oldPayee) revert InvalidTerms();", ""],
  ["pc-nonce-equal", "if (pc.nonce <= engagementNonce[pc.engagementId]) revert NonceUsed();", "if (pc.nonce < engagementNonce[pc.engagementId]) revert NonceUsed();"],
  ["pc-nonce-removed", "if (pc.nonce <= engagementNonce[pc.engagementId]) revert NonceUsed();", ""],
  [
    "pc-owner-sig",
    "bytes32 digest = payeeChangeDigest(pc);\n        if (!SignatureChecker.isValidSignatureNowCalldata(owner, digest, ownerSig)) revert BadOwnerSig();",
    "bytes32 digest = payeeChangeDigest(pc);",
  ],
  [
    "pc-old-sig",
    "if (!SignatureChecker.isValidSignatureNowCalldata(pc.oldPayee, digest, oldSig)) revert BadPayeeSig();",
    "",
  ],
  [
    "pc-new-sig",
    "if (!SignatureChecker.isValidSignatureNowCalldata(pc.newPayee, digest, newSig)) revert BadNewPayeeSig();",
    "",
  ],
  [
    "pc-old-sig-checks-new-payee",
    "isValidSignatureNowCalldata(pc.oldPayee, digest, oldSig)) revert BadPayeeSig();",
    "isValidSignatureNowCalldata(pc.newPayee, digest, oldSig)) revert BadPayeeSig();",
  ],
  ["pc-nonce-store", "engagementNonce[pc.engagementId] = pc.nonce;", ""],
  ["pc-eta-no-delay", "uint64 eta = uint64(block.timestamp) + payeeChangeDelay;", "uint64 eta = uint64(block.timestamp);"],
  ["pc-eta-signer-delay", "uint64 eta = uint64(block.timestamp) + payeeChangeDelay;", "uint64 eta = uint64(block.timestamp) + signerChangeDelay;"],
  ["pc-store-pending", "pendingPayee[pc.engagementId] = PendingPayee({newPayee: pc.newPayee, eta: eta});", ""],
  ["pc-store-epoch", "pendingPayeeEpoch[pc.engagementId] = pauseEpoch;", ""],
  ["pc-emit", "emit PayeeChangeProposed(pc.engagementId, pc.oldPayee, pc.newPayee, eta);", ""],

  // ---- executePayeeChange / payeeChangeLive -------------------------------------------------------------------
  [
    "ex-paused",
    "        if (paused) revert Paused();\n        PendingPayee memory pp",
    "        PendingPayee memory pp",
  ],
  ["ex-no-pending", "if (pp.newPayee == address(0)) revert NoPendingChange();", ""],
  ["ex-epoch", "if (pendingPayeeEpoch[engagementId] != pauseEpoch) revert PayeeChangeCancelled();", ""],
  ["ex-eta-inclusive", "if (block.timestamp < pp.eta) revert TooEarly();\n        Engagement storage e = engagements[engagementId];", "if (block.timestamp <= pp.eta) revert TooEarly();\n        Engagement storage e = engagements[engagementId];"],
  ["ex-eta-removed", "if (block.timestamp < pp.eta) revert TooEarly();\n        Engagement storage e = engagements[engagementId];", "Engagement storage e = engagements[engagementId];"],
  ["ex-active", "if (!e.active) revert NoEngagement();\n\n        address previous = e.payee;", "address previous = e.payee;"],
  ["ex-set-payee", "e.payee = pp.newPayee;", ""],
  ["ex-delete-pending", "delete pendingPayee[engagementId];", ""],
  ["ex-delete-epoch", "delete pendingPayeeEpoch[engagementId];", ""],
  ["ex-emit", "emit PayeeChangeExecuted(engagementId, previous, pp.newPayee);", ""],
  [
    "live-no-pending-check",
    "return pendingPayee[engagementId].newPayee != address(0) && pendingPayeeEpoch[engagementId] == pauseEpoch;",
    "return pendingPayeeEpoch[engagementId] == pauseEpoch;",
  ],
  [
    "live-no-epoch-check",
    "return pendingPayee[engagementId].newPayee != address(0) && pendingPayeeEpoch[engagementId] == pauseEpoch;",
    "return pendingPayee[engagementId].newPayee != address(0);",
  ],

  // ---- pause / unpause -----------------------------------------------------------------------------------------
  ["pause-guardian-cannot", "if (msg.sender != owner && msg.sender != guardian) revert Unauthorized();", "if (msg.sender != owner) revert Unauthorized();"],
  ["pause-anyone", "if (msg.sender != owner && msg.sender != guardian) revert Unauthorized();", ""],
  ["pause-owner-cannot", "if (msg.sender != owner && msg.sender != guardian) revert Unauthorized();", "if (msg.sender != guardian) revert Unauthorized();"],
  ["pause-set", "        paused = true;\n        ++pauseEpoch;", "        ++pauseEpoch;"],
  ["pause-epoch", "++pauseEpoch;", ""],
  ["pause-emit", "emit VaultPaused(msg.sender);", ""],
  ["unpause-only-owner", "function unpause() external onlyOwner {", "function unpause() external {"],
  ["unpause-set", "paused = false;", ""],
  ["unpause-emit", "emit VaultUnpaused(msg.sender);", ""],

  // ---- kernel signer rotation ----------------------------------------------------------------------------------
  ["signer-propose-only-owner", "function proposeKernelSigner(address next) external onlyOwner {", "function proposeKernelSigner(address next) external {"],
  ["signer-propose-zero", "if (next == address(0)) revert ZeroAddress();\n        uint64 eta", "uint64 eta"],
  ["signer-propose-no-delay", "uint64 eta = uint64(block.timestamp) + signerChangeDelay;", "uint64 eta = uint64(block.timestamp);"],
  ["signer-propose-payee-delay", "uint64 eta = uint64(block.timestamp) + signerChangeDelay;", "uint64 eta = uint64(block.timestamp) + payeeChangeDelay;"],
  ["signer-propose-store", "pendingSigner = next;", ""],
  ["signer-propose-store-eta", "pendingSignerEta = eta;", ""],
  ["signer-propose-emit", "emit KernelSignerProposed(next, eta);", ""],
  ["signer-execute-only-owner", "function executeKernelSigner() external onlyOwner {", "function executeKernelSigner() external {"],
  ["signer-execute-no-pending", "if (next == address(0)) revert NoPendingChange();", ""],
  ["signer-execute-eta-inclusive", "if (block.timestamp < pendingSignerEta) revert TooEarly();", "if (block.timestamp <= pendingSignerEta) revert TooEarly();"],
  ["signer-execute-eta-removed", "if (block.timestamp < pendingSignerEta) revert TooEarly();", ""],
  ["signer-execute-set", "kernelSigner = next;", ""],
  ["signer-execute-delete-pending", "delete pendingSigner;", ""],
  ["signer-execute-delete-eta", "delete pendingSignerEta;", ""],
  ["signer-execute-emit-rotated", "emit KernelSignerRotated(previous, next);", ""],
  ["signer-execute-emit-config", "emit KernelSignerRotated(previous, next);\n        emit ConfigChanged(configHash());", "emit KernelSignerRotated(previous, next);"],

  // ---- withdraw / guardian ---------------------------------------------------------------------------------------
  ["wd-only-owner", "function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {", "function withdraw(address to, uint256 amount) external nonReentrant {"],
  ["wd-nonreentrant", "function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {", "function withdraw(address to, uint256 amount) external onlyOwner {"],
  ["wd-zero-to", "if (to == address(0)) revert ZeroAddress();\n        token.safeTransfer(to, amount);", "token.safeTransfer(to, amount);"],
  ["wd-transfer", "token.safeTransfer(to, amount);\n        emit Withdrawn(to, amount);", "emit Withdrawn(to, amount);"],
  ["wd-emit", "emit Withdrawn(to, amount);", ""],
  ["wd-blocked-while-paused", "function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {\n", "function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {\n        if (paused) revert Paused();\n"],
  ["guardian-only-owner", "function setGuardian(address g) external onlyOwner {", "function setGuardian(address g) external {"],
  ["guardian-zero", "if (g == address(0)) revert ZeroAddress();\n        address previous = guardian;", "address previous = guardian;"],
  ["guardian-set", "guardian = g;", ""],
  ["guardian-emit-changed", "emit GuardianChanged(previous, g);", ""],
  ["guardian-emit-config", "emit GuardianChanged(previous, g);\n        emit ConfigChanged(configHash());", "emit GuardianChanged(previous, g);"],

  // ---- views and digests -----------------------------------------------------------------------------------------
  ["view-engagement-count", "return engagementIds.length;", "return 0;"],
  ["view-engagement-id-at", "return engagementIds[i];", "return engagementIds[0];"],
  ["view-domain-separator", "return _domainSeparatorV4();", "return bytes32(0);"],
  [
    "digest-attestation-field-order",
    "ATTESTATION_TYPEHASH,\n                    a.intentId,\n                    a.engagementId,",
    "ATTESTATION_TYPEHASH,\n                    a.engagementId,\n                    a.intentId,",
  ],
  [
    "digest-attestation-drops-receipt",
    "a.amount,\n                    a.receiptHash,\n                    a.deadline",
    "a.amount,\n                    bytes32(0),\n                    a.deadline",
  ],
  [
    "digest-terms-drops-termshash",
    "t.end,\n                    t.termsHash,\n                    t.nonce",
    "t.end,\n                    bytes32(0),\n                    t.nonce",
  ],
  [
    "digest-payee-change-drops-nonce",
    "abi.encode(PAYEE_CHANGE_TYPEHASH, pc.engagementId, pc.oldPayee, pc.newPayee, pc.nonce)",
    "abi.encode(PAYEE_CHANGE_TYPEHASH, pc.engagementId, pc.oldPayee, pc.newPayee, uint256(0))",
  ],
  [
    "digest-approval-drops-deadline",
    "abi.encode(OWNER_APPROVAL_TYPEHASH, intentId, receiptHash, amount, deadline)",
    "abi.encode(OWNER_APPROVAL_TYPEHASH, intentId, receiptHash, amount, uint64(0))",
  ],
  [
    "digest-approval-drops-receipt",
    "abi.encode(OWNER_APPROVAL_TYPEHASH, intentId, receiptHash, amount, deadline)",
    "abi.encode(OWNER_APPROVAL_TYPEHASH, intentId, bytes32(0), amount, deadline)",
  ],
  [
    "digest-terms-drops-nonce",
    "t.end,\n                    t.termsHash,\n                    t.nonce",
    "t.end,\n                    t.termsHash,\n                    uint256(0)",
  ],
  [
    "digest-payee-change-drops-new-payee",
    "abi.encode(PAYEE_CHANGE_TYPEHASH, pc.engagementId, pc.oldPayee, pc.newPayee, pc.nonce)",
    "abi.encode(PAYEE_CHANGE_TYPEHASH, pc.engagementId, pc.oldPayee, pc.oldPayee, pc.nonce)",
  ],
  ["const-ring-size", "uint8 public constant RING_SIZE = 64;", "uint8 public constant RING_SIZE = 32;"],

  // ---- configHash --------------------------------------------------------------------------------------------------
  [
    "cfg-drops-guardian",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, perTxCap),",
  ],
  [
    "cfg-drops-decimals",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
    "abi.encode(address(token), owner, kernelSigner, guardian, perTxCap),",
  ],
  [
    "cfg-drops-owner",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
    "abi.encode(address(token), tokenDecimals, kernelSigner, guardian, perTxCap),",
  ],
  [
    "cfg-drops-kernel",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
    "abi.encode(address(token), tokenDecimals, owner, guardian, perTxCap),",
  ],
  [
    "cfg-drops-token",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
    "abi.encode(tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
  ],
  [
    "cfg-drops-hourly",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
    "abi.encode(dailyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
  ],
  [
    "cfg-drops-threshold",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
    "abi.encode(dailyCap, hourlyCap, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
  ],
  [
    "cfg-drops-delays",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, RING_SIZE)",
  ],
  [
    "cfg-drops-ring-size",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay)",
  ],
  [
    "cfg-includes-paused",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),",
    "abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap, paused),",
  ],
  [
    "cfg-includes-pending-signer",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)",
    "abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE, pendingSigner)",
  ],

  // ---- rolling window ---------------------------------------------------------------------------------------------
  ["roll-skip-empty", "if (r.amt == 0) continue;", ""],
  ["roll-day-inclusive", "if (age < 1 days) {", "if (age <= 1 days) {"],
  ["roll-day-shorter", "if (age < 1 days) {", "if (age < 1 days - 1) {"],
  ["roll-hour-inclusive", "if (age < 1 hours) hourSum += r.amt;", "if (age <= 1 hours) hourSum += r.amt;"],
  ["roll-hour-shorter", "if (age < 1 hours) hourSum += r.amt;", "if (age < 1 hours - 1) hourSum += r.amt;"],
  ["roll-hour-ignores-window", "if (age < 1 hours) hourSum += r.amt;", "hourSum += r.amt;"],
  ["roll-day-sum", "daySum += r.amt;", ""],
  ["roll-count", "++count;", ""],
  ["roll-hour-sum", "if (age < 1 hours) hourSum += r.amt;", ""],
  ["roll-loop-skips-last-slot", "for (uint256 i = 0; i < RING_SIZE; ++i) {", "for (uint256 i = 0; i + 1 < RING_SIZE; ++i) {"],
  ["check-daily-inclusive", "if (daySum + amount > dailyCap) revert DailyCap();", "if (daySum + amount >= dailyCap) revert DailyCap();"],
  ["check-daily-removed", "if (daySum + amount > dailyCap) revert DailyCap();", ""],
  ["check-count-over", "if (count >= RING_SIZE) revert TooManyReleases();", "if (count > RING_SIZE) revert TooManyReleases();"],
  ["check-count-removed", "if (count >= RING_SIZE) revert TooManyReleases();", ""],
  [
    "check-hourly-inclusive",
    "if (hourlyCap != 0 && hourSum + amount > hourlyCap) revert HourlyCap();",
    "if (hourlyCap != 0 && hourSum + amount >= hourlyCap) revert HourlyCap();",
  ],
  [
    "check-hourly-zero-not-disabled",
    "if (hourlyCap != 0 && hourSum + amount > hourlyCap) revert HourlyCap();",
    "if (hourSum + amount > hourlyCap) revert HourlyCap();",
  ],
  [
    "check-hourly-removed",
    "if (hourlyCap != 0 && hourSum + amount > hourlyCap) revert HourlyCap();",
    "",
  ],
  [
    "check-hourly-before-count",
    "        if (count >= RING_SIZE) revert TooManyReleases();\n        if (hourlyCap != 0 && hourSum + amount > hourlyCap) revert HourlyCap();",
    "        if (hourlyCap != 0 && hourSum + amount > hourlyCap) revert HourlyCap();\n        if (count >= RING_SIZE) revert TooManyReleases();",
  ],
  [
    "check-count-before-daily",
    "        if (daySum + amount > dailyCap) revert DailyCap();\n        // count < RING_SIZE also",
    "        if (count >= RING_SIZE) revert TooManyReleases();\n        if (daySum + amount > dailyCap) revert DailyCap();\n        // count < RING_SIZE also",
  ],
];
