// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice docs/06 A.5 Rolling.t.sol: the exact rolling window (`t > now - 1 days`, i.e. half-open), boundary
/// seconds, 64-slot saturation, wraparound, the optional hourly cap, and a differential fuzz against a model
/// that keeps the full release history (INV-5).
contract RollingTest is VaultTestBase {
    function setUp() public override {
        super.setUp();
        _registerDefault();
    }

    /// @dev Vault with custom caps, its own big engagement, funded.
    function _vaultWith(uint256 perTx, uint256 daily, uint256 hourly, uint256 human) internal returns (SymbolonVault v) {
        v = new SymbolonVault(
            IERC20(address(token)), owner, kernel, guardian, perTx, daily, hourly, human, PAYEE_DELAY, SIGNER_DELAY
        );
        token.mint(address(v), 1_000_000 * USDC);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, type(uint128).max);
        t.owner = owner;
        t.end = uint64(block.timestamp + 3650 days);
        _registerOn(v, t);
    }

    function _relOn(SymbolonVault v, uint256 amount) internal {
        SymbolonVault.Attestation memory a = _att(ENG, payee, amount);
        v.release(a, _sign(kernel, _digest(address(v), _attHash(a))), _noRef(), "");
    }

    function _expectRelRevert(SymbolonVault v, uint256 amount, bytes4 err) internal {
        SymbolonVault.Attestation memory a = _att(ENG, payee, amount);
        bytes memory sig = _sign(kernel, _digest(address(v), _attHash(a)));
        vm.expectRevert(err);
        v.release(a, sig, _noRef(), "");
    }

    // ---- 24 h window boundary --------------------------------------------------------------------------------

    function test_dailyWindow_boundarySeconds_halfOpen() public {
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, 0, type(uint256).max);
        uint256 t0 = block.timestamp;
        _relOn(v, 100 * USDC);
        _relOn(v, 100 * USDC); // daily cap reached at t0
        vm.warp(t0 + 1 days - 1); // still inside: age 86399 < 86400
        _expectRelRevert(v, 1, SymbolonVault.DailyCap.selector);
        vm.warp(t0 + 1 days); // exactly 24 h old: outside (t > now - 1 days is false)
        _relOn(v, 100 * USDC);
        _relOn(v, 100 * USDC);
        (uint256 daySum,, uint256 count) = v.rollingUsage();
        assertEq(daySum, 200 * USDC);
        assertEq(count, 2);
        vm.warp(t0 + 1 days + 1);
        _expectRelRevert(v, 1, SymbolonVault.DailyCap.selector);
    }

    function test_dailyCap_exactlyReachable() public {
        SymbolonVault v = _vaultWith(100 * USDC, 150 * USDC, 0, type(uint256).max);
        _relOn(v, 100 * USDC);
        _expectRelRevert(v, 50 * USDC + 1, SymbolonVault.DailyCap.selector);
        _relOn(v, 50 * USDC);
    }

    // ---- 64-slot saturation and wraparound -------------------------------------------------------------------

    function test_saturation_64thPasses_65thReverts_sameTimestamp() public {
        // Arc block timestamps can repeat, so all 64 releases may share one timestamp.
        uint256 t0 = block.timestamp;
        for (uint256 i = 0; i < 64; ++i) {
            _release(_att(ENG, payee, 1));
        }
        (uint256 daySum,, uint256 count) = vault.rollingUsage();
        assertEq(count, 64);
        assertEq(daySum, 64);
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1);
        a.deadline = uint64(t0 + 2 days);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.TooManyReleases.selector);
        vault.release(a, sig, _noRef(), "");
        vm.warp(t0 + 1 days - 1);
        vm.expectRevert(SymbolonVault.TooManyReleases.selector);
        vault.release(a, sig, _noRef(), "");
        vm.warp(t0 + 1 days);
        vault.release(a, sig, _noRef(), ""); // all 64 expired together
        (, , count) = vault.rollingUsage();
        assertEq(count, 1);
    }

    function test_wraparound_overwritesOnlyExpiredSlots() public {
        uint256 t0 = block.timestamp;
        for (uint256 i = 0; i < 64; ++i) {
            vm.warp(t0 + i); // releases at t0 .. t0+63, one per second
            _release(_att(ENG, payee, 1));
        }
        vm.warp(t0 + 1 days); // only the t0 release has expired
        (,, uint256 count) = vault.rollingUsage();
        assertEq(count, 63);
        _release(_att(ENG, payee, 1)); // overwrites slot 0 (t0)
        (,, count) = vault.rollingUsage();
        assertEq(count, 64);
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1);
        a.deadline = uint64(t0 + 2 days);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.TooManyReleases.selector);
        vault.release(a, sig, _noRef(), ""); // t0+1 is still inside
        vm.warp(t0 + 1 days + 1);
        vault.release(a, sig, _noRef(), ""); // t0+1 expired; overwrites slot 1

        // Two more laps: release k lands at t0 + (k / 64) days + (k % 64) s, so each overwrites a slot that is
        // exactly 24 h old. The ring stays full, never over-counts and never under-counts.
        for (uint256 k = 66; k < 64 * 3 + 5; ++k) {
            vm.warp(t0 + (k / 64) * 1 days + (k % 64));
            _release(_att(ENG, payee, 1));
            (uint256 daySum,, uint256 c) = vault.rollingUsage();
            assertEq(c, 64);
            assertEq(daySum, 64);
            // one more in the same second is always refused: the window holds 64 releases
            SymbolonVault.Attestation memory extra = _att(ENG, payee, 1);
            bytes memory esig = _kernelSig(extra);
            vm.expectRevert(SymbolonVault.TooManyReleases.selector);
            vault.release(extra, esig, _noRef(), "");
        }
    }

    // ---- hourly cap ------------------------------------------------------------------------------------------

    function test_hourlyCap_boundarySeconds() public {
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, 30 * USDC, type(uint256).max);
        uint256 t0 = block.timestamp;
        _relOn(v, 30 * USDC);
        vm.warp(t0 + 1 hours - 1);
        _expectRelRevert(v, 1, SymbolonVault.HourlyCap.selector);
        vm.warp(t0 + 1 hours); // exactly 1 h old: outside the hourly window, inside the daily one
        _relOn(v, 30 * USDC);
        (uint256 daySum, uint256 hourSum, uint256 count) = v.rollingUsage();
        assertEq(daySum, 60 * USDC);
        assertEq(hourSum, 30 * USDC);
        assertEq(count, 2);
    }

    function test_hourlyCap_zeroMeansDisabled() public {
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, 0, type(uint256).max);
        _relOn(v, 100 * USDC);
        _relOn(v, 100 * USDC); // 200 in the same second: only the daily cap applies
        (, uint256 hourSum,) = v.rollingUsage();
        assertEq(hourSum, 200 * USDC);
    }

    function test_hourlyCap_largerThanPerTx_singleReleaseExceedsIt() public {
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, 40 * USDC, type(uint256).max);
        _expectRelRevert(v, 41 * USDC, SymbolonVault.HourlyCap.selector);
        _relOn(v, 40 * USDC);
    }

    // ---- error precedence within step 10 ---------------------------------------------------------------------

    function test_dailyCap_reportedBeforeTooManyReleases() public {
        SymbolonVault v = _vaultWith(1, 64, 0, type(uint256).max);
        for (uint256 i = 0; i < 64; ++i) {
            _relOn(v, 1);
        }
        _expectRelRevert(v, 1, SymbolonVault.DailyCap.selector); // both fail; DailyCap is checked first
    }

    function test_tooManyReleases_reportedBeforeHourlyCap() public {
        SymbolonVault v = _vaultWith(100, 1_000_000, 64, type(uint256).max);
        for (uint256 i = 0; i < 64; ++i) {
            _relOn(v, 1);
        }
        _expectRelRevert(v, 1, SymbolonVault.TooManyReleases.selector);
    }

    // ---- differential fuzz against a full-history model ------------------------------------------------------

    uint256[] internal histT;
    uint256[] internal histAmt;

    function _model(uint256 nowTs, uint256 amount, uint256 daily, uint256 hourly) internal view returns (bytes4) {
        uint256 daySum;
        uint256 hourSum;
        uint256 count;
        for (uint256 i = 0; i < histT.length; ++i) {
            if (histT[i] + 1 days > nowTs) {
                daySum += histAmt[i];
                ++count;
                if (histT[i] + 1 hours > nowTs) hourSum += histAmt[i];
            }
        }
        if (daySum + amount > daily) return SymbolonVault.DailyCap.selector;
        if (count >= 64) return SymbolonVault.TooManyReleases.selector;
        if (hourly != 0 && hourSum + amount > hourly) return SymbolonVault.HourlyCap.selector;
        return bytes4(0);
    }

    function testFuzz_rollingWindow_matchesFullHistoryModel(uint256 seed, uint8 steps, bool withHourly) public {
        uint256 hourly = withHourly ? 60 * USDC : 0;
        SymbolonVault v = _vaultWith(100 * USDC, 200 * USDC, hourly, type(uint256).max);
        uint256 n = bound(steps, 1, 90);
        for (uint256 i = 0; i < n; ++i) {
            _step(v, uint256(keccak256(abi.encode(seed, i))), hourly);
        }
    }

    function _step(SymbolonVault v, uint256 r, uint256 hourly) internal {
        uint256 daily = 200 * USDC;
        // mostly tiny gaps and amounts (to reach 64 releases), sometimes large ones; gaps straddle 1 h and 24 h
        uint256 gapKind = r % 8;
        uint256 dt = gapKind < 4 ? (r >> 8) % 3 : gapKind < 6 ? (r >> 8) % 2 hours : (r >> 8) % 25 hours;
        uint256 amount = (r >> 64) % 5 == 0 ? 1 + (r >> 72) % (100 * USDC) : 1 + (r >> 72) % (2 * USDC);
        vm.warp(block.timestamp + dt);

        bytes4 expected = _model(block.timestamp, amount, daily, hourly);
        SymbolonVault.Attestation memory a = _att(ENG, payee, amount);
        bytes memory sig = _sign(kernel, _digest(address(v), _attHash(a)));
        try v.release(a, sig, _noRef(), "") {
            assertEq(expected, bytes4(0), "vault released where the model reverts");
            histT.push(block.timestamp);
            histAmt.push(amount);
        } catch (bytes memory err) {
            assertEq(bytes4(err), expected, "vault reverted with a different reason than the model");
            assertTrue(expected != bytes4(0), "vault reverted where the model releases");
        }
        (uint256 daySum, uint256 hourSum, uint256 count) = v.rollingUsage();
        assertLe(daySum, daily);
        assertLe(count, 64);
        if (hourly != 0) assertLe(hourSum, hourly);
    }
}
