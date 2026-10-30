// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {MerkleAirdrop} from "../contracts/MerkleAirdrop.sol";
import {MockUSDC, FalseReturningToken, HookToken} from "./mocks/Tokens.sol";

/// MerkleAirdrop has no deployment anywhere; these tests exist so the source in the repo
/// is not untested code. The tree is built here with the same leaf and sorted-pair rules
/// the contract and mcp/src/airdrop.ts use.
contract MerkleAirdropTest is Test {
    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    uint256 internal constant T0 = 1_790_985_600;
    uint256 internal constant DEADLINE = T0 + 30 days;

    MockUSDC internal usdc;
    MerkleAirdrop internal drop;
    address internal treasury = makeAddr("treasury");
    address[4] internal accounts;
    uint256[4] internal amounts = [uint256(1_000_000), 2_500_000, 300_000, 7_000_000];
    bytes32[4] internal leaves;
    bytes32 internal n01;
    bytes32 internal n23;
    bytes32 internal root;

    function setUp() public {
        vm.warp(T0);
        accounts[0] = makeAddr("alice");
        accounts[1] = makeAddr("bob");
        accounts[2] = makeAddr("carol");
        accounts[3] = makeAddr("dave");
        for (uint256 i = 0; i < 4; i++) {
            leaves[i] = _leaf(i, accounts[i], amounts[i]);
        }
        n01 = _hashPair(leaves[0], leaves[1]);
        n23 = _hashPair(leaves[2], leaves[3]);
        root = _hashPair(n01, n23);

        usdc = new MockUSDC();
        drop = new MerkleAirdrop(address(usdc), root, treasury, DEADLINE);
        usdc.mint(address(drop), _total());
    }

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(index, account, amount));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _total() internal view returns (uint256 t) {
        for (uint256 i = 0; i < 4; i++) t += amounts[i];
    }

    function _proof(uint256 index) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[index ^ 1];
        p[1] = index < 2 ? n23 : n01;
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(MerkleAirdrop.ZeroOwner.selector);
        new MerkleAirdrop(address(usdc), root, address(0), DEADLINE);
    }

    /// Covers F-04
    function test_F04_constructor_revertsOnZeroToken() public {
        vm.expectRevert(MerkleAirdrop.ZeroToken.selector);
        new MerkleAirdrop(address(0), root, treasury, DEADLINE);
    }

    /// Covers F-04
    function test_F04_constructor_checkOrder_ownerThenTokenThenDeadline() public {
        vm.expectRevert(MerkleAirdrop.ZeroOwner.selector);
        new MerkleAirdrop(address(0), root, address(0), 0);
        vm.expectRevert(MerkleAirdrop.ZeroToken.selector);
        new MerkleAirdrop(address(0), root, treasury, 0);
        vm.expectRevert(MerkleAirdrop.InvalidDeadline.selector);
        new MerkleAirdrop(address(usdc), root, treasury, 0);
    }

    // ---------------------------------------------------------------------- claim

    function test_claim_everyLeafOnce() public {
        for (uint256 i = 0; i < 4; i++) {
            vm.expectEmit(true, true, false, true, address(drop));
            emit Claimed(i, accounts[i], amounts[i]);
            drop.claim(i, accounts[i], amounts[i], _proof(i));
            assertTrue(drop.isClaimed(i));
            assertEq(usdc.balanceOf(accounts[i]), amounts[i]);
        }
        assertEq(usdc.balanceOf(address(drop)), 0);
    }

    function test_claim_byRelayer_paysTheAccountNotTheCaller() public {
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        drop.claim(1, accounts[1], amounts[1], _proof(1));
        assertEq(usdc.balanceOf(accounts[1]), amounts[1]);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_claim_twiceReverts() public {
        drop.claim(0, accounts[0], amounts[0], _proof(0));
        vm.expectRevert(MerkleAirdrop.AlreadyClaimed.selector);
        drop.claim(0, accounts[0], amounts[0], _proof(0));
    }

    function test_claim_rejectsAnyAlteredField() public {
        bytes32[] memory p = _proof(2);
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        drop.claim(2, accounts[2], amounts[2] + 1, p);
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        drop.claim(2, accounts[1], amounts[2], p);
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        drop.claim(3, accounts[2], amounts[2], p);
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        drop.claim(2, accounts[2], amounts[2], new bytes32[](0));
    }

    function test_claim_rejectsATruncatedProof() public {
        bytes32[] memory p = new bytes32[](1);
        p[0] = n23;
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        drop.claim(0, accounts[0], amounts[0], p);
    }

    function testFuzz_singleLeafTree_bitmapIsolatesIndices(uint256 index, address account, uint96 amount) public {
        index = bound(index, 1, type(uint256).max - 1);
        vm.assume(account != address(0));
        bytes32 leaf = _leaf(index, account, amount);
        MerkleAirdrop d = new MerkleAirdrop(address(usdc), leaf, treasury, DEADLINE);
        usdc.mint(address(d), amount);

        d.claim(index, account, amount, new bytes32[](0));
        assertTrue(d.isClaimed(index));
        assertFalse(d.isClaimed(index - 1));
        assertFalse(d.isClaimed(index + 1));
    }

    function test_bitmap_wordBoundary() public {
        uint256[3] memory idx = [uint256(255), 256, 511];
        for (uint256 i = 0; i < 3; i++) {
            bytes32 leaf = _leaf(idx[i], accounts[0], 1);
            MerkleAirdrop d = new MerkleAirdrop(address(usdc), leaf, treasury, DEADLINE);
            usdc.mint(address(d), 1);
            d.claim(idx[i], accounts[0], 1, new bytes32[](0));
            assertTrue(d.isClaimed(idx[i]));
            assertFalse(d.isClaimed(idx[i] - 1));
            assertFalse(d.isClaimed(idx[i] + 1));
        }
    }

    // ---------------------------------------------------------------------- sweep

    function test_sweep_onlyOwner() public {
        vm.warp(DEADLINE);
        vm.expectRevert(MerkleAirdrop.NotOwner.selector);
        drop.sweep(treasury);
    }

    function test_sweep_blockedBeforeTheDeadline_openAtIt() public {
        vm.warp(DEADLINE - 1);
        vm.prank(treasury);
        vm.expectRevert(MerkleAirdrop.SweepBeforeDeadline.selector);
        drop.sweep(treasury);

        drop.claim(0, accounts[0], amounts[0], _proof(0));
        vm.warp(DEADLINE);
        uint256 rest = _total() - amounts[0];
        vm.expectEmit(true, false, false, true, address(drop));
        emit Swept(treasury, rest);
        vm.prank(treasury);
        drop.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), rest);
    }

    /// Finding M-2: claims never close. After the deadline a claim still succeeds until
    /// the owner sweeps, and after a sweep it fails inside the token, not with a typed error.
    function test_claim_documentsItStaysOpenAfterTheDeadline() public {
        vm.warp(DEADLINE + 365 days);
        drop.claim(0, accounts[0], amounts[0], _proof(0));

        vm.prank(treasury);
        drop.sweep(treasury);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds balance"));
        drop.claim(1, accounts[1], amounts[1], _proof(1));
    }

    function test_claimAndSweep_revertWithTransferFailed_whenTokenReturnsFalse() public {
        FalseReturningToken bad = new FalseReturningToken();
        MerkleAirdrop d = new MerkleAirdrop(address(bad), root, treasury, DEADLINE);
        vm.expectRevert(MerkleAirdrop.TransferFailed.selector);
        d.claim(0, accounts[0], amounts[0], _proof(0));
        assertFalse(d.isClaimed(0));

        vm.warp(DEADLINE);
        vm.prank(treasury);
        vm.expectRevert(MerkleAirdrop.TransferFailed.selector);
        d.sweep(treasury);
    }

    // ============================================================ F-tagged review tests

    // ----------------------------------------------------------------------- F-01

    /// Covers F-01
    function test_F01_constructor_revertsOnPastOrCurrentDeadline() public {
        vm.expectRevert(MerkleAirdrop.InvalidDeadline.selector);
        new MerkleAirdrop(address(usdc), root, treasury, 0);
        vm.expectRevert(MerkleAirdrop.InvalidDeadline.selector);
        new MerkleAirdrop(address(usdc), root, treasury, block.timestamp);
        vm.expectRevert(MerkleAirdrop.InvalidDeadline.selector);
        new MerkleAirdrop(address(usdc), root, treasury, block.timestamp - 1);
    }

    /// Covers F-01
    function test_F01_constructor_acceptsDeadlineOneSecondAhead() public {
        MerkleAirdrop d = new MerkleAirdrop(address(usdc), root, treasury, block.timestamp + 1);
        assertEq(d.claimDeadline(), block.timestamp + 1);
    }

    /// Covers F-01
    function testFuzz_F01_constructor_deadlineMustBeStrictlyInTheFuture(uint256 deadline) public {
        if (deadline <= block.timestamp) {
            vm.expectRevert(MerkleAirdrop.InvalidDeadline.selector);
            new MerkleAirdrop(address(usdc), root, treasury, deadline);
        } else {
            MerkleAirdrop d = new MerkleAirdrop(address(usdc), root, treasury, deadline);
            assertEq(d.claimDeadline(), deadline);
        }
    }

    /// Covers F-01
    function testFuzz_F01_sweepNeverHappensBeforeTheDeadline(uint256 deadlineOffset, uint256 warpTo) public {
        deadlineOffset = bound(deadlineOffset, 1, 3650 days);
        uint256 deadline = block.timestamp + deadlineOffset;
        MerkleAirdrop d = new MerkleAirdrop(address(usdc), root, treasury, deadline);
        usdc.mint(address(d), 1_000);
        warpTo = bound(warpTo, block.timestamp, deadline + 365 days);
        vm.warp(warpTo);

        vm.prank(treasury);
        if (warpTo < deadline) {
            vm.expectRevert(MerkleAirdrop.SweepBeforeDeadline.selector);
            d.sweep(treasury);
            assertEq(usdc.balanceOf(address(d)), 1_000);
        } else {
            d.sweep(treasury);
            assertEq(usdc.balanceOf(treasury), 1_000);
        }
    }

    // ----------------------------------------------------------------------- F-05

    /// Covers F-05
    function test_F05_sweepToZero_afterDeadline_revertsZeroAddressAndMovesNothing() public {
        vm.warp(DEADLINE);
        vm.prank(treasury);
        vm.expectRevert(MerkleAirdrop.ZeroAddress.selector);
        drop.sweep(address(0));
        assertEq(usdc.balanceOf(address(drop)), _total());
        assertEq(usdc.balanceOf(address(0)), 0);
    }

    /// Covers F-05
    function test_F05_sweepToValidAddress_stillWorks() public {
        address other = makeAddr("other");
        vm.warp(DEADLINE);
        vm.expectEmit(true, false, false, true, address(drop));
        emit Swept(other, _total());
        vm.prank(treasury);
        drop.sweep(other);
        assertEq(usdc.balanceOf(other), _total());
        assertEq(usdc.balanceOf(address(drop)), 0);
    }

    /// Covers F-05
    function test_F05_sweepCheckOrder_notOwner_thenBeforeDeadline_thenZeroAddress() public {
        address stranger = makeAddr("stranger");
        // non-owner with to == 0: NotOwner, both before and after the deadline
        vm.prank(stranger);
        vm.expectRevert(MerkleAirdrop.NotOwner.selector);
        drop.sweep(address(0));
        vm.warp(DEADLINE);
        vm.prank(stranger);
        vm.expectRevert(MerkleAirdrop.NotOwner.selector);
        drop.sweep(address(0));
        // owner before the deadline with to == 0: SweepBeforeDeadline
        vm.warp(DEADLINE - 1);
        vm.prank(treasury);
        vm.expectRevert(MerkleAirdrop.SweepBeforeDeadline.selector);
        drop.sweep(address(0));
    }

    // ----------------------------------------------------------------------- F-06

    /// Covers F-06
    function test_F06_claimsStayOpenAfterTheDeadline() public {
        vm.warp(DEADLINE + 3650 days);
        for (uint256 i = 0; i < 4; i++) {
            drop.claim(i, accounts[i], amounts[i], _proof(i));
            assertTrue(drop.isClaimed(i));
        }
        assertEq(usdc.balanceOf(address(drop)), 0);
    }

    /// Covers F-06
    function test_F06_claimedThenSwept_accountingSumsToFunded() public {
        drop.claim(0, accounts[0], amounts[0], _proof(0));
        drop.claim(2, accounts[2], amounts[2], _proof(2));
        vm.warp(DEADLINE);
        vm.prank(treasury);
        drop.sweep(treasury);

        uint256 claimed = usdc.balanceOf(accounts[0]) + usdc.balanceOf(accounts[2]);
        assertEq(claimed, amounts[0] + amounts[2]);
        assertEq(claimed + usdc.balanceOf(treasury), _total());
        assertEq(usdc.balanceOf(address(drop)), 0);

        // a late claim dies inside the token and leaves the index unclaimed
        vm.expectRevert(bytes("ERC20: transfer amount exceeds balance"));
        drop.claim(1, accounts[1], amounts[1], _proof(1));
        assertFalse(drop.isClaimed(1));
        assertEq(usdc.balanceOf(accounts[1]), 0);
    }

    // ----------------------------------------------------------------------- F-07

    /// Covers F-07
    function test_F07_noOwnershipTransferEntryPoint_andOwnerIsConstant() public {
        bytes[4] memory data;
        data[0] = abi.encodeWithSignature("transferOwnership(address)", makeAddr("x"));
        data[1] = abi.encodeWithSignature("setOwner(address)", makeAddr("x"));
        data[2] = abi.encodeWithSignature("renounceOwnership()");
        data[3] = abi.encodeWithSignature("acceptOwnership()");
        address[2] memory callers = [treasury, makeAddr("stranger")];
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = 0; j < 2; j++) {
                vm.prank(callers[j]);
                (bool ok,) = address(drop).call(data[i]);
                assertFalse(ok);
            }
        }
        assertEq(drop.owner(), treasury);

        // owner() is constant across claim and sweep
        drop.claim(0, accounts[0], amounts[0], _proof(0));
        assertEq(drop.owner(), treasury);
        vm.warp(DEADLINE);
        vm.prank(treasury);
        drop.sweep(treasury);
        assertEq(drop.owner(), treasury);
    }

    // ----------------------------------------------------------------------- F-21

    /// Covers F-21
    function test_F21_sweepBoundary_blockedAtDeadlineMinusOne_openAtDeadline() public {
        vm.warp(DEADLINE - 1);
        vm.prank(treasury);
        vm.expectRevert(MerkleAirdrop.SweepBeforeDeadline.selector);
        drop.sweep(treasury);
        assertEq(usdc.balanceOf(address(drop)), _total());

        vm.warp(DEADLINE);
        vm.prank(treasury);
        drop.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), _total());
    }

    // ------------------------------------------------------------------ F-29 / F-30

    /// Covers F-30
    function testFuzz_F30_owner_returnsConstructorArgument(address o) public {
        vm.assume(o != address(0));
        MerkleAirdrop d = new MerkleAirdrop(address(usdc), root, o, DEADLINE);
        assertEq(d.owner(), o);
    }

    /// Covers F-30
    function test_F30_ownerOnlySweep_worksForOwner_revertsForOthers() public {
        vm.warp(DEADLINE);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(MerkleAirdrop.NotOwner.selector);
        drop.sweep(stranger);
        vm.prank(treasury);
        drop.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), _total());
    }

    /// Covers F-30
    function test_F30_storageWriteCannotChangeOwner() public {
        address attacker = makeAddr("attacker");
        for (uint256 s = 0; s <= 5; s++) {
            vm.store(address(drop), bytes32(s), bytes32(uint256(uint160(attacker))));
            assertEq(drop.owner(), treasury);
            vm.store(address(drop), bytes32(s), bytes32(type(uint256).max));
            assertEq(drop.owner(), treasury);
        }
        vm.warp(DEADLINE);
        vm.prank(attacker);
        vm.expectRevert(MerkleAirdrop.NotOwner.selector);
        drop.sweep(attacker);
        vm.prank(treasury);
        drop.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), _total());
    }

    // ------------------------------------------------------------ F-19 / F-20 reentrancy

    /// Covers F-19
    function test_F19_sweep_reentrantTokenCannotSweepTwice() public {
        // The token is the owner so its re-entry passes the NotOwner gate and reaches the logic.
        // (a) hook runs AFTER the balance moved (ERC-777 style): the nested sweep sees 0.
        HookToken t = new HookToken();
        MerkleAirdrop d = new MerkleAirdrop(address(t), root, address(t), DEADLINE);
        t.mint(address(d), _total());
        bytes[] memory cs = new bytes[](1);
        cs[0] = abi.encodeCall(d.sweep, (treasury));
        t.arm(address(d), true, "", cs);
        vm.warp(DEADLINE);
        vm.prank(address(t));
        d.sweep(treasury);
        assertTrue(t.okAt(0));
        assertEq(t.balanceOf(treasury), _total());
        assertEq(t.balanceOf(address(d)), 0);

        // (b) hook runs BEFORE the balance moved: the nested sweep drains the pool, so the outer
        // transfer cannot be paid and the whole transaction reverts: nothing is swept twice.
        vm.warp(T0);
        HookToken t2 = new HookToken();
        MerkleAirdrop d2 = new MerkleAirdrop(address(t2), root, address(t2), DEADLINE);
        t2.mint(address(d2), _total());
        t2.arm(address(d2), false, "", cs); // same calldata: sweep(treasury)
        vm.warp(DEADLINE);
        vm.prank(address(t2));
        vm.expectRevert(stdError.arithmeticError);
        d2.sweep(treasury);
        assertEq(t2.balanceOf(treasury), 0);
        assertEq(t2.balanceOf(address(d2)), _total());
    }

    /// Covers F-20
    function test_F20_claim_reentrantTokenCannotDoubleClaim() public {
        HookToken t = new HookToken();
        MerkleAirdrop d = new MerkleAirdrop(address(t), root, treasury, DEADLINE);
        t.mint(address(d), _total());

        bytes[] memory cs = new bytes[](2);
        cs[0] = abi.encodeCall(d.claim, (0, accounts[0], amounts[0], _proof(0))); // same index
        cs[1] = abi.encodeCall(d.claim, (1, accounts[1], amounts[1], _proof(1))); // another index
        t.arm(address(d), false, abi.encodeCall(d.isClaimed, (0)), cs);

        d.claim(0, accounts[0], amounts[0], _proof(0));

        // the bitmap was already set when the token's hook ran
        assertTrue(t.observedOk());
        assertTrue(abi.decode(t.observed(), (bool)));
        // re-entering the same index failed, another index claimed once, legitimately
        assertFalse(t.okAt(0));
        assertEq(t.retSelector(0), MerkleAirdrop.AlreadyClaimed.selector);
        assertTrue(t.okAt(1));

        assertEq(t.balanceOf(accounts[0]), amounts[0]);
        assertEq(t.balanceOf(accounts[1]), amounts[1]);
        assertEq(t.balanceOf(address(d)), _total() - amounts[0] - amounts[1]);
        assertTrue(d.isClaimed(0));
        assertTrue(d.isClaimed(1));
        assertFalse(d.isClaimed(2));

        vm.expectRevert(MerkleAirdrop.AlreadyClaimed.selector);
        d.claim(0, accounts[0], amounts[0], _proof(0));
        vm.expectRevert(MerkleAirdrop.AlreadyClaimed.selector);
        d.claim(1, accounts[1], amounts[1], _proof(1));
    }

    // ----------------------------------------------------------------------- F-31

    function _expectInvalid(uint256 index, address account, uint256 amount, bytes32[] memory proof) internal {
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        drop.claim(index, account, amount, proof);
    }

    function _one(bytes32 a) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = a;
    }

    /// Re-encode a 64-byte node preimage (l || r) as every (index, account, amount) that could
    /// plausibly be made to look like it, and claim with the node's own sibling path.
    function _tryNodeAsLeaf(bytes32 l, bytes32 r, bytes32[] memory proof) internal {
        _expectInvalid(uint256(l), address(uint160(uint256(r) >> 96)), uint256(uint96(uint256(r))), proof);
        _expectInvalid(uint256(l), address(bytes20(r)), uint256(r), proof);
        _expectInvalid(uint256(l), address(0), uint256(r), proof);
        _expectInvalid(uint256(l), address(uint160(uint256(r))), 0, proof);
    }

    /// Covers F-31 — Merkle leaf/node domain separation holds (84-byte leaf vs 64-byte node), Informational, no code change
    function test_F31_internalNodeCannotBeUsedAsLeaf() public {
        assertEq(abi.encodePacked(uint256(0), accounts[0], amounts[0]).length, 84);
        assertEq(abi.encodePacked(leaves[0], leaves[1]).length, 64);

        _tryNodeAsLeaf(leaves[0], leaves[1], _one(n23)); // n01 with its sibling path
        _tryNodeAsLeaf(leaves[2], leaves[3], _one(n01)); // n23 with its sibling path
        _tryNodeAsLeaf(n01, n23, new bytes32[](0)); // the root's preimage, no path
        _tryNodeAsLeaf(n01, n23, _one(n01));

        assertEq(usdc.balanceOf(address(drop)), _total());
        for (uint256 i = 0; i < 4; i++) {
            assertFalse(drop.isClaimed(i));
        }
        // the real leaves still claim, so the rejections above are not a broken tree
        drop.claim(0, accounts[0], amounts[0], _proof(0));
    }

    /// Covers F-31 — Merkle leaf/node domain separation holds (84-byte leaf vs 64-byte node), Informational, no code change
    function testFuzz_F31_randomTripleNotInTreeNeverClaims(
        uint256 index,
        address account,
        uint256 amount,
        bytes32 p0,
        bytes32 p1
    ) public {
        for (uint256 i = 0; i < 4; i++) {
            vm.assume(!(index == i && account == accounts[i] && amount == amounts[i]));
        }
        _expectInvalid(index, account, amount, new bytes32[](0));
        _expectInvalid(index, account, amount, _one(n23));
        _expectInvalid(index, account, amount, _one(n01));
        _expectInvalid(index, account, amount, _one(p0));
        bytes32[] memory two = new bytes32[](2);
        two[0] = p0;
        two[1] = p1;
        _expectInvalid(index, account, amount, two);
        _expectInvalid(index, account, amount, _proof(index % 4)); // a real proof for a different leaf

        assertFalse(drop.isClaimed(index));
        assertEq(usdc.balanceOf(address(drop)), _total());
    }
}
