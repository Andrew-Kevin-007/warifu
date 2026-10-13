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

// ---------------------------------------------------------------------------------------------------------------
// Hostile / unusual ERC-1271 wallets (WP-08, Erc1271.t.sol). The vault calls `isValidSignature` through OZ
// SignatureChecker: a STATICCALL with all remaining gas, valid only if it succeeds, returns >= 32 bytes, and the first
// word is exactly the magic value 0x1626ba7e left-aligned with zero padding.
// ---------------------------------------------------------------------------------------------------------------

/// @notice Reverts in `isValidSignature`.
contract RevertingWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert("wallet says no");
    }
}

/// @notice Returns a value one bit away from the magic value.
contract WrongMagicWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7f;
    }
}

/// @notice Returns only the 4 magic bytes (no ABI padding): shorter than one word, so it is not accepted.
contract ShortReturnWallet {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            return(0x00, 0x04)
        }
    }
}

/// @notice Returns the magic value with a non-zero byte in the padding: the vault compares the whole word.
contract DirtyMagicWallet {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000001)
            return(0x00, 0x20)
        }
    }
}

/// @notice Returns the correct magic word followed by extra data: extra return data is ignored (valid).
contract LongReturnWallet {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            mstore(0x20, 0xdeadbeef)
            return(0x00, 0x40)
        }
    }
}

/// @notice Burns every unit of gas it is given (INVALID opcode). The caller keeps 1/64 (EIP-150) and fails cleanly.
contract GasBurnerWallet {
    fallback() external {
        assembly ("memory-safe") {
            invalid()
        }
    }
}

/// @notice Tries to write storage inside `isValidSignature`. Under the vault's STATICCALL the write reverts.
contract StateChangingWallet {
    uint256 public calls;

    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        ++calls;
        return 0x1626ba7e;
    }
}

/// @notice Says yes to every hash and every signature (a misconfigured or malicious contract wallet).
contract AcceptAllWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
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

/// @notice A wallet whose answer can be switched at runtime (ERC-1271 signatures are revocable: SignatureChecker asks
/// "valid now?", not "valid when signed?").
contract ToggleWallet {
    bool public accepting = true;

    function setAccepting(bool value) external {
        accepting = value;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        return accepting ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @notice A wallet that, inside `isValidSignature`, calls back into `target` with `data` and approves only if that
/// call-back SUCCEEDED. A passing signature check would therefore prove that the vault let it change state mid-check.
contract ReenteringWallet {
    address public target;
    bytes public data;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        (bool ok,) = target.call(data);
        return ok ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// @dev Lets the test drive owner calls (pause, withdraw) as this wallet.
    function exec(address target_, bytes calldata data_) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target_.call(data_);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// @notice EIP-7702 delegate WITHOUT ERC-1271 (e.g. a plain batch executor). An EOA that delegates to it has code, so
/// SignatureChecker stops using ecrecover for it and asks `isValidSignature`, which does not exist here.
contract BatchExecutorDelegate {
    function execute(address target, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        require(ok, "call failed");
    }
}

/// @notice EIP-7702 delegate WITH ERC-1271 that accepts the delegating EOA's own ECDSA signatures (`address(this)` is
/// the EOA when running as its delegate).
contract SelfValidatingDelegate {
    uint256 public pings;

    /// @dev A state-changing no-op, used as the call that carries the EIP-7702 authorization in tests.
    function ping() external {
        ++pings;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
