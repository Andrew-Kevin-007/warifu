// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title SymbolonVault
 * @notice Per-business, non-custodial USDC vault (docs/06 Part A). Funds leave only when the kernel signer attests,
 * the payee is a registered engagement payee (owner + payee dual signature), the engagement window and cap hold,
 * the per-transaction cap and the exact rolling 24 h (and optional 1 h) caps hold, amounts above `humanThreshold`
 * carry an owner approval, and the `intentId` has never been used. The owner can always pause and withdraw.
 * @dev There are deliberately no setters for `perTxCap`, `dailyCap`, `hourlyCap`, `humanThreshold`, the delays or
 * `token`: a different limit means a different vault and a different Loss Bound Certificate (docs/06 A.4,
 * docs/16 §2.4). They are `immutable`, so adding a setter would not compile.
 * The vault accounts in ERC-20 base units of `token` only (Arc: the ERC-20 USDC interface has 6 decimals; the
 * native 18-decimal balance is never read). Arc specifics: value transfers to `address(0)` revert, and USDC
 * blocklist reverts consume gas without moving funds; a release to a blocklisted payee reverts atomically, so
 * `used[intentId]` stays false and the kernel decodes the failure (docs/06 A.4).
 */
contract SymbolonVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------------------
    // Types (EIP-712 field order is part of the type hash: never reorder; see packages/schemas/src/eip712.ts)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Owner + payee co-signed engagement. `termsHash` = keccak256(JCS(terms without signatures)); its
    /// preimage includes `paymentTerms` and `milestones[].evidenceSpec` (docs/05 §2).
    struct EngagementTerms {
        bytes32 engagementId;
        address owner;
        address payee;
        uint256 cap;
        uint64 start;
        uint64 end;
        bytes32 termsHash;
        uint256 nonce;
    }

    /// @notice Kernel attestation for one release.
    struct Attestation {
        bytes32 intentId;
        bytes32 engagementId;
        bytes32 milestoneId;
        address payee;
        uint256 amount;
        bytes32 receiptHash;
        uint64 deadline;
    }

    /// @notice The fields of the signed `OwnerApproval` the vault cannot derive from the attestation.
    /// `receiptHash` is the escalation receipt the owner reviewed; `intentId` and `amount` come from the
    /// attestation, so an approval cannot move to another intent or grow to a larger amount (docs/06 A.4).
    struct OwnerApprovalRef {
        bytes32 receiptHash;
        uint64 deadline;
    }

    /// @notice Payee change, co-signed by the owner, the old payee and the new payee.
    struct PayeeChange {
        bytes32 engagementId;
        address oldPayee;
        address newPayee;
        uint256 nonce;
    }

    /// @notice On-chain engagement state.
    struct Engagement {
        address payee;
        uint256 cap;
        uint256 released;
        uint64 start;
        uint64 end;
        bytes32 termsHash;
        bool active;
    }

    /// @dev One release in the rolling window ring (exactly one storage slot).
    struct Rel {
        uint64 t;
        uint192 amt;
    }

    /// @notice A proposed payee change and the earliest time it can execute.
    struct PendingPayee {
        address newPayee;
        uint64 eta;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Number of releases the exact rolling 24 h window can hold (= max releases per 24 h).
    uint8 public constant RING_SIZE = 64;

    bytes32 public constant ENGAGEMENT_TERMS_TYPEHASH = keccak256(
        "EngagementTerms(bytes32 engagementId,address owner,address payee,uint256 cap,uint64 start,uint64 end,bytes32 termsHash,uint256 nonce)"
    );
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 intentId,bytes32 engagementId,bytes32 milestoneId,address payee,uint256 amount,bytes32 receiptHash,uint64 deadline)"
    );
    bytes32 public constant OWNER_APPROVAL_TYPEHASH =
        keccak256("OwnerApproval(bytes32 intentId,bytes32 receiptHash,uint256 amount,uint64 deadline)");
    bytes32 public constant PAYEE_CHANGE_TYPEHASH =
        keccak256("PayeeChange(bytes32 engagementId,address oldPayee,address newPayee,uint256 nonce)");

    // ---------------------------------------------------------------------------------------------------------
    // Configuration (everything below except `paused` and `pendingSigner*` is in `configHash()`)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Settlement token (USDC ERC-20 interface on Arc). Never hardcoded; passed at deploy.
    IERC20 public immutable token;
    /// @notice `token.decimals()` read at deploy (V-04); the kernel asserts it.
    uint8 public immutable tokenDecimals;
    /// @notice Maximum amount of a single release, in token base units.
    uint256 public immutable perTxCap;
    /// @notice Maximum sum of releases in any rolling 24 h window (`t > now - 1 days`), in token base units.
    uint256 public immutable dailyCap;
    /// @notice Maximum sum of releases in any rolling 1 h window (`t > now - 1 hours`); 0 disables it.
    uint256 public immutable hourlyCap;
    /// @notice Releases strictly above this amount need an owner approval.
    uint256 public immutable humanThreshold;
    /// @notice Seconds between `proposePayeeChange` and the earliest `executePayeeChange`.
    uint32 public immutable payeeChangeDelay;
    /// @notice Seconds between `proposeKernelSigner` and the earliest `executeKernelSigner`.
    uint32 public immutable signerChangeDelay;

    /// @notice Business owner (EOA or ERC-1271 smart wallet such as a Safe). No setter.
    address public owner;
    /// @notice Key whose EIP-712 `Attestation` signatures authorize releases.
    address public kernelSigner;
    /// @notice May call `pause()` and nothing else.
    address public guardian;
    /// @notice While true, releases and payee changes revert.
    bool public paused;

    // ---------------------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Engagements by id.
    mapping(bytes32 => Engagement) public engagements;
    /// @notice intentId single-use flags (INV-4). Monotonic: never reset.
    mapping(bytes32 => bool) public used;
    /// @notice Highest nonce consumed by a signed message about an engagement (registration, then payee changes).
    /// A `PayeeChange` must carry a strictly larger nonce, so no co-signed message can be replayed.
    mapping(bytes32 => uint256) public engagementNonce;
    /// @notice Every registered engagement id, in registration order. Append-only; ids are unique.
    bytes32[] public engagementIds;

    Rel[64] private ring;
    uint8 private ringHead;

    /// @notice Pending payee changes by engagement id.
    mapping(bytes32 => PendingPayee) public pendingPayee;
    /// @notice `pauseEpoch` at the time each pending payee change was proposed.
    mapping(bytes32 => uint64) public pendingPayeeEpoch;
    /// @notice Incremented by every `pause()`. A pending payee change proposed in an earlier epoch is cancelled.
    uint64 public pauseEpoch;

    /// @notice Proposed next kernel signer and the earliest time it can take effect.
    address public pendingSigner;
    uint64 public pendingSignerEta;

    // ---------------------------------------------------------------------------------------------------------
    // Events (docs/05 §6)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Emitted by the constructor, `setGuardian` and `executeKernelSigner` with the new `configHash()`.
    event ConfigChanged(bytes32 indexed configHash);
    event EngagementRegistered(
        bytes32 indexed engagementId,
        address indexed owner,
        address indexed payee,
        uint256 cap,
        uint64 start,
        uint64 end,
        bytes32 termsHash
    );
    event EngagementClosed(bytes32 indexed engagementId);
    event Released(
        bytes32 indexed intentId, bytes32 indexed engagementId, address indexed payee, uint256 amount, bytes32 receiptHash
    );
    event PayeeChangeProposed(bytes32 indexed engagementId, address indexed oldPayee, address indexed newPayee, uint64 eta);
    event PayeeChangeExecuted(bytes32 indexed engagementId, address indexed oldPayee, address indexed newPayee);
    /// @dev Named `VaultPaused`/`VaultUnpaused` because the revert error is `Paused()` (docs/06 A.4 step 1) and
    /// Solidity does not allow an event and an error with the same name.
    event VaultPaused(address indexed by);
    event VaultUnpaused(address indexed by);
    event KernelSignerProposed(address indexed next, uint64 eta);
    event KernelSignerRotated(address indexed previous, address indexed next);
    event GuardianChanged(address indexed previous, address indexed next);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------------------

    // release, in check order (docs/06 A.4)
    error Paused();
    error Expired();
    error AlreadyUsed();
    error BadKernelSig();
    error NoEngagement();
    error PayeeMismatch();
    error OutOfWindow();
    error PerTxCap();
    error EngagementCap();
    error DailyCap();
    error TooManyReleases();
    error HourlyCap();
    error ApprovalExpired();
    error ApprovalRequired();
    // everything else
    error Unauthorized();
    error ZeroAddress();
    error InvalidConfig();
    error InvalidTerms();
    error OwnerMismatch();
    error EngagementExists();
    error NonceUsed();
    error BadOwnerSig();
    error BadPayeeSig();
    error BadNewPayeeSig();
    error NoPendingChange();
    error PayeeChangeCancelled();
    error TooEarly();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /**
     * @param token_ settlement token (non-zero; must implement `decimals()`)
     * @param owner_ business owner (non-zero)
     * @param kernelSigner_ kernel attestation key (non-zero)
     * @param guardian_ pause-only key (non-zero)
     * @param perTxCap_ per-release cap, base units (> 0, fits uint192)
     * @param dailyCap_ rolling 24 h cap, base units (> 0)
     * @param hourlyCap_ rolling 1 h cap, base units (0 = disabled)
     * @param humanThreshold_ releases above this need an owner approval
     * @param payeeChangeDelay_ payee change timelock, seconds
     * @param signerChangeDelay_ kernel signer rotation timelock, seconds
     */
    constructor(
        IERC20 token_,
        address owner_,
        address kernelSigner_,
        address guardian_,
        uint256 perTxCap_,
        uint256 dailyCap_,
        uint256 hourlyCap_,
        uint256 humanThreshold_,
        uint32 payeeChangeDelay_,
        uint32 signerChangeDelay_
    ) EIP712("SymbolonVault", "1") {
        if (
            address(token_) == address(0) || owner_ == address(0) || kernelSigner_ == address(0)
                || guardian_ == address(0)
        ) revert ZeroAddress();
        // perTxCap bounds every ring entry, so the uint192 ring amounts can never truncate.
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > type(uint192).max) revert InvalidConfig();

        token = token_;
        tokenDecimals = IERC20Metadata(address(token_)).decimals();
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        hourlyCap = hourlyCap_;
        humanThreshold = humanThreshold_;
        payeeChangeDelay = payeeChangeDelay_;
        signerChangeDelay = signerChangeDelay_;
        owner = owner_;
        kernelSigner = kernelSigner_;
        guardian = guardian_;

        emit ConfigChanged(configHash());
    }

    // ---------------------------------------------------------------------------------------------------------
    // Engagements
    // ---------------------------------------------------------------------------------------------------------

    /**
     * @notice Register an engagement co-signed (EIP-712 `EngagementTerms`) by the owner and the payee. Anyone may
     * submit it. Each `engagementId` can be registered once, ever (closing does not free it), so `released`
     * can never be reset and registration signatures cannot be replayed.
     * @param t the signed terms; `t.owner` must be the vault owner
     * @param ownerSig owner signature (ECDSA or ERC-1271)
     * @param payeeSig payee signature (ECDSA or ERC-1271)
     */
    function registerEngagement(EngagementTerms calldata t, bytes calldata ownerSig, bytes calldata payeeSig)
        external
    {
        if (t.owner != owner) revert OwnerMismatch();
        if (t.payee == address(0)) revert ZeroAddress();
        if (t.cap == 0 || t.start > t.end) revert InvalidTerms();
        Engagement storage e = engagements[t.engagementId];
        if (e.payee != address(0)) revert EngagementExists();

        bytes32 digest = engagementTermsDigest(t);
        if (!SignatureChecker.isValidSignatureNowCalldata(owner, digest, ownerSig)) revert BadOwnerSig();
        if (!SignatureChecker.isValidSignatureNowCalldata(t.payee, digest, payeeSig)) revert BadPayeeSig();

        engagementNonce[t.engagementId] = t.nonce;
        e.payee = t.payee;
        e.cap = t.cap;
        e.start = t.start;
        e.end = t.end;
        e.termsHash = t.termsHash;
        e.active = true;
        engagementIds.push(t.engagementId);

        emit EngagementRegistered(t.engagementId, t.owner, t.payee, t.cap, t.start, t.end, t.termsHash);
    }

    /// @notice Close an active engagement. Irreversible: the id can never be registered again.
    function closeEngagement(bytes32 engagementId) external onlyOwner {
        Engagement storage e = engagements[engagementId];
        if (!e.active) revert NoEngagement();
        e.active = false;
        emit EngagementClosed(engagementId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Release (docs/06 A.4, 13 steps, in this exact order)
    // ---------------------------------------------------------------------------------------------------------

    /**
     * @notice Release `a.amount` to the engagement payee.
     * @param a kernel attestation
     * @param kernelSig `kernelSigner` signature over `a` (ECDSA or ERC-1271)
     * @param ref the owner-approval fields the vault cannot derive from `a`; ignored when
     * `a.amount <= humanThreshold` (pass a zero struct)
     * @param ownerApprovalSig owner signature over `OwnerApproval(a.intentId, ref.receiptHash, a.amount,
     * ref.deadline)`; ignored when `a.amount <= humanThreshold` (pass empty bytes)
     */
    function release(
        Attestation calldata a,
        bytes calldata kernelSig,
        OwnerApprovalRef calldata ref,
        bytes calldata ownerApprovalSig
    ) external nonReentrant {
        // 1
        if (paused) revert Paused();
        // 2
        if (a.deadline < block.timestamp) revert Expired();
        // 3 (checks-effects-interactions: the flag is set before any external call)
        if (used[a.intentId]) revert AlreadyUsed();
        used[a.intentId] = true;
        // 4
        if (!SignatureChecker.isValidSignatureNowCalldata(kernelSigner, attestationDigest(a), kernelSig)) {
            revert BadKernelSig();
        }
        // 5
        Engagement storage e = engagements[a.engagementId];
        if (!e.active) revert NoEngagement();
        // 6 (INV-2)
        if (a.payee != e.payee) revert PayeeMismatch();
        // 7
        if (block.timestamp < e.start || block.timestamp > e.end) revert OutOfWindow();
        // 8
        if (a.amount == 0 || a.amount > perTxCap) revert PerTxCap();
        // 9 (INV-3)
        if (e.released + a.amount > e.cap) revert EngagementCap();
        // 10 (INV-5)
        _checkRolling(a.amount);
        // 11 (INV-6)
        if (a.amount > humanThreshold) {
            if (ref.deadline < block.timestamp) revert ApprovalExpired();
            bytes32 approvalDigest = ownerApprovalDigest(a.intentId, ref.receiptHash, a.amount, ref.deadline);
            if (!SignatureChecker.isValidSignatureNowCalldata(owner, approvalDigest, ownerApprovalSig)) {
                revert ApprovalRequired();
            }
        }
        // 12
        e.released += a.amount;
        ring[ringHead] = Rel({t: uint64(block.timestamp), amt: SafeCast.toUint192(a.amount)});
        ringHead = uint8((uint256(ringHead) + 1) % RING_SIZE);
        // 13
        token.safeTransfer(e.payee, a.amount);
        emit Released(a.intentId, a.engagementId, e.payee, a.amount, a.receiptHash);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Payee change (INV-7)
    // ---------------------------------------------------------------------------------------------------------

    /**
     * @notice Propose a payee change co-signed by the owner, the old payee and the new payee. Anyone may submit it.
     * It executes after `payeeChangeDelay`, unless the vault is paused in between (any `pause()` cancels it).
     * A newer proposal for the same engagement replaces an older one.
     */
    function proposePayeeChange(
        PayeeChange calldata pc,
        bytes calldata ownerSig,
        bytes calldata oldSig,
        bytes calldata newSig
    ) external {
        if (paused) revert Paused();
        Engagement storage e = engagements[pc.engagementId];
        if (!e.active) revert NoEngagement();
        if (pc.oldPayee != e.payee) revert PayeeMismatch();
        if (pc.newPayee == address(0)) revert ZeroAddress();
        if (pc.newPayee == pc.oldPayee) revert InvalidTerms();
        if (pc.nonce <= engagementNonce[pc.engagementId]) revert NonceUsed();

        bytes32 digest = payeeChangeDigest(pc);
        if (!SignatureChecker.isValidSignatureNowCalldata(owner, digest, ownerSig)) revert BadOwnerSig();
        if (!SignatureChecker.isValidSignatureNowCalldata(pc.oldPayee, digest, oldSig)) revert BadPayeeSig();
        if (!SignatureChecker.isValidSignatureNowCalldata(pc.newPayee, digest, newSig)) revert BadNewPayeeSig();

        engagementNonce[pc.engagementId] = pc.nonce;
        uint64 eta = uint64(block.timestamp) + payeeChangeDelay;
        pendingPayee[pc.engagementId] = PendingPayee({newPayee: pc.newPayee, eta: eta});
        pendingPayeeEpoch[pc.engagementId] = pauseEpoch;
        emit PayeeChangeProposed(pc.engagementId, pc.oldPayee, pc.newPayee, eta);
    }

    /// @notice Execute a pending payee change once its delay has passed. Anyone may call it.
    function executePayeeChange(bytes32 engagementId) external {
        if (paused) revert Paused();
        PendingPayee memory pp = pendingPayee[engagementId];
        if (pp.newPayee == address(0)) revert NoPendingChange();
        if (pendingPayeeEpoch[engagementId] != pauseEpoch) revert PayeeChangeCancelled();
        if (block.timestamp < pp.eta) revert TooEarly();
        Engagement storage e = engagements[engagementId];
        if (!e.active) revert NoEngagement();

        address previous = e.payee;
        e.payee = pp.newPayee;
        delete pendingPayee[engagementId];
        delete pendingPayeeEpoch[engagementId];
        emit PayeeChangeExecuted(engagementId, previous, pp.newPayee);
    }

    /// @notice True while a payee change for `engagementId` is pending and has not been cancelled by a pause.
    function payeeChangeLive(bytes32 engagementId) external view returns (bool) {
        return pendingPayee[engagementId].newPayee != address(0) && pendingPayeeEpoch[engagementId] == pauseEpoch;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Safety (INV-12: the owner can always pause and withdraw)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Pause releases and payee changes, and cancel every pending payee change. Owner or guardian.
    function pause() external {
        if (msg.sender != owner && msg.sender != guardian) revert Unauthorized();
        paused = true;
        ++pauseEpoch;
        emit VaultPaused(msg.sender);
    }

    /// @notice Resume releases. Owner only (the guardian cannot unpause).
    function unpause() external onlyOwner {
        paused = false;
        emit VaultUnpaused(msg.sender);
    }

    /// @notice Propose a new kernel signer; effective after `signerChangeDelay` via `executeKernelSigner`.
    function proposeKernelSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        uint64 eta = uint64(block.timestamp) + signerChangeDelay;
        pendingSigner = next;
        pendingSignerEta = eta;
        emit KernelSignerProposed(next, eta);
    }

    /// @notice Rotate to the pending kernel signer once its delay has passed. Works while paused.
    function executeKernelSigner() external onlyOwner {
        address next = pendingSigner;
        if (next == address(0)) revert NoPendingChange();
        if (block.timestamp < pendingSignerEta) revert TooEarly();
        address previous = kernelSigner;
        kernelSigner = next;
        delete pendingSigner;
        delete pendingSignerEta;
        emit KernelSignerRotated(previous, next);
        emit ConfigChanged(configHash());
    }

    /// @notice Withdraw `amount` token base units to `to`. Owner only; works while paused (non-custodial).
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Replace the guardian.
    function setGuardian(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddress();
        address previous = guardian;
        guardian = g;
        emit GuardianChanged(previous, g);
        emit ConfigChanged(configHash());
    }

    // ---------------------------------------------------------------------------------------------------------
    // Read-only surface for Loss Bound Certificates (docs/16 §2.4) and off-chain checks
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Number of registered engagements (open and closed).
    function engagementCount() external view returns (uint256) {
        return engagementIds.length;
    }

    /// @notice The `i`-th registered engagement id, in registration order.
    function engagementIdAt(uint256 i) external view returns (bytes32) {
        return engagementIds[i];
    }

    /**
     * @notice keccak256(abi.encode(token, tokenDecimals, owner, kernelSigner, guardian, perTxCap, dailyCap,
     * hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)). Excludes `paused` and
     * `pendingSigner*` (docs/16 §2.4).
     */
    function configHash() public view returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(address(token), tokenDecimals, owner, kernelSigner, guardian, perTxCap),
                abi.encode(dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)
            )
        );
    }

    /// @notice Releases in the current rolling windows: sums for 24 h and 1 h, and the 24 h release count.
    function rollingUsage() public view returns (uint256 daySum, uint256 hourSum, uint256 count) {
        for (uint256 i = 0; i < RING_SIZE; ++i) {
            Rel memory r = ring[i];
            if (r.amt == 0) continue;
            // Timestamps never decrease, so r.t <= block.timestamp. "Inside" means t > now - window.
            uint256 age = block.timestamp - r.t;
            if (age < 1 days) {
                daySum += r.amt;
                ++count;
                if (age < 1 hours) hourSum += r.amt;
            }
        }
    }

    /// @notice EIP-712 domain separator (name "SymbolonVault", version "1", this chain, this vault).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest of `EngagementTerms`.
    function engagementTermsDigest(EngagementTerms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ENGAGEMENT_TERMS_TYPEHASH,
                    t.engagementId,
                    t.owner,
                    t.payee,
                    t.cap,
                    t.start,
                    t.end,
                    t.termsHash,
                    t.nonce
                )
            )
        );
    }

    /// @notice EIP-712 digest of `Attestation`.
    function attestationDigest(Attestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.intentId,
                    a.engagementId,
                    a.milestoneId,
                    a.payee,
                    a.amount,
                    a.receiptHash,
                    a.deadline
                )
            )
        );
    }

    /// @notice EIP-712 digest of `OwnerApproval(intentId, receiptHash, amount, deadline)`.
    function ownerApprovalDigest(bytes32 intentId, bytes32 receiptHash, uint256 amount, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(OWNER_APPROVAL_TYPEHASH, intentId, receiptHash, amount, deadline)));
    }

    /// @notice EIP-712 digest of `PayeeChange`.
    function payeeChangeDigest(PayeeChange calldata pc) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAYEE_CHANGE_TYPEHASH, pc.engagementId, pc.oldPayee, pc.newPayee, pc.nonce))
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    /// @dev Step 10: exact rolling windows over the last RING_SIZE releases.
    function _checkRolling(uint256 amount) private view {
        (uint256 daySum, uint256 hourSum, uint256 count) = rollingUsage();
        if (daySum + amount > dailyCap) revert DailyCap();
        // count < RING_SIZE also guarantees the slot at ringHead (the oldest) is empty or outside the window,
        // so overwriting it never drops a release that is still inside the 24 h window.
        if (count >= RING_SIZE) revert TooManyReleases();
        if (hourlyCap != 0 && hourSum + amount > hourlyCap) revert HourlyCap();
    }
}
