// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../../src/SymbolonVault.sol";
import {MockUSDC} from "./Mocks.sol";

/// @notice Shared fixture. Digests here are computed independently of the vault: type strings are typed out
/// again (not read from the vault's constants) and the domain separator is rebuilt by hand, so a vault-side
/// encoding bug makes signatures fail instead of agreeing with itself. Test keys are derived from labels at
/// runtime (`makeAddrAndKey`); no key literal exists in the repo.
abstract contract VaultTestBase is Test {
    uint256 internal constant USDC = 1e6;
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21, a realistic Arc timestamp
    uint32 internal constant PAYEE_DELAY = 2 days;
    uint32 internal constant SIGNER_DELAY = 1 days;

    bytes32 internal constant DOMAIN_TYPEHASH_T =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TERMS_TYPEHASH_T = keccak256(
        "EngagementTerms(bytes32 engagementId,address owner,address payee,uint256 cap,uint64 start,uint64 end,bytes32 termsHash,uint256 nonce)"
    );
    bytes32 internal constant ATT_TYPEHASH_T = keccak256(
        "Attestation(bytes32 intentId,bytes32 engagementId,bytes32 milestoneId,address payee,uint256 amount,bytes32 receiptHash,uint64 deadline)"
    );
    bytes32 internal constant APPROVAL_TYPEHASH_T =
        keccak256("OwnerApproval(bytes32 intentId,bytes32 receiptHash,uint256 amount,uint64 deadline)");
    bytes32 internal constant PC_TYPEHASH_T =
        keccak256("PayeeChange(bytes32 engagementId,address oldPayee,address newPayee,uint256 nonce)");

    // secp256k1n / 2, for malleability tests
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    MockUSDC internal token;
    SymbolonVault internal vault;

    address internal owner;
    address internal kernel;
    address internal guardian;
    address internal payee;
    address internal payee2;
    address internal attacker;
    mapping(address => uint256) internal keyOf;

    uint256 internal perTxCap = 100 * USDC;
    uint256 internal dailyCap = 200 * USDC;
    uint256 internal hourlyCap = 0;
    uint256 internal humanThreshold = 50 * USDC;

    bytes32 internal constant ENG = keccak256("engagement-1");
    bytes32 internal constant MILESTONE = keccak256("milestone-1");
    uint256 internal intentCounter;

    function setUp() public virtual {
        vm.warp(T0);
        owner = _actor("owner");
        kernel = _actor("kernel");
        guardian = _actor("guardian");
        payee = _actor("payee");
        payee2 = _actor("payee2");
        attacker = _actor("attacker");
        token = new MockUSDC(6);
        vault = _deployVault(owner, kernel);
        token.mint(address(vault), 10_000 * USDC);
    }

    function _actor(string memory label) internal returns (address a) {
        uint256 k;
        (a, k) = makeAddrAndKey(label);
        keyOf[a] = k;
    }

    function _deployVault(address owner_, address kernel_) internal returns (SymbolonVault) {
        return new SymbolonVault(
            IERC20(address(token)),
            owner_,
            kernel_,
            guardian,
            perTxCap,
            dailyCap,
            hourlyCap,
            humanThreshold,
            PAYEE_DELAY,
            SIGNER_DELAY
        );
    }

    // ---- independent EIP-712 -------------------------------------------------------------------------------

    function _domain(address v) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH_T, keccak256("SymbolonVault"), keccak256("1"), block.chainid, v));
    }

    function _digest(address v, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domain(v), structHash));
    }

    function _termsHash(SymbolonVault.EngagementTerms memory t) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(TERMS_TYPEHASH_T, t.engagementId, t.owner, t.payee, t.cap, t.start, t.end, t.termsHash, t.nonce)
        );
    }

    function _attHash(SymbolonVault.Attestation memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATT_TYPEHASH_T, a.intentId, a.engagementId, a.milestoneId, a.payee, a.amount, a.receiptHash, a.deadline
            )
        );
    }

    function _approvalHash(bytes32 intentId, bytes32 receiptHash, uint256 amount, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(APPROVAL_TYPEHASH_T, intentId, receiptHash, amount, deadline));
    }

    function _pcHash(SymbolonVault.PayeeChange memory pc) internal pure returns (bytes32) {
        return keccak256(abi.encode(PC_TYPEHASH_T, pc.engagementId, pc.oldPayee, pc.newPayee, pc.nonce));
    }

    function _sign(address signer, bytes32 digest) internal view returns (bytes memory) {
        uint256 k = keyOf[signer];
        require(k != 0, "no key for signer");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---- engagements -----------------------------------------------------------------------------------------

    function _terms(bytes32 id, address payee_, uint256 cap) internal view returns (SymbolonVault.EngagementTerms memory) {
        return SymbolonVault.EngagementTerms({
            engagementId: id,
            owner: vault.owner(),
            payee: payee_,
            cap: cap,
            start: uint64(block.timestamp),
            end: uint64(block.timestamp + 90 days),
            termsHash: keccak256(abi.encode("terms", id)),
            nonce: 1
        });
    }

    function _registerOn(SymbolonVault v, SymbolonVault.EngagementTerms memory t) internal {
        bytes32 d = _digest(address(v), _termsHash(t));
        v.registerEngagement(t, _sign(t.owner, d), _sign(t.payee, d));
    }

    function _register(SymbolonVault.EngagementTerms memory t) internal {
        _registerOn(vault, t);
    }

    function _registerDefault() internal returns (SymbolonVault.EngagementTerms memory t) {
        t = _terms(ENG, payee, 1_000 * USDC);
        _register(t);
    }

    // ---- attestations ----------------------------------------------------------------------------------------

    function _nextIntent() internal returns (bytes32) {
        return keccak256(abi.encode("intent", ++intentCounter));
    }

    function _att(bytes32 engagementId, address payee_, uint256 amount)
        internal
        returns (SymbolonVault.Attestation memory)
    {
        return SymbolonVault.Attestation({
            intentId: _nextIntent(),
            engagementId: engagementId,
            milestoneId: MILESTONE,
            payee: payee_,
            amount: amount,
            receiptHash: keccak256(abi.encode("receipt", intentCounter)),
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    /// @dev Memory structs are references in Solidity; mutate a copy, never an alias.
    function _copy(SymbolonVault.Attestation memory a) internal pure returns (SymbolonVault.Attestation memory) {
        return SymbolonVault.Attestation(a.intentId, a.engagementId, a.milestoneId, a.payee, a.amount, a.receiptHash, a.deadline);
    }

    function _kernelSig(SymbolonVault.Attestation memory a) internal view returns (bytes memory) {
        return _sign(vault.kernelSigner(), _digest(address(vault), _attHash(a)));
    }

    function _noRef() internal pure returns (SymbolonVault.OwnerApprovalRef memory) {
        return SymbolonVault.OwnerApprovalRef({receiptHash: bytes32(0), deadline: 0});
    }

    /// @dev Release without owner approval (amount must be <= humanThreshold to succeed).
    function _release(SymbolonVault.Attestation memory a) internal {
        vault.release(a, _kernelSig(a), _noRef(), "");
    }

    /// @dev Owner approval over the escalation receipt `escalationReceipt` (EOA owner).
    function _approval(SymbolonVault.Attestation memory a, bytes32 escalationReceipt, uint64 deadline)
        internal
        view
        returns (SymbolonVault.OwnerApprovalRef memory ref, bytes memory sig)
    {
        ref = SymbolonVault.OwnerApprovalRef({receiptHash: escalationReceipt, deadline: deadline});
        sig = _sign(vault.owner(), _digest(address(vault), _approvalHash(a.intentId, escalationReceipt, a.amount, deadline)));
    }

    function _releaseApproved(SymbolonVault.Attestation memory a) internal {
        (SymbolonVault.OwnerApprovalRef memory ref, bytes memory sig) =
            _approval(a, keccak256("escalation"), uint64(block.timestamp + 1 days));
        vault.release(a, _kernelSig(a), ref, sig);
    }

    function _released(bytes32 id) internal view returns (uint256 r) {
        (,, r,,,,) = vault.engagements(id);
    }

    function _payeeOf(bytes32 id) internal view returns (address p) {
        (p,,,,,,) = vault.engagements(id);
    }

    function _active(bytes32 id) internal view returns (bool a) {
        (,,,,,, a) = vault.engagements(id);
    }
}
