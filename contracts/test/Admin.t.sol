// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {NoDecimalsToken} from "./utils/Mocks.sol";

/// @notice docs/06 A.5 Admin.t.sol: guardian pauses but cannot unpause; signer rotation delay; withdraw while
/// paused (INV-12); access control on every admin function; constructor validation.
contract AdminTest is VaultTestBase {
    event VaultPaused(address indexed by);
    event VaultUnpaused(address indexed by);
    event KernelSignerProposed(address indexed next, uint64 eta);
    event KernelSignerRotated(address indexed previous, address indexed next);
    event GuardianChanged(address indexed previous, address indexed next);
    event Withdrawn(address indexed to, uint256 amount);

    // ---- pause / unpause -------------------------------------------------------------------------------------

    function test_guardian_canPause_cannotUnpause() public {
        vm.expectEmit(address(vault));
        emit VaultPaused(guardian);
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
        assertEq(vault.pauseEpoch(), 1);
        vm.prank(guardian);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.unpause();
        vm.expectEmit(address(vault));
        emit VaultUnpaused(owner);
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_strangers_cannotPause() public {
        address[3] memory who = [attacker, kernel, payee];
        for (uint256 i = 0; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.pause();
        }
        assertFalse(vault.paused());
    }

    function test_pause_isIdempotent_andAlwaysAvailableToOwner() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vault.pause(); // pausing a paused vault still succeeds (INV-12)
        assertTrue(vault.paused());
        assertEq(vault.pauseEpoch(), 2);
        vm.prank(owner);
        vault.unpause();
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    // ---- kernel signer rotation ------------------------------------------------------------------------------

    function test_signerRotation_delay_andEffect() public {
        _registerDefault();
        address next = _actor("kernel-v2");
        uint64 eta = uint64(block.timestamp) + SIGNER_DELAY;
        vm.expectEmit(address(vault));
        emit KernelSignerProposed(next, eta);
        vm.prank(owner);
        vault.proposeKernelSigner(next);
        assertEq(vault.pendingSigner(), next);
        assertEq(vault.pendingSignerEta(), eta);
        assertEq(vault.kernelSigner(), kernel, "not effective before execute");

        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.TooEarly.selector);
        vault.executeKernelSigner();

        vm.warp(eta);
        vm.expectEmit(address(vault));
        emit KernelSignerRotated(kernel, next);
        vm.prank(owner);
        vault.executeKernelSigner();
        assertEq(vault.kernelSigner(), next);
        assertEq(vault.pendingSigner(), address(0));
        assertEq(vault.pendingSignerEta(), 0);

        // the old key no longer releases; the new one does
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        bytes memory oldSig = _sign(kernel, _digest(address(vault), _attHash(a)));
        vm.expectRevert(SymbolonVault.BadKernelSig.selector);
        vault.release(a, oldSig, _noRef(), "");
        _release(a); // _kernelSig reads vault.kernelSigner()
        assertEq(token.balanceOf(payee), 1 * USDC);
    }

    function test_signerRotation_worksWhilePaused() public {
        address next = _actor("kernel-v2");
        vm.startPrank(owner);
        vault.pause();
        vault.proposeKernelSigner(next);
        vm.warp(block.timestamp + SIGNER_DELAY);
        vault.executeKernelSigner();
        vm.stopPrank();
        assertEq(vault.kernelSigner(), next);
        assertTrue(vault.paused());
    }

    function test_signerRotation_accessAndValidation() public {
        vm.prank(attacker);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.proposeKernelSigner(attacker);
        vm.prank(kernel); // the kernel key cannot rotate itself
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.proposeKernelSigner(attacker);
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        vault.proposeKernelSigner(address(0));
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.NoPendingChange.selector);
        vault.executeKernelSigner();
        vm.prank(owner);
        vault.proposeKernelSigner(attacker);
        vm.warp(block.timestamp + SIGNER_DELAY);
        vm.prank(guardian);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.executeKernelSigner();
    }

    function test_signerRotation_reproposalResetsDelay() public {
        address a1 = _actor("k1");
        address a2 = _actor("k2");
        vm.prank(owner);
        vault.proposeKernelSigner(a1);
        vm.warp(block.timestamp + SIGNER_DELAY - 10);
        vm.prank(owner);
        vault.proposeKernelSigner(a2);
        vm.warp(block.timestamp + 10);
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.TooEarly.selector);
        vault.executeKernelSigner();
        vm.warp(block.timestamp + SIGNER_DELAY);
        vm.prank(owner);
        vault.executeKernelSigner();
        assertEq(vault.kernelSigner(), a2);
    }

    // ---- withdraw (INV-12) -----------------------------------------------------------------------------------

    function test_withdraw_whilePaused() public {
        vm.prank(guardian);
        vault.pause();
        uint256 bal = token.balanceOf(address(vault));
        vm.expectEmit(address(vault));
        emit Withdrawn(owner, bal);
        vm.prank(owner);
        vault.withdraw(owner, bal);
        assertEq(token.balanceOf(owner), bal);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_withdraw_accessAndValidation() public {
        address[3] memory who = [guardian, kernel, attacker];
        for (uint256 i = 0; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(SymbolonVault.Unauthorized.selector);
            vault.withdraw(who[i], 1);
        }
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        vault.withdraw(address(0), 1);
        uint256 bal = token.balanceOf(address(vault));
        vm.prank(owner);
        vm.expectRevert(); // ERC20InsufficientBalance from the token
        vault.withdraw(owner, bal + 1);
        vm.prank(owner);
        vault.withdraw(payee, 0); // zero amount is a no-op transfer
    }

    // ---- guardian ---------------------------------------------------------------------------------------------

    function test_setGuardian() public {
        address g2 = _actor("guardian-2");
        vm.prank(attacker);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.setGuardian(attacker);
        vm.prank(guardian); // the guardian cannot replace itself
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.setGuardian(g2);
        vm.prank(owner);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        vault.setGuardian(address(0));
        vm.expectEmit(address(vault));
        emit GuardianChanged(guardian, g2);
        vm.prank(owner);
        vault.setGuardian(g2);
        assertEq(vault.guardian(), g2);
        vm.prank(guardian);
        vm.expectRevert(SymbolonVault.Unauthorized.selector);
        vault.pause();
        vm.prank(g2);
        vault.pause();
        assertTrue(vault.paused());
    }

    // ---- constructor -----------------------------------------------------------------------------------------

    function _deploy(
        address token_,
        address owner_,
        address kernel_,
        address guardian_,
        uint256 perTx,
        uint256 daily
    ) internal returns (SymbolonVault) {
        return new SymbolonVault(IERC20(token_), owner_, kernel_, guardian_, perTx, daily, 0, 0, 0, 0);
    }

    function test_constructor_rejectsZeroAddresses() public {
        address t = address(token);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        _deploy(address(0), owner, kernel, guardian, 1, 1);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        _deploy(t, address(0), kernel, guardian, 1, 1);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        _deploy(t, owner, address(0), guardian, 1, 1);
        vm.expectRevert(SymbolonVault.ZeroAddress.selector);
        _deploy(t, owner, kernel, address(0), 1, 1);
    }

    function test_constructor_rejectsBadCaps() public {
        address t = address(token);
        vm.expectRevert(SymbolonVault.InvalidConfig.selector);
        _deploy(t, owner, kernel, guardian, 0, 1);
        vm.expectRevert(SymbolonVault.InvalidConfig.selector);
        _deploy(t, owner, kernel, guardian, 1, 0);
        vm.expectRevert(SymbolonVault.InvalidConfig.selector);
        _deploy(t, owner, kernel, guardian, uint256(type(uint192).max) + 1, type(uint256).max);
        SymbolonVault ok = _deploy(t, owner, kernel, guardian, type(uint192).max, type(uint256).max);
        assertEq(ok.perTxCap(), type(uint192).max);
    }

    function test_constructor_rejectsTokenWithoutDecimals() public {
        NoDecimalsToken bad = new NoDecimalsToken();
        vm.expectRevert();
        _deploy(address(bad), owner, kernel, guardian, 1, 1);
        vm.expectRevert(); // an address without code has no decimals() either
        _deploy(attacker, owner, kernel, guardian, 1, 1);
    }

    function test_constructor_setsEverything() public view {
        assertEq(address(vault.token()), address(token));
        assertEq(vault.tokenDecimals(), 6);
        assertEq(vault.owner(), owner);
        assertEq(vault.kernelSigner(), kernel);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.perTxCap(), perTxCap);
        assertEq(vault.dailyCap(), dailyCap);
        assertEq(vault.hourlyCap(), hourlyCap);
        assertEq(vault.humanThreshold(), humanThreshold);
        assertEq(vault.payeeChangeDelay(), PAYEE_DELAY);
        assertEq(vault.signerChangeDelay(), SIGNER_DELAY);
        assertFalse(vault.paused());
        assertEq(vault.engagementCount(), 0);
    }
}
