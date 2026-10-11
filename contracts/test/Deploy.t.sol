// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {DeployVault} from "../script/Deploy.s.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// @notice The deploy script in-process (no network, no keys): profile limits, read-back verification, the
/// deployments JSON (production/sandbox groups, configHash, runtimeCodeHash), SEC-04 disjoint profiles.
/// Output goes to contracts/cache/deploy-test (git-ignored), never to the real deployments/ folder.
contract DeployTest is Test {
    uint256 internal constant USDC = 1e6;
    string internal constant DIR = "cache/deploy-test";

    DeployVault internal script;
    MockUSDC internal token;

    function setUp() public {
        vm.warp(1_790_000_000);
        script = new DeployVault();
        token = new MockUSDC(6);
        vm.createDir(string.concat(vm.projectRoot(), "/", DIR), true);
    }

    /// One file per test: forge runs tests in parallel.
    function _path(string memory name) internal returns (string memory) {
        string memory p = string.concat(vm.projectRoot(), "/", DIR, "/", name, ".json");
        if (vm.exists(p)) vm.removeFile(p);
        return p;
    }

    function _params(string memory tag, uint256 perTx, uint256 daily) internal returns (DeployVault.Params memory p) {
        p.token = address(token);
        p.owner = makeAddr(string.concat(tag, "-owner"));
        p.kernelSigner = makeAddr(string.concat(tag, "-kernel"));
        p.guardian = makeAddr(string.concat(tag, "-guardian"));
        p.perTxCap = perTx;
        p.dailyCap = daily;
        p.hourlyCap = 0;
        p.humanThreshold = 10 * USDC;
        p.payeeChangeDelay = 2 days;
        p.signerChangeDelay = 1 days;
    }

    function test_deployVerifyWrite_productionAndSandboxGroups() public {
        string memory path = _path("groups");
        DeployVault.Params memory prod = _params("prod", 100 * USDC, 200 * USDC);
        script.checkLimits("production", prod, block.chainid);
        SymbolonVault pv = script.deployVault(prod);
        script.verifyDeployment(pv, prod);
        script.writeDeployment(path, "production", pv, prod, address(this), "abc1234");

        DeployVault.Params memory sb = _params("sandbox", 25 * USDC, 60 * USDC);
        script.checkLimits("sandbox", sb, block.chainid);
        script.checkDisjoint(path, "sandbox", sb);
        SymbolonVault sv = script.deployVault(sb);
        script.verifyDeployment(sv, sb);
        script.writeDeployment(path, "sandbox", sv, sb, address(this), "abc1234");

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".schema"), "symbolon-deployments/1");
        assertEq(vm.parseJsonString(json, ".network"), "local");
        assertEq(vm.parseJsonUint(json, ".chainId"), 31337);
        // production group kept after the sandbox write
        assertEq(vm.parseJsonAddress(json, ".production.vault"), address(pv));
        assertEq(vm.parseJsonBytes32(json, ".production.configHash"), pv.configHash());
        assertEq(vm.parseJsonBytes32(json, ".production.runtimeCodeHash"), address(pv).codehash);
        assertEq(vm.parseJsonString(json, ".production.caps.perTxCap"), "100000000");
        assertEq(vm.parseJsonString(json, ".production.caps.dailyCap"), "200000000");
        assertEq(vm.parseJsonAddress(json, ".production.kernelSigner"), prod.kernelSigner);
        assertEq(vm.parseJsonString(json, ".production.gitSha"), "abc1234");
        assertEq(vm.parseJsonString(json, ".production.artifactPath"), "contracts/out/SymbolonVault.sol/SymbolonVault.json");
        assertEq(vm.parseJsonUint(json, ".production.tokenDecimals"), 6);
        assertEq(vm.parseJsonAddress(json, ".sandbox.vault"), address(sv));
        assertEq(vm.parseJsonBytes32(json, ".sandbox.configHash"), sv.configHash());
        assertEq(vm.parseJsonString(json, ".sandbox.caps.dailyCap"), "60000000");
        assertTrue(address(pv).codehash != address(sv).codehash, "immutables differ, so runtime code hashes differ");
        vm.removeFile(path);
    }

    function test_verifyDeployment_detectsEveryMismatch() public {
        DeployVault.Params memory p = _params("v", 10 * USDC, 20 * USDC);
        SymbolonVault v = script.deployVault(p);
        script.verifyDeployment(v, p);
        DeployVault.Params memory q = _params("v", 10 * USDC, 20 * USDC);
        q.dailyCap = 21 * USDC;
        vm.expectRevert(abi.encodeWithSelector(DeployVault.ReadBackMismatch.selector, "dailyCap"));
        script.verifyDeployment(v, q);
        q = _params("v", 10 * USDC, 20 * USDC);
        q.guardian = makeAddr("someone-else");
        vm.expectRevert(abi.encodeWithSelector(DeployVault.ReadBackMismatch.selector, "guardian"));
        script.verifyDeployment(v, q);
    }

    function test_sandboxLimits() public {
        vm.expectRevert(abi.encodeWithSelector(DeployVault.ProfileLimitExceeded.selector, "sandbox perTxCap > 25"));
        script.checkLimits("sandbox", _params("s", 25 * USDC + 1, 60 * USDC), block.chainid);
        vm.expectRevert(abi.encodeWithSelector(DeployVault.ProfileLimitExceeded.selector, "sandbox dailyCap > 60"));
        script.checkLimits("sandbox", _params("s", 25 * USDC, 60 * USDC + 1), block.chainid);
        script.checkLimits("sandbox", _params("s", 25 * USDC, 60 * USDC), 5042002);
    }

    function test_mainnetLimits_unknownChainIsMainnet() public {
        uint256 unknownChain = 1; // any chain other than Arc testnet / local
        vm.expectRevert(abi.encodeWithSelector(DeployVault.ProfileLimitExceeded.selector, "mainnet perTxCap > 100"));
        script.checkLimits("production", _params("m", 100 * USDC + 1, 200 * USDC), unknownChain);
        vm.expectRevert(abi.encodeWithSelector(DeployVault.ProfileLimitExceeded.selector, "mainnet dailyCap > 200"));
        script.checkLimits("production", _params("m", 100 * USDC, 200 * USDC + 1), unknownChain);
        script.checkLimits("production", _params("m", 100 * USDC, 200 * USDC), unknownChain);
        vm.expectRevert(DeployVault.SandboxOnMainnet.selector);
        script.checkLimits("sandbox", _params("m", 1, 1), unknownChain);
        // testnet production vaults are not capped by the script
        script.checkLimits("production", _params("t", 1_000 * USDC, 5_000 * USDC), 5042002);
        vm.expectRevert(abi.encodeWithSelector(DeployVault.UnknownProfile.selector, "prod"));
        script.checkLimits("prod", _params("t", 1, 1), 5042002);
    }

    function test_profilesMustNotShareAddresses() public {
        string memory path = _path("disjoint");
        DeployVault.Params memory prod = _params("prod", 100 * USDC, 200 * USDC);
        SymbolonVault pv = script.deployVault(prod);
        script.writeDeployment(path, "production", pv, prod, address(this), "abc1234");
        DeployVault.Params memory sb = _params("sandbox", 25 * USDC, 60 * USDC);
        sb.kernelSigner = prod.kernelSigner; // reusing the production kernel key in the sandbox
        vm.expectRevert(abi.encodeWithSelector(DeployVault.SharedAddressAcrossProfiles.selector, "kernelSigner"));
        script.checkDisjoint(path, "sandbox", sb);
        sb = _params("sandbox", 25 * USDC, 60 * USDC);
        sb.guardian = prod.owner; // cross-field reuse is refused too
        vm.expectRevert(abi.encodeWithSelector(DeployVault.SharedAddressAcrossProfiles.selector, "guardian"));
        script.checkDisjoint(path, "sandbox", sb);
        script.checkDisjoint(path, "sandbox", _params("sandbox", 25 * USDC, 60 * USDC));
        vm.removeFile(path);
    }

    function test_run_endToEnd_fromEnv() public {
        string memory path = _path("run");
        DeployVault.Params memory p = _params("env", 20 * USDC, 50 * USDC);
        vm.setEnv("VAULT_PROFILE", "sandbox");
        vm.setEnv("VAULT_TOKEN", vm.toString(p.token));
        vm.setEnv("VAULT_OWNER", vm.toString(p.owner));
        vm.setEnv("VAULT_KERNEL_SIGNER", vm.toString(p.kernelSigner));
        vm.setEnv("VAULT_GUARDIAN", vm.toString(p.guardian));
        vm.setEnv("VAULT_PER_TX_CAP", vm.toString(p.perTxCap));
        vm.setEnv("VAULT_DAILY_CAP", vm.toString(p.dailyCap));
        vm.setEnv("VAULT_HOURLY_CAP", "0");
        vm.setEnv("VAULT_HUMAN_THRESHOLD", vm.toString(p.humanThreshold));
        vm.setEnv("VAULT_PAYEE_CHANGE_DELAY", vm.toString(uint256(p.payeeChangeDelay)));
        vm.setEnv("VAULT_SIGNER_CHANGE_DELAY", vm.toString(uint256(p.signerChangeDelay)));
        vm.setEnv("GIT_SHA", "def5678");
        vm.setEnv("DEPLOYMENTS_FILE", path);
        SymbolonVault v = script.run();
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".sandbox.vault"), address(v));
        assertEq(vm.parseJsonBytes32(json, ".sandbox.configHash"), script.expectedConfigHash(p));
        assertEq(vm.parseJsonString(json, ".sandbox.gitSha"), "def5678");
        assertTrue(vm.parseJsonAddress(json, ".sandbox.deployer") != address(0));
        vm.removeFile(path);
    }
}
