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

/// @notice Malicious token for reentrancy tests. During the FIRST `transfer` it takes one
/// staticcall snapshot of `target` (`observeData`) and then fires every call in `_calls` at
/// `target` with low-level `call`, recording success and return data. `hookAfter` picks whether
/// the hook runs after (ERC-777 style) or before the balances move. The token is `msg.sender`
/// inside the hook, so a test makes it the owner/operator of the target to let the re-entry
/// pass access control and reach the state checks.
contract HookToken is MockUSDC {
    address public target;
    bool public hookAfter;
    bool public entered;
    bytes public observeData;
    bytes public observed;
    bool public observedOk;
    bytes[] internal _calls;
    bool[] internal _ok;
    bytes[] internal _rets;

    function arm(address t, bool after_, bytes calldata obs, bytes[] calldata cs) external {
        target = t;
        hookAfter = after_;
        observeData = obs;
        for (uint256 i = 0; i < cs.length; i++) {
            _calls.push(cs[i]);
        }
    }

    function callCount() external view returns (uint256) {
        return _ok.length;
    }

    function okAt(uint256 i) external view returns (bool) {
        return _ok[i];
    }

    function retSelector(uint256 i) external view returns (bytes4) {
        bytes memory r = _rets[i];
        return r.length >= 4 ? bytes4(r) : bytes4(0);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        bool first = target != address(0) && !entered;
        if (first) entered = true;
        if (first && !hookAfter) _hook();
        require(to != address(0), "ERC20: transfer to the zero address");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (first && hookAfter) _hook();
        return true;
    }

    function _hook() internal {
        if (observeData.length != 0) {
            (observedOk, observed) = target.staticcall(observeData);
        }
        for (uint256 i = 0; i < _calls.length; i++) {
            (bool s, bytes memory r) = target.call(_calls[i]);
            _ok.push(s);
            _rets.push(r);
        }
    }
}
