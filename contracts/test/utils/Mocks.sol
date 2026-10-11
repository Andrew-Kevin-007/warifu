// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice ERC-20 stand-in for Arc's USDC ERC-20 interface: configurable decimals and a runtime blocklist.
/// Arc behaviour mirrored: a transfer to or from a blocklisted address reverts (docs.arc.network evm-differences,
/// "The blocklist is enforced at runtime"); a transfer to address(0) reverts (OZ ERC20 already refuses it).
contract MockUSDC is ERC20 {
    uint8 private immutable _decimals;
    mapping(address => bool) public blocklisted;

    error Blocklisted(address account);

    constructor(uint8 decimals_) ERC20("Mock USDC", "mUSDC") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocklisted(address account, bool value) external {
        blocklisted[account] = value;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (blocklisted[from]) revert Blocklisted(from);
        if (blocklisted[to]) revert Blocklisted(to);
        super._update(from, to, value);
    }
}

/// @notice A token without `decimals()`: the vault constructor must refuse it.
contract NoDecimalsToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// @notice ERC-1271 smart wallet stand-in (a Safe with one EOA signer, plus Safe-style pre-approved hashes).
/// It can call the vault (owner actions) through `exec`.
contract MockSafe is IERC1271 {
    bytes4 internal constant MAGIC = IERC1271.isValidSignature.selector;
    address public immutable signer;
    mapping(bytes32 => bool) public approvedHashes;

    constructor(address signer_) {
        signer = signer_;
    }

    function approveHash(bytes32 hash) external {
        approvedHashes[hash] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (approvedHashes[hash]) return MAGIC;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer && signer != address(0)) return MAGIC;
        return 0xffffffff;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
