// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice WP-08: differential fuzzing of the FULL revert precedence and of the validation order of every
/// state-changing entry point against small independent oracles (docs/06 A.4). Fuzz.t.sol checks one dimension per
/// test; here every dimension varies at once, so any wrong precedence between two checks shows up as a different
/// error selector. The oracles read vault state only to learn what earlier random calls did; the decision logic is
/// restated in the test.
contract FuzzModelTest is VaultTestBase {
    // ---- release: precedence of steps 1..11 -------------------------------------------------------------------

    struct World {
        uint256[] histT;
        uint256[] histAmt;
        bytes32 closedId;
        bytes32 unknownId;
        bytes32 usedIntent;
        uint256 rng;
    }

    World internal w;

    function _rand(uint256 modulo) internal returns (uint256) {
        w.rng = uint256(keccak256(abi.encode(w.rng, "step")));
        return w.rng % modulo;
    }

    function _deployWith(uint256 hourly, uint256 threshold) internal {
        hourlyCap = hourly;
        humanThreshold = threshold;
        vault = _deployVault(owner, kernel);
        token.mint(address(vault), 10_000 * USDC);
    }

    /// Random history (releases, pauses, closes, time) then one attestation with every field randomized; the oracle
    /// names the first failing step, and the vault must revert with exactly that error (or release).
    function testFuzz_release_firstFailingStepMatchesOracle(uint256 seed) public {
        _scenario(seed);
    }

    mapping(bytes4 => uint256) internal outcomes;

    /// Non-vacuity: over a fixed sweep of seeds every reachable outcome (each revert precedence step, and success)
    /// occurs at least once, so the fuzz test above is not passing through one corner of the state space.
    function test_oracleSweep_reachesEveryOutcome() public {
        for (uint256 seed = 1; seed <= 240; ++seed) {
            delete w.histT;
            delete w.histAmt;
            w.usedIntent = bytes32(0);
            outcomes[this.scenarioExt(seed * 0x9E3779B97F4A7C15)] += 1; // own call frame: memory is freed per scenario
        }
        bytes4[13] memory expectedKinds = [
            SymbolonVault.Paused.selector,
            SymbolonVault.Expired.selector,
            SymbolonVault.AlreadyUsed.selector,
            SymbolonVault.BadKernelSig.selector,
            SymbolonVault.NoEngagement.selector,
            SymbolonVault.PayeeMismatch.selector,
            SymbolonVault.OutOfWindow.selector,
            SymbolonVault.PerTxCap.selector,
            SymbolonVault.EngagementCap.selector,
            SymbolonVault.DailyCap.selector,
            SymbolonVault.HourlyCap.selector,
            SymbolonVault.ApprovalExpired.selector,
            SymbolonVault.ApprovalRequired.selector
        ];
        for (uint256 i = 0; i < expectedKinds.length; ++i) {
            assertGt(outcomes[expectedKinds[i]], 0, string.concat("outcome never produced, index ", vm.toString(i)));
        }
        assertGt(outcomes[bytes4(0)], 0, "a successful release was never produced");
    }

    function scenarioExt(uint256 seed) external returns (bytes4) {
        require(msg.sender == address(this), "internal helper");
        return _scenario(seed);
    }

    function _scenario(uint256 seed) internal returns (bytes4 expected) {
        w.rng = seed;
        _deployWith(_rand(2) == 0 ? 0 : (30 + _rand(100)) * USDC, _rand(3) * 25 * USDC);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, (60 + _rand(300)) * USDC);
        uint256 wk = _rand(8); // where in time the history starts: before / at / after the window, or inside
        t.start = uint64(block.timestamp + (wk == 0 ? 1 hours : _rand(2) * 1 hours));
        t.end = uint64(t.start + 1 days + _rand(3 days));
        _register(t);
        w.closedId = keccak256("closed-engagement");
        _register(_terms(w.closedId, payee2, 100 * USDC));
        vm.prank(owner);
        vault.closeEngagement(w.closedId);
        w.unknownId = keccak256("unknown-engagement");

        // random prior history: releases of random size at random times, sometimes a pause/unpause cycle
        vm.warp(wk == 0 ? t.start - 1 : wk == 1 ? t.end + 1 : wk == 2 ? t.end : t.start + _rand(2));
        uint256 steps = _rand(7);
        for (uint256 i = 0; i < steps; ++i) {
            vm.warp(block.timestamp + _rand(3) * (_rand(2) == 0 ? 1 : 40 minutes));
            if (_rand(8) == 0) {
                vm.prank(guardian);
                vault.pause();
                vm.prank(owner);
                vault.unpause();
            }
            _priorRelease((1 + _rand(110)) * USDC);
        }
        vm.warp(block.timestamp + _rand(4) * (_rand(2) == 0 ? 1 : 30 minutes));
        if (_rand(10) == 0) {
            vm.prank(_rand(2) == 0 ? owner : guardian);
            vault.pause();
        }
        return _finalAttemptAndCompare();
    }

    function _priorRelease(uint256 amount) internal {
        SymbolonVault.Attestation memory a = _att(ENG, payee, amount);
        bytes memory ksig = _kernelSig(a);
        SymbolonVault.OwnerApprovalRef memory ref = _noRef();
        bytes memory osig;
        if (amount > vault.humanThreshold()) (ref, osig) = _approval(a, keccak256("esc"), uint64(block.timestamp + 1 days));
        try vault.release(a, ksig, ref, osig) {
            w.histT.push(block.timestamp);
            w.histAmt.push(amount);
            if (_rand(4) == 0) w.usedIntent = a.intentId; // a later attempt may replay it
        } catch {}
    }

    struct Final {
        SymbolonVault.Attestation a;
        SymbolonVault.OwnerApprovalRef ref;
        bytes ksig;
        bytes osig;
        bool kernelSigValid;
        bool approvalValid;
    }

    function _buildFinal() internal returns (Final memory f) {
        uint256 e = _rand(10);
        bytes32 id = e == 0 ? w.unknownId : e == 1 ? w.closedId : ENG;
        address p = _rand(6) == 0 ? payee2 : payee;
        f.a = _att(id, p, _finalAmount());
        if (w.usedIntent != bytes32(0) && _rand(5) == 0) f.a.intentId = w.usedIntent;
        uint256 dl = _rand(8);
        f.a.deadline = dl == 0
            ? uint64(block.timestamp - 1)
            : dl == 1 ? uint64(block.timestamp) : uint64(block.timestamp + 1 + _rand(2 hours));

        f.kernelSigValid = _rand(8) != 0;
        f.ksig = _sign(f.kernelSigValid ? kernel : attacker, _digest(address(vault), _attHash(f.a)));

        // approval: valid / expired / wrong amount / wrong signer / absent
        uint256 ap = _rand(6);
        if (ap == 5) return f; // no approval at all: zero ref, empty signature
        uint64 refDeadline = ap == 1 ? uint64(block.timestamp - 1) : uint64(block.timestamp + 1 hours);
        uint256 approvedAmount = ap == 2 ? f.a.amount + 1 : f.a.amount;
        address approver = ap == 3 ? attacker : owner;
        f.ref = SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: refDeadline});
        f.osig = _sign(
            approver, _digest(address(vault), _approvalHash(f.a.intentId, f.ref.receiptHash, approvedAmount, refDeadline))
        );
        f.approvalValid = ap == 0 || ap == 4;
    }

    function _finalAmount() internal returns (uint256) {
        uint256 k = _rand(8);
        if (k == 0) return 0;
        if (k == 1) return perTxCap;
        if (k == 2) return perTxCap + 1;
        if (k == 3) return vault.humanThreshold();
        if (k == 4) return vault.humanThreshold() + 1;
        return 1 + _rand(110 * USDC);
    }

    /// @dev docs/06 A.4 steps 1..11, restated.
    function _oracle(Final memory f) internal view returns (bytes4) {
        if (vault.paused()) return SymbolonVault.Paused.selector;
        if (f.a.deadline < block.timestamp) return SymbolonVault.Expired.selector;
        if (vault.used(f.a.intentId)) return SymbolonVault.AlreadyUsed.selector;
        if (!f.kernelSigValid) return SymbolonVault.BadKernelSig.selector;
        (address ep, uint256 ecap, uint256 erel, uint64 es, uint64 ee,, bool active) = vault.engagements(f.a.engagementId);
        if (!active) return SymbolonVault.NoEngagement.selector;
        if (f.a.payee != ep) return SymbolonVault.PayeeMismatch.selector;
        if (block.timestamp < es || block.timestamp > ee) return SymbolonVault.OutOfWindow.selector;
        if (f.a.amount == 0 || f.a.amount > perTxCap) return SymbolonVault.PerTxCap.selector;
        if (erel + f.a.amount > ecap) return SymbolonVault.EngagementCap.selector;
        uint256 daySum;
        uint256 hourSum;
        uint256 count;
        for (uint256 i = 0; i < w.histT.length; ++i) {
            if (block.timestamp < w.histT[i] + 1 days) {
                daySum += w.histAmt[i];
                ++count;
                if (block.timestamp < w.histT[i] + 1 hours) hourSum += w.histAmt[i];
            }
        }
        if (daySum + f.a.amount > dailyCap) return SymbolonVault.DailyCap.selector;
        if (count >= 64) return SymbolonVault.TooManyReleases.selector;
        if (hourlyCap != 0 && hourSum + f.a.amount > hourlyCap) return SymbolonVault.HourlyCap.selector;
        if (f.a.amount > vault.humanThreshold()) {
            if (f.ref.deadline < block.timestamp) return SymbolonVault.ApprovalExpired.selector;
            if (!f.approvalValid) return SymbolonVault.ApprovalRequired.selector;
        }
        return bytes4(0);
    }

    function _finalAttemptAndCompare() internal returns (bytes4 expected) {
        Final memory f = _buildFinal();
        expected = _oracle(f);
        uint256 payeeBefore = token.balanceOf(f.a.payee);
        bool wasUsed = vault.used(f.a.intentId);
        if (expected != bytes4(0)) {
            vm.expectRevert(expected);
            vault.release(f.a, f.ksig, f.ref, f.osig);
            assertEq(vault.used(f.a.intentId), wasUsed, "a failed release changes nothing");
            assertEq(token.balanceOf(f.a.payee), payeeBefore);
        } else {
            vault.release(f.a, f.ksig, f.ref, f.osig);
            assertTrue(vault.used(f.a.intentId));
            assertEq(token.balanceOf(f.a.payee), payeeBefore + f.a.amount);
        }
    }

    // ---- registerEngagement: validation order ------------------------------------------------------------------

    function _pick(uint256 seed, string memory tag, uint256 modulo) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, tag))) % modulo;
    }

    struct RegCase {
        SymbolonVault.EngagementTerms t;
        bytes os;
        bytes ps;
        bytes4 expected;
    }

    function _regCase(uint256 seed, bytes32 existingId) internal view returns (RegCase memory c) {
        c.t = _terms(_pick(seed, "dup", 4) == 0 ? existingId : keccak256(abi.encode("fresh", seed)), payee, 50 * USDC);
        if (_pick(seed, "owner", 6) == 0) c.t.owner = address(uint160(uint256(keccak256(abi.encode(seed, "o")))));
        uint256 pk = _pick(seed, "payee", 6);
        address signingPayee = payee2;
        if (pk == 0) c.t.payee = address(0);
        else if (pk == 1) c.t.payee = attacker;
        else if (pk == 2) c.t.payee = address(uint160(uint256(keccak256(abi.encode(seed, "p"))))); // no key
        else c.t.payee = payee2;
        if (keyOf[c.t.payee] != 0) signingPayee = c.t.payee;
        c.t.cap = _pick(seed, "cap", 6) == 0 ? 0 : 1 + _pick(seed, "cap2", 1_000 * USDC);
        if (_pick(seed, "time", 6) == 0) {
            c.t.start = uint64(_pick(seed, "s", type(uint64).max));
            c.t.end = uint64(_pick(seed, "e", type(uint64).max));
        } else {
            c.t.start = uint64(1 + _pick(seed, "s", 4e9));
            c.t.end = c.t.start + uint64(_pick(seed, "e", 365 days));
        }
        c.t.nonce = _pick(seed, "nonce", 5);
        bytes32 d = _digest(address(vault), _termsHash(c.t));
        bool forgeOwner = _pick(seed, "fo", 6) == 0;
        bool forgePayee = _pick(seed, "fp", 6) == 0;
        c.os = _sign(forgeOwner ? attacker : owner, d);
        address payeeSigner = forgePayee ? (c.t.payee == attacker ? payee : attacker) : signingPayee;
        c.ps = _sign(payeeSigner, d);

        if (c.t.owner != owner) c.expected = SymbolonVault.OwnerMismatch.selector;
        else if (c.t.payee == address(0)) c.expected = SymbolonVault.ZeroAddress.selector;
        else if (c.t.cap == 0 || c.t.start > c.t.end) c.expected = SymbolonVault.InvalidTerms.selector;
        else if (c.t.engagementId == existingId) c.expected = SymbolonVault.EngagementExists.selector;
        else if (forgeOwner) c.expected = SymbolonVault.BadOwnerSig.selector;
        else if (payeeSigner != c.t.payee) c.expected = SymbolonVault.BadPayeeSig.selector;
    }

    function testFuzz_register_validationOrderMatchesOracle(address caller, uint256 seed) public {
        SymbolonVault.EngagementTerms memory existing = _registerDefault();
        RegCase memory c = _regCase(seed, existing.engagementId);
        uint256 before = vault.engagementCount();
        vm.prank(caller); // anyone may submit
        if (c.expected != bytes4(0)) vm.expectRevert(c.expected);
        vault.registerEngagement(c.t, c.os, c.ps);
        assertEq(vault.engagementCount(), c.expected == bytes4(0) ? before + 1 : before);
        if (c.expected == bytes4(0)) _assertRegistered(c.t);
    }

    function _assertRegistered(SymbolonVault.EngagementTerms memory t) internal view {
        (address p, uint256 cap, uint256 released, uint64 s, uint64 e, bytes32 th, bool active) =
            vault.engagements(t.engagementId);
        assertEq(p, t.payee);
        assertEq(cap, t.cap);
        assertEq(released, 0);
        assertEq(s, t.start);
        assertEq(e, t.end);
        assertEq(th, t.termsHash);
        assertTrue(active);
        assertEq(vault.engagementNonce(t.engagementId), t.nonce);
        assertEq(vault.engagementIdAt(vault.engagementCount() - 1), t.engagementId);
    }

    // ---- proposePayeeChange: validation order -------------------------------------------------------------------

    struct PcCase {
        SymbolonVault.PayeeChange pc;
        bytes os;
        bytes olds;
        bytes news;
        bytes4 expected;
    }

    function _pcCase(uint256 seed) internal returns (PcCase memory c) {
        bool paused_ = _pick(seed, "paused", 8) == 0;
        bool closed = _pick(seed, "closed", 8) == 0;
        if (closed) {
            vm.prank(owner);
            vault.closeEngagement(ENG);
        }
        if (paused_) {
            vm.prank(guardian);
            vault.pause();
        }
        uint256 om = _pick(seed, "old", 5);
        address oldP = om == 0 ? payee2 : om == 1 ? attacker : payee; // wrong / stranger / right (60 %)
        uint256 nm = _pick(seed, "new", 6);
        address newP = nm == 0 ? address(0) : nm == 1 ? payee : nm == 2 ? attacker : payee2;
        uint256 nonce = _pick(seed, "nonce", 4) == 0 ? _pick(seed, "n2", 3) : 2 + _pick(seed, "n3", 1000);
        c.pc = SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: oldP, newPayee: newP, nonce: nonce});
        bytes32 d = _digest(address(vault), _pcHash(c.pc));
        bool fo = _pick(seed, "fo", 6) == 0;
        bool fold = _pick(seed, "fold", 6) == 0;
        bool fnew = _pick(seed, "fnew", 6) == 0;
        c.os = _sign(fo ? attacker : owner, d);
        c.olds = _sign(fold ? payee2 : oldP, d);
        c.news = keyOf[newP] == 0 ? bytes("") : _sign(fnew ? payee : newP, d);
        // a forged signature by the very account it stands in for is not forged: keep the oracle honest
        if (fold && oldP == payee2) fold = false;
        if (fnew && newP == payee) fnew = false;

        if (paused_) c.expected = SymbolonVault.Paused.selector;
        else if (closed) c.expected = SymbolonVault.NoEngagement.selector;
        else if (oldP != payee) c.expected = SymbolonVault.PayeeMismatch.selector;
        else if (newP == address(0)) c.expected = SymbolonVault.ZeroAddress.selector;
        else if (newP == oldP) c.expected = SymbolonVault.InvalidTerms.selector;
        else if (nonce <= 1) c.expected = SymbolonVault.NonceUsed.selector;
        else if (fo) c.expected = SymbolonVault.BadOwnerSig.selector;
        else if (fold) c.expected = SymbolonVault.BadPayeeSig.selector;
        else if (fnew) c.expected = SymbolonVault.BadNewPayeeSig.selector;
    }

    function testFuzz_proposePayeeChange_validationOrderMatchesOracle(address caller, uint256 seed) public {
        _registerDefault(); // payee, nonce 1
        PcCase memory c = _pcCase(seed);
        vm.prank(caller); // anyone may submit
        if (c.expected != bytes4(0)) vm.expectRevert(c.expected);
        vault.proposePayeeChange(c.pc, c.os, c.olds, c.news);
        (address pending, uint64 eta) = vault.pendingPayee(ENG);
        if (c.expected == bytes4(0)) {
            assertEq(pending, c.pc.newPayee);
            assertEq(uint256(eta), block.timestamp + PAYEE_DELAY);
            assertEq(vault.engagementNonce(ENG), c.pc.nonce);
            assertTrue(vault.payeeChangeLive(ENG));
            assertEq(vault.pendingPayeeEpoch(ENG), vault.pauseEpoch());
        } else {
            assertEq(pending, address(0));
            assertEq(vault.engagementNonce(ENG), 1, "a rejected proposal does not consume the nonce");
            assertFalse(vault.payeeChangeLive(ENG));
        }
    }

    // ---- executePayeeChange / executeKernelSigner: anyone, any id --------------------------------------------------

    function testFuzz_executePayeeChange_anyCallerAnyId(address caller, bytes32 anyId, bool propose, uint256 wait)
        public
    {
        _registerDefault();
        if (propose) {
            SymbolonVault.PayeeChange memory pc =
                SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: 2});
            bytes32 d = _digest(address(vault), _pcHash(pc));
            vault.proposePayeeChange(pc, _sign(owner, d), _sign(payee, d), _sign(payee2, d));
        }
        wait = bound(wait, 0, 2 * uint256(PAYEE_DELAY));
        vm.warp(block.timestamp + wait);
        bytes32 id = uint256(anyId) % 3 == 0 && anyId != ENG ? anyId : ENG;
        vm.prank(caller);
        if (id != ENG || !propose) vm.expectRevert(SymbolonVault.NoPendingChange.selector);
        else if (wait < PAYEE_DELAY) vm.expectRevert(SymbolonVault.TooEarly.selector);
        vault.executePayeeChange(id);
        bool executed = id == ENG && propose && wait >= PAYEE_DELAY;
        assertEq(_payeeOf(ENG), executed ? payee2 : payee);
        if (executed) {
            (address pending, uint64 eta) = vault.pendingPayee(ENG);
            assertEq(pending, address(0), "pending record cleared");
            assertEq(uint256(eta), 0);
            assertEq(vault.pendingPayeeEpoch(ENG), 0, "pending epoch cleared");
            assertFalse(vault.payeeChangeLive(ENG));
            vm.expectRevert(SymbolonVault.NoPendingChange.selector);
            vault.executePayeeChange(ENG); // single use
        }
    }

    function testFuzz_executeKernelSigner_onlyOwner_afterDelay_singleUse(
        address caller,
        address next,
        bool propose,
        uint256 wait
    ) public {
        vm.assume(next != address(0));
        if (propose) {
            vm.prank(owner);
            vault.proposeKernelSigner(next);
        }
        wait = bound(wait, 0, 2 * uint256(SIGNER_DELAY));
        vm.warp(block.timestamp + wait);
        vm.prank(caller);
        if (caller != owner) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        else if (!propose) vm.expectRevert(SymbolonVault.NoPendingChange.selector);
        else if (wait < SIGNER_DELAY) vm.expectRevert(SymbolonVault.TooEarly.selector);
        vault.executeKernelSigner();
        bool rotated = caller == owner && propose && wait >= SIGNER_DELAY;
        assertEq(vault.kernelSigner(), rotated ? next : kernel);
        if (rotated) {
            assertEq(vault.pendingSigner(), address(0));
            assertEq(uint256(vault.pendingSignerEta()), 0);
            vm.prank(owner);
            vm.expectRevert(SymbolonVault.NoPendingChange.selector);
            vault.executeKernelSigner();
        }
    }

    // ---- closeEngagement / withdraw side effects ---------------------------------------------------------------------

    function testFuzz_closeEngagement_isIrreversible_andBlocksEverything(bytes32 id) public {
        SymbolonVault.EngagementTerms memory t = _terms(id, payee, 100 * USDC);
        _register(t);
        vm.prank(owner);
        vault.closeEngagement(id);
        assertFalse(_active(id));

        SymbolonVault.Attestation memory a = _att(id, payee, 1 * USDC);
        bytes memory ksig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.release(a, ksig, _noRef(), "");
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.closeEngagement(id); // not closable twice
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        vm.expectRevert(SymbolonVault.EngagementExists.selector);
        vault.registerEngagement(t, os, ps); // the id is never free again
        assertEq(vault.engagementCount(), 1);
    }

    function testFuzz_withdraw_neverTouchesEngagementAccounting(uint256 amount, uint256 releaseAmt) public {
        _registerDefault();
        releaseAmt = bound(releaseAmt, 1, humanThreshold);
        SymbolonVault.Attestation memory a = _att(ENG, payee, releaseAmt);
        _release(a);
        uint256 bal = token.balanceOf(address(vault));
        amount = bound(amount, 0, bal);
        (, uint256 capBefore, uint256 releasedBefore,,,,) = vault.engagements(ENG);
        bytes32 cfgBefore = vault.configHash();
        vm.prank(owner);
        vault.withdraw(owner, amount);
        (, uint256 capAfter, uint256 releasedAfter,,,,) = vault.engagements(ENG);
        assertEq(capAfter, capBefore);
        assertEq(releasedAfter, releasedBefore, "withdrawals are not releases");
        assertEq(vault.configHash(), cfgBefore);
        (uint256 daySum,,) = vault.rollingUsage();
        assertEq(daySum, releaseAmt, "withdrawals do not enter the rolling window");
    }
}
