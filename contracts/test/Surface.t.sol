// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {VmSafe} from "forge-std/Vm.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// @notice WP-08: the external surface of SymbolonVault is pinned. `docs/06` A.4 and `docs/16` §2.4 make "no limit
/// setters" a property of the design, because a Loss Bound Certificate is only sound for a vault whose limits cannot
/// move. `immutable` already stops a setter for the immutables from compiling; this test stops anyone adding a NEW
/// storage variable that gates a limit (or any other state-changing entry point) without a deliberate edit here.
/// The function list comes from the compiler artifact's `methodIdentifiers`, i.e. exactly what an ABI consumer sees.
contract SurfaceTest is VaultTestBase {
    string internal art;

    function setUp() public override {
        super.setUp();
        // `forge coverage` builds without the optimizer into a different layout; the artifact is not comparable.
        vm.skip(vm.isContext(VmSafe.ForgeContext.Coverage));
        art = vm.readFile(string.concat(vm.projectRoot(), "/out/SymbolonVault.sol/SymbolonVault.json"));
    }

    function _name(string memory sig) internal pure returns (string memory) {
        bytes memory b = bytes(sig);
        uint256 end = 0;
        while (end < b.length && b[end] != "(") ++end;
        bytes memory out = new bytes(end);
        for (uint256 i = 0; i < end; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }

    function _has(string[] memory names, string memory x) internal pure returns (bool) {
        for (uint256 i = 0; i < names.length; ++i) {
            if (keccak256(bytes(names[i])) == keccak256(bytes(x))) return true;
        }
        return false;
    }

    function _names() internal view returns (string[] memory names) {
        string[] memory sigs = vm.parseJsonKeys(art, ".methodIdentifiers");
        names = new string[](sigs.length);
        for (uint256 i = 0; i < sigs.length; ++i) {
            names[i] = _name(sigs[i]);
        }
    }

    function _stateChanging() internal pure returns (string[11] memory) {
        return [
            "closeEngagement",
            "executeKernelSigner",
            "executePayeeChange",
            "pause",
            "proposeKernelSigner",
            "proposePayeeChange",
            "registerEngagement",
            "release",
            "setGuardian",
            "unpause",
            "withdraw"
        ];
    }

    function _readOnly() internal pure returns (string[37] memory) {
        return [
            "ATTESTATION_TYPEHASH",
            "ENGAGEMENT_TERMS_TYPEHASH",
            "OWNER_APPROVAL_TYPEHASH",
            "PAYEE_CHANGE_TYPEHASH",
            "RING_SIZE",
            "attestationDigest",
            "configHash",
            "dailyCap",
            "domainSeparator",
            "eip712Domain",
            "engagementCount",
            "engagementIdAt",
            "engagementIds",
            "engagementNonce",
            "engagementTermsDigest",
            "engagements",
            "guardian",
            "hourlyCap",
            "humanThreshold",
            "kernelSigner",
            "owner",
            "ownerApprovalDigest",
            "pauseEpoch",
            "paused",
            "payeeChangeDelay",
            "payeeChangeDigest",
            "payeeChangeLive",
            "pendingPayee",
            "pendingPayeeEpoch",
            "pendingSigner",
            "pendingSignerEta",
            "perTxCap",
            "rollingUsage",
            "signerChangeDelay",
            "token",
            "tokenDecimals",
            "used"
        ];
    }

    /// The whole external function set is exactly the 11 documented state-changing functions plus the 37 getters and
    /// digest helpers. A new function (a limit setter, an upgrade hook, a sweep) fails here until it is reviewed.
    function test_externalFunctions_areExactlyTheDocumentedSet() public view {
        string[] memory names = _names();
        string[11] memory sc = _stateChanging();
        string[37] memory ro = _readOnly();
        assertEq(names.length, sc.length + ro.length, "the external surface changed");
        for (uint256 i = 0; i < sc.length; ++i) {
            assertTrue(_has(names, sc[i]), sc[i]);
        }
        for (uint256 i = 0; i < ro.length; ++i) {
            assertTrue(_has(names, ro[i]), ro[i]);
        }
    }

    /// The only function named like a setter is the documented `setGuardian`; nothing is named like a limit mutator.
    function test_noLimitSetter_byName() public view {
        string[] memory names = _names();
        for (uint256 i = 0; i < names.length; ++i) {
            bytes memory b = bytes(names[i]);
            bool setLike = b.length >= 3 && b[0] == "s" && b[1] == "e" && b[2] == "t";
            bool updateLike = b.length >= 6 && b[0] == "u" && b[1] == "p" && b[2] == "d" && b[3] == "a" && b[4] == "t";
            if (setLike) assertEq(names[i], "setGuardian", "unexpected setter");
            assertFalse(updateLike, "unexpected update function");
        }
    }

    /// Native value is refused everywhere: no receive/fallback, and none of the state-changing entry points is
    /// payable (a payable function would need no ABI change to start taking Arc's native 18-decimal USDC).
    function test_nativeValueIsRefused() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok, "receive");
        (ok,) = address(vault).call{value: 1}(hex"deadbeef");
        assertFalse(ok, "fallback");
        bytes4[11] memory sels = [
            SymbolonVault.closeEngagement.selector,
            SymbolonVault.executeKernelSigner.selector,
            SymbolonVault.executePayeeChange.selector,
            SymbolonVault.pause.selector,
            SymbolonVault.proposeKernelSigner.selector,
            SymbolonVault.proposePayeeChange.selector,
            SymbolonVault.registerEngagement.selector,
            SymbolonVault.release.selector,
            SymbolonVault.setGuardian.selector,
            SymbolonVault.unpause.selector,
            SymbolonVault.withdraw.selector
        ];
        for (uint256 i = 0; i < sels.length; ++i) {
            vm.prank(owner);
            (ok,) = address(vault).call{value: 1}(abi.encodePacked(sels[i], new bytes(512)));
            assertFalse(ok, "payable entry point");
        }
        assertEq(address(vault).balance, 0);
    }
}
