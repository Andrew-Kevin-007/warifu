// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {VmSafe} from "forge-std/Vm.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockSafe} from "./utils/Mocks.sol";

/// @notice WP-08 gas snapshot. Each test measures one state-changing call in a named scenario and fails if it exceeds
/// its ceiling, so a change that makes `release` materially more expensive is a deliberate, reviewed decision.
/// `forge snapshot --match-contract GasTest` records the exact numbers in `.gas-snapshot`; the ceilings below are
/// the measured COLD value (every account and slot cold, as in a standalone transaction) plus about 15 % headroom.
/// About 134k of a first release is the cold scan of the 64 ring slots (64 x 2100). Numbers are for stock forge
/// 1.5.1 (solc 0.8.30, optimizer 200 runs, prague); they are indicative for Arc, whose gas schedule has not been
/// verified (V-19).
contract GasTest is VaultTestBase {
    function setUp() public override {
        super.setUp();
        // `forge coverage` runs unoptimized, instrumented code: gas numbers are meaningless there.
        vm.skip(vm.isContext(VmSafe.ForgeContext.Coverage));
    }

    uint256 internal constant CEIL_RELEASE_PLAIN = 350_000;
    uint256 internal constant CEIL_RELEASE_APPROVED = 360_000;
    uint256 internal constant CEIL_RELEASE_FULL_RING = 305_000;
    uint256 internal constant CEIL_RELEASE_CONTRACT_WALLETS = 355_000;
    uint256 internal constant CEIL_REGISTER = 232_000;
    uint256 internal constant CEIL_PAYEE_PROPOSE = 69_000;
    uint256 internal constant CEIL_PAYEE_EXECUTE = 19_500;
    uint256 internal constant CEIL_PAUSE = 40_000;
    uint256 internal constant CEIL_WITHDRAW = 55_000;

    /// @dev Transactions start with every account and slot cold; a forge test is one transaction, so cool them
    /// before each measured call to report what a standalone transaction pays.
    function _cold() internal {
        vm.cool(address(vault));
        vm.cool(address(token));
    }

    function _measureRelease(SymbolonVault.Attestation memory a, SymbolonVault.OwnerApprovalRef memory ref, bytes memory osig)
        internal
        returns (uint256 used)
    {
        bytes memory ksig = _kernelSig(a);
        _cold();
        uint256 g = gasleft();
        vault.release(a, ksig, ref, osig);
        used = g - gasleft();
    }

    function test_gas_release_plain() public {
        _registerDefault();
        SymbolonVault.Attestation memory a = _att(ENG, payee, 10 * USDC);
        uint256 used = _measureRelease(a, _noRef(), "");
        emit log_named_uint("release (no approval, ring empty)", used);
        assertLt(used, CEIL_RELEASE_PLAIN);
    }

    function test_gas_release_withOwnerApproval() public {
        _registerDefault();
        SymbolonVault.Attestation memory a = _att(ENG, payee, 80 * USDC);
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory sig) =
            _approval(a, keccak256("esc"), uint64(block.timestamp + 1 days));
        uint256 used = _measureRelease(a, ref, sig);
        emit log_named_uint("release (owner approval)", used);
        assertLt(used, CEIL_RELEASE_APPROVED);
    }

    /// Worst case for the window scan: 63 releases inside the window, the 64th is the measured one.
    function test_gas_release_fullRing() public {
        _registerDefault();
        token.mint(address(vault), 1_000 * USDC);
        for (uint256 i = 0; i < 63; ++i) {
            _release(_att(ENG, payee, 1 * USDC));
        }
        SymbolonVault.Attestation memory a = _att(ENG, payee, 1 * USDC);
        uint256 used = _measureRelease(a, _noRef(), "");
        emit log_named_uint("release (64th in window)", used);
        assertLt(used, CEIL_RELEASE_FULL_RING);
    }

    function test_gas_release_contractWalletsEverywhere() public {
        MockSafe safeOwner = new MockSafe(owner);
        MockSafe safeKernel = new MockSafe(kernel);
        MockSafe safePayee = new MockSafe(payee);
        keyOf[address(safeOwner)] = keyOf[owner];
        keyOf[address(safeKernel)] = keyOf[kernel];
        keyOf[address(safePayee)] = keyOf[payee];
        SymbolonVault v = _deployVault(address(safeOwner), address(safeKernel));
        token.mint(address(v), 10_000 * USDC);
        SymbolonVault.EngagementTerms memory t = SymbolonVault.EngagementTerms({
            engagementId: ENG,
            owner: address(safeOwner),
            payee: address(safePayee),
            cap: 1_000 * USDC,
            start: uint64(block.timestamp),
            end: uint64(block.timestamp + 90 days),
            termsHash: keccak256("terms"),
            nonce: 1
        });
        bytes32 d = _digest(address(v), _termsHash(t));
        v.registerEngagement(t, _sign(address(safeOwner), d), _sign(address(safePayee), d));
        SymbolonVault.Attestation memory a = SymbolonVault.Attestation({
            intentId: keccak256("intent"),
            engagementId: ENG,
            milestoneId: MILESTONE,
            payee: address(safePayee),
            amount: 80 * USDC,
            receiptHash: keccak256("receipt"),
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes memory ksig = _sign(address(safeKernel), _digest(address(v), _attHash(a)));
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 days)});
        bytes memory osig = _sign(
            address(safeOwner), _digest(address(v), _approvalHash(a.intentId, ref.receiptHash, a.amount, ref.deadline))
        );
        vm.cool(address(v));
        vm.cool(address(token));
        vm.cool(address(safeOwner));
        vm.cool(address(safeKernel));
        vm.cool(address(safePayee));
        uint256 g = gasleft();
        v.release(a, ksig, ref, osig);
        uint256 used = g - gasleft();
        emit log_named_uint("release (ERC-1271 kernel signer + owner approval, payee wallet)", used);
        assertLt(used, CEIL_RELEASE_CONTRACT_WALLETS);
        assertEq(token.balanceOf(address(safePayee)), 80 * USDC);
    }

    function test_gas_registerEngagement() public {
        SymbolonVault.EngagementTerms memory t = _terms(ENG, payee, 1_000 * USDC);
        bytes32 d = _digest(address(vault), _termsHash(t));
        bytes memory os = _sign(owner, d);
        bytes memory ps = _sign(payee, d);
        _cold();
        uint256 g = gasleft();
        vault.registerEngagement(t, os, ps);
        uint256 used = g - gasleft();
        emit log_named_uint("registerEngagement", used);
        assertLt(used, CEIL_REGISTER);
    }

    function test_gas_payeeChange() public {
        _registerDefault();
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: 2});
        bytes32 d = _digest(address(vault), _pcHash(pc));
        bytes memory os = _sign(owner, d);
        bytes memory olds = _sign(payee, d);
        bytes memory news = _sign(payee2, d);
        _cold();
        uint256 g = gasleft();
        vault.proposePayeeChange(pc, os, olds, news);
        uint256 proposeGas = g - gasleft();
        vm.warp(block.timestamp + PAYEE_DELAY);
        _cold();
        g = gasleft();
        vault.executePayeeChange(ENG);
        uint256 executeGas = g - gasleft();
        emit log_named_uint("proposePayeeChange", proposeGas);
        emit log_named_uint("executePayeeChange", executeGas);
        assertLt(proposeGas, CEIL_PAYEE_PROPOSE);
        assertLt(executeGas, CEIL_PAYEE_EXECUTE);
    }

    function test_gas_pause_and_withdraw() public {
        vm.prank(guardian);
        _cold();
        uint256 g = gasleft();
        vault.pause();
        uint256 pauseGas = g - gasleft();
        vm.prank(owner);
        _cold();
        g = gasleft();
        vault.withdraw(owner, 100 * USDC);
        uint256 withdrawGas = g - gasleft();
        emit log_named_uint("pause", pauseGas);
        emit log_named_uint("withdraw", withdrawGas);
        assertLt(pauseGas, CEIL_PAUSE);
        assertLt(withdrawGas, CEIL_WITHDRAW);
    }
}
