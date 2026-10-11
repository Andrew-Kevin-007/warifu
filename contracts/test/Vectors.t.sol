// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbolonVault} from "../src/SymbolonVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockUSDC, MockSafe} from "./utils/Mocks.sol";

/// @notice Cross-language EIP-712 check (docs/13 §4.2, WP-01 acceptance item "second implementation"): the vault's
/// type hashes, domain separator and digests must equal `packages/schemas/vectors/eip712.json`, which
/// the schemas package (viem) produced and an independent ethers script re-derived. The file is read at test time,
/// so regenerating the vectors re-runs this check. Vectors use chain id 31337 (QUESTIONS WP-01 item 12).
contract VectorsTest is VaultTestBase {
    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(string.concat(vm.projectRoot(), "/../packages/schemas/vectors/eip712.json"));
    }

    function _p(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "].", field);
    }

    function _str(uint256 i, string memory field) internal view returns (string memory) {
        return vm.parseJsonString(json, _p(i, field));
    }

    function _b32(uint256 i, string memory field) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, _p(i, field));
    }

    function _addr(uint256 i, string memory field) internal view returns (address) {
        return vm.parseJsonAddress(json, _p(i, field));
    }

    /// uintN values are decimal strings in the typed-data JSON
    function _uintStr(uint256 i, string memory field) internal view returns (uint256) {
        return vm.parseUint(_str(i, field));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _vaultAt(address where, uint256 chainId_, address owner_, address kernel_) internal returns (SymbolonVault) {
        vm.chainId(chainId_);
        deployCodeTo(
            "SymbolonVault.sol:SymbolonVault",
            abi.encode(
                IERC20(address(token)),
                owner_,
                kernel_,
                guardian,
                uint256(2_000_000_000),
                uint256(5_000_000_000),
                uint256(0),
                uint256(1_000_000_000),
                uint32(PAYEE_DELAY),
                uint32(SIGNER_DELAY)
            ),
            where
        );
        return SymbolonVault(where);
    }

    function _terms(uint256 i) internal view returns (SymbolonVault.EngagementTerms memory t) {
        t.engagementId = _b32(i, "typedData.message.engagementId");
        t.owner = _addr(i, "typedData.message.owner");
        t.payee = _addr(i, "typedData.message.payee");
        t.cap = _uintStr(i, "typedData.message.cap");
        t.start = uint64(_uintStr(i, "typedData.message.start"));
        t.end = uint64(_uintStr(i, "typedData.message.end"));
        t.termsHash = _b32(i, "typedData.message.termsHash");
        t.nonce = _uintStr(i, "typedData.message.nonce");
    }

    function _attestation(uint256 i) internal view returns (SymbolonVault.Attestation memory a) {
        a.intentId = _b32(i, "typedData.message.intentId");
        a.engagementId = _b32(i, "typedData.message.engagementId");
        a.milestoneId = _b32(i, "typedData.message.milestoneId");
        a.payee = _addr(i, "typedData.message.payee");
        a.amount = _uintStr(i, "typedData.message.amount");
        a.receiptHash = _b32(i, "typedData.message.receiptHash");
        a.deadline = uint64(_uintStr(i, "typedData.message.deadline"));
    }

    function _payeeChange(uint256 i) internal view returns (SymbolonVault.PayeeChange memory pc) {
        pc.engagementId = _b32(i, "typedData.message.engagementId");
        pc.oldPayee = _addr(i, "typedData.message.oldPayee");
        pc.newPayee = _addr(i, "typedData.message.newPayee");
        pc.nonce = _uintStr(i, "typedData.message.nonce");
    }

    function _approvalFields(uint256 i)
        internal
        view
        returns (bytes32 intentId, bytes32 receiptHash, uint256 amount, uint64 deadline)
    {
        intentId = _b32(i, "typedData.message.intentId");
        receiptHash = _b32(i, "typedData.message.receiptHash");
        amount = _uintStr(i, "typedData.message.amount");
        deadline = uint64(_uintStr(i, "typedData.message.deadline"));
    }

    function _caseCount() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".cases[", vm.toString(n), "]"))) ++n;
    }

    function _caseIndex(string memory name) internal view returns (uint256) {
        uint256 n = _caseCount();
        for (uint256 i = 0; i < n; ++i) {
            if (_eq(_str(i, "name"), name)) return i;
        }
        revert(string.concat("vector case not found: ", name));
    }

    // ---- every on-chain case: type hash, domain separator, struct hash, digest -------------------------------

    function test_vectors_allOnChainCases_matchVault() public {
        uint256 n = _caseCount();
        assertGt(n, 0);
        uint256 checked;
        for (uint256 i = 0; i < n; ++i) {
            if (_checkCase(i, _str(i, "name"))) ++checked;
        }
        // 4 base structs + EngagementTerms/max-uint-bounds + 2 OwnerApproval domain-separation cases (WP-01)
        assertEq(checked, 7, "unexpected number of on-chain vector cases");
    }

    function _checkCase(uint256 i, string memory name) internal returns (bool) {
        string memory pt = _str(i, "primaryType");
        bool onChain = _eq(pt, "EngagementTerms") || _eq(pt, "Attestation") || _eq(pt, "OwnerApproval")
            || _eq(pt, "PayeeChange");
        if (!onChain) return false; // MilestoneAck, ReceiptAck, Receipt are off-chain structs (docs/05 §2)

        SymbolonVault v = _vaultAt(
            _addr(i, "typedData.domain.verifyingContract"),
            vm.parseJsonUint(json, _p(i, "typedData.domain.chainId")),
            owner,
            kernel
        );
        assertEq(v.domainSeparator(), _b32(i, "domainSeparator"), string.concat(name, ": domainSeparator"));
        assertEq(_domain(address(v)), _b32(i, "domainSeparator"), string.concat(name, ": test-side domain"));
        (bytes32 typeHash, bytes32 structHash, bytes32 digest) = _hashesFor(v, i, pt);
        assertEq(typeHash, _b32(i, "typeHash"), string.concat(name, ": typeHash"));
        assertEq(keccak256(bytes(_str(i, "encodeType"))), typeHash, string.concat(name, ": encodeType"));
        assertEq(structHash, _b32(i, "structHash"), string.concat(name, ": structHash"));
        assertEq(digest, _b32(i, "digest"), string.concat(name, ": digest"));
        return true;
    }

    function _hashesFor(SymbolonVault v, uint256 i, string memory pt)
        internal
        view
        returns (bytes32 typeHash, bytes32 structHash, bytes32 digest)
    {
        if (_eq(pt, "EngagementTerms")) {
            SymbolonVault.EngagementTerms memory t = _terms(i);
            return (v.ENGAGEMENT_TERMS_TYPEHASH(), _termsHash(t), v.engagementTermsDigest(t));
        }
        if (_eq(pt, "Attestation")) {
            SymbolonVault.Attestation memory a = _attestation(i);
            return (v.ATTESTATION_TYPEHASH(), _attHash(a), v.attestationDigest(a));
        }
        if (_eq(pt, "OwnerApproval")) {
            (bytes32 intentId, bytes32 receiptHash, uint256 amount, uint64 deadline) = _approvalFields(i);
            return (
                v.OWNER_APPROVAL_TYPEHASH(),
                _approvalHash(intentId, receiptHash, amount, deadline),
                v.ownerApprovalDigest(intentId, receiptHash, amount, deadline)
            );
        }
        SymbolonVault.PayeeChange memory pc = _payeeChange(i);
        return (v.PAYEE_CHANGE_TYPEHASH(), _pcHash(pc), v.payeeChangeDigest(pc));
    }

    function test_vectors_domainSeparationCasesDiffer() public view {
        bytes32 base = _b32(_caseIndex("OwnerApproval"), "digest");
        assertTrue(base != _b32(_caseIndex("OwnerApproval/domain-chainId-1"), "digest"));
        assertTrue(base != _b32(_caseIndex("OwnerApproval/domain-other-vault"), "digest"));
    }

    // ---- end to end: the vault accepts signatures made over the vector digests ------------------------------

    /// The vector's owner and payees are fixed addresses with no known keys, so ERC-1271 wallets are placed at
    /// those addresses and pre-approve exactly the digest read from the JSON. Registration, the approved release
    /// and the payee change succeed only if the vault hashes the vector message to that same digest. The kernel
    /// signs the Attestation vector digest (read from the JSON, not recomputed) with a test key.
    SymbolonVault internal ev;
    uint256 internal iTerms;
    uint256 internal iAtt;
    uint256 internal iApp;
    uint256 internal iPc;

    function test_vectors_endToEnd_vaultAcceptsVectorDigests() public {
        iTerms = _caseIndex("EngagementTerms");
        iAtt = _caseIndex("Attestation");
        iApp = _caseIndex("OwnerApproval");
        iPc = _caseIndex("PayeeChange");
        _e2eSetup();
        _e2eRegister();
        _e2eRelease();
        _e2ePayeeChange();
    }

    function _e2eSetup() internal {
        SymbolonVault.EngagementTerms memory t = _terms(iTerms);
        SymbolonVault.PayeeChange memory pc = _payeeChange(iPc);
        MockSafe template = new MockSafe(address(0)); // accepts only pre-approved hashes
        vm.etch(t.owner, address(template).code);
        vm.etch(t.payee, address(template).code);
        vm.etch(pc.newPayee, address(template).code);
        ev = _vaultAt(_addr(iTerms, "typedData.domain.verifyingContract"), 31337, t.owner, kernel);
        token.mint(address(ev), 10_000 * USDC);
        vm.warp(1_791_000_000); // inside the engagement window and before every vector deadline
    }

    function _e2eRegister() internal {
        SymbolonVault.EngagementTerms memory t = _terms(iTerms);
        // negative control: nothing approved yet, so the wallets refuse
        vm.expectRevert(SymbolonVault.BadOwnerSig.selector);
        ev.registerEngagement(t, "", "");
        bytes32 termsDigest = _b32(iTerms, "digest");
        MockSafe(t.owner).approveHash(termsDigest);
        MockSafe(t.payee).approveHash(termsDigest);
        ev.registerEngagement(t, "", "");
        assertEq(ev.engagementCount(), 1);
    }

    function _e2eRelease() internal {
        SymbolonVault.Attestation memory a = _attestation(iAtt);
        (bytes32 appIntent, bytes32 appReceipt, uint256 appAmount, uint64 appDeadline) = _approvalFields(iApp);
        assertEq(appIntent, a.intentId);
        assertEq(appAmount, a.amount);
        assertGt(a.amount, ev.humanThreshold(), "the vector amount must need an owner approval");
        // kernel signature over the digest read from the JSON (not recomputed)
        bytes memory kernelSig = _sign(kernel, _b32(iAtt, "digest"));
        SymbolonVault.OwnerApprovalRef memory ref =
            SymbolonVault.OwnerApprovalRef({receiptHash: appReceipt, deadline: appDeadline});
        vm.expectRevert(SymbolonVault.ApprovalRequired.selector); // approval not given yet
        ev.release(a, kernelSig, ref, "");
        MockSafe(ev.owner()).approveHash(_b32(iApp, "digest"));
        ev.release(a, kernelSig, ref, "");
        assertEq(token.balanceOf(a.payee), a.amount);
    }

    function _e2ePayeeChange() internal {
        SymbolonVault.PayeeChange memory pc = _payeeChange(iPc);
        bytes32 pcDigest = _b32(iPc, "digest");
        MockSafe(ev.owner()).approveHash(pcDigest);
        MockSafe(pc.oldPayee).approveHash(pcDigest);
        MockSafe(pc.newPayee).approveHash(pcDigest);
        ev.proposePayeeChange(pc, "", "", "");
        assertEq(ev.engagementNonce(pc.engagementId), pc.nonce);
        (address np,) = ev.pendingPayee(pc.engagementId);
        assertEq(np, pc.newPayee);
    }
}
