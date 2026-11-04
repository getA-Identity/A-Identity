// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {MerkleAirdrop} from "../contracts/MerkleAirdrop.sol";
import {MockUSDC} from "./mocks/Tokens.sol";
import {LoggingUSDC} from "./AgentSpendPolicy.gaps.t.sol";

/// Companion to AgentSpendPolicy.gaps.t.sol: behaviours that survived a wider mutant set run
/// against the suite. Each test fails on such a mutant and passes on the real source.
contract MerkleAirdropGapsTest is Test {
    uint256 internal constant T0 = 1_790_985_600;
    uint256 internal constant DEADLINE = T0 + 30 days;
    uint256 internal constant HUGE = (uint256(1) << 128) + 7;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    MockUSDC internal usdc;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
    }

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(index, account, amount));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _noProof() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    /// The existing suite stops at a 4-leaf tree, so nothing proved the loop walks a real
    /// proof all the way up. This is a 1024-leaf tree, claimed at the edges and across the
    /// bitmap word boundary.
    function test_gap_claim_walksADeepProof() public {
        uint256 depth = 10;
        uint256 n = 1 << depth;
        bytes32[][] memory level = new bytes32[][](depth + 1);
        level[0] = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            level[0][i] = _leaf(i, vm.addr(i + 1), i + 1);
        }
        for (uint256 d = 0; d < depth; d++) {
            uint256 m = level[d].length / 2;
            level[d + 1] = new bytes32[](m);
            for (uint256 i = 0; i < m; i++) {
                level[d + 1][i] = _hashPair(level[d][2 * i], level[d][2 * i + 1]);
            }
        }
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), level[depth][0], treasury, DEADLINE);
        usdc.mint(address(drop), n * n);

        uint256[4] memory picks = [uint256(0), 255, 256, n - 1];
        for (uint256 k = 0; k < picks.length; k++) {
            uint256 index = picks[k];
            bytes32[] memory proof = new bytes32[](depth);
            uint256 pos = index;
            for (uint256 d = 0; d < depth; d++) {
                proof[d] = level[d][pos ^ 1];
                pos /= 2;
            }
            drop.claim(index, vm.addr(index + 1), index + 1, proof);
            assertEq(usdc.balanceOf(vm.addr(index + 1)), index + 1);
            assertTrue(drop.isClaimed(index));
        }
    }

    function test_gap_claim_alreadyClaimedIsReportedBeforeTheProofIsChecked() public {
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), _leaf(0, alice, 5), treasury, DEADLINE);
        usdc.mint(address(drop), 5);
        drop.claim(0, alice, 5, _noProof());
        bytes32[] memory wrong = new bytes32[](1);
        wrong[0] = keccak256("not a sibling");
        vm.expectRevert(MerkleAirdrop.AlreadyClaimed.selector);
        drop.claim(0, alice, 5, wrong);
    }

    // ------------------------------------------------------------- values past 128 bits

    function test_gap_indexAbove128Bits_isItsOwnBit() public {
        uint256 high = (uint256(1) << 128);
        bytes32 root = _hashPair(_leaf(0, alice, 5), _leaf(high, bob, 7));
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), root, treasury, DEADLINE);
        usdc.mint(address(drop), 12);

        bytes32[] memory p = new bytes32[](1);
        p[0] = _leaf(high, bob, 7);
        drop.claim(0, alice, 5, p);
        assertFalse(drop.isClaimed(high));

        p[0] = _leaf(0, alice, 5);
        drop.claim(high, bob, 7, p);
        assertEq(usdc.balanceOf(bob), 7);
        assertTrue(drop.isClaimed(high));
    }

    function test_gap_amountAbove128Bits_paysEveryBit() public {
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), _leaf(0, alice, HUGE), treasury, DEADLINE);
        usdc.mint(address(drop), HUGE);
        drop.claim(0, alice, HUGE, _noProof());
        assertEq(usdc.balanceOf(alice), HUGE);
    }

    // --------------------------------------------------------------------- native value

    function test_gap_everyEntryPointRejectsNativeValue() public {
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), _leaf(0, alice, 5), treasury, DEADLINE);
        usdc.mint(address(drop), 5);
        vm.deal(address(this), 10);
        vm.deal(treasury, 10);

        (bool ok, ) = address(drop).call{value: 1}("");
        assertFalse(ok, "plain send accepted");
        (ok, ) = address(drop).call{value: 1}(abi.encodeCall(drop.claim, (0, alice, 5, _noProof())));
        assertFalse(ok, "claim accepted value");
        vm.warp(DEADLINE);
        vm.prank(treasury);
        (ok, ) = address(drop).call{value: 1}(abi.encodeCall(drop.sweep, (treasury)));
        assertFalse(ok, "sweep accepted value");
    }

    // ------------------------------------------------------------------- logs

    function test_gap_claimAndSweep_emitExactlyOneLog() public {
        bytes32 root = _hashPair(_leaf(0, alice, 5), _leaf(1, bob, 7));
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), root, treasury, DEADLINE);
        usdc.mint(address(drop), 12);
        bytes32[] memory p = new bytes32[](1);
        p[0] = _leaf(1, bob, 7);

        vm.recordLogs();
        drop.claim(0, alice, 5, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "claim logs");
        assertEq(logs[0].topics[0], MerkleAirdrop.Claimed.selector);

        vm.warp(DEADLINE);
        vm.recordLogs();
        vm.prank(treasury);
        drop.sweep(treasury);
        logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "sweep logs");
        assertEq(logs[0].topics[0], MerkleAirdrop.Swept.selector);
    }

    /// Cosmetic, same as the vault: the event follows the token's Transfer.
    function test_gap_eventsFollowTheTokenTransfer() public {
        LoggingUSDC t = new LoggingUSDC();
        bytes32 root = _hashPair(_leaf(0, alice, 5), _leaf(1, bob, 7));
        MerkleAirdrop drop = new MerkleAirdrop(address(t), root, treasury, DEADLINE);
        t.mint(address(drop), 12);
        bytes32[] memory p = new bytes32[](1);
        p[0] = _leaf(1, bob, 7);

        vm.recordLogs();
        drop.claim(0, alice, 5, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].emitter, address(t));
        assertEq(logs[1].topics[0], MerkleAirdrop.Claimed.selector);

        vm.warp(DEADLINE);
        vm.recordLogs();
        vm.prank(treasury);
        drop.sweep(treasury);
        logs = vm.getRecordedLogs();
        assertEq(logs[0].emitter, address(t));
        assertEq(logs[1].topics[0], MerkleAirdrop.Swept.selector);
    }

    // ---------------------------------------------------------------- storage shape

    /// No function writes the root, so on a real chain this adds nothing over the absence of a
    /// setter. It closes the one field the existing storage-write test does not read back.
    function test_gap_storageWriteCannotChangeTheRoot() public {
        bytes32 root = _leaf(0, alice, 5);
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), root, treasury, DEADLINE);
        for (uint256 s = 0; s <= 5; s++) {
            vm.store(address(drop), bytes32(s), bytes32(type(uint256).max));
            assertEq(drop.merkleRoot(), root);
        }
    }

    // -------------------------------------------- permissive behaviour, pinned on purpose

    function test_gap_constructor_documentsAZeroRootAndAnyFutureDeadline() public {
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), bytes32(0), treasury, DEADLINE);
        assertEq(drop.merkleRoot(), bytes32(0));
        // No upper limit on the deadline either: the funder picks how long the pool stays locked.
        new MerkleAirdrop(address(usdc), bytes32(0), treasury, T0 + 3650 days);
    }

    function test_gap_sweep_documentsSweepingToItselfIsANoOp() public {
        MerkleAirdrop drop = new MerkleAirdrop(address(usdc), _leaf(0, alice, 5), treasury, DEADLINE);
        usdc.mint(address(drop), 5);
        vm.warp(DEADLINE);
        vm.prank(treasury);
        drop.sweep(address(drop));
        assertEq(usdc.balanceOf(address(drop)), 5);
    }
}
