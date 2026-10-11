// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice docs/06 A.5 Fuzz.t.sol: one fuzz test per state-changing function (AGENTS.md §4), each against an
/// explicit model of what must happen. Random multi-call sequences live in Invariants.t.sol.
contract FuzzTest is VaultTestBase {
    // ---- release ---------------------------------------------------------------------------------------------

    /// Model of steps 7-11 for an otherwise valid, kernel-signed attestation.
    function testFuzz_release_matchesModel(uint256 amount, uint256 cap, int256 offset, bool approve, uint256 human) public {
        humanThreshold = bound(human, 0, 120 * USDC);
        vault = _deployVault(owner, kernel);
        token.mint(address(vault), 10_000 * USDC);
        cap = bound(cap, 1, 300 * USDC);
        amount = bound(amount, 0, 400 * USDC);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, cap);
        t.start = uint64(block.timestamp + 1 days);
        t.end = uint64(block.timestamp + 2 days);
        _register(t);
        int256 off = bound(offset, -2, int256(1 days) + 2); // straddles both window edges
        vm.warp(uint256(int256(uint256(t.start)) + off));

        SymbolonVault.Attestation memory a = _att(ENG, payee, amount);
        bytes memory ksig = _kernelSig(a);
        SymbolonVault.OwnerApprovalRef memory ref = _noRef();
        bytes memory osig;
        if (approve) (ref, osig) = _approval(a, keccak256("esc"), uint64(block.timestamp));

        bytes4 expected;
        if (block.timestamp < t.start || block.timestamp > t.end) expected = SymbolonVault.OutOfWindow.selector;
        else if (amount == 0 || amount > perTxCap) expected = SymbolonVault.PerTxCap.selector;
        else if (amount > cap) expected = SymbolonVault.EngagementCap.selector;
        else if (amount > dailyCap) expected = SymbolonVault.DailyCap.selector;
        // without an approval the zero ref has deadline 0, and step 11 checks the deadline before the signature
        else if (amount > humanThreshold && !approve) expected = SymbolonVault.ApprovalExpired.selector;

        if (expected != bytes4(0)) {
            vm.expectRevert(expected);
            vault.release(a, ksig, ref, osig);
            assertFalse(vault.used(a.intentId));
        } else {
            vault.release(a, ksig, ref, osig);
            assertEq(token.balanceOf(payee), amount);
            assertEq(_released(ENG), amount);
        }
    }

    /// Changing any one field of a signed attestation to any other value invalidates the kernel signature.
    function testFuzz_release_anyTamperedFieldRejected(uint8 field, bytes32 noise) public {
        _registerDefault();
        SymbolonVault.Attestation memory a = _att(ENG, payee, 10 * USDC);
        bytes memory sig = _kernelSig(a);
        SymbolonVault.Attestation memory m = _copy(a);
        uint256 f = field % 7;
        if (f == 0) m.intentId = noise;
        if (f == 1) m.engagementId = noise;
        if (f == 2) m.milestoneId = noise;
        if (f == 3) m.payee = address(uint160(uint256(noise)));
        if (f == 4) m.amount = uint256(noise);
        if (f == 5) m.receiptHash = noise;
        if (f == 6) m.deadline = uint64(uint256(noise));
        vm.assume(keccak256(abi.encode(m)) != keccak256(abi.encode(a)));
        vm.expectRevert(); // BadKernelSig, or an earlier step (Expired/AlreadyUsed) if the tamper hits those
        vault.release(m, sig, _noRef(), "");
        assertEq(token.balanceOf(payee), 0);
    }

    /// No key other than the kernel signer's produces an accepted attestation.
    function testFuzz_release_foreignKeyRejected(uint256 pk) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        vm.assume(pk != keyOf[kernel]);
        _registerDefault();
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(address(vault), _attHash(a)));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, abi.encodePacked(r, s, v), _noRef(), "");
    }

    /// Approvals: any amount, intent or ref other than the signed one is refused.
    function testFuzz_release_approvalBindsIntentAndAmount(uint256 approved, uint256 requested, bool sameIntent) public {
        _registerDefault();
        approved = bound(approved, humanThreshold + 1, perTxCap);
        requested = bound(requested, humanThreshold + 1, perTxCap);
        SymbolonVault.Attestation memory signedFor = _att(ENG, payee, approved);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig) =
            _approval(signedFor, keccak256("esc"), uint64(block.timestamp + 1 days));
        SymbolonVault.Attestation memory a = _att(ENG, payee, requested);
        if (sameIntent) a.intentId = signedFor.intentId;
        bytes memory ksig = _kernelSig(a);
        if (sameIntent && requested == approved) {
            vault.release(a, ksig, ref, osig);
            assertEq(token.balanceOf(payee), approved);
        } else {
            vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
            vault.release(a, ksig, ref, osig);
        }
    }

    // ---- registerEngagement / closeEngagement ----------------------------------------------------------------

    function testFuzz_registerEngagement_validation(uint256 cap, uint64 start, uint64 end, uint256 nonce) public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, cap);
        t.start = start;
        t.end = end;
        t.nonce = nonce;
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        if (cap == 0 || start > end) {
            vm.expectRevert(SymbolonVault.InvalidTerms.selector);
            vault.registerEngagement(t, os, ps);
        } else {
            vault.registerEngagement(t, os, ps);
            assertEq(vault.engagementNonce(ENG), nonce);
            assertEq(vault.engagementCount(), 1);
            vm.expectRevert(SymbolonVault.EngagementExists.selector);
            vault.registerEngagement(t, os, ps);
        }
    }

    function testFuzz_registerEngagement_foreignKeysRejected(uint256 pkOwner, uint256 pkPayee) public {
        pkOwner = bound(pkOwner, 1, SECP256K1_N - 1);
        pkPayee = bound(pkPayee, 1, SECP256K1_N - 1);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 100 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pkOwner, d);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(pkPayee, d);
        bool ownerOk = pkOwner == keyOf[owner];
        bool payeeOk = pkPayee == keyOf[payee];
        if (!ownerOk) vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        else if (!payeeOk) vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2));
        assertEq(vault.engagementCount(), ownerOk && payeeOk ? 1 : 0);
    }

    function testFuzz_closeEngagement_onlyOwner(address caller) public {
        _registerDefault();
        vm.prank(caller);
        if (caller != owner) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.closeEngagement(ENG);
        assertEq(_active(ENG), caller != owner);
    }

    // ---- payee change ----------------------------------------------------------------------------------------

    function testFuzz_payeeChange_nonceAndDelay(uint256 nonce, uint256 wait) public {
        _registerDefault(); // nonce 1
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: nonce});
        bytes32 d = _digest(address(vault), _pcHash(pc));
        bytes memory os = _sign(owner, d);
        bytes memory olds = _sign(payee, d);
        bytes memory news = _sign(payee2, d);
        if (nonce <= 1) {
            vm.expectRevert(SymbolonVault.NonceUsed.selector);
            vault.proposePayeeChange(pc, os, olds, news);
            return;
        }
        vault.proposePayeeChange(pc, os, olds, news);
        wait = bound(wait, 0, 2 * uint256(PAYEE_DELAY));
        vm.warp(block.timestamp + wait);
        if (wait < PAYEE_DELAY) {
            vm.expectRevert(SymbolonVault.TooEarly.selector);
            vault.executePayeeChange(ENG);
            assertEq(_payeeOf(ENG), payee);
        } else {
            vault.executePayeeChange(ENG);
            assertEq(_payeeOf(ENG), payee2);
        }
    }

    function testFuzz_payeeChange_pauseAnywhereCancels(uint256 pauseAt) public {
        _registerDefault();
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: 2});
        bytes32 d = _digest(address(vault), _pcHash(pc));
        vault.proposePayeeChange(pc, _sign(owner, d), _sign(payee, d), _sign(payee2, d));
        vm.warp(block.timestamp + bound(pauseAt, 0, PAYEE_DELAY));
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        vm.warp(block.timestamp + PAYEE_DELAY);
        vm.expectRevert(SymbolonVault.PayeeChangeCancelled.selector);
        vault.executePayeeChange(ENG);
    }

    // ---- pause / unpause / signer / guardian / withdraw ------------------------------------------------------

    function testFuzz_pause_onlyOwnerOrGuardian(address caller) public {
        vm.prank(caller);
        bool allowed = caller == owner || caller == guardian;
        if (!allowed) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.pause();
        assertEq(vault.paused(), allowed);
    }

    function testFuzz_unpause_onlyOwner(address caller) public {
        vm.prank(owner);
        vault.pause();
        vm.prank(caller);
        if (caller != owner) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.unpause();
        assertEq(vault.paused(), caller != owner);
    }

    function testFuzz_signerRotation_delay(address next, uint256 wait) public {
        vm.assume(next != address(0));
        vm.prank(owner);
        vault.proposeKernelSigner(next);
        wait = bound(wait, 0, 3 * uint256(SIGNER_DELAY));
        vm.warp(block.timestamp + wait);
        vm.prank(owner);
        if (wait < SIGNER_DELAY) vm.expectRevert(SymbolonVault.TooEarly.selector);
        vault.executeKernelSigner();
        assertEq(vault.kernelSigner(), wait < SIGNER_DELAY ? kernel : next);
    }

    function testFuzz_proposeKernelSigner_onlyOwner(address caller, address next) public {
        vm.assume(next != address(0));
        vm.prank(caller);
        if (caller != owner) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.proposeKernelSigner(next);
    }

    function testFuzz_setGuardian(address caller, address g) public {
        bytes32 before = vault.configHash();
        vm.prank(caller);
        if (caller != owner) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        else if (g == address(0)) vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        vault.setGuardian(g);
        bool changed = caller == owner && g != address(0);
        assertEq(vault.guardian(), changed ? g : guardian);
        if (changed && g != guardian) assertTrue(vault.configHash() != before);
        if (!changed) assertEq(vault.configHash(), before);
    }

    function testFuzz_withdraw(address caller, address to, uint256 amount, bool paused_) public {
        vm.assume(to != address(vault));
        if (paused_) {
            vm.prank(guardian);
            vault.pause();
        }
        uint256 bal = token.balanceOf(address(vault));
        amount = bound(amount, 0, bal + 10);
        uint256 toBefore = token.balanceOf(to);
        vm.prank(caller);
        if (caller != owner) vm.expectRevert(SymbolonVault.Unauthorized.selector);
        else if (to == address(0)) vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        else if (amount > bal) vm.expectRevert(); // token: insufficient balance
        vault.withdraw(to, amount);
        bool ok = caller == owner && to != address(0) && amount <= bal;
        assertEq(token.balanceOf(address(vault)), ok ? bal - amount : bal);
        assertEq(token.balanceOf(to), ok ? toBefore + amount : toBefore);
    }

    /// The constructor's guard keeps uint192 ring amounts exact for every accepted perTxCap.
    function testFuzz_constructor_perTxCapBound(uint256 perTx) public {
        if (perTx == 0 || perTx > type(uint192).max) {
            vm.expectRevert(SymbolonVault.InvalidConfig.selector);
            new SymbolonVault(IERC20(address(token)), owner, kernel, guardian, perTx, 1, 0, 0, 0, 0);
        } else {
            SymbolonVault v = new SymbolonVault(IERC20(address(token)), owner, kernel, guardian, perTx, 1, 0, 0, 0, 0);
            assertEq(v.perTxCap(), perTx);
        }
    }
}
