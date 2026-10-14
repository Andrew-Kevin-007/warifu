// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice WP-08: every state-changing function emits exactly the documented events (docs/05 §6) with exactly the
/// documented arguments, in order, and nothing else. The indexer and the reconciler consume these; a wrong argument
/// (for example a cumulative instead of a per-release amount) would corrupt the audit trail without moving funds,
/// so no other test would notice.
contract EventsTest is VaultTestBase {
    bytes32 internal constant SIG_RELEASED = keccak256("Released(bytes32,bytes32,address,uint256,bytes32)");
    bytes32 internal constant SIG_REGISTERED =
        keccak256("EngagementRegistered(bytes32,address,address,uint256,uint64,uint64,bytes32)");
    bytes32 internal constant SIG_CLOSED = keccak256("EngagementClosed(bytes32)");
    bytes32 internal constant SIG_PC_PROPOSED = keccak256("PayeeChangeProposed(bytes32,address,address,uint64)");
    bytes32 internal constant SIG_PC_EXECUTED = keccak256("PayeeChangeExecuted(bytes32,address,address)");
    bytes32 internal constant SIG_PAUSED = keccak256("VaultPaused(address)");
    bytes32 internal constant SIG_UNPAUSED = keccak256("VaultUnpaused(address)");
    bytes32 internal constant SIG_SIGNER_PROPOSED = keccak256("KernelSignerProposed(address,uint64)");
    bytes32 internal constant SIG_SIGNER_ROTATED = keccak256("KernelSignerRotated(address,address)");
    bytes32 internal constant SIG_GUARDIAN = keccak256("GuardianChanged(address,address)");
    bytes32 internal constant SIG_WITHDRAWN = keccak256("Withdrawn(address,uint256)");
    bytes32 internal constant SIG_CONFIG = keccak256("ConfigChanged(bytes32)");

    function _vaultLogs() internal returns (Vm.Log[] memory out) {
        Vm.Log[] memory all = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < all.length; ++i) {
            if (all[i].emitter == address(vault)) ++n;
        }
        out = new Vm.Log[](n);
        uint256 k;
        for (uint256 i = 0; i < all.length; ++i) {
            if (all[i].emitter == address(vault)) out[k++] = all[i];
        }
    }

    function _addr(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    function test_release_emitsReleasedWithThePerReleaseAmount_notCumulative() public {
        _registerDefault();
        SymbolonVault.Attestation memory first = _att(ENG, payee, 10 * USDC);
        _release(first);
        SymbolonVault.Attestation memory second = _att(ENG, payee, 7 * USDC);
        bytes memory ksig = _kernelSig(second);
        vm.recordLogs();
        vault.release(second, ksig, _noRef(), "");
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1, "release emits exactly one vault event");
        assertEq(logs[0].topics[0], SIG_RELEASED);
        assertEq(logs[0].topics[1], second.intentId);
        assertEq(logs[0].topics[2], second.engagementId);
        assertEq(_addr(logs[0].topics[3]), payee);
        (uint256 amount, bytes32 receiptHash) = abi.decode(logs[0].data, (uint256, bytes32));
        assertEq(amount, 7 * USDC, "per-release amount, not the cumulative 17");
        assertEq(receiptHash, second.receiptHash);
    }

    function test_release_afterPayeeChange_emitsTheNewPayee() public {
        _registerDefault();
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: 2});
        bytes32 d = _digest(address(vault), _pcHash(pc));
        vault.proposePayeeChange(pc, _sign(owner, d), _sign(payee, d), _sign(payee2, d));
        vm.warp(block.timestamp + PAYEE_DELAY);
        vault.executePayeeChange(ENG);
        SymbolonVault.Attestation memory a = _att(ENG, payee2, 5 * USDC);
        bytes memory ksig = _kernelSig(a);
        vm.recordLogs();
        vault.release(a, ksig, _noRef(), "");
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(_addr(logs[0].topics[3]), payee2);
    }

    function test_register_emitsEngagementRegistered() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 123 * USDC);
        t.start = uint64(block.timestamp + 5);
        t.end = uint64(block.timestamp + 77);
        vm.recordLogs();
        _register(t);
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_REGISTERED);
        assertEq(logs[0].topics[1], ENG);
        assertEq(_addr(logs[0].topics[2]), owner);
        assertEq(_addr(logs[0].topics[3]), payee);
        (uint256 cap, uint64 start, uint64 end, bytes32 termsHash) =
            abi.decode(logs[0].data, (uint256, uint64, uint64, bytes32));
        assertEq(cap, 123 * USDC);
        assertEq(uint256(start), block.timestamp + 5);
        assertEq(uint256(end), block.timestamp + 77);
        assertEq(termsHash, t.termsHash);
    }

    function test_close_emitsEngagementClosed() public {
        _registerDefault();
        vm.recordLogs();
        vm.prank(owner);
        vault.closeEngagement(ENG);
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_CLOSED);
        assertEq(logs[0].topics[1], ENG);
        assertEq(logs[0].data.length, 0);
    }

    function test_payeeChange_emitsProposedThenExecuted() public {
        _registerDefault();
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: 2});
        bytes32 d = _digest(address(vault), _pcHash(pc));
        bytes memory os = _sign(owner, d);
        bytes memory olds = _sign(payee, d);
        bytes memory news = _sign(payee2, d);
        vm.recordLogs();
        vault.proposePayeeChange(pc, os, olds, news);
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_PC_PROPOSED);
        assertEq(logs[0].topics[1], ENG);
        assertEq(_addr(logs[0].topics[2]), payee);
        assertEq(_addr(logs[0].topics[3]), payee2);
        assertEq(abi.decode(logs[0].data, (uint64)), uint64(block.timestamp + PAYEE_DELAY));

        vm.warp(block.timestamp + PAYEE_DELAY);
        vm.recordLogs();
        vault.executePayeeChange(ENG);
        logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_PC_EXECUTED);
        assertEq(logs[0].topics[1], ENG);
        assertEq(_addr(logs[0].topics[2]), payee, "previous payee");
        assertEq(_addr(logs[0].topics[3]), payee2, "new payee");
    }

    function test_pauseUnpause_emitCaller() public {
        vm.recordLogs();
        vm.prank(guardian);
        vault.pause();
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_PAUSED);
        assertEq(_addr(logs[0].topics[1]), guardian);

        vm.recordLogs();
        vm.prank(owner);
        vault.pause();
        logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(_addr(logs[0].topics[1]), owner);

        vm.recordLogs();
        vm.prank(owner);
        vault.unpause();
        logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_UNPAUSED);
        assertEq(_addr(logs[0].topics[1]), owner);
    }

    function test_signerRotation_emitsProposedThenRotatedAndConfigChanged() public {
        address next = _actor("next-kernel");
        vm.recordLogs();
        vm.prank(owner);
        vault.proposeKernelSigner(next);
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_SIGNER_PROPOSED);
        assertEq(_addr(logs[0].topics[1]), next);
        assertEq(abi.decode(logs[0].data, (uint64)), uint64(block.timestamp + SIGNER_DELAY));

        vm.warp(block.timestamp + SIGNER_DELAY);
        vm.recordLogs();
        vm.prank(owner);
        vault.executeKernelSigner();
        logs = _vaultLogs();
        assertEq(logs.length, 2, "rotation emits KernelSignerRotated then ConfigChanged");
        assertEq(logs[0].topics[0], SIG_SIGNER_ROTATED);
        assertEq(_addr(logs[0].topics[1]), kernel, "previous");
        assertEq(_addr(logs[0].topics[2]), next, "next");
        assertEq(logs[1].topics[0], SIG_CONFIG);
        assertEq(logs[1].topics[1], vault.configHash());
    }

    function test_setGuardian_emitsChangedThenConfigChanged() public {
        address g = _actor("new-guardian");
        vm.recordLogs();
        vm.prank(owner);
        vault.setGuardian(g);
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], SIG_GUARDIAN);
        assertEq(_addr(logs[0].topics[1]), guardian, "previous");
        assertEq(_addr(logs[0].topics[2]), g, "new");
        assertEq(logs[1].topics[0], SIG_CONFIG);
        assertEq(logs[1].topics[1], vault.configHash());
    }

    function test_withdraw_emitsWithdrawn() public {
        vm.recordLogs();
        vm.prank(owner);
        vault.withdraw(payee2, 33 * USDC);
        Vm.Log[] memory logs = _vaultLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SIG_WITHDRAWN);
        assertEq(_addr(logs[0].topics[1]), payee2);
        assertEq(abi.decode(logs[0].data, (uint256)), 33 * USDC);
        assertEq(token.balanceOf(payee2), 33 * USDC);
    }

    function test_failedCalls_emitNothing() public {
        _registerDefault();
        vm.recordLogs();
        SymbolonVault.Attestation memory a = _att(ENG, payee, perTxCap + 1);
        bytes memory ksig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        vault.release(a, ksig, _noRef(), "");
        vm.prank(attacker);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.pause();
        assertEq(_vaultLogs().length, 0);
    }
}
