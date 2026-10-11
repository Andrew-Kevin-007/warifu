// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {SymbolonVault} from "../src/SymbolonVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// @notice docs/06 A.5 Build.t.sol (v2, RT-18): the artifact is built without metadata hash or CBOR trailer, it
/// lists `immutableReferences`, and the certificate's code-match algorithm (docs/16 §5.3: zero the immutable
/// ranges in both, then compare) matches a deployed vault to the artifact. Two clean builds being byte-identical
/// is checked outside Solidity by `script/check-reproducible-build.mjs` (a test cannot rebuild).
contract BuildTest is VaultTestBase {
    string internal constant ARTIFACT = "/out/SymbolonVault.sol/SymbolonVault.json";
    string internal art;

    function setUp() public override {
        super.setUp();
        art = vm.readFile(string.concat(vm.projectRoot(), ARTIFACT));
    }

    function test_artifact_reproducibleBuildSettings() public view {
        assertEq(vm.parseJsonString(art, ".metadata.settings.metadata.bytecodeHash"), "none");
        assertFalse(vm.parseJsonBool(art, ".metadata.settings.metadata.appendCBOR"));
        assertEq(vm.parseJsonString(art, ".metadata.settings.evmVersion"), "prague"); // V-21
        assertTrue(vm.parseJsonBool(art, ".metadata.settings.optimizer.enabled"));
        assertEq(vm.parseJsonUint(art, ".metadata.settings.optimizer.runs"), 200);
        string memory ver = vm.parseJsonString(art, ".metadata.compiler.version");
        assertEq(_prefix(ver, 7), "0.8.30+", "solc pin (V-21)");
    }

    function test_artifact_runtimeHasNoCborTrailer() public view {
        bytes memory code = vm.parseJsonBytes(art, ".deployedBytecode.object");
        assertGt(code.length, 2);
        // With CBOR metadata, the last two bytes encode the CBOR length and the trailer starts with 0xa1/0xa2 64
        // ("ipfs"/"bzzr"/"solc" keys). Without it the code ends in ordinary opcodes; check the common trailer
        // shape is absent.
        uint256 cborLen = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        if (cborLen + 2 <= code.length) {
            bytes1 head = code[code.length - 2 - cborLen];
            assertTrue(head != 0xa1 && head != 0xa2 && head != 0xa3, "runtime code ends with a CBOR metadata map");
        }
    }

    function test_artifact_listsImmutableReferences() public view {
        string[] memory ids = vm.parseJsonKeys(art, ".deployedBytecode.immutableReferences");
        // token, tokenDecimals, perTxCap, dailyCap, hourlyCap, humanThreshold, two delays, plus OZ EIP712's
        // cached domain fields: at least 8 distinct immutables
        assertGe(ids.length, 8);
    }

    /// docs/16 §5.3 code match: zero the immutable ranges in both, then compare.
    function _codeMatches(bytes memory onchain, bytes memory artifact) internal view returns (bool) {
        if (onchain.length != artifact.length) return false;
        string[] memory ids = vm.parseJsonKeys(art, ".deployedBytecode.immutableReferences");
        for (uint256 k = 0; k < ids.length; ++k) {
            string memory base = string.concat(".deployedBytecode.immutableReferences.", ids[k]);
            for (uint256 j = 0; vm.keyExistsJson(art, string.concat(base, "[", vm.toString(j), "]")); ++j) {
                string memory r = string.concat(base, "[", vm.toString(j), "]");
                uint256 start = vm.parseJsonUint(art, string.concat(r, ".start"));
                uint256 len = vm.parseJsonUint(art, string.concat(r, ".length"));
                for (uint256 b = start; b < start + len; ++b) {
                    onchain[b] = 0;
                    artifact[b] = 0;
                }
            }
        }
        return keccak256(onchain) == keccak256(artifact);
    }

    function test_codeMatch_deployedVaultEqualsArtifactModuloImmutables() public view {
        bytes memory artifact = vm.parseJsonBytes(art, ".deployedBytecode.object");
        assertEq(artifact, vm.getDeployedCode("SymbolonVault.sol:SymbolonVault"));
        assertTrue(keccak256(address(vault).code) != keccak256(artifact), "immutables are filled in on-chain");
        assertTrue(_codeMatches(address(vault).code, vm.parseJsonBytes(art, ".deployedBytecode.object")));
    }

    function test_codeMatch_anotherDeploymentAlsoMatches() public {
        SymbolonVault v2 = _deployVault(attacker, payee); // different owner/kernel (storage), same immutables here
        MockUSDC t18 = new MockUSDC(18);
        SymbolonVault v3 = new SymbolonVault(IERC20(address(t18)), owner, kernel, guardian, 7, 9, 3, 1, 5, 6);
        assertTrue(_codeMatches(address(v2).code, vm.parseJsonBytes(art, ".deployedBytecode.object")));
        assertTrue(_codeMatches(address(v3).code, vm.parseJsonBytes(art, ".deployedBytecode.object")));
        assertTrue(keccak256(address(v3).code) != keccak256(address(vault).code), "different immutables");
    }

    function test_codeMatch_detectsModifiedCode() public view {
        bytes memory tampered = address(vault).code;
        tampered[0] = tampered[0] ^ 0x01; // first byte is never an immutable slot
        assertFalse(_codeMatches(tampered, vm.parseJsonBytes(art, ".deployedBytecode.object")));
        assertFalse(_codeMatches(address(token).code, vm.parseJsonBytes(art, ".deployedBytecode.object")));
    }

    function _prefix(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n && i < b.length; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }
}
