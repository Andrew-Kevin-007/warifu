// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockUSDC, MockSafe} from "./utils/Mocks.sol";

/// @notice docs/06 A.5 Release.t.sol: every revert path of `release` (steps 1-11) with a positive and a negative
/// test, the owner-approval path (review fix), check order, domain separation, malleability, Arc blocklist.
contract ReleaseTest is VaultTestBase {
    SymbolonVault.EngagementTerms internal t;

    event Released(
        bytes32 indexed intentId, bytes32 indexed engagementId, address indexed payee, uint256 amount, bytes32 receiptHash
    );

    function setUp() public override {
        super.setUp();
        t = _registerDefault();
    }

    // ---- happy path ------------------------------------------------------------------------------------------

    function test_release_paysPayeeAndRecordsEverything() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 40 * USDC);
        uint256 vaultBefore = token.balanceOf(address(vault));
        vm.expectEmit(address(vault));
        emit Released(a.intentId, ENG, payee, 40 * USDC, a.receiptHash);
        vm.prank(attacker); // any relayer may submit
        vault.release(a, _kernelSig(a), _noRef(), "");
        assertEq(token.balanceOf(payee), 40 * USDC);
        assertEq(token.balanceOf(address(vault)), vaultBefore - 40 * USDC);
        assertEq(_released(ENG), 40 * USDC);
        assertTrue(vault.used(a.intentId));
        (uint256 daySum, uint256 hourSum, uint256 count) = vault.rollingUsage();
        assertEq(daySum, 40 * USDC);
        assertEq(hourSum, 40 * USDC);
        assertEq(count, 1);
    }

    // ---- step 1: Paused --------------------------------------------------------------------------------------

    function test_step1_paused_reverts() public {
        vm.prank(guardian);
        vault.pause();
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.Paused.selector);
        vault.release(a, sig, _noRef(), "");
        vm.prank(owner);
        vault.unpause();
        vault.release(a, sig, _noRef(), "");
        assertEq(token.balanceOf(payee), 1 * USDC);
    }

    // ---- step 2: Expired -------------------------------------------------------------------------------------

    function test_step2_expired_reverts_andDeadlineIsInclusive() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        a.deadline = uint64(block.timestamp - 1);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.Expired.selector);
        vault.release(a, sig, _noRef(), "");

        SymbolonVault.Attestation memory b = _att(ENG, payee, 1 * USDC);
        b.deadline = uint64(block.timestamp); // deadline >= now passes
        _release(b);
        assertTrue(vault.used(b.intentId));
    }

    // ---- step 3: AlreadyUsed (INV-4, ATK-08) -----------------------------------------------------------------

    function test_step3_alreadyUsed_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory sig = _kernelSig(a);
        vault.release(a, sig, _noRef(), "");
        vm.expectRevert(SymbolonVault.AlreadyUsed.selector);
        vault.release(a, sig, _noRef(), "");
        // a different intent for the same engagement still works
        _release(_att(ENG, payee, 1 * USDC));
        assertEq(token.balanceOf(payee), 2 * USDC);
    }

    function test_step3_failedReleaseDoesNotBurnIntent() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory good = _kernelSig(a);
        bytes memory bad = _sign(attacker, _digest(address(vault), _attHash(a)));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, bad, _noRef(), "");
        assertFalse(vault.used(a.intentId), "a reverted release must not consume the intent");
        vault.release(a, good, _noRef(), "");
        assertTrue(vault.used(a.intentId));
    }

    // ---- step 4: BadKernelSig (INV-1) ------------------------------------------------------------------------

    function test_step4_wrongSigner_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory sig = _sign(owner, _digest(address(vault), _attHash(a)));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, sig, _noRef(), "");
    }

    function test_step4_everyTamperedFieldReverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 10 * USDC);
        bytes memory sig = _kernelSig(a);
        for (uint256 i = 0; i < 7; ++i) {
            SymbolonVault.Attestation memory m = _copy(a);
            if (i == 0) m.intentId = keccak256("other intent");
            if (i == 1) m.engagementId = keccak256("other engagement");
            if (i == 2) m.milestoneId = keccak256("other milestone");
            if (i == 3) m.payee = payee2;
            if (i == 4) m.amount = a.amount + 1;
            if (i == 5) m.receiptHash = keccak256("other receipt");
            if (i == 6) m.deadline = a.deadline + 1;
            vm.expectRevert(SymbolonVault.BadKernelSig.selector);
            vault.release(m, sig, _noRef(), "");
        }
        vault.release(a, sig, _noRef(), "");
        assertEq(token.balanceOf(payee), 10 * USDC);
    }

    function test_step4_highS_malleableSignatureRejected() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOf[kernel], _digest(address(vault), _attHash(a)));
        assertLe(uint256(s), HALF_N);
        bytes32 sHigh = bytes32(SECP256K1_N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27; // (r, n - s, v') recovers the same key
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, abi.encodePacked(r, sHigh, vFlip), _noRef(), "");
        vault.release(a, abi.encodePacked(r, s, v), _noRef(), "");
    }

    function test_step4_malformedSignaturesRejected() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOf[kernel], _digest(address(vault), _attHash(a)));
        bytes[] memory bad = new bytes[](4);
        bad[0] = "";
        bad[1] = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255))); // EIP-2098 compact form
        bad[2] = abi.encodePacked(r, s, uint8(29));
        bad[3] = abi.encodePacked(r, s, v, uint8(0)); // 66 bytes
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(SymbolonVault.BadKernelSig.selector);
            vault.release(a, bad[i], _noRef(), "");
        }
    }

    function test_step4_signatureForOtherChainRejected() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        uint256 home = block.chainid;
        vm.chainId(5042002); // a signature made for Arc testnet ...
        bytes memory arcSig = _kernelSig(a);
        vm.chainId(home); // ... is not valid on this chain
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, arcSig, _noRef(), "");
        vault.release(a, _kernelSig(a), _noRef(), "");
    }

    function test_step4_signatureForOtherVaultRejected() public {
        SymbolonVault other = _deployVault(owner, kernel);
        token.mint(address(other), 1_000 * USDC);
        _registerOn(other, _terms(ENG, payee, 1_000 * USDC));
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory sigForOther = _sign(kernel, _digest(address(other), _attHash(a)));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, sigForOther, _noRef(), "");
        other.release(a, sigForOther, _noRef(), "");
        assertEq(token.balanceOf(payee), 1 * USDC);
    }

    // ---- step 5: NoEngagement --------------------------------------------------------------------------------

    function test_step5_unknownEngagement_reverts() public {
        SymbolonVault.Attestation memory a = _att(keccak256("unregistered"), payee, 1 * USDC);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.release(a, sig, _noRef(), "");
    }

    function test_step5_closedEngagement_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory sig = _kernelSig(a);
        vm.prank(owner);
        vault.closeEngagement(ENG);
        vm.expectRevert(SymbolonVault.NoEngagement.selector);
        vault.release(a, sig, _noRef(), "");
    }

    // ---- step 6: PayeeMismatch (INV-2, ATK-17a) --------------------------------------------------------------

    function test_step6_kernelSignedUnregisteredPayee_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, attacker, 1 * USDC);
        bytes memory sig = _kernelSig(a); // the kernel key itself signs the attacker address
        vm.expectRevert(SymbolonVault.PayeeMismatch.selector);
        vault.release(a, sig, _noRef(), "");
        assertEq(token.balanceOf(attacker), 0);
    }

    // ---- step 7: OutOfWindow ---------------------------------------------------------------------------------

    function test_step7_window_boundaries() public {
        SymbolonVault.EngagementTerms memory w = _terms(keccak256("windowed"), payee, 1_000 * USDC);
        w.start = uint64(block.timestamp + 1 days);
        w.end = uint64(block.timestamp + 2 days);
        _register(w);

        SymbolonVault.Attestation memory early = _att(w.engagementId, payee, 1 * USDC);
        early.deadline = w.end + 1 days;
        bytes memory sigEarly = _kernelSig(early);
        vm.warp(w.start - 1);
        vm.expectRevert(SymbolonVault.OutOfWindow.selector);
        vault.release(early, sigEarly, _noRef(), "");
        vm.warp(w.start); // start is inclusive
        vault.release(early, sigEarly, _noRef(), "");

        SymbolonVault.Attestation memory atEnd = _att(w.engagementId, payee, 1 * USDC);
        atEnd.deadline = w.end + 1 days;
        vm.warp(w.end); // end is inclusive
        _release(atEnd);

        SymbolonVault.Attestation memory late = _att(w.engagementId, payee, 1 * USDC);
        late.deadline = w.end + 1 days;
        bytes memory sigLate = _kernelSig(late);
        vm.warp(w.end + 1);
        vm.expectRevert(SymbolonVault.OutOfWindow.selector);
        vault.release(late, sigLate, _noRef(), "");
        assertEq(_released(w.engagementId), 2 * USDC);
    }

    // ---- step 8: PerTxCap ------------------------------------------------------------------------------------

    function test_step8_zeroAmount_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 0);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        vault.release(a, sig, _noRef(), "");
    }

    function test_step8_perTxCap_boundary() public {
        SymbolonVault.Attestation memory over = _att(ENG, payee, perTxCap + 1);
        bytes memory sig = _kernelSig(over);
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        vault.release(over, sig, _noRef(), "");
        _releaseApproved(_att(ENG, payee, perTxCap)); // exactly the cap passes (above H, so approved)
        assertEq(token.balanceOf(payee), perTxCap);
    }

    // ---- step 9: EngagementCap (INV-3) -----------------------------------------------------------------------

    function test_step9_engagementCap_boundary() public {
        SymbolonVault.EngagementTerms memory small = _terms(keccak256("small"), payee, 30 * USDC);
        _register(small);
        _release(_att(small.engagementId, payee, 20 * USDC));
        SymbolonVault.Attestation memory over = _att(small.engagementId, payee, 10 * USDC + 1);
        bytes memory sig = _kernelSig(over);
        vm.expectRevert(SymbolonVault.EngagementCap.selector);
        vault.release(over, sig, _noRef(), "");
        _release(_att(small.engagementId, payee, 10 * USDC)); // exactly up to the cap
        assertEq(_released(small.engagementId), 30 * USDC);
    }

    // ---- step 10: DailyCap / TooManyReleases / HourlyCap (details in Rolling.t.sol) ---------------------------

    function test_step10_dailyCap_reverts() public {
        _releaseApproved(_att(ENG, payee, 100 * USDC));
        _releaseApproved(_att(ENG, payee, 100 * USDC)); // 200 = dailyCap
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.DailyCap.selector);
        vault.release(a, sig, _noRef(), "");
    }

    // ---- step 11: owner approval (INV-6) ---------------------------------------------------------------------

    function test_step11_aboveThreshold_withoutApproval_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        vault.release(a, sig, SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("x"), deadline: uint64(block.timestamp)}), "");
    }

    function test_step11_validApproval_passes() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, humanThreshold + 1);
        // the owner signed over the escalation receipt, which differs from the final receipt in `a`
        bytes32 escalation = keccak256("escalation receipt");
        assertTrue(escalation != a.receiptHash);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig) = _approval(a, escalation, uint64(block.timestamp));
        vault.release(a, _kernelSig(a), ref, osig); // ref.deadline == now is still valid
        assertEq(token.balanceOf(payee), humanThreshold + 1);
    }

    function test_step11_expiredApproval_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 60 * USDC);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig) =
            _approval(a, keccak256("esc"), uint64(block.timestamp - 1));
        bytes memory ksig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.ApprovalExpired.selector);
        vault.release(a, ksig, ref, osig);
    }

    function test_step11_approvalForOtherIntent_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 60 * USDC);
        SymbolonVault.Attestation memory other = _att(ENG, payee, 60 * USDC);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig) =
            _approval(other, keccak256("esc"), uint64(block.timestamp + 1 days));
        bytes memory ksig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        vault.release(a, ksig, ref, osig);
    }

    function test_step11_approvalForXNeverReleasesXPlusOne() public {
        SymbolonVault.Attestation memory approvedFor = _att(ENG, payee, 60 * USDC);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig) =
            _approval(approvedFor, keccak256("esc"), uint64(block.timestamp + 1 days));
        SymbolonVault.Attestation memory bigger = _copy(approvedFor);
        bigger.amount = approvedFor.amount + 1; // same intent, kernel re-signs a larger amount
        bytes memory ksig = _kernelSig(bigger);
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        vault.release(bigger, ksig, ref, osig);
        vault.release(approvedFor, _kernelSig(approvedFor), ref, osig);
        assertEq(token.balanceOf(payee), 60 * USDC);
    }

    function test_step11_approvalByWrongSigner_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 60 * USDC);
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 days)});
        bytes32 d = _digest(address(vault), _approvalHash(a.intentId, ref.receiptHash, a.amount, ref.deadline));
        bytes memory ksig = _kernelSig(a);
        address[3] memory wrong = [kernel, guardian, payee];
        for (uint256 i = 0; i < wrong.length; ++i) {
            bytes memory osig = _sign(wrong[i], d);
            vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
            vault.release(a, ksig, ref, osig);
        }
    }

    function test_step11_tamperedRef_reverts() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 60 * USDC);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig) =
            _approval(a, keccak256("esc"), uint64(block.timestamp + 1 days));
        bytes memory ksig = _kernelSig(a);

        SymbolonVault.OwnerApprovalRef memory r1 = SymbolonVault.OwnerApprovalRef(ref.receiptHash, ref.deadline);
        r1.receiptHash = a.receiptHash; // claim the final receipt instead of the reviewed escalation receipt
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        vault.release(a, ksig, r1, osig);

        SymbolonVault.OwnerApprovalRef memory r2 = SymbolonVault.OwnerApprovalRef(ref.receiptHash, ref.deadline);
        r2.deadline = ref.deadline + 1; // stretch the deadline
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector);
        vault.release(a, ksig, r2, osig);

        vault.release(a, ksig, ref, osig);
    }

    function test_step11_safeOwner_erc1271() public {
        address safeSigner = _actor("safe-signer");
        MockSafe safe = new MockSafe(safeSigner);
        SymbolonVault sv = _deployVault(address(safe), kernel);
        token.mint(address(sv), 1_000 * USDC);
        SymbolonVault.EngagementTerms memory st = _terms(ENG, payee, 1_000 * USDC);
        st.owner = address(safe);
        bytes32 td = _digest(address(sv), _termsHash(st));
        sv.registerEngagement(st, _sign(safeSigner, td), _sign(payee, td));

        SymbolonVault.Attestation memory a = _att(ENG, payee, 60 * USDC);
        bytes memory ksig = _sign(kernel, _digest(address(sv), _attHash(a)));
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 days)});
        bytes32 ad = _digest(address(sv), _approvalHash(a.intentId, ref.receiptHash, a.amount, ref.deadline));

        vm.expectRevert(SymbolonVault.ApprovalRequired.selector); // not the Safe's signer
        sv.release(a, ksig, ref, _sign(attacker, ad));
        sv.release(a, ksig, ref, _sign(safeSigner, ad));
        assertEq(token.balanceOf(payee), 60 * USDC);

        // Safe-style pre-approved hash (no signature bytes at all)
        SymbolonVault.Attestation memory b = _att(ENG, payee, 60 * USDC);
        bytes32 bd = _digest(address(sv), _approvalHash(b.intentId, ref.receiptHash, b.amount, ref.deadline));
        safe.approveHash(bd);
        sv.release(b, _sign(kernel, _digest(address(sv), _attHash(b))), ref, "");
        assertEq(token.balanceOf(payee), 120 * USDC);
    }

    function test_step11_atOrBelowThreshold_ignoresRefAndSig() public {
        SymbolonVault.OwnerApprovalRef memory junk =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("junk"), deadline: 1}); // expired, unsigned
        SymbolonVault.Attestation memory atH = _att(ENG, payee, humanThreshold);
        vault.release(atH, _kernelSig(atH), junk, hex"deadbeef");
        SymbolonVault.Attestation memory below = _att(ENG, payee, 1);
        vault.release(below, _kernelSig(below), junk, "");
        assertEq(token.balanceOf(payee), humanThreshold + 1);
    }

    // ---- check order (docs/06 A.4: the first failing step decides the error) ----------------------------------

    function test_checkOrder_firstFailingStepWins() public {
        SymbolonVault.Attestation memory a = _att(keccak256("unregistered"), attacker, perTxCap + 1);
        a.deadline = uint64(block.timestamp - 1);
        bytes memory bad = _sign(attacker, _digest(address(vault), _attHash(a)));
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(SymbolonVault.Paused.selector); // 1 beats 2..11
        vault.release(a, bad, _noRef(), "");
        vm.prank(owner);
        vault.unpause();
        vm.expectRevert(SymbolonVault.Expired.selector); // 2 beats 4..11
        vault.release(a, bad, _noRef(), "");
        a.deadline = uint64(block.timestamp + 1);
        bad = _sign(attacker, _digest(address(vault), _attHash(a)));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector); // 4 beats 5..11
        vault.release(a, bad, _noRef(), "");
        bytes memory ks = _kernelSig(a);
        vm.expectRevert(SymbolonVault.NoEngagement.selector); // 5 beats 6..11
        vault.release(a, ks, _noRef(), "");
        a.engagementId = ENG;
        ks = _kernelSig(a);
        vm.expectRevert(SymbolonVault.PayeeMismatch.selector); // 6 beats 8..11
        vault.release(a, ks, _noRef(), "");
        a.payee = payee;
        ks = _kernelSig(a);
        vm.expectRevert(SymbolonVault.PerTxCap.selector); // 8 beats 11
        vault.release(a, ks, _noRef(), "");
    }

    // ---- discounted amount (docs/13 §4.2 v2) -----------------------------------------------------------------

    function test_discountedAmount_releasesExactlyThat_intentKeyedOnGross() public {
        // intentId is derived off-chain from the gross invoice amount; the attestation carries the discounted
        // release amount (2 % early-pay discount on 40 USDC).
        bytes32 grossIntent = keccak256(abi.encode("invoice-17", uint256(40 * USDC)));
        SymbolonVault.Attestation memory a = _att(ENG, payee, 39_200_000);
        a.intentId = grossIntent;
        _release(a);
        assertEq(token.balanceOf(payee), 39_200_000);
        assertEq(_released(ENG), 39_200_000);
        assertTrue(vault.used(grossIntent));
        SymbolonVault.Attestation memory full = _att(ENG, payee, 40 * USDC);
        full.intentId = grossIntent; // paying the gross amount afterwards is a replay
        bytes memory sig = _kernelSig(full);
        vm.expectRevert(SymbolonVault.AlreadyUsed.selector);
        vault.release(full, sig, _noRef(), "");
    }

    // ---- Arc: blocklist reverts are atomic -------------------------------------------------------------------

    function test_arc_blocklistedPayee_revertsAtomically() public {
        SymbolonVault.Attestation memory a = _att(ENG, payee, 5 * USDC);
        bytes memory sig = _kernelSig(a);
        token.setBlocklisted(payee, true);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocklisted.selector, payee));
        vault.release(a, sig, _noRef(), "");
        assertFalse(vault.used(a.intentId));
        assertEq(_released(ENG), 0);
        (,, uint256 count) = vault.rollingUsage();
        assertEq(count, 0);
        token.setBlocklisted(payee, false);
        vault.release(a, sig, _noRef(), "");
        assertEq(token.balanceOf(payee), 5 * USDC);
    }

    function test_insufficientBalance_revertsAtomically() public {
        vm.startPrank(owner);
        vault.withdraw(owner, token.balanceOf(address(vault)));
        vm.stopPrank();
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert();
        vault.release(a, sig, _noRef(), "");
        assertFalse(vault.used(a.intentId));
    }

    // ---- reentrancy: a token that calls back into the vault --------------------------------------------------

    function test_reentrantTokenCannotReenterRelease() public {
        ReentrantToken rt = new ReentrantToken();
        SymbolonVault rv = new SymbolonVault(
            IERC20(address(rt)), owner, kernel, guardian, perTxCap, dailyCap, 0, humanThreshold, PAYEE_DELAY, SIGNER_DELAY
        );
        rt.mint(address(rv), 1_000 * USDC);
        _registerOn(rv, _terms(ENG, payee, 1_000 * USDC));
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        SymbolonVault.Attestation memory b = _att(ENG, payee, 1 * USDC);
        rt.arm(rv, b, _sign(kernel, _digest(address(rv), _attHash(b))));
        rv.release(a, _sign(kernel, _digest(address(rv), _attHash(a))), _noRef(), "");
        assertTrue(rt.reentryReverted(), "nested release must revert");
        assertEq(rt.balanceOf(payee), 1 * USDC);
        assertFalse(rv.used(b.intentId));
    }
}

/// @dev Token whose transfer re-enters `release` once and records whether the nested call reverted.
contract ReentrantToken is MockUSDC(6) {
    SymbolonVault internal target;
    SymbolonVault.Attestation internal nested;
    bytes internal nestedSig;
    bool internal armed;
    bool public reentryReverted;

    function arm(SymbolonVault v, SymbolonVault.Attestation memory a, bytes memory sig) external {
        target = v;
        nested = a;
        nestedSig = sig;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == address(target)) {
            armed = false;
            try target.release(
                nested, nestedSig, SymbolonVault.OwnerApprovalRef({receiptHash: bytes32(0), deadline: 0}), ""
            ) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
    }
}
