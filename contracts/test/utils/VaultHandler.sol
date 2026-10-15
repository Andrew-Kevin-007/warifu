// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../../src/SymbolonVault.sol";
import {MockUSDC, MockSafe} from "./Mocks.sol";

/// @notice Vault configuration and actor flavour for one invariant campaign.
struct HandlerConfig {
    uint256 perTxCap;
    uint256 dailyCap;
    uint256 hourlyCap; // 0 = disabled
    uint256 humanThreshold;
    uint32 payeeChangeDelay;
    uint32 signerChangeDelay;
    bool wallets; // owner, every kernel-signer candidate and every payee is an ERC-1271 wallet (MockSafe)
}

/// @notice Drives a SymbolonVault with random sequences of EVERY state-changing function (registerEngagement,
/// closeEngagement, release, proposePayeeChange, executePayeeChange, pause, unpause, proposeKernelSigner,
/// executeKernelSigner, setGuardian, withdraw) from honest and hostile callers with honest and flawed signatures.
///
/// The handler is an independent model of docs/06 A.4. Before every call it computes from ghost state whether the
/// call MUST succeed. It then counts a violation in both directions:
///   - soundness: the call succeeded although the model says it must fail (the INV-1..7 counters below);
///   - liveness: the call reverted although the model says it must succeed (`violLiveness`), which also covers
///     INV-12 (the owner can always pause and withdraw).
/// No handler function ever reverts on its own (every vault call sits in try/catch), so an invariant campaign cannot
/// pass vacuously through discarded runs; the `ok*` counters show which paths were reached.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant USDC = 1e6;
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    SymbolonVault public vault;
    MockUSDC public token;
    HandlerConfig public cfg;

    // ---- actors ----------------------------------------------------------------------------------------------
    address public owner;
    address[4] public kernels; // kernel-signer candidates; `kIdx` is the one the vault currently trusts
    address[3] public guardians;
    address[3] public payees;
    address public attacker;
    mapping(address => uint256) internal keyOf; // the EOA key whose signature each address (or its wallet) accepts

    // ---- ghost state -------------------------------------------------------------------------------------------
    bytes32[] public ids;
    mapping(bytes32 => address) public ghostPayee;
    mapping(bytes32 => bool) public ghostActive;
    mapping(bytes32 => uint256) public ghostCap;
    mapping(bytes32 => uint64) public ghostStart;
    mapping(bytes32 => uint64) public ghostEnd;
    mapping(bytes32 => bytes32) public ghostTermsHash;
    mapping(bytes32 => uint256) public ghostReleased;
    mapping(bytes32 => uint256) public ghostNonce;
    mapping(address => bool) public everRegisteredPayee;
    uint256 public sumCaps;

    bytes32[] public attemptedIntents;
    mapping(bytes32 => uint256) public timesReleased;
    bytes32[] public releasedIntents;
    uint256[] internal histT;
    uint256[] internal histAmt;

    uint256 public initialBalance;
    uint256 public totalDeposited;
    uint256 public totalReleased;
    uint256 public totalWithdrawn;

    bool public ghostPaused;
    uint256 public ghostEpoch;
    uint256 public kIdx;
    uint256 public kPending; // candidate index + 1; 0 = none
    uint256 public kEta;
    uint256 public gIdx;

    struct GhostPending {
        address newPayee;
        uint256 proposedAt;
        uint256 epoch;
        bool exists;
    }

    mapping(bytes32 => GhostPending) internal ghostPending;

    // ---- violation counters (every one must stay 0) -----------------------------------------------------------
    uint256 public violUnauthorizedRelease; // INV-1: success without a valid kernel attestation of exactly these fields
    uint256 public violUnregisteredPayee; // INV-2
    uint256 public violEngagementCap; // INV-3
    uint256 public violReplay; // INV-4
    uint256 public violPerTxOrRolling; // INV-5
    uint256 public violApproval; // INV-6
    uint256 public violPayeeChange; // INV-7
    uint256 public violLifecycle; // release while paused / closed / outside the window / past the deadline / unpaid
    uint256 public violAccess; // an owner-only or owner/guardian-only function succeeded for someone else
    uint256 public violRegistration; // an engagement was registered without two valid signatures or with bad terms
    uint256 public violLiveness; // a call the model says must succeed reverted (includes INV-12)

    // ---- reach counters ---------------------------------------------------------------------------------------
    uint256 public okReleases;
    uint256 public okRegistrations;
    uint256 public okPayeeProposals;
    uint256 public okPayeeChanges;
    uint256 public okPauses;
    uint256 public okUnpauses;
    uint256 public okWithdrawals;
    uint256 public okSignerProposals;
    uint256 public okSignerRotations;
    uint256 public okGuardianChanges;
    uint256 public okCloses;
    uint256 public blockedReleases;
    uint256 public maxRingCount;

    uint256 internal counter;

    constructor(HandlerConfig memory c) {
        cfg = c;
        uint256 ownerKey;
        (owner, ownerKey) = _actor("inv-owner");
        keyOf[owner] = ownerKey;
        for (uint256 i = 0; i < kernels.length; ++i) {
            uint256 k;
            (kernels[i], k) = _actor(string.concat("inv-kernel-", vm.toString(i)));
            keyOf[kernels[i]] = k;
        }
        for (uint256 i = 0; i < guardians.length; ++i) {
            guardians[i] = makeAddr(string.concat("inv-guardian-", vm.toString(i)));
        }
        for (uint256 i = 0; i < payees.length; ++i) {
            uint256 k;
            (payees[i], k) = _actor(string.concat("inv-payee-", vm.toString(i)));
            keyOf[payees[i]] = k;
        }
        uint256 attackerKey;
        (attacker, attackerKey) = makeAddrAndKey("inv-attacker"); // always a plain EOA
        keyOf[attacker] = attackerKey;

        token = new MockUSDC(6);
        vault = new SymbolonVault(
            IERC20(address(token)),
            owner,
            kernels[0],
            guardians[0],
            c.perTxCap,
            c.dailyCap,
            c.hourlyCap,
            c.humanThreshold,
            c.payeeChangeDelay,
            c.signerChangeDelay
        );
        initialBalance = 100_000 * USDC;
        token.mint(address(vault), initialBalance);
    }

    function _actor(string memory label) internal returns (address a, uint256 key) {
        (a, key) = makeAddrAndKey(label);
        if (cfg.wallets) a = address(new MockSafe(a));
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The same signature rewritten to its high-s twin (a valid ecrecover input the vault must refuse).
    function _highS(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        require(uint256(s) <= HALF_N, "expected a low-s signature");
        return abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    function _pick(uint256 seed) internal view returns (bytes32) {
        return ids[seed % ids.length];
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        uint256 k = seed % 6;
        if (k == 0) return owner;
        if (k == 1) return guardians[gIdx];
        if (k == 2) return guardians[(gIdx + 1) % guardians.length];
        if (k == 3) return attacker;
        if (k == 4) return payees[0];
        return kernels[kIdx];
    }

    /// @notice The model of step 10: exact rolling windows over the whole release history.
    function modelRolling() public view returns (uint256 daySum, uint256 hourSum, uint256 count) {
        for (uint256 i = 0; i < histT.length; ++i) {
            if (histT[i] + 1 days > block.timestamp) {
                daySum += histAmt[i];
                ++count;
                if (histT[i] + 1 hours > block.timestamp) hourSum += histAmt[i];
            }
        }
    }

    function _rollingOk(uint256 amount) internal view returns (bool) {
        (uint256 d, uint256 h, uint256 c) = modelRolling();
        return d + amount <= cfg.dailyCap && c < vault.RING_SIZE() && (cfg.hourlyCap == 0 || h + amount <= cfg.hourlyCap);
    }

    function pendingOf(bytes32 id) external view returns (address newPayee, uint256 proposedAt, uint256 epoch, bool exists) {
        GhostPending memory g = ghostPending[id];
        return (g.newPayee, g.proposedAt, g.epoch, g.exists);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function releasedIntentsLength() external view returns (uint256) {
        return releasedIntents.length;
    }

    function attemptedIntentsLength() external view returns (uint256) {
        return attemptedIntents.length;
    }

    // ---- time and money -----------------------------------------------------------------------------------------

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 0, 500 * USDC);
        token.mint(address(vault), amount);
        totalDeposited += amount;
    }

    function blocklist(uint256 payeeSeed, bool on) external {
        token.setBlocklisted(payees[payeeSeed % 3], on);
    }

    // ---- engagements --------------------------------------------------------------------------------------------

    function register(uint256 payeeSeed, uint256 capSeed, uint256 startSeed, uint256 lenSeed) external {
        bytes32 id = keccak256(abi.encode("inv-engagement", ++counter));
        address p = payees[payeeSeed % 3];
        uint64 start =
            uint64(block.timestamp + bound(startSeed, 0, 1 days)) - uint64(bound(startSeed >> 128, 0, 1 hours));
        SymbolonVault.EngagementTerms memory t = SymbolonVault.EngagementTerms({
            engagementId: id,
            owner: owner,
            payee: p,
            cap: bound(capSeed, 1, 1_000 * USDC),
            start: start,
            end: start + uint64(bound(lenSeed, 0, 10 days)),
            termsHash: keccak256(abi.encode("terms", id)),
            nonce: 1 + (capSeed % 3)
        });
        bytes32 d = vault.engagementTermsDigest(t);
        bytes memory ownerSig = _sig(keyOf[owner], d);
        bytes memory payeeSig = _sig(keyOf[p], d);
        vm.prank(_pickActor(lenSeed)); // anyone may submit a co-signed registration
        try vault.registerEngagement(t, ownerSig, payeeSig) {
            ++okRegistrations;
            ids.push(id);
            ghostPayee[id] = p;
            ghostActive[id] = true;
            ghostCap[id] = t.cap;
            ghostStart[id] = t.start;
            ghostEnd[id] = t.end;
            ghostTermsHash[id] = t.termsHash;
            ghostNonce[id] = t.nonce;
            everRegisteredPayee[p] = true;
            sumCaps += t.cap;
        } catch {
            ++violLiveness;
        }
    }

    /// @dev Registrations that must all fail: one flaw per `mode`.
    function registerBad(uint256 mode, uint256 seed) external {
        uint256 flaw = mode % 8;
        bytes32 id = keccak256(abi.encode("inv-bad-engagement", ++counter));
        address p = payees[seed % 3];
        if (flaw == 7 && ids.length > 0) id = _pick(seed); // duplicate id (replay / re-registration)
        uint64 start = uint64(block.timestamp);
        SymbolonVault.EngagementTerms memory t = SymbolonVault.EngagementTerms({
            engagementId: id,
            owner: owner,
            payee: p,
            cap: 1 + (seed % (100 * USDC)),
            start: start,
            end: start + 1 days,
            termsHash: keccak256(abi.encode("bad-terms", id)),
            nonce: seed % 5
        });
        uint256 ownerSigner = keyOf[owner];
        uint256 payeeSigner = keyOf[p];
        if (flaw == 0) ownerSigner = keyOf[attacker]; // owner signature forged
        if (flaw == 1) payeeSigner = keyOf[attacker]; // payee signature forged
        if (flaw == 2) t.owner = attacker; // terms name a different owner
        if (flaw == 3) t.payee = address(0);
        if (flaw == 4) t.cap = 0;
        if (flaw == 5) t.end = t.start - 1;
        if (flaw == 6) payeeSigner = keyOf[owner]; // owner signs for the payee as well
        bytes32 d = vault.engagementTermsDigest(t);
        try vault.registerEngagement(t, _sig(ownerSigner, d), _sig(payeeSigner, d)) {
            ++violRegistration;
        } catch {}
    }

    function close(uint256 actorSeed, uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(seed);
        address caller = _pickActor(actorSeed);
        bool expected = caller == owner && ghostActive[id];
        vm.prank(caller);
        try vault.closeEngagement(id) {
            ++okCloses;
            if (!expected) ++violAccess;
            ghostActive[id] = false;
        } catch {
            if (expected) ++violLiveness;
        }
    }

    // ---- release -----------------------------------------------------------------------------------------------

    struct Rc {
        bytes32 id;
        SymbolonVault.Attestation a;
        SymbolonVault.OwnerApprovalRef ref;
        bytes kSig;
        bytes aSig;
        bool signerOk; // signed by the signer the vault trusts now, over exactly the submitted fields
        bool approvalOk; // a valid, unexpired approval for exactly (intentId, amount)
        bool tampered; // a signed field was changed after signing
    }

    struct Exp {
        bool payeeOk;
        bool capOk;
        bool amountOk;
        bool rollingOk;
        bool approvalNeeded;
        bool fresh;
        bool moneyOk;
        bool lifecycleOk;
        bool allButMoney;
        bool expected;
    }

    function release(uint256 engSeed, uint256 amtSeed, uint256 mode, uint256 dt) public {
        if (ids.length == 0) return;
        // time: usually nothing, sometimes a few seconds (edge hunting), sometimes hours
        uint256 kind = dt % 4;
        if (kind == 0) vm.warp(block.timestamp + bound(dt >> 8, 0, 2));
        else if (kind == 1) vm.warp(block.timestamp + bound(dt >> 8, 0, 3 hours));
        Rc memory c;
        c.id = mode % 16 == 0 ? keccak256(abi.encode("unregistered", engSeed)) : _pick(engSeed);
        _buildAttestation(c, engSeed, amtSeed, mode);
        _signKernel(c, mode);
        _buildApproval(c, mode);
        _doRelease(c);
    }

    function _buildAttestation(Rc memory c, uint256 engSeed, uint256 amtSeed, uint256 mode) internal {
        address p = ghostPayee[c.id] == address(0) ? payees[0] : ghostPayee[c.id];
        uint256 pm = (mode >> 4) % 16;
        if (pm == 0) p = attacker;
        else if (pm == 1) p = payees[(engSeed + 1) % 3] == p ? payees[(engSeed + 2) % 3] : payees[(engSeed + 1) % 3];

        bytes32 intent = keccak256(abi.encode("inv-intent", ++counter));
        if ((mode >> 8) % 16 == 0 && releasedIntents.length > 0) {
            intent = releasedIntents[engSeed % releasedIntents.length];
        }

        uint64 deadline;
        {
            uint256 dm = (mode >> 16) & 0xf;
            if (dm == 0) deadline = uint64(block.timestamp) - 1; // expired by one second
            else if (dm == 1) deadline = uint64(block.timestamp); // inclusive edge
            else deadline = uint64(block.timestamp + ((mode >> 20) & 0xff) * 30);
        }

        c.a = SymbolonVault.Attestation({
            intentId: intent,
            engagementId: c.id,
            milestoneId: bytes32(mode),
            payee: p,
            amount: _pickAmount(c.id, amtSeed, mode),
            receiptHash: keccak256(abi.encode("receipt", counter)),
            deadline: deadline
        });
    }

    function _pickAmount(bytes32 id, uint256 amtSeed, uint256 mode) internal view returns (uint256) {
        if ((mode >> 12) % 8 != 0) return bound(amtSeed, 0, cfg.perTxCap + cfg.perTxCap / 10);
        uint256 room = ghostCap[id] > ghostReleased[id] ? ghostCap[id] - ghostReleased[id] : 0;
        uint256 pick = amtSeed % 8;
        if (pick == 0) return 0;
        if (pick == 1) return 1;
        if (pick == 2) return cfg.perTxCap;
        if (pick == 3) return cfg.perTxCap + 1;
        if (pick == 4) return cfg.humanThreshold;
        if (pick == 5) return cfg.humanThreshold + 1;
        if (pick == 6) return room;
        return room + 1;
    }

    /// @dev Kernel signature: usually the signer the vault trusts now, sometimes a stale/pending candidate or a
    /// stranger; then post-signing tampering of any signed field, or the high-s twin of a valid signature.
    function _signKernel(Rc memory c, uint256 mode) internal view {
        uint256 sm = ((mode >> 28) & 0xf) % 10;
        uint256 signerKey;
        if (sm == 0) signerKey = keyOf[kernels[(kIdx + 1 + (((mode >> 32) & 0xf) % 3)) % 4]]; // never the current signer
        else if (sm == 1) signerKey = keyOf[attacker];
        else signerKey = keyOf[kernels[kIdx]];
        c.kSig = _sig(signerKey, vault.attestationDigest(c.a));
        c.signerOk = sm >= 2;

        uint256 tm = ((mode >> 36) & 0xf) % 12;
        if (tm == 0) {
            uint256 f = ((mode >> 40) & 0xf) % 7;
            if (f == 0) c.a.intentId = keccak256(abi.encode(c.a.intentId, "t"));
            else if (f == 1) c.a.engagementId = keccak256(abi.encode(c.a.engagementId, "t"));
            else if (f == 2) c.a.milestoneId = keccak256(abi.encode(c.a.milestoneId, "t"));
            else if (f == 3) c.a.payee = address(uint160(c.a.payee) ^ 1);
            else if (f == 4) c.a.amount = c.a.amount + 1;
            else if (f == 5) c.a.receiptHash = keccak256(abi.encode(c.a.receiptHash, "t"));
            else c.a.deadline = c.a.deadline + 1;
            c.signerOk = false;
            c.tampered = true;
        } else if (tm == 1) {
            c.kSig = _highS(c.kSig);
            c.signerOk = false;
        }
    }

    /// @dev Owner approval (only consulted above the threshold; junk is passed below it to prove it is ignored).
    function _buildApproval(Rc memory c, uint256 mode) internal view {
        if (c.a.amount <= cfg.humanThreshold) {
            if ((mode >> 48) % 4 == 0) {
                c.ref = SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("junk"), deadline: 0});
                c.aSig = hex"deadbeef";
            }
            return;
        }
        uint256 apm = (mode >> 44) % 8;
        c.ref = SymbolonVault.OwnerApprovalRef({
            receiptHash: keccak256(abi.encode("escalation", counter)),
            deadline: uint64(block.timestamp + 1 days)
        });
        bytes32 approvedIntent = c.a.intentId;
        bytes32 approvedReceipt = c.ref.receiptHash;
        uint256 approvedAmount = c.a.amount;
        uint256 signerOfApproval = keyOf[owner];
        c.approvalOk = !c.tampered; // a tampered attestation no longer matches what the owner approved
        if (apm == 2) {
            approvedAmount = c.a.amount - 1; // approval for less
            c.approvalOk = false;
        } else if (apm == 3) {
            signerOfApproval = keyOf[attacker]; // wrong signer
            c.approvalOk = false;
        } else if (apm == 4) {
            c.ref.deadline = uint64(block.timestamp) - 1; // correctly signed but expired
            c.approvalOk = false;
        } else if (apm == 5) {
            approvedIntent = keccak256("another intent"); // approval of another intent
            c.approvalOk = false;
        } else if (apm == 6) {
            approvedReceipt = keccak256("another receipt"); // ref.receiptHash differs from what was signed
            c.approvalOk = false;
        } else if (apm == 7) {
            c.ref.deadline = uint64(block.timestamp); // inclusive edge: still valid
        }
        c.aSig = _sig(
            signerOfApproval, vault.ownerApprovalDigest(approvedIntent, approvedReceipt, approvedAmount, c.ref.deadline)
        );
    }

    function _expectation(Rc memory c) internal view returns (Exp memory x) {
        bytes32 id = c.a.engagementId;
        x.rollingOk = _rollingOk(c.a.amount);
        x.payeeOk = ghostPayee[id] != address(0) && c.a.payee == ghostPayee[id];
        x.capOk = ghostReleased[id] + c.a.amount <= ghostCap[id];
        x.amountOk = c.a.amount != 0 && c.a.amount <= cfg.perTxCap;
        x.approvalNeeded = c.a.amount > cfg.humanThreshold;
        x.fresh = timesReleased[c.a.intentId] == 0;
        x.moneyOk = token.balanceOf(address(vault)) >= c.a.amount && !token.blocklisted(c.a.payee);
        x.lifecycleOk = !ghostPaused && ghostActive[id] && block.timestamp >= ghostStart[id]
            && block.timestamp <= ghostEnd[id] && c.a.deadline >= block.timestamp;
        x.allButMoney = c.signerOk && x.fresh && x.lifecycleOk && x.payeeOk && x.amountOk && x.capOk && x.rollingOk
            && (!x.approvalNeeded || c.approvalOk);
        x.expected = x.allButMoney && x.moneyOk;
    }

    function _doRelease(Rc memory c) internal {
        attemptedIntents.push(c.a.intentId);
        Exp memory x = _expectation(c);
        uint256 balanceBefore = token.balanceOf(address(vault));
        try vault.release(c.a, c.kSig, c.ref, c.aSig) {
            ++okReleases;
            if (!x.expected) _countReleaseViolations(c, x);
            ghostReleased[c.a.engagementId] += c.a.amount;
            ++timesReleased[c.a.intentId];
            releasedIntents.push(c.a.intentId);
            histT.push(block.timestamp);
            histAmt.push(c.a.amount);
            totalReleased += c.a.amount;
            if (token.balanceOf(address(vault)) != balanceBefore - c.a.amount) ++violLifecycle;
            (,, uint256 inWindow) = modelRolling();
            if (inWindow > maxRingCount) maxRingCount = inWindow;
        } catch {
            if (x.expected) ++violLiveness;
            if (token.blocklisted(c.a.payee)) ++blockedReleases;
        }
    }

    function _countReleaseViolations(Rc memory c, Exp memory x) internal {
        if (!c.signerOk) ++violUnauthorizedRelease;
        if (!x.payeeOk) ++violUnregisteredPayee;
        if (!x.capOk) ++violEngagementCap;
        if (!x.fresh) ++violReplay;
        if (!x.amountOk || !x.rollingOk) ++violPerTxOrRolling;
        if (x.approvalNeeded && !c.approvalOk) ++violApproval;
        if (!x.lifecycleOk) ++violLifecycle;
        if (x.allButMoney && !x.moneyOk) ++violLifecycle; // paid a blocklisted address or beyond the balance
    }

    /// @dev Up to 70 one-base-unit releases inside one timestamp to reach the 64-release ring saturation.
    function burst(uint256 engSeed, uint256 n) external {
        if (ids.length == 0) return;
        n = bound(n, 1, 70);
        bytes32 id = _pick(engSeed);
        for (uint256 i = 0; i < n; ++i) {
            Rc memory c;
            c.id = id;
            c.a = SymbolonVault.Attestation({
                intentId: keccak256(abi.encode("inv-burst", ++counter)),
                engagementId: id,
                milestoneId: bytes32(0),
                payee: ghostPayee[id],
                amount: 1,
                receiptHash: bytes32(counter),
                deadline: uint64(block.timestamp + 1 hours)
            });
            c.kSig = _sig(keyOf[kernels[kIdx]], vault.attestationDigest(c.a));
            c.signerOk = true;
            c.approvalOk = true; // amount 1 <= humanThreshold unless the campaign sets threshold 0; see _buildApproval
            if (c.a.amount > cfg.humanThreshold) _buildApproval(c, 0);
            _doRelease(c);
        }
    }

    // ---- payee change --------------------------------------------------------------------------------------------

    function proposePayeeChange(uint256 engSeed, uint256 newSeed, uint256 mode) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(engSeed);
        address oldP = ghostPayee[id];
        address newP = payees[newSeed % 3];
        if (newP == oldP) newP = payees[(newSeed + 1) % 3];
        bool staleNonce = (mode & 0x7) % 5 == 0;
        uint256 nonce = ghostNonce[id] + (staleNonce ? 0 : 1 + ((mode >> 16) & 0xf) % 3);
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: id, oldPayee: oldP, newPayee: newP, nonce: nonce});
        bytes32 d = vault.payeeChangeDigest(pc);
        uint256 bad = ((mode >> 3) & 0xf) % 7; // 0: owner sig forged, 1: old payee forged, 2: new payee forged, else valid
        bytes memory os = _sig(bad == 0 ? keyOf[attacker] : keyOf[owner], d);
        bytes memory olds = _sig(bad == 1 ? keyOf[attacker] : keyOf[oldP], d);
        bytes memory news = _sig(bad == 2 ? keyOf[attacker] : keyOf[newP], d);
        bool expected = bad >= 3 && !staleNonce && !ghostPaused && ghostActive[id];
        try vault.proposePayeeChange(pc, os, olds, news) {
            ++okPayeeProposals;
            if (!expected) ++violPayeeChange;
            ghostNonce[id] = nonce;
            ghostPending[id] = GhostPending({newPayee: newP, proposedAt: block.timestamp, epoch: ghostEpoch, exists: true});
        } catch {
            if (expected) ++violLiveness;
        }
    }

    function executePayeeChange(uint256 callerSeed, uint256 engSeed) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(engSeed);
        GhostPending memory gp = ghostPending[id];
        bool expected = gp.exists && gp.epoch == ghostEpoch
            && block.timestamp >= gp.proposedAt + cfg.payeeChangeDelay && !ghostPaused && ghostActive[id];
        vm.prank(_pickActor(callerSeed)); // anyone may execute
        try vault.executePayeeChange(id) {
            ++okPayeeChanges;
            if (!expected) ++violPayeeChange;
            ghostPayee[id] = gp.newPayee;
            everRegisteredPayee[gp.newPayee] = true;
            delete ghostPending[id];
        } catch {
            if (expected) ++violLiveness;
        }
    }

    // ---- pause / admin -------------------------------------------------------------------------------------------

    function pause(uint256 actorSeed) external {
        address caller = _pickActor(actorSeed);
        bool expected = caller == owner || caller == guardians[gIdx];
        vm.prank(caller);
        try vault.pause() {
            ++okPauses;
            if (!expected) ++violAccess;
            ghostPaused = true;
            ++ghostEpoch;
        } catch {
            if (expected) ++violLiveness; // INV-12: the owner (and the guardian) can always pause
        }
    }

    function unpause(uint256 actorSeed) external {
        address caller = _pickActor(actorSeed);
        bool expected = caller == owner;
        vm.prank(caller);
        try vault.unpause() {
            ++okUnpauses;
            if (!expected) ++violAccess;
            ghostPaused = false;
        } catch {
            if (expected) ++violLiveness;
        }
    }

    function withdraw(uint256 actorSeed, uint256 amount, uint256 toSeed) external {
        address caller = _pickActor(actorSeed);
        address to = toSeed % 3 == 0 ? owner : toSeed % 3 == 1 ? guardians[0] : attacker;
        uint256 bal = token.balanceOf(address(vault));
        amount = bound(amount, 0, bal / 4 + 1);
        if (amount > bal) amount = bal;
        bool expected = caller == owner; // INV-12: owner withdrawals never fail (paused or not)
        vm.prank(caller);
        try vault.withdraw(to, amount) {
            ++okWithdrawals;
            if (!expected) ++violAccess;
            totalWithdrawn += amount;
        } catch {
            if (expected) ++violLiveness;
        }
    }

    function proposeSigner(uint256 actorSeed, uint256 candidate) external {
        address caller = _pickActor(actorSeed);
        uint256 idx = candidate % 4;
        bool expected = caller == owner;
        vm.prank(caller);
        try vault.proposeKernelSigner(kernels[idx]) {
            ++okSignerProposals;
            if (!expected) ++violAccess;
            kPending = idx + 1;
            kEta = block.timestamp + cfg.signerChangeDelay;
        } catch {
            if (expected) ++violLiveness;
        }
    }

    function executeSigner(uint256 actorSeed) external {
        address caller = _pickActor(actorSeed);
        bool expected = caller == owner && kPending != 0 && block.timestamp >= kEta;
        vm.prank(caller);
        try vault.executeKernelSigner() {
            ++okSignerRotations;
            if (!expected) ++violAccess;
            kIdx = kPending - 1;
            kPending = 0;
            kEta = 0;
        } catch {
            if (expected) ++violLiveness;
        }
    }

    function setGuardian(uint256 actorSeed, uint256 seed) external {
        address caller = _pickActor(actorSeed);
        uint256 idx = seed % 3;
        bool expected = caller == owner;
        vm.prank(caller);
        try vault.setGuardian(guardians[idx]) {
            ++okGuardianChanges;
            if (!expected) ++violAccess;
            gIdx = idx;
        } catch {
            if (expected) ++violLiveness;
        }
    }
}
