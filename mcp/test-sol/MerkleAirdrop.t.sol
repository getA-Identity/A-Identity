// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleAirdrop} from "../contracts/MerkleAirdrop.sol";
import {MockUSDC, FalseReturningToken} from "./mocks/Tokens.sol";

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

    /// Finding M-1: the token address is not checked, so a zero token deploys and every
    /// claim then reverts.
    function test_constructor_documentsZeroTokenIsAccepted() public {
        MerkleAirdrop d = new MerkleAirdrop(address(0), root, treasury, DEADLINE);
        assertEq(address(d.token()), address(0));
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
}
