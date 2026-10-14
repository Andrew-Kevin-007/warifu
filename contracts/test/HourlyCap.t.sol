// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice WP-08 `hourlyCap` suite (docs/06 A.4 step 10, docs/16 §2.2): the 1 h window is exact and half-open
/// (`t > now - 1 hours`, so a release exactly 3600 s old no longer counts), 0 disables it, it is checked after the
/// daily cap and the 64-slot count and before the owner approval, a failure never burns the intent, and over any
/// half-open horizon `t` the released sum stays within the certificate's `hc * ceil(t / 3600)` and
/// `d* * ceil(t / 86400)` terms. Boundary seconds are tested at -1 / 0 / +1 around every edge.
contract HourlyCapTest is VaultTestBase {
    uint256 internal constant HOUR = 3600;
    uint256 internal constant DAY = 86_400;

    function _vaultWith(uint256 perTx, uint256 daily, uint256 hourly, uint256 human) internal returns (SymbolonVault v) {
        v = new SymbolonVault(
            IERC20(address(token)), owner, kernel, guardian, perTx, daily, hourly, human, PAYEE_DELAY, SIGNER_DELAY
        );
        token.mint(address(v), 10_000_000 * USDC);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, type(uint128).max);
        t.owner = owner;
        t.end = uint64(block.timestamp + 3650 days);
        _registerOn(v, t);
    }

    function _signed(SymbolonVault v, uint256 amount)
        internal
        returns (SymbolonVault.Attestation memory a, bytes memory sig)
    {
        a = _att(ENG, payee, amount);
        a.deadline = uint64(block.timestamp + 30 days);
        sig = _sign(kernel, _digest(address(v), _attHash(a)));
    }

    function _rel(SymbolonVault v, uint256 amount) internal {
        (SymbolonVault.Attestation memory a, bytes memory sig) = _signed(v, amount);
        v.release(a, sig, _noRef(), "");
    }

    function _relReverts(SymbolonVault v, uint256 amount, bytes4 err) internal {
        (SymbolonVault.Attestation memory a, bytes memory sig) = _signed(v, amount);
        vm.expectRevert(err);
        v.release(a, sig, _noRef(), "");
        assertFalse(v.used(a.intentId), "a failed release never burns the intent");
    }

    function _hourSum(SymbolonVault v) internal view returns (uint256 h) {
        (, h,) = v.rollingUsage();
    }

    // ---- the 1 h edge, one second at a time ------------------------------------------------------------------

    function test_singleRelease_edgeAt3599_3600_3601() public {
        uint256 t0 = block.timestamp;
        uint256[3] memory offsets = [HOUR - 1, HOUR, HOUR + 1];
        for (uint256 i = 0; i < 3; ++i) {
            vm.warp(t0);
            SymbolonVault v = _vaultWith(100 * USDC, 1_000 * USDC, 30 * USDC, type(uint256).max);
            _rel(v, 30 * USDC);
            vm.warp(t0 + offsets[i]);
            if (offsets[i] < HOUR) {
                assertEq(_hourSum(v), 30 * USDC, "age 3599 s: still inside the hour");
                _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
            } else {
                assertEq(_hourSum(v), 0, "age >= 3600 s: outside the hour");
                _rel(v, 30 * USDC);
                assertEq(_hourSum(v), 30 * USDC);
                _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
            }
            (uint256 daySum,,) = v.rollingUsage();
            assertEq(daySum, offsets[i] < HOUR ? 30 * USDC : 60 * USDC, "the day window still holds everything");
        }
    }

    function test_slidingWindow_freesExactlyTheExpiredAmount_atTheExpiringSecond() public {
        SymbolonVault v = _vaultWith(100 * USDC, 10_000 * USDC, 60 * USDC, type(uint256).max);
        uint256 t0 = block.timestamp;
        _rel(v, 10 * USDC); // t0
        vm.warp(t0 + 100);
        _rel(v, 20 * USDC); // t0+100
        vm.warp(t0 + 200);
        _rel(v, 30 * USDC); // t0+200: hour full (60)

        vm.warp(t0 + HOUR - 1);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        vm.warp(t0 + HOUR); // the 10 at t0 leaves the window
        _relReverts(v, 10 * USDC + 1, SymbolonVault.HourlyCap.selector);
        _rel(v, 10 * USDC); // exactly the freed amount

        vm.warp(t0 + 100 + HOUR - 1);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        vm.warp(t0 + 100 + HOUR); // the 20 at t0+100 leaves
        _relReverts(v, 20 * USDC + 1, SymbolonVault.HourlyCap.selector);
        _rel(v, 20 * USDC);

        vm.warp(t0 + 200 + HOUR); // the 30 leaves
        assertEq(_hourSum(v), 30 * USDC); // 10 @ t0+3600 and 20 @ t0+3700
        _rel(v, 30 * USDC);
        assertEq(_hourSum(v), 60 * USDC);
    }

    function test_hourlyCap_exactlyReachable_oneBaseUnitMoreReverts() public {
        SymbolonVault v = _vaultWith(100 * USDC, 10_000 * USDC, 30 * USDC, type(uint256).max);
        _rel(v, 10 * USDC);
        _rel(v, 19 * USDC);
        _relReverts(v, 1 * USDC + 1, SymbolonVault.HourlyCap.selector);
        _rel(v, 1 * USDC); // sum == hourlyCap exactly
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        assertEq(_hourSum(v), 30 * USDC);
    }

    function test_hourlyCap_ofOneBaseUnit() public {
        SymbolonVault v = _vaultWith(2, 10_000, 1, type(uint256).max);
        _relReverts(v, 2, SymbolonVault.HourlyCap.selector);
        _rel(v, 1);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + HOUR - 1);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        vm.warp(t0 + HOUR);
        _rel(v, 1);
    }

    function test_hourlyCap_belowPerTxCap_boundsEverySingleRelease() public {
        SymbolonVault v = _vaultWith(100 * USDC, 10_000 * USDC, 40 * USDC, type(uint256).max);
        _relReverts(v, 40 * USDC + 1, SymbolonVault.HourlyCap.selector);
        _relReverts(v, 100 * USDC, SymbolonVault.HourlyCap.selector);
        _rel(v, 40 * USDC);
    }

    function test_burstInOneSecond_stopsAtTheHourlyCap() public {
        SymbolonVault v = _vaultWith(100 * USDC, 10_000 * USDC, 10 * USDC, type(uint256).max);
        for (uint256 i = 0; i < 10; ++i) {
            _rel(v, 1 * USDC);
        }
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        (uint256 daySum, uint256 hourSum, uint256 count) = v.rollingUsage();
        assertEq(daySum, 10 * USDC);
        assertEq(hourSum, 10 * USDC);
        assertEq(count, 10);
    }

    // ---- interaction with the daily window and the 64-slot ring ---------------------------------------------

    function test_hourAndDayEdges_releaseAt24hMinus1_countsForDayNotHour() public {
        SymbolonVault v = _vaultWith(100 * USDC, 100 * USDC, 50 * USDC, type(uint256).max);
        uint256 t0 = block.timestamp;
        _rel(v, 50 * USDC);
        vm.warp(t0 + HOUR);
        _rel(v, 50 * USDC); // day full
        vm.warp(t0 + DAY - 1);
        (uint256 daySum, uint256 hourSum,) = v.rollingUsage();
        assertEq(daySum, 100 * USDC);
        assertEq(hourSum, 0);
        _relReverts(v, 1, SymbolonVault.DailyCap.selector); // hourly has room, daily does not
        vm.warp(t0 + DAY); // the t0 release leaves the day window now
        _rel(v, 50 * USDC);
        uint256 count;
        (daySum, hourSum, count) = v.rollingUsage();
        assertEq(daySum, 100 * USDC);
        assertEq(hourSum, 50 * USDC);
        assertEq(count, 2);
        vm.warp(t0 + HOUR + DAY - 1); // t0+3600 still in the day, the release at t0+DAY still in the hour
        _relReverts(v, 1, SymbolonVault.DailyCap.selector);
        vm.warp(t0 + HOUR + DAY); // t0+3600 leaves the day; the t0+DAY release (age 3600) leaves the hour
        (daySum, hourSum,) = v.rollingUsage();
        assertEq(daySum, 50 * USDC);
        assertEq(hourSum, 0);
        _rel(v, 50 * USDC);
        _relReverts(v, 1, SymbolonVault.DailyCap.selector);
    }

    /// The hourly cap binds inside a day that still has room.
    function test_hourlyBindsWhileDailyHasRoom_thenFreesAtTheHourEdge() public {
        SymbolonVault v = _vaultWith(100 * USDC, 1_000 * USDC, 50 * USDC, type(uint256).max);
        uint256 t0 = block.timestamp;
        _rel(v, 50 * USDC);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        vm.warp(t0 + HOUR - 1);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        vm.warp(t0 + HOUR);
        _rel(v, 50 * USDC);
        vm.warp(t0 + HOUR + 1);
        _relReverts(v, 1, SymbolonVault.HourlyCap.selector);
        (uint256 daySum,,) = v.rollingUsage();
        assertEq(daySum, 100 * USDC);
    }

    function test_hourlyCapEqualToDailyCap_dailyBindsAfterTheFirstHour() public {
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, 200 * USDC, type(uint256).max);
        uint256 t0 = block.timestamp;
        _rel(v, 100 * USDC);
        _rel(v, 100 * USDC);
        _relReverts(v, 1, SymbolonVault.DailyCap.selector); // both full: daily is checked first
        vm.warp(t0 + HOUR);
        _relReverts(v, 1, SymbolonVault.DailyCap.selector);
    }

    function test_hourlyCapAboveDailyCap_neverBinds() public {
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, 1_000 * USDC, type(uint256).max);
        _rel(v, 100 * USDC);
        _rel(v, 100 * USDC);
        _relReverts(v, 1, SymbolonVault.DailyCap.selector);
    }

    function test_tooManyReleases_beforeHourlyCap_evenWhenBothFail() public {
        SymbolonVault v = _vaultWith(100, 1_000_000, 64, type(uint256).max);
        for (uint256 i = 0; i < 64; ++i) {
            _rel(v, 1);
        }
        assertEq(_hourSum(v), 64);
        _relReverts(v, 1, SymbolonVault.TooManyReleases.selector);
    }

    function test_hourlyCapZero_isDisabled_atEverySecond() public {
        SymbolonVault v = _vaultWith(100 * USDC, 1_000 * USDC, 0, type(uint256).max);
        for (uint256 i = 0; i < 10; ++i) {
            _rel(v, 100 * USDC); // 1000 USDC in one second: only the daily cap applies
        }
        assertEq(_hourSum(v), 1_000 * USDC, "rollingUsage still reports the hour sum");
        _relReverts(v, 1, SymbolonVault.DailyCap.selector);
    }

    // ---- check order vs the owner approval (step 10 before step 11) -----------------------------------------

    function test_hourlyCapFailsBeforeApproval_thenTheSameSignedReleasePassesAfterTheHour() public {
        SymbolonVault v = _vaultWith(100 * USDC, 1_000 * USDC, 60 * USDC, 50 * USDC);
        uint256 t0 = block.timestamp;
        _rel(v, 50 * USDC);
        (SymbolonVault.Attestation memory a, bytes memory ksig) = _signed(v, 51 * USDC);
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(t0 + 2 days)});
        bytes memory osig =
            _sign(owner, _digest(address(v), _approvalHash(a.intentId, ref.receiptHash, a.amount, ref.deadline)));
        vm.expectRevert(SymbolonVault.HourlyCap.selector); // even with a valid approval
        v.release(a, ksig, ref, osig);
        assertFalse(v.used(a.intentId));
        vm.expectRevert(SymbolonVault.HourlyCap.selector); // and without one: step 10 decides first
        v.release(a, ksig, _noRef(), "");
        vm.warp(t0 + HOUR);
        v.release(a, ksig, ref, osig);
        assertTrue(v.used(a.intentId));
        assertEq(_hourSum(v), 51 * USDC);
    }

    // ---- configHash binds hourlyCap (RT-19) ------------------------------------------------------------------

    function testFuzz_hourlyCap_isBoundByConfigHash(uint256 h1, uint256 h2) public {
        vm.assume(h1 != h2);
        SymbolonVault a = new SymbolonVault(
            IERC20(address(token)), owner, kernel, guardian, perTxCap, dailyCap, h1, humanThreshold, PAYEE_DELAY, SIGNER_DELAY
        );
        SymbolonVault b = new SymbolonVault(
            IERC20(address(token)), owner, kernel, guardian, perTxCap, dailyCap, h2, humanThreshold, PAYEE_DELAY, SIGNER_DELAY
        );
        assertEq(a.hourlyCap(), h1);
        assertTrue(a.configHash() != b.configHash());
    }

    // ---- fuzz: the 1 h edge at -3 .. +3 seconds --------------------------------------------------------------

    function testFuzz_hourEdge(uint256 first, uint256 second, int256 off, uint256 hc) public {
        hc = bound(hc, 1, 100 * USDC);
        first = bound(first, 1, hc);
        second = bound(second, 1, 100 * USDC);
        off = bound(off, -3, 3);
        SymbolonVault v = _vaultWith(100 * USDC, 1_000_000 * USDC, hc, type(uint256).max);
        uint256 t0 = block.timestamp;
        _rel(v, first);
        vm.warp(uint256(int256(t0 + HOUR) + off));
        bool firstStillInside = off < 0;
        uint256 inWindow = firstStillInside ? first : 0;
        assertEq(_hourSum(v), inWindow);
        if (inWindow + second > hc) _relReverts(v, second, SymbolonVault.HourlyCap.selector);
        else _rel(v, second);
    }

    // ---- differential fuzz with random caps, biased to the 1 h and 24 h edges --------------------------------

    uint256[] internal histT;
    uint256[] internal histAmt;
    uint256 internal P;
    uint256 internal D;
    uint256 internal HC;

    function _windowSum(uint256 nowTs, uint256 len) internal view returns (uint256 s, uint256 n) {
        for (uint256 i = 0; i < histT.length; ++i) {
            if (histT[i] + len > nowTs) {
                s += histAmt[i];
                ++n;
            }
        }
    }

    function _model(uint256 amount) internal view returns (bytes4) {
        if (amount == 0 || amount > P) return SymbolonVault.PerTxCap.selector;
        (uint256 day, uint256 n) = _windowSum(block.timestamp, DAY);
        (uint256 hour,) = _windowSum(block.timestamp, HOUR);
        if (day + amount > D) return SymbolonVault.DailyCap.selector;
        if (n >= 64) return SymbolonVault.TooManyReleases.selector;
        if (HC != 0 && hour + amount > HC) return SymbolonVault.HourlyCap.selector;
        return bytes4(0);
    }

    function testFuzz_randomCaps_matchFullHistoryModel_andCertificateRateTerms(
        uint256 seed,
        uint256 perTx,
        uint256 daily,
        uint256 hourly,
        uint8 steps
    ) public {
        P = bound(perTx, 1, 50 * USDC);
        D = bound(daily, P, 200 * USDC);
        HC = hourly % 4 == 0 ? 0 : bound(hourly, 1, 2 * D); // 1 in 4 runs: hourly cap off
        SymbolonVault v = _vaultWith(P, D, HC, type(uint256).max);
        uint256 n = bound(steps, 1, 120);
        for (uint256 i = 0; i < n; ++i) {
            _diffStep(v, uint256(keccak256(abi.encode(seed, i))));
        }
        _assertCertificateRateTerms();
    }

    function _diffStep(SymbolonVault v, uint256 r) internal {
        uint256 kind = r % 10;
        uint256 dt;
        if (kind < 4) {
            dt = (r >> 8) % 3; // same or next seconds (saturate the ring, repeat timestamps)
        } else if (kind < 8 && histT.length > 0) {
            // jump to an edge of an earlier release: its 1 h or 24 h expiry, -1 / 0 / +1 s
            uint256 base = histT[(r >> 8) % histT.length] + ((r >> 40) % 2 == 0 ? HOUR : DAY);
            uint256 target = base + ((r >> 48) % 3) - 1;
            dt = target > block.timestamp ? target - block.timestamp : 0;
        } else {
            dt = (r >> 8) % (26 * HOUR);
        }
        vm.warp(block.timestamp + dt);
        uint256 amount = (r >> 64) % 4 == 0 ? (r >> 72) % (P + 2) : 1 + (r >> 72) % (P / 8 + 1);
        bytes4 expected = _model(amount);
        SymbolonVault.Attestation memory a = _att(ENG, payee, amount);
        bytes memory sig = _sign(kernel, _digest(address(v), _attHash(a)));
        try v.release(a, sig, _noRef(), "") {
            assertEq(expected, bytes4(0), "vault released where the model reverts");
            histT.push(block.timestamp);
            histAmt.push(amount);
        } catch (bytes memory err) {
            assertTrue(expected != bytes4(0), "vault reverted where the model releases");
            assertEq(bytes4(err), expected, "different revert reason than the model");
        }
        (uint256 vDay, uint256 vHour, uint256 vCount) = v.rollingUsage();
        (uint256 mDay, uint256 mCount) = _windowSum(block.timestamp, DAY);
        (uint256 mHour,) = _windowSum(block.timestamp, HOUR);
        assertEq(vDay, mDay, "rollingUsage day sum");
        assertEq(vHour, mHour, "rollingUsage hour sum");
        assertEq(vCount, mCount, "rollingUsage count");
    }

    /// docs/16 §2.2: over ANY half-open interval [T, T + t) the released sum is at most
    /// min(d* * ceil(t / 86400), hc > 0 ? hc * ceil(t / 3600) : inf), d* = min(D, 64 * P) (no threshold here).
    /// The maximum over T is reached with T at a release time, so checking every release start is exhaustive.
    function _assertCertificateRateTerms() internal view {
        uint256[6] memory horizons = [uint256(60), HOUR, 6 * HOUR, DAY, 2 * DAY, 7 * DAY];
        uint256 dStar = D < 64 * P ? D : 64 * P;
        for (uint256 h = 0; h < 6; ++h) {
            uint256 len = horizons[h];
            uint256 bound_ = dStar * ((len + DAY - 1) / DAY);
            if (HC != 0) {
                uint256 hb = HC * ((len + HOUR - 1) / HOUR);
                if (hb < bound_) bound_ = hb;
            }
            for (uint256 i = 0; i < histT.length; ++i) {
                uint256 s;
                for (uint256 j = i; j < histT.length && histT[j] < histT[i] + len; ++j) {
                    s += histAmt[j];
                }
                assertLe(s, bound_, "a half-open horizon exceeded the certificate's rate terms");
            }
        }
    }
}
