// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// @notice docs/06 A.5 ArcDecimals.t.sol. On Arc, USDC has an 18-decimal native interface and a 6-decimal ERC-20
/// interface over one balance (docs.arc.network evm-differences). The vault reads `decimals()` once at deploy
/// and accounts in ERC-20 base units only; an amount scaled to 18 decimals by mistake hits the caps.
contract ArcDecimalsTest is VaultTestBase {
    uint256 internal constant SCALE_6_TO_18 = 1e12;

    function test_decimalsReadFromToken() public {
        assertEq(vault.tokenDecimals(), 6);
        MockUSDC t18 = new MockUSDC(18);
        SymbolonVault v18 = new SymbolonVault(
            IERC20(address(t18)), owner, kernel, guardian, 100e18, 200e18, 0, 50e18, PAYEE_DELAY, SIGNER_DELAY
        );
        assertEq(v18.tokenDecimals(), 18);
        MockUSDC t0 = new MockUSDC(0);
        SymbolonVault v0 = new SymbolonVault(IERC20(address(t0)), owner, kernel, guardian, 1, 1, 0, 0, 0, 0);
        assertEq(v0.tokenDecimals(), 0);
    }

    function test_amountScaledTo18Decimals_revertsAtPerTxCap() public {
        _registerDefault();
        // the kernel meant 1 USDC (1e6) but sent the native 18-decimal figure (1e18)
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC * SCALE_6_TO_18);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        vault.release(a, sig, _noRef(), "");
        assertEq(token.balanceOf(payee), 0);
    }

    function test_engagementCapIn18Decimals_stillBoundByVaultCaps() public {
        // an engagement registered with an 18-decimal cap by mistake cannot let more than perTxCap / dailyCap out
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 1_000 * USDC * SCALE_6_TO_18);
        _register(t);
        _releaseApproved(_att(ENG, payee, perTxCap));
        _releaseApproved(_att(ENG, payee, perTxCap));
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.DailyCap.selector);
        vault.release(a, sig, _noRef(), "");
        assertEq(token.balanceOf(payee), dailyCap);
    }

    function test_capsConfiguredIn6Decimals_onAn18DecimalToken_releaseTinyAmounts() public {
        // the reverse confusion: caps typed as 6-decimal numbers on an 18-decimal token. 1 "USDC" in 18 decimals
        // exceeds the 100e6 cap, so nothing meaningful can leave; the mistake fails closed.
        MockUSDC t18 = new MockUSDC(18);
        SymbolonVault v18 = new SymbolonVault(
            IERC20(address(t18)), owner, kernel, guardian, 100 * USDC, 200 * USDC, 0, 50 * USDC, PAYEE_DELAY, SIGNER_DELAY
        );
        t18.mint(address(v18), 1_000e18);
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 1_000e18);
        _registerOn(v18, t);
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1e18);
        bytes memory sig = _sign(kernel, _digest(address(v18), _attHash(a)));
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        v18.release(a, sig, _noRef(), "");
    }

    function testFuzz_scaledAmountsAboveCapAlwaysRevert(uint256 usdcAmount) public {
        _registerDefault();
        usdcAmount = bound(usdcAmount, 1, 1_000_000 * USDC);
        uint256 scaled = usdcAmount * SCALE_6_TO_18;
        assertGt(scaled, perTxCap); // any non-zero 18-decimal figure exceeds a 6-decimal cap of 100 USDC
        SymbolonVault.Attestation memory a = _att(ENG, payee, scaled);
        bytes memory sig = _kernelSig(a);
        vm.expectRevert(SymbolonVault.PerTxCap.selector);
        vault.release(a, sig, _noRef(), "");
    }
}
