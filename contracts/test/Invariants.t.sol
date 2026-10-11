// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {MockUSDC} from "./utils/Mocks.sol";

/// @notice Drives the vault with random sequences of every state-changing call except the two config mutations
/// (`setGuardian`, kernel signer rotation; covered in Admin/Config tests), including hostile variants: unregistered
/// engagements, wrong payees, foreign signers, replayed intents, missing or forged approvals, stale nonces and
/// premature payee changes. Ghost state records what *should* be possible; any success that should not have
/// happened increments a violation counter that the invariants require to stay 0.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant USDC = 1e6;

    SymbolonVault public vault;
    MockUSDC public token;

    address public owner;
    uint256 internal ownerKey;
    address public kernel;
    uint256 internal kernelKey;
    address public guardian;
    address internal attacker;
    uint256 internal attackerKey;
    address[3] internal payees;
    mapping(address => uint256) internal keyOf;

    // ghost state
    bytes32[] public ids;
    mapping(bytes32 => address) public ghostPayee;
    mapping(bytes32 => bool) public ghostActive;
    mapping(address => bool) public everRegisteredPayee;
    uint256 public sumCaps;
    bytes32[] public releasedIntents;
    mapping(bytes32 => uint256) public timesReleased;
    uint256[] internal histT;
    uint256[] internal histAmt;
    uint256 public initialBalance;
    uint256 public totalDeposited;
    uint256 public totalReleased;
    uint256 public totalWithdrawn;
    bool public ghostPaused;
    uint256 public ghostEpoch;

    struct GhostPending {
        address newPayee;
        uint256 proposedAt;
        uint256 epoch;
        bool exists;
    }

    mapping(bytes32 => GhostPending) internal ghostPending;

    // violations (must all stay 0)
    uint256 public violUnauthorizedRelease; // INV-1
    uint256 public violUnregisteredPayee; // INV-2
    uint256 public violEngagementCap; // INV-3
    uint256 public violReplay; // INV-4
    uint256 public violPerTxOrRolling; // INV-5
    uint256 public violApproval; // INV-6
    uint256 public violPayeeChange; // INV-7
    uint256 public violReleaseWhilePausedOrOutOfWindow;

    // call counters (to see that the run exercised the paths)
    uint256 public okReleases;
    uint256 public okPayeeChanges;

    uint256 internal counter;

    constructor() {
        (owner, ownerKey) = makeAddrAndKey("inv-owner");
        (kernel, kernelKey) = makeAddrAndKey("inv-kernel");
        guardian = makeAddr("inv-guardian");
        (attacker, attackerKey) = makeAddrAndKey("inv-attacker");
        for (uint256 i = 0; i < 3; ++i) {
            (address p, uint256 k) = makeAddrAndKey(string.concat("inv-payee-", vm.toString(i)));
            payees[i] = p;
            keyOf[p] = k;
        }
        keyOf[owner] = ownerKey;
        keyOf[attacker] = attackerKey;
        token = new MockUSDC(6);
        vault = new SymbolonVault(
            IERC20(address(token)), owner, kernel, guardian, 100 * USDC, 300 * USDC, 150 * USDC, 50 * USDC, 1 days, 1 days
        );
        initialBalance = 5_000 * USDC;
        token.mint(address(vault), initialBalance);
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pick(uint256 seed) internal view returns (bytes32) {
        return ids[seed % ids.length];
    }

    function _rollingOk(uint256 amount) internal view returns (bool) {
        uint256 daySum;
        uint256 hourSum;
        uint256 count;
        for (uint256 i = 0; i < histT.length; ++i) {
            if (histT[i] + 1 days > block.timestamp) {
                daySum += histAmt[i];
                ++count;
                if (histT[i] + 1 hours > block.timestamp) hourSum += histAmt[i];
            }
        }
        return daySum + amount <= vault.dailyCap() && count < 64 && hourSum + amount <= vault.hourlyCap();
    }

    function historyLength() external view returns (uint256) {
        return histT.length;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function releasedIntentsLength() external view returns (uint256) {
        return releasedIntents.length;
    }

    // ---- actions ---------------------------------------------------------------------------------------------

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }

    function register(uint256 payeeSeed, uint256 capSeed, uint256 startSeed, uint256 lenSeed) external {
        bytes32 id = keccak256(abi.encode("inv-engagement", ++counter));
        address p = payees[payeeSeed % 3];
        uint64 start = uint64(block.timestamp + bound(startSeed, 0, 1 days)) - uint64(bound(startSeed >> 128, 0, 1 hours));
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
        vault.registerEngagement(t, _sig(ownerKey, d), _sig(keyOf[p], d));
        ids.push(id);
        ghostPayee[id] = p;
        ghostActive[id] = true;
        everRegisteredPayee[p] = true;
        sumCaps += t.cap;
    }

    function close(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(seed);
        vm.prank(owner);
        try vault.closeEngagement(id) {
            ghostActive[id] = false;
        } catch {}
    }

    function pause(bool byGuardian) external {
        vm.prank(byGuardian ? guardian : owner);
        vault.pause();
        ghostPaused = true;
        ++ghostEpoch;
    }

    function unpause() external {
        vm.prank(owner);
        vault.unpause();
        ghostPaused = false;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 0, 500 * USDC);
        token.mint(address(vault), amount);
        totalDeposited += amount;
    }

    function withdraw(uint256 amount) external {
        amount = bound(amount, 0, token.balanceOf(address(vault)) / 4);
        vm.prank(owner);
        vault.withdraw(owner, amount);
        totalWithdrawn += amount;
    }

    struct ReleaseCase {
        bytes32 id;
        bool authorized;
        bool approvalValid;
        SymbolonVault.Attestation a;
        SymbolonVault.OwnerApprovalRef ref;
        bytes kernelSig;
        bytes approvalSig;
    }

    function release(uint256 engSeed, uint256 amtSeed, uint256 mode, uint256 dt) external {
        if (ids.length == 0) return;
        vm.warp(block.timestamp + bound(dt, 0, 3 hours));
        ReleaseCase memory c;
        c.id = mode % 8 == 0 ? keccak256(abi.encode("unregistered", engSeed)) : _pick(engSeed);
        address p = (mode >> 3) % 8 == 0 ? attacker : (ghostPayee[c.id] == address(0) ? payees[0] : ghostPayee[c.id]);
        bytes32 intent = (mode >> 6) % 8 == 0 && releasedIntents.length > 0
            ? releasedIntents[engSeed % releasedIntents.length]
            : keccak256(abi.encode("inv-intent", ++counter));
        c.a = SymbolonVault.Attestation({
            intentId: intent,
            engagementId: c.id,
            milestoneId: bytes32(mode),
            payee: p,
            amount: bound(amtSeed, 0, 110 * USDC),
            receiptHash: keccak256(abi.encode("receipt", counter)),
            deadline: uint64(block.timestamp + (mode >> 9) % 2 hours)
        });
        c.authorized = (mode >> 20) % 10 != 0;
        c.kernelSig = _sig(c.authorized ? kernelKey : attackerKey, vault.attestationDigest(c.a));
        if (c.a.amount > vault.humanThreshold()) {
            c.ref = SymbolonVault.OwnerApprovalRef({receiptHash: keccak256("esc"), deadline: uint64(block.timestamp + 1 days)});
            uint256 approvalMode = (mode >> 24) % 4;
            uint256 approvedAmount = approvalMode == 1 ? c.a.amount - 1 : c.a.amount; // mode 1: approval for less
            uint256 signerKey = approvalMode == 2 ? kernelKey : ownerKey; // mode 2: wrong signer
            c.approvalSig =
                _sig(signerKey, vault.ownerApprovalDigest(c.a.intentId, c.ref.receiptHash, approvedAmount, c.ref.deadline));
            c.approvalValid = approvalMode == 0 || approvalMode == 3;
        }
        _doRelease(c);
    }

    function _doRelease(ReleaseCase memory c) internal {
        bool rollingOk = _rollingOk(c.a.amount);
        (, uint256 cap, uint256 releasedBefore, uint64 start, uint64 end,,) = vault.engagements(c.id);
        try vault.release(c.a, c.kernelSig, c.ref, c.approvalSig) {
            ++okReleases;
            if (!c.authorized) ++violUnauthorizedRelease;
            if (c.a.payee != ghostPayee[c.id] || !everRegisteredPayee[c.a.payee]) ++violUnregisteredPayee;
            if (releasedBefore + c.a.amount > cap) ++violEngagementCap;
            if (timesReleased[c.a.intentId] != 0) ++violReplay;
            if (c.a.amount == 0 || c.a.amount > vault.perTxCap() || !rollingOk) ++violPerTxOrRolling;
            if (c.a.amount > vault.humanThreshold() && !c.approvalValid) ++violApproval;
            if (ghostPaused || !ghostActive[c.id] || block.timestamp < start || block.timestamp > end) {
                ++violReleaseWhilePausedOrOutOfWindow;
            }
            ++timesReleased[c.a.intentId];
            releasedIntents.push(c.a.intentId);
            histT.push(block.timestamp);
            histAmt.push(c.a.amount);
            totalReleased += c.a.amount;
        } catch {}
    }

    function proposePayeeChange(uint256 engSeed, uint256 newSeed, uint256 mode) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(engSeed);
        address oldP = ghostPayee[id];
        address newP = payees[newSeed % 3];
        if (newP == oldP) newP = payees[(newSeed + 1) % 3];
        uint256 nonce = vault.engagementNonce(id) + (mode % 5 == 0 ? 0 : 1); // 1 in 5: stale nonce
        SymbolonVault.PayeeChange memory pc =
            SymbolonVault.PayeeChange({engagementId: id, oldPayee: oldP, newPayee: newP, nonce: nonce});
        bytes32 d = vault.payeeChangeDigest(pc);
        uint256 bad = (mode >> 3) % 6; // 0: owner sig forged, 1: old payee forged, 2: new payee forged, else valid
        bytes memory os = _sig(bad == 0 ? attackerKey : ownerKey, d);
        bytes memory olds = _sig(bad == 1 ? attackerKey : keyOf[oldP], d);
        bytes memory news = _sig(bad == 2 ? attackerKey : keyOf[newP], d);
        try vault.proposePayeeChange(pc, os, olds, news) {
            if (bad < 3 || mode % 5 == 0) ++violPayeeChange; // forged signature or stale nonce accepted
            ghostPending[id] = GhostPending({newPayee: newP, proposedAt: block.timestamp, epoch: ghostEpoch, exists: true});
        } catch {}
    }

    function executePayeeChange(uint256 engSeed) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(engSeed);
        try vault.executePayeeChange(id) {
            ++okPayeeChanges;
            GhostPending memory gp = ghostPending[id];
            if (
                !gp.exists || gp.epoch != ghostEpoch || block.timestamp < gp.proposedAt + vault.payeeChangeDelay()
                    || ghostPaused || !ghostActive[id]
            ) ++violPayeeChange;
            ghostPayee[id] = gp.newPayee;
            delete ghostPending[id];
        } catch {}
    }
}

/// @notice docs/06 A.5 Invariants.t.sol: handler-based invariants INV-1..7 and INV-12 (docs/02 §4),
/// Σ released ≤ Σ caps, `used` monotonic, balance accounting, append-only engagement list, stable configHash.
contract InvariantsTest is Test {
    VaultHandler internal h;
    SymbolonVault internal vault;
    MockUSDC internal token;
    bytes32 internal configAtStart;

    function setUp() public {
        vm.warp(1_790_000_000);
        h = new VaultHandler();
        vault = h.vault();
        token = h.token();
        configAtStart = vault.configHash();
        // seed two engagements so release paths are reachable from the first call
        h.register(0, 500e6, 0, 5 days);
        h.register(1, 800e6, 0, 5 days);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = VaultHandler.warp.selector;
        selectors[1] = VaultHandler.register.selector;
        selectors[2] = VaultHandler.close.selector;
        selectors[3] = VaultHandler.pause.selector;
        selectors[4] = VaultHandler.unpause.selector;
        selectors[5] = VaultHandler.deposit.selector;
        selectors[6] = VaultHandler.withdraw.selector;
        selectors[7] = VaultHandler.release.selector;
        selectors[8] = VaultHandler.release.selector; // weight releases double
        selectors[9] = VaultHandler.proposePayeeChange.selector;
        selectors[10] = VaultHandler.executePayeeChange.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
        targetContract(address(h));
    }

    function invariant_INV1_onlyKernelSignedReleasesSucceed() public view {
        assertEq(h.violUnauthorizedRelease(), 0);
    }

    function invariant_INV2_onlyRegisteredCurrentPayeeIsPaid() public view {
        assertEq(h.violUnregisteredPayee(), 0);
        uint256 n = h.idsLength();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = h.ids(i);
            (address p,,,,,,) = vault.engagements(id);
            assertEq(p, h.ghostPayee(id), "on-chain payee differs from the dual/tri-signed history");
        }
    }

    function invariant_INV3_releasedNeverExceedsCap() public view {
        assertEq(h.violEngagementCap(), 0);
        uint256 n = h.idsLength();
        uint256 sumReleased;
        for (uint256 i = 0; i < n; ++i) {
            (, uint256 cap, uint256 released,,,,) = vault.engagements(h.ids(i));
            assertLe(released, cap);
            sumReleased += released;
        }
        assertLe(sumReleased, h.sumCaps());
        assertEq(sumReleased, h.totalReleased(), "sum of engagement.released == sum of Released amounts");
    }

    function invariant_INV4_intentsSingleUse_usedMonotonic() public view {
        assertEq(h.violReplay(), 0);
        uint256 n = h.releasedIntentsLength();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 intent = h.releasedIntents(i);
            assertTrue(vault.used(intent), "used[] must never be reset");
            assertEq(h.timesReleased(intent), 1);
        }
    }

    function invariant_INV5_perTxAndRollingCaps() public view {
        assertEq(h.violPerTxOrRolling(), 0);
        (uint256 daySum, uint256 hourSum, uint256 count) = vault.rollingUsage();
        assertLe(daySum, vault.dailyCap());
        assertLe(hourSum, vault.hourlyCap());
        assertLe(count, vault.RING_SIZE());
    }

    function invariant_INV6_aboveThresholdNeedsOwnerApproval() public view {
        assertEq(h.violApproval(), 0);
    }

    function invariant_INV7_payeeChangeNeedsThreeSigsAndDelay() public view {
        assertEq(h.violPayeeChange(), 0);
    }

    function invariant_noReleaseWhilePausedClosedOrOutOfWindow() public view {
        assertEq(h.violReleaseWhilePausedOrOutOfWindow(), 0);
    }

    function invariant_INV12_ownerCanAlwaysPauseAndWithdraw() public {
        uint256 snap = vm.snapshotState();
        address o = h.owner();
        vm.prank(o);
        vault.pause();
        assertTrue(vault.paused());
        uint256 bal = token.balanceOf(address(vault));
        vm.prank(o);
        vault.withdraw(o, bal);
        assertEq(token.balanceOf(address(vault)), 0);
        vm.revertToState(snap);
    }

    function invariant_balanceAccounting() public view {
        assertEq(
            token.balanceOf(address(vault)),
            h.initialBalance() + h.totalDeposited() - h.totalReleased() - h.totalWithdrawn()
        );
    }

    function invariant_engagementListAppendOnly() public view {
        uint256 n = h.idsLength();
        assertEq(vault.engagementCount(), n);
        for (uint256 i = 0; i < n; ++i) {
            assertEq(vault.engagementIdAt(i), h.ids(i));
        }
    }

    function invariant_configHashUnchangedByNonConfigCalls() public view {
        assertEq(vault.configHash(), configAtStart);
    }

    function invariant_ghostPausedMatches() public view {
        assertEq(vault.paused(), h.ghostPaused());
        assertEq(vault.pauseEpoch(), h.ghostEpoch());
    }

    /// Non-vacuity: the handler's honest paths do succeed (a handler that only ever reverts would make every
    /// invariant above pass trivially).
    function test_handler_honestPathsSucceed() public {
        uint256 releasesBefore = h.okReleases();
        for (uint256 i = 0; i < 12; ++i) {
            // engagement 0 or 1, amount <= humanThreshold, authorized kernel, fresh intent, registered payee
            h.release(i % 2, 1e6 + i, 1 | (1 << 3) | (1 << 6) | (uint256(1) << 9) | (uint256(1) << 20), 60);
        }
        assertGt(h.okReleases(), releasesBefore, "no honest release succeeded");
        // payee change: valid nonce and signatures, then wait out the delay
        h.proposePayeeChange(0, 1, 1 | (5 << 3));
        h.warp(1 days);
        uint256 changesBefore = h.okPayeeChanges();
        h.executePayeeChange(0);
        assertEq(h.okPayeeChanges(), changesBefore + 1, "honest payee change did not execute");
        assertEq(h.violPayeeChange(), 0);
    }
}
