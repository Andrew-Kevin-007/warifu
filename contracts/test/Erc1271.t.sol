// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {
    MockSafe,
    RevertingWallet,
    WrongMagicWallet,
    ShortReturnWallet,
    DirtyMagicWallet,
    LongReturnWallet,
    GasBurnerWallet,
    StateChangingWallet,
    AcceptAllWallet,
    ToggleWallet,
    ReenteringWallet,
    BatchExecutorDelegate,
    SelfValidatingDelegate
} from "./utils/Mocks.sol";

/// @notice WP-08 / docs/13 §4.2 "ERC-1271 owner/payee": contract wallets in every signing role (owner, payee, old and
/// new payee, kernel signer), hostile wallets that must never validate, wallets that try to re-enter during the
/// check, revocable answers, an accept-anything kernel signer (the vault still bounds the loss), and EIP-7702
/// delegated EOAs (Prague/Osaka). Threat notes for each case are in contracts/README.md.
contract Erc1271Test is VaultTestBase {
    // ---- helpers ---------------------------------------------------------------------------------------------

    function _vaultFor(address owner_, address kernel_) internal returns (SymbolonVault v) {
        v = _deployVault(owner_, kernel_);
        token.mint(address(v), 10_000 * USDC);
    }

    function _termsOn(SymbolonVault v, bytes32 id, address payee_) internal view returns (SymbolonVault.EngagementTerms memory t) {
        t = _terms(id, payee_, 1_000 * USDC);
        t.owner = v.owner();
    }

    function _attSig(SymbolonVault v, address signer, SymbolonVault.Attestation memory a) internal view returns (bytes memory) {
        return _sign(signer, _digest(address(v), _attHash(a)));
    }

    /// @dev Register `payee_` on `v` whose owner validates `ownerSigner`'s ECDSA signatures.
    function _registerWith(SymbolonVault v, bytes32 id, address payee_, address ownerSigner, address payeeSigner) internal {
        SymbolonVault.EngagementTerms memory t = _termsOn(v, id, payee_);
        bytes32 d = _digest(address(v), _termsHash(t));
        v.registerEngagement(t, _sign(ownerSigner, d), _sign(payeeSigner, d));
    }

    function _hostileWallets() internal returns (address[] memory w) {
        w = new address[](6);
        w[0] = address(new RevertingWallet());
        w[1] = address(new WrongMagicWallet());
        w[2] = address(new ShortReturnWallet());
        w[3] = address(new DirtyMagicWallet());
        w[4] = address(new GasBurnerWallet());
        w[5] = address(new StateChangingWallet());
    }

    // ---- every role can be a contract wallet -----------------------------------------------------------------

    function test_kernelSigner_isContractWallet() public {
        address kSigner = _actor("kernel-safe-signer");
        MockSafe kSafe = new MockSafe(kSigner);
        SymbolonVault v = _vaultFor(owner, address(kSafe));
        _registerWith(v, ENG, payee, owner, payee);

        SymbolonVault.Attestation memory a = _att(ENG, payee, 10 * USDC);
        vm.expectRevert(SymbolonVault.BadKernelSig.selector); // the Safe's address has no key; its signer's does
        v.release(a, _attSig(v, kernel, a), _noRef(), "");
        v.release(a, _attSig(v, kSigner, a), _noRef(), "");
        assertEq(token.balanceOf(payee), 10 * USDC);

        // Safe-style pre-approved hash: empty signature bytes
        SymbolonVault.Attestation memory b = _att(ENG, payee, 5 * USDC);
        bytes32 bd = _digest(address(v), _attHash(b));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        v.release(b, "", _noRef(), "");
        kSafe.approveHash(bd);
        v.release(b, "", _noRef(), "");
        assertEq(token.balanceOf(payee), 15 * USDC);
    }

    function test_payeeChange_ownerOldAndNewPayeeAreAllContractWallets() public {
        address ownerSigner = _actor("owner-safe-signer");
        MockSafe ownerSafe = new MockSafe(ownerSigner);
        MockSafe oldSafe = new MockSafe(address(0)); // accepts only pre-approved hashes
        address newSigner = _actor("new-payee-signer");
        MockSafe newSafe = new MockSafe(newSigner);
        SymbolonVault v = _vaultFor(address(ownerSafe), kernel);

        SymbolonVault.EngagementTerms memory t = _termsOn(v, ENG, address(oldSafe));
        bytes32 td = _digest(address(v), _termsHash(t));
        oldSafe.approveHash(td);
        v.registerEngagement(t, _sign(ownerSigner, td), "");

        SymbolonVault.PayeeChange memory pc = SymbolonVault.PayeeChange(ENG, address(oldSafe), address(newSafe), 2);
        bytes32 d = _digest(address(v), _pcHash(pc));
        bytes memory os = _sign(ownerSigner, d);
        bytes memory ns = _sign(newSigner, d);

        vm.expectRevert(SymbolonVault.BadPayeeSig.selector); // old payee has not approved this hash yet
        v.proposePayeeChange(pc, os, "", ns);
        oldSafe.approveHash(d);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        v.proposePayeeChange(pc, _sign(attacker, d), "", ns);
        vm.expectRevert(SymbolonVault.BadNewPayeeSig.selector);
        v.proposePayeeChange(pc, os, "", _sign(attacker, d));
        v.proposePayeeChange(pc, os, "", ns);

        vm.warp(block.timestamp + PAYEE_DELAY);
        v.executePayeeChange(ENG);
        (address p,,,,,,) = v.engagements(ENG);
        assertEq(p, address(newSafe));

        SymbolonVault.Attestation memory a = _att(ENG, address(newSafe), 7 * USDC);
        v.release(a, _attSig(v, kernel, a), _noRef(), "");
        assertEq(token.balanceOf(address(newSafe)), 7 * USDC);
    }

    // ---- hostile wallets never validate, in any role ---------------------------------------------------------

    function test_hostileWallets_asPayee_neverValidate() public {
        address[] memory w = _hostileWallets();
        for (uint256 i = 0; i < w.length; ++i) {
            SymbolonVault.EngagementTerms memory t = _terms(keccak256(abi.encode("hostile-payee", i)), w[i], 10 * USDC);
            bytes32 d = _digest(address(vault), _termsHash(t));
            vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
            vault.registerEngagement(t, _sign(owner, d), hex"1234");
        }
        assertEq(vault.engagementCount(), 0);
        assertEq(StateChangingWallet(w[5]).calls(), 0, "the STATICCALL kept the wallet from writing storage");
    }

    function test_hostileWallets_asOwner_neverValidate() public {
        address[] memory w = _hostileWallets();
        for (uint256 i = 0; i < w.length; ++i) {
            SymbolonVault v = _vaultFor(w[i], kernel);
            SymbolonVault.EngagementTerms memory t = _termsOn(v, ENG, payee);
            bytes32 d = _digest(address(v), _termsHash(t));
            vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
            v.registerEngagement(t, hex"1234", _sign(payee, d));
        }
    }

    function test_hostileWallets_asOwner_approvalsNeverValidate() public {
        address[] memory w = _hostileWallets();
        for (uint256 i = 0; i < w.length; ++i) {
            // register through a pre-approving Safe owner is not possible here (the owner IS the hostile wallet),
            // so check the approval path in isolation on a vault whose engagement is registered by an AcceptAll
            // stand-in at the same address: etch the hostile code only after registration.
            AcceptAllWallet tmp = new AcceptAllWallet();
            SymbolonVault v = _vaultFor(address(tmp), kernel);
            SymbolonVault.EngagementTerms memory t = _termsOn(v, ENG, payee);
            bytes32 d = _digest(address(v), _termsHash(t));
            v.registerEngagement(t, "", _sign(payee, d));
            vm.etch(address(tmp), w[i].code);

            SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
            SymbolonVault.OwnerApprovalRef memory ref =
                SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 hours)});
            bytes memory ks = _attSig(v, kernel, a);
            vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
            v.release(a, ks, ref, hex"1234");
            assertFalse(v.used(a.intentId));
        }
    }

    function test_hostileWallets_asKernelSigner_neverValidate() public {
        address[] memory w = _hostileWallets();
        for (uint256 i = 0; i < w.length; ++i) {
            SymbolonVault v = _vaultFor(owner, w[i]);
            _registerWith(v, ENG, payee, owner, payee);
            SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
            vm.expectRevert(SymbolonVault.BadKernelSig.selector);
            v.release(a, hex"1234", _noRef(), "");
        }
    }

    function test_gasBurningWallet_failsWithItsError_notOutOfGas() public {
        GasBurnerWallet burner = new GasBurnerWallet();
        SymbolonVault v = _vaultFor(owner, address(burner));
        _registerWith(v, ENG, payee, owner, payee);
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        // The vault forwards all gas to the wallet and keeps 1/64 (EIP-150), enough to revert with its own error.
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        v.release{gas: 2_000_000}(a, hex"1234", _noRef(), "");
    }

    function test_longReturnData_withExactMagicWord_isValid() public {
        LongReturnWallet w = new LongReturnWallet();
        SymbolonVault.EngagementTerms memory t = _terms(ENG, address(w), 10 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        vault.registerEngagement(t, _sign(owner, d), "");
        assertEq(vault.engagementCount(), 1);
    }

    // ---- a wallet that says yes to everything ----------------------------------------------------------------

    /// A payee wallet that accepts anything does not weaken the owner's control: registration and payee change
    /// still need the owner's signature, and moving the payee still needs the new payee's signature.
    function test_acceptAllPayee_cannotBypassOwnerOrNewPayee() public {
        AcceptAllWallet lax = new AcceptAllWallet();
        SymbolonVault.EngagementTerms memory t = _terms(ENG, address(lax), 100 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.registerEngagement(t, _sign(attacker, d), "");
        vault.registerEngagement(t, _sign(owner, d), "");

        SymbolonVault.PayeeChange memory pc = SymbolonVault.PayeeChange(ENG, address(lax), attacker, 2);
        bytes32 pd = _digest(address(vault), _pcHash(pc));
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        vault.proposePayeeChange(pc, _sign(attacker, pd), "", _sign(attacker, pd));
        pc.newPayee = payee2;
        pd = _digest(address(vault), _pcHash(pc));
        vm.expectRevert(SymbolonVault.BadNewPayeeSig.selector);
        vault.proposePayeeChange(pc, _sign(owner, pd), "", _sign(attacker, pd));
    }

    /// "Bound it": with a kernel signer that validates ANY signature (equivalent to a fully compromised kernel key),
    /// an attacker still cannot pay itself, exceed the per-tx, engagement or daily caps, or pass the human threshold
    /// without the owner. The worst case is the certificate's T3c bound, not the vault balance.
    function test_acceptAllKernelSigner_lossStillBoundedByVault() public {
        AcceptAllWallet anyone = new AcceptAllWallet();
        SymbolonVault v = _vaultFor(owner, address(anyone));
        _registerWith(v, ENG, payee, owner, payee);
        uint256 vaultBefore = token.balanceOf(address(v));

        vm.startPrank(attacker);
        SymbolonVault.Attestation memory a = _att(ENG, attacker, 1 * USDC);
        vm.expectRevert(SymbolonVault.PayeeMismatch.selector);
        v.release(a, "", _noRef(), "");
        a = _att(keccak256("not-registered"), attacker, 1 * USDC);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        v.release(a, "", _noRef(), "");
        a = _att(ENG, payee, perTxCap + 1);
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        v.release(a, "", _noRef(), "");
        a = _att(ENG, payee, humanThreshold + 1);
        vm.expectRevert(SymbolonVault.ApprovalExpired.selector);
        v.release(a, "", _noRef(), "");
        // drain as much as the vault allows without the owner: releases of humanThreshold until the daily cap
        uint256 paid;
        for (uint256 i = 0; i < 10; ++i) {
            a = _att(ENG, payee, humanThreshold);
            try v.release(a, "", _noRef(), "") {
                paid += humanThreshold;
            } catch {}
        }
        vm.stopPrank();
        assertEq(paid, dailyCap, "unapproved outflow per 24 h == min(D, 64 * min(P, H)) for these caps");
        assertEq(token.balanceOf(address(v)), vaultBefore - dailyCap);
        assertEq(token.balanceOf(attacker), 0);
    }

    /// Documented limitation (README threat notes): an OWNER wallet that accepts every signature hands the owner's
    /// signing authority to anyone (here: registering the attacker as a payee). Owner-only CALLS still need
    /// msg.sender == owner, so pause and withdraw stay with the real owner.
    function test_acceptAllOwner_handsOwnerSignatureAuthorityToAnyone_butNotOwnerCalls() public {
        AcceptAllWallet lax = new AcceptAllWallet();
        SymbolonVault v = _vaultFor(address(lax), kernel);
        SymbolonVault.EngagementTerms memory t = _termsOn(v, keccak256("attacker-eng"), attacker);
        bytes32 d = _digest(address(v), _termsHash(t));
        vm.prank(attacker);
        v.registerEngagement(t, hex"00", _sign(attacker, d));
        assertEq(v.engagementCount(), 1, "the lax owner wallet let anyone co-sign as owner");

        vm.startPrank(attacker);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        v.withdraw(attacker, 1);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        v.unpause();
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        v.setGuardian(attacker);
        vm.stopPrank();
        // the kernel signer is still required to move funds to the attacker
        SymbolonVault.Attestation memory a = _att(keccak256("attacker-eng"), attacker, 1 * USDC);
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        v.release(a, _attSig(v, attacker, a), _noRef(), "");
    }

    // ---- ERC-1271 answers are "valid now", so they can be revoked --------------------------------------------

    function test_revokedOwnerApproval_failsClosed() public {
        ToggleWallet ow = new ToggleWallet();
        SymbolonVault v = _vaultFor(address(ow), kernel);
        SymbolonVault.EngagementTerms memory t = _termsOn(v, ENG, payee);
        bytes32 d = _digest(address(v), _termsHash(t));
        v.registerEngagement(t, "", _sign(payee, d));

        SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 hours)});
        bytes memory ks = _attSig(v, kernel, a);
        ow.setAccepting(false); // the owner revokes before the release lands
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        v.release(a, ks, ref, "");
        ow.setAccepting(true);
        v.release(a, ks, ref, "");
        assertEq(token.balanceOf(payee), humanThreshold + 1);
    }

    /// A contract kernel signer is an instant kill switch: switching it off stops every attestation at once,
    /// without waiting for `signerChangeDelay` (rotation still needs the delay).
    function test_contractKernelSigner_canBeSwitchedOffInstantly() public {
        ToggleWallet kw = new ToggleWallet();
        SymbolonVault v = _vaultFor(owner, address(kw));
        _registerWith(v, ENG, payee, owner, payee);
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        kw.setAccepting(false);
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        v.release(a, "", _noRef(), "");
        assertFalse(v.used(a.intentId));
    }

    // ---- re-entry from inside isValidSignature ---------------------------------------------------------------

    function test_reenteringOwnerWallet_cannotWithdrawDuringApprovalCheck() public {
        ReenteringWallet ow = new ReenteringWallet();
        SymbolonVault v = _vaultFor(address(ow), kernel);
        // register while the wallet still says yes (its call-back is a harmless no-op on the token)
        ow.arm(address(token), abi.encodeCall(IERC20.totalSupply, ()));
        SymbolonVault.EngagementTerms memory t = _termsOn(v, ENG, payee);
        bytes32 d = _digest(address(v), _termsHash(t));
        v.registerEngagement(t, "", _sign(payee, d));
        assertEq(v.engagementCount(), 1, "control: a call-back that changes nothing is allowed");

        uint256 bal = token.balanceOf(address(v));
        ow.arm(address(v), abi.encodeCall(SymbolonVault.withdraw, (address(ow), bal)));
        SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 hours)});
        bytes memory ks = _attSig(v, kernel, a);
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector); // the call-back failed, so the wallet said no
        v.release(a, ks, ref, "");
        assertEq(token.balanceOf(address(v)), bal);

        // control: the same withdraw outside the signature check works (it is the owner)
        ow.exec(address(v), abi.encodeCall(SymbolonVault.withdraw, (address(ow), 1)));
        assertEq(token.balanceOf(address(ow)), 1);
    }

    function test_reenteringPayeeWallet_cannotRegisterDuringCheck() public {
        ReenteringWallet pw = new ReenteringWallet();
        SymbolonVault.EngagementTerms memory inner = _terms(keccak256("inner"), payee2, 10 * USDC);
        bytes32 id_ = _digest(address(vault), _termsHash(inner));
        bytes memory innerCall =
            abi.encodeCall(SymbolonVault.registerEngagement, (inner, _sign(owner, id_), _sign(payee2, id_)));
        pw.arm(address(vault), innerCall);

        SymbolonVault.EngagementTerms memory t = _terms(ENG, address(pw), 10 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, _sign(owner, d), "");
        assertEq(vault.engagementCount(), 0);

        // control: the inner registration is valid on its own
        (bool ok,) = address(vault).call(innerCall);
        assertTrue(ok);
        assertEq(vault.engagementCount(), 1);
    }

    function test_reenteringKernelWallet_cannotReleaseDuringCheck() public {
        ReenteringWallet kw = new ReenteringWallet();
        SymbolonVault v = _vaultFor(owner, address(kw));
        _registerWith(v, ENG, payee, owner, payee);
        SymbolonVault.Attestation memory inner = _att(ENG, payee, 2 * USDC);
        kw.arm(address(v), abi.encodeCall(SymbolonVault.release, (inner, bytes(""), _noRef(), bytes(""))));
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        v.release(a, "", _noRef(), "");
        assertEq(token.balanceOf(payee), 0);
        assertFalse(v.used(inner.intentId));
    }

    // ---- EIP-7702 delegated EOAs (Arc baseline Osaka includes Prague's EIP-7702; VERIFY(V-41)) ---------------

    /// An owner EOA that delegates to code without ERC-1271 can no longer sign for the vault: SignatureChecker sees
    /// code and asks the (missing) `isValidSignature`. This fails CLOSED (registrations and approvals stop), and
    /// INV-12 still holds because pause and withdraw check msg.sender, not a signature.
    function test_eip7702_ownerDelegatedWithout1271_signaturesFailClosed_pauseAndWithdrawStillWork() public {
        (address eoa, uint256 eoaKey) = makeAddrAndKey("7702-owner");
        keyOf[eoa] = eoaKey;
        SymbolonVault v = _vaultFor(eoa, kernel);
        _registerWith(v, ENG, payee, eoa, payee); // before delegation: plain ecrecover

        BatchExecutorDelegate batch = new BatchExecutorDelegate();
        vm.signAndAttachDelegation(address(batch), eoaKey);
        BatchExecutorDelegate(eoa).execute(address(token), abi.encodeCall(IERC20.totalSupply, ()));
        assertEq(eoa.code.length, 23, "EIP-7702 delegation designator 0xef0100 || address");

        SymbolonVault.EngagementTerms memory t = _termsOn(v, keccak256("second"), payee);
        bytes32 d = _digest(address(v), _termsHash(t));
        bytes memory os = _sign(eoa, d);
        bytes memory ps = _sign(payee, d);
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        v.registerEngagement(t, os, ps);

        SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 hours)});
        bytes memory approval =
            _sign(eoa, _digest(address(v), _approvalHash(a.intentId, ref.receiptHash, a.amount, ref.deadline)));
        bytes memory ks = _attSig(v, kernel, a);
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        v.release(a, ks, ref, approval);

        vm.startPrank(eoa);
        v.pause();
        v.withdraw(eoa, token.balanceOf(address(v)));
        vm.stopPrank();
        assertTrue(v.paused());
        assertEq(token.balanceOf(address(v)), 0);
    }

    function test_eip7702_ownerDelegatedToSelfValidating1271_keepsSigning() public {
        (address eoa, uint256 eoaKey) = makeAddrAndKey("7702-owner-ok");
        keyOf[eoa] = eoaKey;
        SymbolonVault v = _vaultFor(eoa, kernel);
        SelfValidatingDelegate impl = new SelfValidatingDelegate();
        vm.signAndAttachDelegation(address(impl), eoaKey);
        SelfValidatingDelegate(eoa).ping();
        assertEq(eoa.code.length, 23);

        _registerWith(v, ENG, payee, eoa, payee);
        SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 hours)});
        bytes memory approval =
            _sign(eoa, _digest(address(v), _approvalHash(a.intentId, ref.receiptHash, a.amount, ref.deadline)));
        v.release(a, _attSig(v, kernel, a), ref, approval);
        assertEq(token.balanceOf(payee), humanThreshold + 1);
    }

    // ---- fuzz: any wallet answer other than the exact magic word is a refusal --------------------------------

    function testFuzz_erc1271_onlyExactMagicWordValidates(bytes32 word, uint8 extraWords) public {
        bool exact = word == bytes32(bytes4(0x1626ba7e));
        address w = address(new FixedAnswerWallet(word, extraWords % 3));
        SymbolonVault.EngagementTerms memory t = _terms(ENG, w, 10 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        if (!exact) vm.expectRevert(SymbolonVault.BadPayeeSig.selector);
        vault.registerEngagement(t, os, "");
        assertEq(vault.engagementCount(), exact ? 1 : 0);
    }

    function testFuzz_erc1271_exactMagicWithAnyTrailingData(uint8 extraWords) public {
        address w = address(new FixedAnswerWallet(bytes32(bytes4(0x1626ba7e)), extraWords % 4));
        SymbolonVault.EngagementTerms memory t = _terms(ENG, w, 10 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        vault.registerEngagement(t, _sign(owner, d), "");
        assertEq(vault.engagementCount(), 1);
    }
}

/// @dev Answers every call with `word` followed by `extra` 32-byte words of junk.
contract FixedAnswerWallet {
    bytes32 internal immutable WORD;
    uint256 internal immutable EXTRA;

    constructor(bytes32 word, uint256 extra) {
        WORD = word;
        EXTRA = extra;
    }

    fallback() external {
        bytes32 w = WORD;
        uint256 len = 32 * (1 + EXTRA);
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, w)
            for { let i := 32 } lt(i, len) { i := add(i, 32) } { mstore(add(p, i), not(0)) }
            return(p, len)
        }
    }
}
