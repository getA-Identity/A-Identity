// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerkleAirdrop
/// @notice A Merkle-proof USDC airdrop / claim on Arc. A funder (typically the shared
/// 2/2 Gnosis Safe treasury) deposits USDC into this contract; each recipient claims
/// exactly their allocation ONCE by presenting a Merkle proof against the fixed
/// `merkleRoot`. Claimed indices are tracked in a bitmap, so a claim can never be
/// replayed. After the campaign the `owner` can sweep any unclaimed USDC back to the
/// treasury.
///
/// Leaf = keccak256(abi.encodePacked(index, account, amount)); internal nodes are the
/// keccak256 of the sorted pair (OpenZeppelin / Uniswap MerkleDistributor convention),
/// so the backend (airdrop.ts) and this contract compute the exact same root.
///
/// Amounts are in USDC's 6-decimal ERC-20 units ($1.00 = 1_000_000), matching the
/// rest of the backend. USDC on Arc is 0x3600...0000 via the standard ERC-20 interface.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MerkleAirdrop {
    /// @notice Human treasury/principal — can sweep unclaimed funds after the campaign.
    address public immutable owner;
    /// @notice The USDC token (6-decimal ERC-20 interface).
    IERC20 public immutable token;
    /// @notice The fixed Merkle root committing to every (index, account, amount) leaf.
    bytes32 public immutable merkleRoot;
    /// @notice Unix time before which `sweep` is disabled. Recipients are guaranteed a
    /// window to claim; the owner cannot rug the pool out from under them until it passes.
    uint256 public immutable claimDeadline;

    /// @dev Packed bitmap of claimed indices (256 claims per storage word).
    mapping(uint256 => uint256) private claimedBitMap;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    error AlreadyClaimed();
    error InvalidProof();
    error NotOwner();
    error TransferFailed();
    error ZeroOwner();
    error SweepBeforeDeadline();
    error InvalidDeadline();
    error ZeroToken();
    error ZeroAddress();

    /// @param _owner The treasury that owns sweep — MUST be the shared 2/2 Gnosis Safe, NOT
    /// the deployer key. Passing an explicit owner keeps the funded pool under 2/2 control
    /// instead of the single hot key that broadcast the deploy.
    /// @param _claimDeadline Unix time before which sweep is disabled, so recipients get a
    /// guaranteed claim window (the owner can't empty the pool early). Must be in the future.
    constructor(address _token, bytes32 _merkleRoot, address _owner, uint256 _claimDeadline) {
        if (_owner == address(0)) revert ZeroOwner();
        if (_token == address(0)) revert ZeroToken();
        if (_claimDeadline <= block.timestamp) revert InvalidDeadline();
        owner = _owner;
        token = IERC20(_token);
        merkleRoot = _merkleRoot;
        claimDeadline = _claimDeadline;
    }

    /// @notice Whether the allocation at `index` has already been claimed.
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;
        uint256 mask = (1 << bitIndex);
        return claimedBitMap[wordIndex] & mask == mask;
    }

    function _setClaimed(uint256 index) private {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;
        claimedBitMap[wordIndex] = claimedBitMap[wordIndex] | (1 << bitIndex);
    }

    /// @notice Claim `amount` USDC for `account` at `index`, proving membership with
    /// `merkleProof`. Reverts if already claimed or the proof is invalid. Anyone can
    /// submit the tx (the funds always go to `account`), so a relayer can pay gas.
    function claim(
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external {
        if (isClaimed(index)) revert AlreadyClaimed();

        bytes32 computed = keccak256(abi.encodePacked(index, account, amount));
        for (uint256 i = 0; i < merkleProof.length; i++) {
            bytes32 proofElement = merkleProof[i];
            computed = computed <= proofElement
                ? keccak256(abi.encodePacked(computed, proofElement))
                : keccak256(abi.encodePacked(proofElement, computed));
        }
        if (computed != merkleRoot) revert InvalidProof();

        _setClaimed(index);
        if (!token.transfer(account, amount)) revert TransferFailed();
        emit Claimed(index, account, amount);
    }

    /// @notice Owner sweeps the remaining (unclaimed) USDC to `to` AFTER the claim deadline.
    /// Disabled until `claimDeadline` so the owner cannot rug recipients mid-campaign.
    function sweep(address to) external {
        if (msg.sender != owner) revert NotOwner();
        if (block.timestamp < claimDeadline) revert SweepBeforeDeadline();
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = token.balanceOf(address(this));
        if (!token.transfer(to, bal)) revert TransferFailed();
        emit Swept(to, bal);
    }
}
