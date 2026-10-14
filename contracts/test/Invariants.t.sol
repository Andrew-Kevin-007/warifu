// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {MockUSDC} from "./utils/Mocks.sol";
import {VaultHandler, HandlerConfig} from "./utils/VaultHandler.sol";

/// @notice docs/06 A.5 Invariants.t.sol: handler-based invariants INV-1..7 and INV-12 (docs/02 §4) plus
/// `Σ released ≤ Σ caps`, `used` monotonic, balance accounting, append-only engagement list, exact rolling-window
/// model, configuration immutability and `configHash` against its documented preimage.
///
/// The handler (`utils/VaultHandler.sol`) calls every state-changing function from honest and hostile callers and
/// is itself a second implementation of the release rules; see its header. Four campaigns run the same invariants
/// over different configurations: the default caps, hourlyCap disabled with a zero threshold and zero delays,
/// ERC-1271 wallets in every signing role, and tiny base-unit caps where the hourly window binds.
abstract contract InvariantsBase is Test {
    VaultHandler internal h;
    SymbolonVault internal vault;
    MockUSDC internal token;
    HandlerConfig internal cfg;
    bytes32 internal configAtStart;

    /// @dev Campaign configuration.
    function _config() internal view virtual returns (HandlerConfig memory);

    /// @dev A typical release amount for this campaign's scale (fits perTxCap).
    function _amount() internal view virtual returns (uint256);

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        cfg = _config();
        h = new VaultHandler(cfg);
        vault = h.vault();
        token = h.token();
        configAtStart = vault.configHash();
        // two engagements so release paths are reachable from the first call
        h.register(0, 500e6, 0, 5 days);
        h.register(1, 800e6, 0, 5 days);

        bytes4[] memory s = new bytes4[](22);
        s[0] = VaultHandler.warp.selector;
        s[1] = VaultHandler.warp.selector;
        s[2] = VaultHandler.register.selector;
        s[3] = VaultHandler.registerBad.selector;
        s[4] = VaultHandler.close.selector;
        s[5] = VaultHandler.pause.selector;
        s[6] = VaultHandler.unpause.selector;
        s[7] = VaultHandler.unpause.selector;
        s[8] = VaultHandler.deposit.selector;
        s[9] = VaultHandler.withdraw.selector;
        s[10] = VaultHandler.release.selector;
        s[11] = VaultHandler.release.selector;
        s[12] = VaultHandler.release.selector;
        s[13] = VaultHandler.release.selector;
        s[14] = VaultHandler.burst.selector;
        s[15] = VaultHandler.proposePayeeChange.selector;
        s[16] = VaultHandler.proposePayeeChange.selector;
        s[17] = VaultHandler.executePayeeChange.selector;
        s[18] = VaultHandler.proposeSigner.selector;
        s[19] = VaultHandler.executeSigner.selector;
        s[20] = VaultHandler.setGuardian.selector;
        s[21] = VaultHandler.blocklist.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
        targetContract(address(h));
    }

    // ---- INV-1 .. INV-7 ----------------------------------------------------------------------------------------

    /// INV-1: a release succeeds only with a valid kernel attestation of exactly the submitted fields, signed by the
    /// signer the vault trusts at that moment (stale, pending, foreign, tampered and high-s signatures all fail).
    function invariant_INV1_onlyKernelSignedReleasesSucceed() public view {
        assertEq(h.violUnauthorizedRelease(), 0);
    }

    /// INV-2: only the registered payee of an active engagement is ever paid; the on-chain payee equals the
    /// payee produced by the dual-signed registration and three-signature changes.
    function invariant_INV2_onlyRegisteredCurrentPayeeIsPaid() public view {
        assertEq(h.violUnregisteredPayee(), 0);
        assertEq(h.violRegistration(), 0, "an engagement was registered without both signatures");
        uint256 n = h.idsLength();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = h.ids(i);
            (address p, uint256 cap, uint256 released, uint64 start, uint64 end, bytes32 termsHash, bool active) =
                vault.engagements(id);
            assertEq(p, h.ghostPayee(id), "payee");
            assertEq(cap, h.ghostCap(id), "cap is fixed at registration");
            assertEq(start, h.ghostStart(id), "start is fixed at registration");
            assertEq(end, h.ghostEnd(id), "end is fixed at registration");
            assertEq(termsHash, h.ghostTermsHash(id), "termsHash is fixed at registration");
            assertEq(active, h.ghostActive(id), "active");
            assertEq(released, h.ghostReleased(id), "released");
        }
    }

    /// INV-3: Σ released(engagement) ≤ cap(engagement), and the per-engagement counters add up to what left.
    function invariant_INV3_releasedNeverExceedsCap() public view {
        assertEq(h.violEngagementCap(), 0);
        uint256 n = h.idsLength();
        uint256 sumReleased;
        for (uint256 i = 0; i < n; ++i) {
            (, uint256 cap, uint256 released,,,,) = vault.engagements(h.ids(i));
            assertLe(released, cap);
            sumReleased += released;
        }
        assertLe(sumReleased, h.sumCaps());
        assertEq(sumReleased, h.totalReleased(), "sum of engagement.released == sum of Released amounts");
    }

    /// INV-4: an intentId is single-use and `used` is monotonic: true exactly for the intents that paid, never
    /// burned by a failed attempt, never reset.
    function invariant_INV4_intentsSingleUse_usedMonotonic() public view {
        assertEq(h.violReplay(), 0);
        uint256 n = h.attemptedIntentsLength();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 intent = h.attemptedIntents(i);
            assertEq(vault.used(intent), h.timesReleased(intent) == 1, "used[] must mirror successful releases");
            assertLe(h.timesReleased(intent), 1);
        }
    }

    /// INV-5: per-tx cap and the exact rolling 24 h / 1 h / 64-release windows. The vault's own window accounting
    /// is compared with a full-history model, not just bounded.
    function invariant_INV5_perTxAndRollingCaps() public view {
        assertEq(h.violPerTxOrRolling(), 0);
        (uint256 daySum, uint256 hourSum, uint256 count) = vault.rollingUsage();
        (uint256 mDay, uint256 mHour, uint256 mCount) = h.modelRolling();
        assertEq(daySum, mDay, "24h sum differs from the full-history model");
        assertEq(hourSum, mHour, "1h sum differs from the full-history model");
        assertEq(count, mCount, "24h release count differs from the full-history model");
        assertLe(daySum, vault.dailyCap());
        if (vault.hourlyCap() != 0) assertLe(hourSum, vault.hourlyCap());
        assertLe(count, vault.RING_SIZE());
        assertLe(h.maxRingCount(), vault.RING_SIZE());
    }

    /// INV-6: above the threshold a release needs an unexpired owner approval of exactly this intent and amount.
    function invariant_INV6_aboveThresholdNeedsOwnerApproval() public view {
        assertEq(h.violApproval(), 0);
    }

    /// INV-7: a payee change needs the owner and the old and the new payee, a fresh nonce, the delay, and no pause
    /// in between; the vault's pending record mirrors the model.
    function invariant_INV7_payeeChangeNeedsThreeSigsAndDelay() public view {
        assertEq(h.violPayeeChange(), 0);
        uint256 n = h.idsLength();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = h.ids(i);
            assertEq(vault.engagementNonce(id), h.ghostNonce(id), "nonce");
            (address newPayee, uint256 proposedAt, uint256 epoch, bool exists) = h.pendingOf(id);
            (address vNew, uint64 vEta) = vault.pendingPayee(id);
            if (exists) {
                assertEq(vNew, newPayee, "pending payee");
                assertEq(uint256(vEta), proposedAt + cfg.payeeChangeDelay, "eta");
                assertEq(vault.pendingPayeeEpoch(id), epoch, "epoch");
                assertEq(vault.payeeChangeLive(id), epoch == h.ghostEpoch(), "live");
            } else {
                assertEq(vNew, address(0), "no pending payee");
                assertEq(vault.payeeChangeLive(id), false);
            }
        }
    }

    // ---- INV-12 ------------------------------------------------------------------------------------------------

    /// INV-12: the owner can always pause and withdraw: no reachable state blocks either call. The handler checks
    /// every attempted owner pause/withdraw (`violLiveness`); this also exercises both from the CURRENT state.
    function invariant_INV12_ownerCanAlwaysPauseAndWithdraw() public {
        assertEq(h.violLiveness(), 0, "a call the model says must succeed reverted");
        uint256 snap = vm.snapshotState();
        address o = h.owner();
        vm.prank(o);
        vault.pause();
        assertTrue(vault.paused());
        uint256 bal = token.balanceOf(address(vault));
        vm.prank(o);
        vault.withdraw(o, bal);
        assertEq(token.balanceOf(address(vault)), 0);
        vm.revertToState(snap);
    }

    // ---- lifecycle, access and bookkeeping -----------------------------------------------------------------------

    function invariant_noReleaseWhilePausedClosedOutOfWindowOrPastDeadline() public view {
        assertEq(h.violLifecycle(), 0);
    }

    function invariant_ownerOnlyFunctionsRejectEveryoneElse() public view {
        assertEq(h.violAccess(), 0);
    }

    function invariant_balanceAccounting() public view {
        assertEq(
            token.balanceOf(address(vault)),
            h.initialBalance() + h.totalDeposited() - h.totalReleased() - h.totalWithdrawn()
        );
    }

    function invariant_engagementListAppendOnly() public view {
        uint256 n = h.idsLength();
        assertEq(vault.engagementCount(), n);
        for (uint256 i = 0; i < n; ++i) {
            assertEq(vault.engagementIdAt(i), h.ids(i));
        }
    }

    /// There is no limit setter and the configuration moves only through the two timelocked/owner paths: every
    /// immutable still has its deploy value, `configHash()` equals its documented preimage computed from the
    /// handler's own record of owner, kernel signer and guardian, and `paused`/`pendingSigner*` are outside it.
    function invariant_configurationIsImmutableAndHashMatchesPreimage() public view {
        assertEq(vault.perTxCap(), cfg.perTxCap);
        assertEq(vault.dailyCap(), cfg.dailyCap);
        assertEq(vault.hourlyCap(), cfg.hourlyCap);
        assertEq(vault.humanThreshold(), cfg.humanThreshold);
        assertEq(uint256(vault.payeeChangeDelay()), uint256(cfg.payeeChangeDelay));
        assertEq(uint256(vault.signerChangeDelay()), uint256(cfg.signerChangeDelay));
        assertEq(address(vault.token()), address(token));
        assertEq(uint256(vault.tokenDecimals()), 6);
        assertEq(vault.owner(), h.owner());
        assertEq(vault.kernelSigner(), h.kernels(h.kIdx()));
        assertEq(vault.guardian(), h.guardians(h.gIdx()));
        assertEq(vault.pendingSigner(), h.kPending() == 0 ? address(0) : h.kernels(h.kPending() - 1));
        assertEq(uint256(vault.pendingSignerEta()), h.kEta());
        bytes32 expected = keccak256(
            abi.encode(
                address(token),
                uint8(6),
                h.owner(),
                h.kernels(h.kIdx()),
                h.guardians(h.gIdx()),
                cfg.perTxCap,
                cfg.dailyCap,
                cfg.hourlyCap,
                cfg.humanThreshold,
                cfg.payeeChangeDelay,
                cfg.signerChangeDelay,
                uint8(64)
            )
        );
        assertEq(vault.configHash(), expected, "configHash differs from the documented preimage");
        if (h.kIdx() == 0 && h.gIdx() == 0) assertEq(vault.configHash(), configAtStart);
    }

    function invariant_pauseStateMatchesModel() public view {
        assertEq(vault.paused(), h.ghostPaused());
        assertEq(vault.pauseEpoch(), h.ghostEpoch());
    }

    // ---- non-vacuity -------------------------------------------------------------------------------------------

    function _honestMode() internal pure returns (uint256 m) {
        m = 1; // registered engagement
        m |= uint256(2) << 4; // registered payee
        m |= uint256(1) << 8; // fresh intent
        m |= uint256(1) << 12; // plain bounded amount
        m |= uint256(2) << 16; // deadline in the future
        m |= uint256(2) << 28; // the signer the vault trusts
        m |= uint256(2) << 36; // no tampering
        m |= uint256(0) << 44; // a valid approval whenever one is needed
        m |= uint256(1) << 48; // no junk ref
    }

    /// The handler's honest paths do succeed and every one of its model checks agrees with the real vault; a
    /// handler that only ever reverted would make every invariant above pass trivially.
    function test_handler_everyStateChangingFunctionIsReachableAndTheModelAgrees() public {
        uint256 amt = _amount();
        for (uint256 i = 0; i < 6; ++i) {
            h.release(i % 2, amt, _honestMode(), 2);
        }
        assertGe(h.okReleases(), 6, "honest releases must succeed");

        h.burst(0, 70); // hits the 64-release window unless an hourly cap binds first
        if (cfg.hourlyCap == 0 || cfg.hourlyCap >= 70) assertEq(h.maxRingCount(), 64, "saturation not reached");

        h.pause(1); // guardian
        assertEq(h.okPauses(), 1);
        h.unpause(0); // owner
        assertEq(h.okUnpauses(), 1);
        h.withdraw(0, 1, 0);
        assertEq(h.okWithdrawals(), 1);
        h.deposit(10e6);

        h.proposePayeeChange(0, 1, 1 | (5 << 3));
        assertEq(h.okPayeeProposals(), 1, "payee change proposal");
        h.warp(2 days);
        h.executePayeeChange(3, 0);
        assertEq(h.okPayeeChanges(), 1, "payee change execution");

        h.proposeSigner(0, 2);
        assertEq(h.okSignerProposals(), 1);
        h.warp(2 days);
        h.executeSigner(0);
        assertEq(h.okSignerRotations(), 1);
        h.release(0, amt, _honestMode(), 2); // signed by the rotated signer
        assertGe(h.okReleases(), 7);

        h.setGuardian(0, 2);
        assertEq(h.okGuardianChanges(), 1);
        h.close(0, 1);
        assertEq(h.okCloses(), 1);
        h.registerBad(0, 3);

        assertEq(h.violUnauthorizedRelease(), 0);
        assertEq(h.violUnregisteredPayee(), 0);
        assertEq(h.violEngagementCap(), 0);
        assertEq(h.violReplay(), 0);
        assertEq(h.violPerTxOrRolling(), 0);
        assertEq(h.violApproval(), 0);
        assertEq(h.violPayeeChange(), 0);
        assertEq(h.violLifecycle(), 0);
        assertEq(h.violAccess(), 0);
        assertEq(h.violRegistration(), 0);
        assertEq(h.violLiveness(), 0);
    }
}

/// @notice Default caps: all four windows and the approval path reachable.
contract InvariantsTest is InvariantsBase {
    function _config() internal pure override returns (HandlerConfig memory) {
        return HandlerConfig({
            perTxCap: 100e6,
            dailyCap: 300e6,
            hourlyCap: 150e6,
            humanThreshold: 50e6,
            payeeChangeDelay: 1 days,
            signerChangeDelay: 1 days,
            wallets: false
        });
    }

    function _amount() internal pure override returns (uint256) {
        return 10e6;
    }
}

/// @notice hourlyCap disabled, every release needs an approval, no timelocks (delay boundary = same second).
contract InvariantsNoHourlyZeroDelayTest is InvariantsBase {
    function _config() internal pure override returns (HandlerConfig memory) {
        return HandlerConfig({
            perTxCap: 100e6,
            dailyCap: 250e6,
            hourlyCap: 0,
            humanThreshold: 0,
            payeeChangeDelay: 0,
            signerChangeDelay: 0,
            wallets: false
        });
    }

    function _amount() internal pure override returns (uint256) {
        return 10e6;
    }
}

/// @notice Owner, every kernel-signer candidate and every payee are ERC-1271 wallets (MockSafe).
contract InvariantsWalletsTest is InvariantsBase {
    function _config() internal pure override returns (HandlerConfig memory) {
        return HandlerConfig({
            perTxCap: 100e6,
            dailyCap: 300e6,
            hourlyCap: 150e6,
            humanThreshold: 50e6,
            payeeChangeDelay: 1 days,
            signerChangeDelay: 1 days,
            wallets: true
        });
    }

    function _amount() internal pure override returns (uint256) {
        return 10e6;
    }
}

/// @notice Tiny base-unit caps: the hourly window and the 64-release window bind within a few calls.
contract InvariantsTinyCapsTest is InvariantsBase {
    function _config() internal pure override returns (HandlerConfig memory) {
        return HandlerConfig({
            perTxCap: 7,
            dailyCap: 100,
            hourlyCap: 30,
            humanThreshold: 3,
            payeeChangeDelay: 1 hours,
            signerChangeDelay: 1 hours,
            wallets: false
        });
    }

    function _amount() internal pure override returns (uint256) {
        return 2;
    }
}
