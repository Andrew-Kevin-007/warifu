// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice docs/06 A.5 PayeeChange.t.sol: three-signature requirement, delay, cancel on pause, no change while
/// paused, nonce replay (INV-7).
contract PayeeChangeTest is VaultTestBase {
    event PayeeChangeProposed(bytes32 indexed engagementId, address indexed oldPayee, address indexed newPayee, uint64 eta);
    event PayeeChangeExecuted(bytes32 indexed engagementId, address indexed oldPayee, address indexed newPayee);

    function setUp() public override {
        super.setUp();
        _registerDefault(); // registration nonce 1
    }

    function _pc(uint256 nonce) internal view returns (SymbolonVault.PayeeChange memory) {
        return SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: nonce});
    }

    function _sigs(SymbolonVault.PayeeChange memory pc)
        internal
        view
        returns (bytes memory os, bytes memory olds, bytes memory news)
    {
        bytes32 d = _digest(address(vault), _pcHash(pc));
        os = _sign(owner, d);
        olds = _sign(pc.oldPayee, d);
        news = _sign(pc.newPayee, d);
    }

    function _propose(SymbolonVault.PayeeChange memory pc) internal {
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(pc);
        vault.proposePayeeChange(pc, os, olds, news);
    }

    function test_happyPath_proposeWaitExecute_thenReleasesGoToNewPayee() public {
        SymbolonVault.PayeeChange memory pc = _pc(2);
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(pc);
        uint64 eta = uint64(block.timestamp) + PAYEE_DELAY;
        vm.expectEmit(address(vault));
        emit PayeeChangeProposed(ENG, payee, payee2, eta);
        vm.prank(attacker); // relayer
        vault.proposePayeeChange(pc, os, olds, news);
        (address np, uint64 e) = vault.pendingPayee(ENG);
        assertEq(np, payee2);
        assertEq(e, eta);
        assertTrue(vault.payeeChangeLive(ENG));
        assertEq(vault.engagementNonce(ENG), 2);

        vm.warp(eta);
        vm.expectEmit(address(vault));
        emit PayeeChangeExecuted(ENG, payee, payee2);
        vm.prank(attacker);
        vault.executePayeeChange(ENG);
        assertEq(_payeeOf(ENG), payee2);
        assertFalse(vault.payeeChangeLive(ENG));
        (np,) = vault.pendingPayee(ENG);
        assertEq(np, address(0));

        SymbolonVault.Attestation memory toOld = _att(ENG, payee, 1 * USDC);
        toOld.deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _kernelSig(toOld);
        vm.expectRevert(SymbolonVault.PayeeMismatch.selector);
        vault.release(toOld, sig, _noRef(), "");
        _release(_att(ENG, payee2, 1 * USDC));
        assertEq(token.balanceOf(payee2), 1 * USDC);
    }

    function test_threeSignatures_eachRequired() public {
        SymbolonVault.PayeeChange memory pc = _pc(2);
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(pc);
        bytes32 d = _digest(address(vault), _pcHash(pc));
        bytes memory junk = _sign(attacker, d);

        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.proposePayeeChange(pc, junk, olds, news);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.proposePayeeChange(pc, news, olds, news); // new payee cannot stand in for the owner
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.proposePayeeChange(pc, os, junk, news);
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.proposePayeeChange(pc, os, os, news); // owner cannot stand in for the old payee
        vm.expectRevert(SymbolonVault.BadNewPayeeSig.selector);
        vault.proposePayeeChange(pc, os, olds, junk);
        vm.expectRevert(SymbolonVault.BadNewPayeeSig.selector);
        vault.proposePayeeChange(pc, os, olds, ""); // missing new-payee signature
        vault.proposePayeeChange(pc, os, olds, news);
        assertTrue(vault.payeeChangeLive(ENG));
    }

    function test_kernelKeyCannotChangePayee() public {
        // ATK-17(f): even the kernel key plus a colluding new payee cannot redirect funds
        SymbolonVault.PayeeChange memory pc = _pc(2);
        pc.newPayee = attacker;
        bytes32 d = _digest(address(vault), _pcHash(pc));
        bytes memory k = _sign(kernel, d);
        bytes memory a = _sign(attacker, d);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.proposePayeeChange(pc, k, k, a);
    }

    function test_delay_boundary() public {
        _propose(_pc(2));
        (, uint64 eta) = vault.pendingPayee(ENG);
        vm.warp(eta - 1);
        vm.expectRevert(SymbolonVault.TooEarly.selector);
        vault.executePayeeChange(ENG);
        vm.warp(eta);
        vault.executePayeeChange(ENG);
        assertEq(_payeeOf(ENG), payee2);
    }

    function test_cancelOnPause() public {
        _propose(_pc(2));
        vm.prank(guardian);
        vault.pause();
        assertFalse(vault.payeeChangeLive(ENG));
        vm.prank(owner);
        vault.unpause();
        vm.warp(block.timestamp + PAYEE_DELAY + 1);
        vm.expectRevert(SymbolonVault.PayeeChangeCancelled.selector);
        vault.executePayeeChange(ENG);
        assertEq(_payeeOf(ENG), payee);

        // the parties can re-propose with fresh signatures and a higher nonce
        _propose(_pc(3));
        assertTrue(vault.payeeChangeLive(ENG));
        vm.warp(block.timestamp + PAYEE_DELAY);
        vault.executePayeeChange(ENG);
        assertEq(_payeeOf(ENG), payee2);
    }

    function test_cancelOnPause_evenWithinTheSameTimestamp() public {
        // Arc block timestamps can repeat; cancellation is by pause epoch, not by time.
        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        _propose(_pc(2)); // same timestamp as the pause, but proposed after it: stays live
        assertTrue(vault.payeeChangeLive(ENG));
        vm.prank(owner);
        vault.pause(); // same timestamp again: cancels it
        vm.prank(owner);
        vault.unpause();
        vm.warp(block.timestamp + PAYEE_DELAY);
        vm.expectRevert(SymbolonVault.PayeeChangeCancelled.selector);
        vault.executePayeeChange(ENG);
    }

    function test_noChangeWhilePaused() public {
        SymbolonVault.PayeeChange memory pc = _pc(2);
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(pc);
        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(SymbolonVault.Paused.selector);
        vault.proposePayeeChange(pc, os, olds, news);
        vm.prank(owner);
        vault.unpause();
        vault.proposePayeeChange(pc, os, olds, news);
        vm.warp(block.timestamp + PAYEE_DELAY);
        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(SymbolonVault.Paused.selector);
        vault.executePayeeChange(ENG);
    }

    function test_nonceReplay_reverts() public {
        SymbolonVault.PayeeChange memory stale = _pc(1); // not above the registration nonce
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(stale);
        vm.expectRevert(SymbolonVault.NonceUsed.selector);
        vault.proposePayeeChange(stale, os, olds, news);

        SymbolonVault.PayeeChange memory pc = _pc(5);
        (os, olds, news) = _sigs(pc);
        vault.proposePayeeChange(pc, os, olds, news);
        vm.expectRevert(SymbolonVault.NonceUsed.selector);
        vault.proposePayeeChange(pc, os, olds, news); // exact replay of a pending proposal

        SymbolonVault.PayeeChange memory lower = _pc(4);
        (os, olds, news) = _sigs(lower);
        vm.expectRevert(SymbolonVault.NonceUsed.selector);
        vault.proposePayeeChange(lower, os, olds, news);
    }

    function test_executedChange_cannotBeReplayedBackwards() public {
        SymbolonVault.PayeeChange memory pc = _pc(2);
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(pc);
        vault.proposePayeeChange(pc, os, olds, news);
        vm.warp(block.timestamp + PAYEE_DELAY);
        vault.executePayeeChange(ENG);
        vm.expectRevert(SymbolonVault.PayeeMismatch.selector); // old payee no longer matches
        vault.proposePayeeChange(pc, os, olds, news);
        vm.expectRevert(SymbolonVault.NoPendingChange.selector);
        vault.executePayeeChange(ENG);
    }

    function test_newerProposalReplacesOlder() public {
        _propose(_pc(2));
        SymbolonVault.PayeeChange memory pc3 = _pc(3);
        address payee3 = _actor("payee3");
        pc3.newPayee = payee3;
        vm.warp(block.timestamp + 1 hours);
        _propose(pc3);
        (address np, uint64 eta) = vault.pendingPayee(ENG);
        assertEq(np, payee3);
        assertEq(eta, uint64(block.timestamp) + PAYEE_DELAY);
        vm.warp(eta);
        vault.executePayeeChange(ENG);
        assertEq(_payeeOf(ENG), payee3);
    }

    function test_validation() public {
        SymbolonVault.PayeeChange memory pc = _pc(2);

        pc.engagementId = keccak256("unregistered");
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.proposePayeeChange(pc, "", "", "");
        pc.engagementId = ENG;

        pc.oldPayee = attacker;
        vm.expectRevert(SymbolonVault.PayeeMismatch.selector);
        vault.proposePayeeChange(pc, "", "", "");
        pc.oldPayee = payee;

        pc.newPayee = address(0);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        vault.proposePayeeChange(pc, "", "", "");

        pc.newPayee = payee;
        vm.expectRevert(SymbolonVault.InvalidTerms.selector);
        vault.proposePayeeChange(pc, "", "", "");

        vm.expectRevert(SymbolonVault.NoPendingChange.selector);
        vault.executePayeeChange(ENG);
    }

    function test_closedEngagement_blocksProposeAndExecute() public {
        _propose(_pc(2));
        vm.prank(owner);
        vault.closeEngagement(ENG);
        vm.warp(block.timestamp + PAYEE_DELAY);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.executePayeeChange(ENG);
        SymbolonVault.PayeeChange memory pc = _pc(3);
        (bytes memory os, bytes memory olds, bytes memory news) = _sigs(pc);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.proposePayeeChange(pc, os, olds, news);
    }
}
