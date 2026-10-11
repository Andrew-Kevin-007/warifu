// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// @notice docs/06 A.5 Config.t.sol (v2, RT-19): `configHash()` preimage, which operations change it, exactly
/// which paths emit `ConfigChanged`, `engagementIds` enumeration, `RING_SIZE`.
contract ConfigTest is VaultTestBase {
    bytes32 internal constant CONFIG_CHANGED_SIG = keccak256("ConfigChanged(bytes32)");
    bytes32 internal constant ENGAGEMENT_REGISTERED_SIG =
        keccak256("EngagementRegistered(bytes32,address,address,uint256,uint64,uint64,bytes32)");

    function _documentedPreimageHash(SymbolonVault v) internal view returns (bytes32) {
        // docs/06 A.4 / docs/16 §2.4, field by field, read through the public getters
        return keccak256(
            bytes.concat(
                abi.encode(address(v.token()), v.tokenDecimals(), v.owner(), v.kernelSigner(), v.guardian()),
                abi.encode(v.perTxCap(), v.dailyCap(), v.hourlyCap(), v.humanThreshold()),
                abi.encode(v.payeeChangeDelay(), v.signerChangeDelay(), v.RING_SIZE())
            )
        );
    }

    /// @dev Number of ConfigChanged logs from `vault` in the recorded logs; asserts each carries configHash().
    function _configChangedCount() internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == CONFIG_CHANGED_SIG) {
                assertEq(logs[i].topics[1], vault.configHash(), "ConfigChanged must carry the new configHash");
                ++n;
            }
        }
    }

    function test_ringSize_is64() public view {
        assertEq(vault.RING_SIZE(), 64);
    }

    function test_configHash_equalsDocumentedPreimage() public view {
        assertEq(vault.configHash(), _documentedPreimageHash(vault));
    }

    /// Independent cross-check: the expected values below were computed outside Solidity with viem 2.56.9
    /// (`keccak256(encodeAbiParameters([address,uint8,address,address,address,uint256 x4,uint32,uint32,uint8], ...))`)
    /// for the fixed configuration in this test. A field-order or type change in the vault breaks them.
    function test_configHash_matchesViemVector() public {
        address tok = 0x52908400098527886E0F7030069857D2E4169EE7;
        deployCodeTo("Mocks.sol:MockUSDC", abi.encode(uint8(6)), tok);
        SymbolonVault v = new SymbolonVault(
            IERC20(tok),
            0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed,
            0x8617E340B3D01FA5F11F306F4090FD50E238070D,
            0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb,
            2_000_000_000,
            5_000_000_000,
            0,
            1_000_000_000,
            172_800,
            86_400
        );
        assertEq(v.configHash(), 0xc64cfbc628ae84625dd223121327d2c5434d5dad4d3bc79ab89d4ee68a890be8);

        SymbolonVault h = new SymbolonVault(
            IERC20(tok),
            0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed,
            0x8617E340B3D01FA5F11F306F4090FD50E238070D,
            0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb,
            2_000_000_000,
            5_000_000_000,
            250_000_000,
            1_000_000_000,
            172_800,
            86_400
        );
        assertEq(h.configHash(), 0x7c1bad8a2d7b196738bc3a6aa1a63d78c4762659359da9c0909b79318db93812);

        vm.prank(0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed);
        v.setGuardian(0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359);
        assertEq(v.configHash(), 0x3d0e017e56b279a27fda2d2e435093680e96a1d2a1ce7532153a6f04248a445a);
    }

    function test_constructor_emitsConfigChanged() public {
        vm.recordLogs();
        vault = _deployVault(owner, kernel);
        assertEq(_configChangedCount(), 1);
    }

    function test_setGuardian_changesHash_andEmitsOnce() public {
        bytes32 before = vault.configHash();
        vm.recordLogs();
        vm.prank(owner);
        vault.setGuardian(_actor("guardian-2"));
        assertEq(_configChangedCount(), 1);
        assertTrue(vault.configHash() != before);
        assertEq(vault.configHash(), _documentedPreimageHash(vault));
    }

    function test_executeKernelSigner_changesHash_proposeDoesNot() public {
        bytes32 before = vault.configHash();
        vm.recordLogs();
        vm.prank(owner);
        vault.proposeKernelSigner(_actor("kernel-2")); // pendingSigner* is excluded
        assertEq(_configChangedCount(), 0);
        assertEq(vault.configHash(), before);
        vm.warp(block.timestamp + SIGNER_DELAY);
        vm.recordLogs();
        vm.prank(owner);
        vault.executeKernelSigner();
        assertEq(_configChangedCount(), 1);
        assertTrue(vault.configHash() != before);
        assertEq(vault.configHash(), _documentedPreimageHash(vault));
    }

    function test_operationsThatMustNotChangeConfig() public {
        bytes32 h = vault.configHash();
        vm.recordLogs();

        vm.prank(guardian);
        vault.pause(); // paused is excluded
        vm.prank(owner);
        vault.unpause();
        _registerDefault(); // new engagement
        _register(_terms(keccak256("second"), payee2, 10 * USDC));
        _release(_att(ENG, payee, 10 * USDC)); // release
        token.mint(address(vault), 5 * USDC); // deposit
        vm.prank(owner);
        vault.withdraw(owner, 1 * USDC);
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: ENG, oldPayee: payee, newPayee: payee2, nonce: 2});
        bytes32 d = _digest(address(vault), _pcHash(pc));
        vault.proposePayeeChange(pc, _sign(owner, d), _sign(payee, d), _sign(payee2, d));
        vm.warp(block.timestamp + PAYEE_DELAY);
        vault.executePayeeChange(ENG);
        vm.prank(owner);
        vault.closeEngagement(ENG);
        vm.prank(owner);
        vault.proposeKernelSigner(_actor("kernel-2"));

        assertEq(_configChangedCount(), 0, "none of these may emit ConfigChanged");
        assertEq(vault.configHash(), h, "none of these may change configHash");
    }

    function test_engagementIds_appendOnly_inRegistrationOrder_matchEvents() public {
        bytes32[] memory ids = new bytes32[](5);
        address[] memory payees = new address[](5);
        vm.recordLogs();
        for (uint256 i = 0; i < 5; ++i) {
            ids[i] = keccak256(abi.encode("eng", 5 - i)); // deliberately not sorted
            payees[i] = i % 2 == 0 ? payee : payee2;
            _register(_terms(ids[i], payees[i], (i + 1) * USDC));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != ENGAGEMENT_REGISTERED_SIG) continue;
            assertEq(logs[i].topics[1], ids[seen], "event order == registration order");
            assertEq(vault.engagementIdAt(seen), ids[seen], "engagementIdAt follows the events");
            ++seen;
        }
        assertEq(seen, 5);
        assertEq(vault.engagementCount(), 5);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(vault.engagementIds(i), ids[i]);
            (address p, uint256 cap,,,,, bool active) = vault.engagements(ids[i]);
            assertEq(p, payees[i]);
            assertEq(cap, (i + 1) * USDC);
            assertTrue(active);
        }
        // closing does not remove or reorder
        vm.prank(owner);
        vault.closeEngagement(ids[2]);
        assertEq(vault.engagementCount(), 5);
        assertEq(vault.engagementIdAt(2), ids[2]);
        vm.expectRevert(); // index out of range
        vault.engagementIdAt(5);
    }

    function test_configHash_bindsTokenDecimals() public {
        // tokenDecimals is part of the preimage: same args with an 18-decimal token give a different hash
        MockUSDC t18 = new MockUSDC(18);
        SymbolonVault v18 = new SymbolonVault(
            IERC20(address(t18)), owner, kernel, guardian, perTxCap, dailyCap, hourlyCap, humanThreshold, PAYEE_DELAY, SIGNER_DELAY
        );
        assertEq(v18.configHash(), _documentedPreimageHash(v18));
        assertTrue(v18.configHash() != vault.configHash());
    }
}
