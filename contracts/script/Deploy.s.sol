// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";

/**
 * @title DeployVault
 * @notice Deploys one SymbolonVault, reads every immutable back, and records the deployment in
 * `deployments/<network>.json` under the `production` or `sandbox` group (docs/06 A.6, docs/15 §3).
 *
 * Usage (from contracts/; the deployer key comes from forge's wallet options, never from env or the repo):
 *   VAULT_PROFILE=sandbox VAULT_TOKEN=<USDC from the Arc contract-addresses page> VAULT_OWNER=... \
 *   VAULT_KERNEL_SIGNER=... VAULT_GUARDIAN=... VAULT_PER_TX_CAP=25000000 VAULT_DAILY_CAP=60000000 \
 *   VAULT_HOURLY_CAP=0 VAULT_HUMAN_THRESHOLD=10000000 VAULT_PAYEE_CHANGE_DELAY=172800 \
 *   VAULT_SIGNER_CHANGE_DELAY=86400 GIT_SHA=$(git rev-parse HEAD) \
 *   arc-forge script script/Deploy.s.sol:DeployVault --rpc-url $ARC_RPC_URL --account <keystore> --broadcast
 *
 * Amounts are token base units (USDC ERC-20 interface: 6 decimals on Arc). Profile limits, in whole tokens:
 * sandbox perTx <= 25 and daily <= 60, testnet/local only; any chain other than Arc testnet (5042002) or a local
 * chain (31337) is treated as mainnet: perTx <= 100 and daily <= 200 until independently reviewed.
 * The forge script cannot know the transaction hash or block of its own broadcast; take them from
 * `broadcast/Deploy.s.sol/<chainId>/run-latest.json` (`txHash`, `blockNumber` are not written here).
 * VERIFY(V-19): run with arc-forge against Arc testnet; stock forge has only been used against its local EVM.
 */
contract DeployVault is Script {
    struct Params {
        address token;
        address owner;
        address kernelSigner;
        address guardian;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 hourlyCap;
        uint256 humanThreshold;
        uint32 payeeChangeDelay;
        uint32 signerChangeDelay;
    }

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002; // docs/06 B.4, VERIFY_LOG V-20
    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    string internal constant ARTIFACT_PATH = "contracts/out/SymbolonVault.sol/SymbolonVault.json";

    error UnknownProfile(string profile);
    error ProfileLimitExceeded(string what);
    error SandboxOnMainnet();
    error ReadBackMismatch(string field);
    error SharedAddressAcrossProfiles(string field);

    function run() external returns (SymbolonVault vault) {
        string memory profile = vm.envString("VAULT_PROFILE");
        Params memory p = paramsFromEnv();
        checkLimits(profile, p, block.chainid);
        string memory path = vm.envOr("DEPLOYMENTS_FILE", defaultPath(block.chainid));
        checkDisjoint(path, profile, p);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        vault = deployVault(p);
        vm.stopBroadcast();

        verifyDeployment(vault, p);
        writeDeployment(path, profile, vault, p, deployer, vm.envString("GIT_SHA"));
    }

    function paramsFromEnv() public view returns (Params memory p) {
        p.token = vm.envAddress("VAULT_TOKEN");
        p.owner = vm.envAddress("VAULT_OWNER");
        p.kernelSigner = vm.envAddress("VAULT_KERNEL_SIGNER");
        p.guardian = vm.envAddress("VAULT_GUARDIAN");
        p.perTxCap = vm.envUint("VAULT_PER_TX_CAP");
        p.dailyCap = vm.envUint("VAULT_DAILY_CAP");
        p.hourlyCap = vm.envUint("VAULT_HOURLY_CAP");
        p.humanThreshold = vm.envUint("VAULT_HUMAN_THRESHOLD");
        p.payeeChangeDelay = uint32(vm.envUint("VAULT_PAYEE_CHANGE_DELAY"));
        p.signerChangeDelay = uint32(vm.envUint("VAULT_SIGNER_CHANGE_DELAY"));
    }

    function networkName(uint256 chainId) public pure returns (string memory) {
        if (chainId == ARC_TESTNET_CHAIN_ID) return "testnet";
        if (chainId == LOCAL_CHAIN_ID) return "local";
        return "mainnet";
    }

    function defaultPath(uint256 chainId) public pure returns (string memory) {
        return string.concat("../deployments/", networkName(chainId), ".json");
    }

    /// @notice Fail closed on profile limits (docs/06 A.6). Unknown chains get mainnet limits.
    function checkLimits(string memory profile, Params memory p, uint256 chainId) public view {
        bool sandbox = _eq(profile, "sandbox");
        if (!sandbox && !_eq(profile, "production")) revert UnknownProfile(profile);
        bool mainnet = chainId != ARC_TESTNET_CHAIN_ID && chainId != LOCAL_CHAIN_ID;
        uint256 unit = 10 ** uint256(IERC20Metadata(p.token).decimals());
        if (sandbox) {
            if (mainnet) revert SandboxOnMainnet();
            if (p.perTxCap > 25 * unit) revert ProfileLimitExceeded("sandbox perTxCap > 25");
            if (p.dailyCap > 60 * unit) revert ProfileLimitExceeded("sandbox dailyCap > 60");
        }
        if (mainnet) {
            if (p.perTxCap > 100 * unit) revert ProfileLimitExceeded("mainnet perTxCap > 100");
            if (p.dailyCap > 200 * unit) revert ProfileLimitExceeded("mainnet dailyCap > 200");
        }
    }

    /// @notice SEC-04: production and sandbox never share a signer, owner, guardian or vault address.
    function checkDisjoint(string memory path, string memory profile, Params memory p) public view {
        if (!vm.exists(path)) return;
        string memory json = vm.readFile(path);
        string memory other = _eq(profile, "sandbox") ? ".production" : ".sandbox";
        if (!vm.keyExistsJson(json, string.concat(other, ".vault"))) return;
        address[3] memory mine = [p.owner, p.kernelSigner, p.guardian];
        string[3] memory fields = ["owner", "kernelSigner", "guardian"];
        for (uint256 i = 0; i < 3; ++i) {
            for (uint256 j = 0; j < 3; ++j) {
                address theirs = vm.parseJsonAddress(json, string.concat(other, ".", fields[j]));
                if (mine[i] == theirs) revert SharedAddressAcrossProfiles(fields[i]);
            }
        }
    }

    function deployVault(Params memory p) public returns (SymbolonVault) {
        return new SymbolonVault(
            IERC20(p.token),
            p.owner,
            p.kernelSigner,
            p.guardian,
            p.perTxCap,
            p.dailyCap,
            p.hourlyCap,
            p.humanThreshold,
            p.payeeChangeDelay,
            p.signerChangeDelay
        );
    }

    /// @notice Read every immutable and initial state back from the chain and compare with the inputs.
    function verifyDeployment(SymbolonVault v, Params memory p) public view {
        if (address(v).code.length == 0) revert ReadBackMismatch("code");
        if (address(v.token()) != p.token) revert ReadBackMismatch("token");
        if (v.tokenDecimals() != IERC20Metadata(p.token).decimals()) revert ReadBackMismatch("tokenDecimals");
        if (v.owner() != p.owner) revert ReadBackMismatch("owner");
        if (v.kernelSigner() != p.kernelSigner) revert ReadBackMismatch("kernelSigner");
        if (v.guardian() != p.guardian) revert ReadBackMismatch("guardian");
        if (v.perTxCap() != p.perTxCap) revert ReadBackMismatch("perTxCap");
        if (v.dailyCap() != p.dailyCap) revert ReadBackMismatch("dailyCap");
        if (v.hourlyCap() != p.hourlyCap) revert ReadBackMismatch("hourlyCap");
        if (v.humanThreshold() != p.humanThreshold) revert ReadBackMismatch("humanThreshold");
        if (v.payeeChangeDelay() != p.payeeChangeDelay) revert ReadBackMismatch("payeeChangeDelay");
        if (v.signerChangeDelay() != p.signerChangeDelay) revert ReadBackMismatch("signerChangeDelay");
        if (v.RING_SIZE() != 64) revert ReadBackMismatch("RING_SIZE");
        if (v.paused()) revert ReadBackMismatch("paused");
        if (v.engagementCount() != 0) revert ReadBackMismatch("engagementCount");
        if (v.configHash() != expectedConfigHash(p)) revert ReadBackMismatch("configHash");
    }

    /// @notice configHash recomputed from the inputs (docs/16 §2.4 preimage), independent of the vault's getter.
    function expectedConfigHash(Params memory p) public view returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(p.token, IERC20Metadata(p.token).decimals(), p.owner, p.kernelSigner, p.guardian),
                abi.encode(p.perTxCap, p.dailyCap, p.hourlyCap, p.humanThreshold),
                abi.encode(p.payeeChangeDelay, p.signerChangeDelay, uint8(64))
            )
        );
    }

    /// @notice Write (or replace) this profile's group in the deployments file; the other group is kept.
    function writeDeployment(
        string memory path,
        string memory profile,
        SymbolonVault v,
        Params memory p,
        address deployer,
        string memory gitSha
    ) public {
        string memory obj = string.concat("deployment-", profile);
        vm.serializeAddress(obj, "vault", address(v));
        vm.serializeAddress(obj, "token", p.token);
        vm.serializeUint(obj, "tokenDecimals", v.tokenDecimals());
        vm.serializeAddress(obj, "owner", p.owner);
        vm.serializeAddress(obj, "kernelSigner", p.kernelSigner);
        vm.serializeAddress(obj, "guardian", p.guardian);
        vm.serializeString(obj, "caps", _caps(profile, p));
        vm.serializeUint(obj, "payeeChangeDelay", p.payeeChangeDelay);
        vm.serializeUint(obj, "signerChangeDelay", p.signerChangeDelay);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeBytes32(obj, "configHash", v.configHash());
        vm.serializeBytes32(obj, "runtimeCodeHash", address(v).codehash);
        vm.serializeString(obj, "artifactPath", ARTIFACT_PATH);
        string memory group = vm.serializeString(obj, "gitSha", gitSha);

        if (!vm.exists(path)) {
            vm.writeFile(
                path,
                string.concat(
                    '{"schema":"symbolon-deployments/1","network":"',
                    networkName(block.chainid),
                    '","chainId":',
                    vm.toString(block.chainid),
                    ',"production":null,"sandbox":null}'
                )
            );
        }
        vm.writeJson(group, path, string.concat(".", profile));
    }

    /// Money as decimal strings of base units (INV-10).
    function _caps(string memory profile, Params memory p) internal returns (string memory) {
        string memory obj = string.concat("caps-", profile);
        vm.serializeString(obj, "perTxCap", vm.toString(p.perTxCap));
        vm.serializeString(obj, "dailyCap", vm.toString(p.dailyCap));
        vm.serializeString(obj, "hourlyCap", vm.toString(p.hourlyCap));
        return vm.serializeString(obj, "humanThreshold", vm.toString(p.humanThreshold));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
