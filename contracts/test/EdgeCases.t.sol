// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice WP-08: small boundary cases that no earlier suite pinned.
contract EdgeCasesTest is VaultTestBase {
    /// A local chain can run with a clock below one day (anvil --timestamp, fresh dev chains). An empty ring slot has
    /// t = 0 and amt = 0; it must never be counted as a release inside the window.
    function test_rolling_emptySlotsAreNeverCounted_whenTheClockIsBelowOneDay() public {
        vm.warp(1000);
        SymbolonVault v = _deployVault(owner, kernel);
        token.mint(address(v), 1_000 * USDC);
        (uint256 d, uint256 h, uint256 c) = v.rollingUsage();
        assertEq(d, 0);
        assertEq(h, 0);
        assertEq(c, 0, "empty slots must not count as releases");

        vault = v;
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        _register(t);
        for (uint256 i = 0; i < 3; ++i) {
            _release(_att(ENG, payee, 10 * USDC));
        }
        (d, h, c) = v.rollingUsage();
        assertEq(d, 30 * USDC);
        assertEq(c, 3);
        assertEq(token.balanceOf(payee), 30 * USDC);
    }

    /// start == end is a valid one-second window: open at that second, shut one second later.
    function test_window_startEqualsEnd_isOneSecond() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 100 * USDC);
        t.start = uint64(block.timestamp + 100);
        t.end = t.start;
        _register(t);
        vm.warp(t.start - 1);
        SymbolonVault.Attestation memory early = _att(ENG, payee, 1 * USDC);
        bytes memory earlySig = _kernelSig(early);
        vm.expectRevert(SymbolonVault.OutOfWindow.selector);
        vault.release(early, earlySig, _noRef(), "");
        vm.warp(t.start);
        _release(_att(ENG, payee, 1 * USDC));
        vm.warp(t.start + 1);
        SymbolonVault.Attestation memory late = _att(ENG, payee, 1 * USDC);
        bytes memory lateSig = _kernelSig(late);
        vm.expectRevert(SymbolonVault.OutOfWindow.selector);
        vault.release(late, lateSig, _noRef(), "");
    }

    /// The engagement list is exactly the ids that registered successfully, in order, and a rejected registration
    /// appends nothing.
    function test_engagementList_ignoresRejectedRegistrations() public {
        SymbolonVault.EngagementTerms memory a = _terms(keccak256("a"), payee, 10 * USDC);
        _register(a);
        SymbolonVault.EngagementTerms memory bad = _terms(keccak256("b"), payee, 0); // cap 0
        bytes32 d = _digest(address(vault), _termsHash(bad));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        vm.expectRevert(SymbolonVault.InvalidTerms.selector);
        vault.registerEngagement(bad, os, ps);
        SymbolonVault.EngagementTerms memory c = _terms(keccak256("c"), payee2, 10 * USDC);
        _register(c);
        assertEq(vault.engagementCount(), 2);
        assertEq(vault.engagementIdAt(0), keccak256("a"));
        assertEq(vault.engagementIdAt(1), keccak256("c"));
        vm.expectRevert(); // out of bounds
        vault.engagementIdAt(2);
    }

    /// A released amount equal to the whole balance leaves nothing; the next release fails atomically and the
    /// intent stays usable (docs/06 A.4: failed attempts burn nothing).
    function test_insufficientBalance_doesNotBurnTheIntent_andSucceedsAfterFunding() public {
        _registerDefault();
        uint256 all = token.balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(owner, all);
        SymbolonVault.Attestation memory a = _att(ENG, payee, 10 * USDC);
        bytes memory ksig = _kernelSig(a);
        vm.expectRevert();
        vault.release(a, ksig, _noRef(), "");
        assertFalse(vault.used(a.intentId));
        (uint256 d,, uint256 c) = vault.rollingUsage();
        assertEq(d, 0);
        assertEq(c, 0);
        token.mint(address(vault), 10 * USDC);
        vault.release(a, ksig, _noRef(), "");
        assertTrue(vault.used(a.intentId));
        assertEq(token.balanceOf(payee), 10 * USDC);
    }

    /// Anyone, including the payee and the kernel signer, can register/propose/execute, but never pause the vault or
    /// call an owner function: roles are not transitive.
    function test_roles_areNotTransitive() public {
        _registerDefault();
        address[4] memory callers = [payee, kernel, payee2, address(0xBEEF)];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.pause();
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.unpause();
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.withdraw(callers[i], 1);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.closeEngagement(ENG);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.setGuardian(callers[i]);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.proposeKernelSigner(callers[i]);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.executeKernelSigner();
            vm.stopPrank();
        }
        // the guardian can pause and nothing else
        vm.startPrank(guardian);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.withdraw(guardian, 1);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.closeEngagement(ENG);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.setGuardian(guardian);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.proposeKernelSigner(guardian);
        vm.stopPrank();
    }
}
