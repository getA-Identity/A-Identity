// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 that behaves like USDC where the vault can see it: transfer
/// returns true, and reverts on an insufficient balance or a zero recipient.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A token that reports failure by returning false instead of reverting.
contract FalseReturningToken is MockUSDC {
    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @notice A USDT-style token whose transfer returns no data at all.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

interface IVaultEntry {
    function pay(address to, uint256 amount) external;
    function ownerPay(address to, uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
}

/// @notice A token that calls back into the vault during transfer, to show that a hook
/// cannot reach a privileged entry point: inside the callback msg.sender is the token.
contract ReentrantToken is MockUSDC {
    IVaultEntry public vault;
    bool public reentered;
    bool public reentrySucceeded;

    function setVault(address v) external {
        vault = IVaultEntry(v);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (address(vault) != address(0) && !reentered) {
            reentered = true;
            try vault.pay(to, amount) {
                reentrySucceeded = true;
            } catch {}
            try vault.ownerPay(to, amount) {
                reentrySucceeded = true;
            } catch {}
            try vault.withdraw(to, amount) {
                reentrySucceeded = true;
            } catch {}
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
