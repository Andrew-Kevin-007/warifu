// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockSafe} from "./utils/Mocks.sol";

/// @notice docs/06 A.5 Engagement.t.sol: dual-signature registration, ERC-1271 owner and payee, replay, bad
/// signers, input validation, closing (INV-2).
contract EngagementTest is VaultTestBase {
    event EngagementRegistered(
        bytes32 indexed engagementId,
        address indexed owner,
        address indexed payee,
        uint256 cap,
        uint64 start,
        uint64 end,
        bytes32 termsHash
    );
    event EngagementClosed(bytes32 indexed engagementId);

    function test_register_dualSig_storesTermsAndEmits() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        vm.expectEmit(address(vault));
        emit EngagementRegistered(ENG, owner, payee, 500 * USDC, t.start, t.end, t.termsHash);
        vm.prank(attacker); // a relayer submits; authority comes from the signatures
        vault.registerEngagement(t, os, ps);

        (address p, uint256 cap, uint256 rel, uint64 s, uint64 e, bytes32 th, bool active) = vault.engagements(ENG);
        assertEq(p, payee);
        assertEq(cap, 500 * USDC);
        assertEq(rel, 0);
        assertEq(s, t.start);
        assertEq(e, t.end);
        assertEq(th, t.termsHash);
        assertTrue(active);
        assertEq(vault.engagementNonce(ENG), 1);
        assertEq(vault.engagementCount(), 1);
        assertEq(vault.engagementIdAt(0), ENG);
    }

    function test_register_missingPayeeSig_reverts() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, os, "");
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, os, os); // owner cannot sign for the payee
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, os, _sign(attacker, d));
    }

    function test_register_missingOwnerSig_reverts() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory ps = _sign(payee, d);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, "", ps);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, ps, ps); // payee cannot sign for the owner
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, _sign(kernel, d), ps); // nor can the kernel key (ATK-17f)
    }

    function test_register_tamperedTermsAfterSigning_reverts() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        t.cap = 501 * USDC;
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, os, ps);
        t.cap = 500 * USDC;
        t.termsHash = keccak256("different payment terms");
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, os, ps);
    }

    function test_register_signaturesForOtherVaultRejected() public {
        SymbolonVault other = _deployVault(owner, kernel);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        bytes32 dOther = _digest(address(other), _termsHash(t));
        bytes memory os = _sign(owner, dOther);
        bytes memory ps = _sign(payee, dOther);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, os, ps);
        other.registerEngagement(t, os, ps);
        assertEq(other.engagementCount(), 1);
        assertEq(vault.engagementCount(), 0);
    }

    function test_register_replayAndReRegistration_revert() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        vault.registerEngagement(t, os, ps);
        vm.expectRevert(SymbolonVault.EngagementExists.selector);
        vault.registerEngagement(t, os, ps); // exact replay

        // pay something, close, then try to re-register the same id with fresh signatures and a higher nonce
        _release(_att(ENG, payee, 10 * USDC));
        vm.prank(owner);
        vault.closeEngagement(ENG);
        SymbolonVault.EngagementTerms memory again = _terms(ENG, payee, 500 * USDC);
        again.nonce = 7;
        bytes32 d2 = _digest(address(vault), _termsHash(again));
        bytes memory os2 = _sign(owner, d2);
        bytes memory ps2 = _sign(payee, d2);
        vm.expectRevert(SymbolonVault.EngagementExists.selector);
        vault.registerEngagement(again, os2, ps2);
        assertEq(_released(ENG), 10 * USDC, "released can never be reset");
        assertEq(vault.engagementCount(), 1);
    }

    function test_register_validation() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);

        t.owner = attacker;
        vm.expectRevert(SymbolonVault.OwnerMismatch.selector);
        vault.registerEngagement(t, "", "");
        t.owner = owner;

        t.payee = address(0);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        vault.registerEngagement(t, "", "");
        t.payee = payee;

        t.cap = 0;
        vm.expectRevert(SymbolonVault.InvalidTerms.selector);
        vault.registerEngagement(t, "", "");
        t.cap = 1;

        t.start = t.end + 1;
        vm.expectRevert(SymbolonVault.InvalidTerms.selector);
        vault.registerEngagement(t, "", "");

        t.start = t.end; // a one-second window is valid
        _register(t);
        assertTrue(_active(ENG));
    }

    function test_register_erc1271Owner_mockSafe() public {
        address safeSigner = _actor("safe-signer");
        MockSafe safe = new MockSafe(safeSigner);
        SymbolonVault sv = _deployVault(address(safe), kernel);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 500 * USDC);
        t.owner = address(safe);
        bytes32 d = _digest(address(sv), _termsHash(t));
        bytes memory ps = _sign(payee, d);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        sv.registerEngagement(t, _sign(attacker, d), ps);
        sv.registerEngagement(t, _sign(safeSigner, d), ps);
        assertEq(sv.engagementCount(), 1);
    }

    function test_register_erc1271Payee() public {
        address safeSigner = _actor("payee-safe-signer");
        MockSafe payeeSafe = new MockSafe(safeSigner);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, address(payeeSafe), 500 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, os, _sign(attacker, d));
        payeeSafe.approveHash(d); // Safe-style on-chain approval, empty signature bytes
        vault.registerEngagement(t, os, "");
        _release(_att(ENG, address(payeeSafe), 5 * USDC));
        assertEq(token.balanceOf(address(payeeSafe)), 5 * USDC);
    }

    function test_register_allowedWhilePaused() public {
        vm.prank(guardian);
        vault.pause();
        _registerDefault(); // no funds move; only releases and payee changes stop
        assertTrue(_active(ENG));
    }

    function test_close_onlyOwner_andOnlyActive() public {
        _registerDefault();
        vm.prank(attacker);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.closeEngagement(ENG);
        vm.prank(guardian);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.closeEngagement(ENG);
        vm.expectEmit(address(vault));
        emit EngagementClosed(ENG);
        vm.prank(owner);
        vault.closeEngagement(ENG);
        assertFalse(_active(ENG));
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.closeEngagement(ENG);
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.closeEngagement(keccak256("never registered"));
    }
}
