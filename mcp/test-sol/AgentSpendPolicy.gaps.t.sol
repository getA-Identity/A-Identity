// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {AgentSpendPolicy} from "../contracts/AgentSpendPolicy.sol";
import {MockUSDC} from "./mocks/Tokens.sol";

/// Emits Transfer the way real USDC does, so the order of logs in a payment can be asserted.
contract LoggingUSDC is MockUSDC {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// Tests for behaviours that survived a wider mutant set run against the suite (boundaries,
/// deleted writes, narrowing casts, added logs, payable entry points). Each test fails on at
/// least one such mutant and passes on the real source. Tests named `..._documents...` pin
/// behaviour nothing else pins, so that tightening it becomes a deliberate change.
contract AgentSpendPolicyGapsTest is Test {
    event PolicyUpdated(uint256 dailyCap, uint256 autoApproveMax, bool allowlistEnabled);
    event FrozenSet(bool frozen);
    event AllowlistSet(address indexed payee, bool allowed);
    event Withdrawn(address indexed to, uint256 amount);

    uint256 internal constant CAP = 1_000_000;
    uint256 internal constant CEILING = 250_000;
    uint256 internal constant T0 = 1_790_985_600 + 12 hours;
    // Low 128 bits are 7, so a uint128 cast anywhere turns this into a tiny amount.
    uint256 internal constant HUGE = (uint256(1) << 128) + 7;

    AgentSpendPolicy internal vault;
    MockUSDC internal usdc;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
        vault = new AgentSpendPolicy(owner, operator, address(usdc), CAP, CEILING);
        usdc.mint(address(vault), 100 * CAP);
    }

    // --------------------------------------------------- the session key stays in its lane

    /// A stolen session key must not reach ANY owner power. setAllowed would let it list its
    /// own payee, setSessionKeyExpiry(0) would undo its expiry, setOperator would hand off.
    function test_gap_operatorCannotReachAnyOwnerFunction() public {
        vm.startPrank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.ownerPay(payee, 1);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setPolicy(0, 0, false);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setAllowed(payee, true);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setOperator(stranger);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setSessionKeyExpiry(0);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setFrozen(false);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.withdraw(operator, 1);
        vm.stopPrank();
    }

    /// The allowlist starts empty. In particular the operator is not on it, or an allowlisted
    /// vault could still pay the key's own address.
    function test_gap_constructor_allowlistStartsEmpty() public view {
        assertFalse(vault.allowed(owner));
        assertFalse(vault.allowed(operator));
        assertFalse(vault.allowed(payee));
        assertFalse(vault.allowed(address(vault)));
        assertFalse(vault.allowed(address(usdc)));
    }

    // ---------------------------------------------------------------------- setter values

    /// setFrozen SETS. A toggle would unfreeze the vault on a second click of "freeze".
    function test_gap_setFrozen_setsRatherThanToggles() public {
        vm.startPrank(owner);
        vault.setFrozen(true);
        vault.setFrozen(true);
        assertTrue(vault.frozen());
        vault.setFrozen(false);
        vault.setFrozen(false);
        assertFalse(vault.frozen());
        vm.stopPrank();
    }

    function test_gap_events_reportTheFalseValue() public {
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit AllowlistSet(payee, false);
        vault.setAllowed(payee, false);
        vm.expectEmit(false, false, false, true, address(vault));
        emit FrozenSet(false);
        vault.setFrozen(false);
        vm.stopPrank();
    }

    function test_gap_withdraw_eventNamesTheRealRecipient() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit Withdrawn(stranger, 3);
        vm.prank(owner);
        vault.withdraw(stranger, 3);
        assertEq(usdc.balanceOf(stranger), 3);
    }

    // ------------------------------------------------------------------------- boundaries

    /// 1 is the smallest real expiry. It is not a second "no expiry" value next to 0.
    function test_gap_expiryOfOne_isExpiredNotUnbounded() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(1);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);
    }

    function test_gap_ownerPay_underfundedReverts_notClampedToTheBalance() public {
        uint256 bal = vault.balance();
        vm.prank(owner);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds balance"));
        vault.ownerPay(payee, bal + 1);
        assertEq(vault.balance(), bal);
        assertEq(vault.spentToday(), 0);
    }

    // -------------------------------------------------- a zero amount skips no payee gate

    function test_gap_zeroAmount_skipsNoPayeeGate() public {
        vm.prank(owner);
        vault.setPolicy(CAP, CEILING, true);

        vm.startPrank(operator);
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        vault.pay(address(0), 0);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.pay(address(vault), 0);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.pay(address(usdc), 0);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(payee, 0);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        vault.ownerPay(address(0), 0);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.ownerPay(address(vault), 0);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.ownerPay(address(usdc), 0);
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        vault.withdraw(address(0), 0);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.withdraw(address(vault), 0);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.withdraw(address(usdc), 0);
        vm.stopPrank();
    }

    /// The invariants catch these three only when a run happens to try a zero payment in the
    /// right state, so they are pinned here without relying on the seed.
    function test_gap_zeroAmount_skipsNoPolicyGate() public {
        vm.prank(owner);
        vault.setFrozen(true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.IsFrozen.selector);
        vault.pay(payee, 0);

        vm.startPrank(owner);
        vault.setFrozen(false);
        vault.setSessionKeyExpiry(T0 - 1);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 0);

        vm.startPrank(owner);
        vault.setSessionKeyExpiry(0);
        vault.ownerPay(payee, CAP + 1);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 0);
    }

    /// Only testFuzz_policy_anyCapAndCeiling reaches a bound of 1, and only when the fuzzer
    /// picks it.
    function test_gap_boundOfOne_isARealBound() public {
        vm.prank(owner);
        vault.setPolicy(0, 1, false);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(payee, 2);

        vm.prank(owner);
        vault.setPolicy(1, 0, false);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 2);
    }

    // ------------------------------------------------------------- amounts past 128 bits
    // No real USDC balance gets near these, so this is refactor insurance: a narrowing cast
    // introduced anywhere in the money path must go red.

    function test_gap_hugeAmount_ceilingSeesEveryBit() public {
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(payee, HUGE);
    }

    function test_gap_hugeAmount_capSeesEveryBit() public {
        vm.prank(owner);
        vault.setPolicy(CAP, 0, false);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, HUGE);
    }

    function test_gap_hugeAmount_movesAndRecordsEveryBit() public {
        usdc.mint(address(vault), 3 * HUGE);
        vm.prank(owner);
        vault.setPolicy(0, 0, false);

        vm.prank(operator);
        vault.pay(payee, HUGE);
        assertEq(usdc.balanceOf(payee), HUGE);
        assertEq(vault.spentToday(), HUGE);

        vm.prank(owner);
        vault.ownerPay(payee, HUGE);
        assertEq(usdc.balanceOf(payee), 2 * HUGE);
        assertEq(vault.spentToday(), 2 * HUGE);

        vm.prank(owner);
        vault.withdraw(stranger, HUGE);
        assertEq(usdc.balanceOf(stranger), HUGE);
    }

    // ------------------------------------------------------------------ arithmetic checks
    // Only reachable with a token that holds near 2^256 units, so again refactor insurance:
    // an `unchecked` added for gas must go red. They pin the checked arithmetic of 0.8.

    function test_gap_capSum_overflowPanics_notWraps() public {
        vm.startPrank(owner);
        vault.setPolicy(CAP, 0, false);
        vault.ownerPay(payee, 5 * CAP); // the day is past the cap, so a wrapped sum is still above it
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(stdError.arithmeticError);
        vault.pay(payee, type(uint256).max);
    }

    function _vaultWithMaxSupply() internal returns (AgentSpendPolicy v, MockUSDC t) {
        t = new MockUSDC();
        v = new AgentSpendPolicy(owner, operator, address(t), 0, 0);
        t.mint(address(v), type(uint256).max);
    }

    function test_gap_dayLedger_overflowPanics_pay() public {
        (AgentSpendPolicy v, MockUSDC t) = _vaultWithMaxSupply();
        vm.prank(operator);
        v.pay(payee, type(uint256).max);
        vm.prank(payee);
        t.transfer(address(v), 1);
        vm.prank(operator);
        vm.expectRevert(stdError.arithmeticError);
        v.pay(payee, 1);
    }

    function test_gap_dayLedger_overflowPanics_ownerPay() public {
        (AgentSpendPolicy v, MockUSDC t) = _vaultWithMaxSupply();
        vm.prank(owner);
        v.ownerPay(payee, type(uint256).max);
        vm.prank(payee);
        t.transfer(address(v), 1);
        vm.prank(owner);
        vm.expectRevert(stdError.arithmeticError);
        v.ownerPay(payee, 1);
    }

    // --------------------------------------------------------------------- native value
    // On Arc native USDC and the ERC-20 share one balance, so a payable entry point here is a
    // second, unaccounted way in. Every entry point refuses value, and so does a plain send.

    function _assertRejectsValue(address caller, bytes memory data) internal {
        vm.deal(caller, 1);
        vm.prank(caller);
        (bool ok, ) = address(vault).call{value: 1}(data);
        assertFalse(ok, "accepted native value");
    }

    function test_gap_everyEntryPointRejectsNativeValue() public {
        _assertRejectsValue(stranger, "");
        _assertRejectsValue(operator, abi.encodeCall(vault.pay, (payee, 1)));
        _assertRejectsValue(owner, abi.encodeCall(vault.ownerPay, (payee, 1)));
        _assertRejectsValue(owner, abi.encodeCall(vault.setPolicy, (CAP, CEILING, false)));
        _assertRejectsValue(owner, abi.encodeCall(vault.setAllowed, (payee, true)));
        _assertRejectsValue(owner, abi.encodeCall(vault.setOperator, (operator)));
        _assertRejectsValue(owner, abi.encodeCall(vault.setSessionKeyExpiry, (0)));
        _assertRejectsValue(owner, abi.encodeCall(vault.setFrozen, (false)));
        _assertRejectsValue(owner, abi.encodeCall(vault.withdraw, (owner, 1)));
        assertEq(address(vault).balance, 0);
    }

    // ------------------------------------------------------------------ exactly one log
    // vm.expectEmit only proves a log is present. An indexer counts them, so a second Paid
    // doubles a spend off-chain and a Paid out of withdraw invents one.

    function _assertOneLog(address caller, bytes memory data, bytes32 topic0) internal {
        vm.recordLogs();
        vm.prank(caller);
        (bool ok, ) = address(vault).call(data);
        assertTrue(ok, "call failed");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "log count");
        assertEq(logs[0].emitter, address(vault));
        assertEq(logs[0].topics[0], topic0);
    }

    function test_gap_everyEntryPointEmitsExactlyOneLog() public {
        _assertOneLog(operator, abi.encodeCall(vault.pay, (payee, 1)), AgentSpendPolicy.Paid.selector);
        _assertOneLog(owner, abi.encodeCall(vault.ownerPay, (payee, 1)), AgentSpendPolicy.Paid.selector);
        _assertOneLog(owner, abi.encodeCall(vault.setPolicy, (CAP, CEILING, false)), AgentSpendPolicy.PolicyUpdated.selector);
        _assertOneLog(owner, abi.encodeCall(vault.setAllowed, (payee, true)), AgentSpendPolicy.AllowlistSet.selector);
        _assertOneLog(owner, abi.encodeCall(vault.setOperator, (operator)), AgentSpendPolicy.OperatorSet.selector);
        _assertOneLog(owner, abi.encodeCall(vault.setSessionKeyExpiry, (0)), AgentSpendPolicy.SessionKeyExpirySet.selector);
        _assertOneLog(owner, abi.encodeCall(vault.setFrozen, (true)), AgentSpendPolicy.FrozenSet.selector);
        _assertOneLog(owner, abi.encodeCall(vault.withdraw, (owner, 1)), AgentSpendPolicy.Withdrawn.selector);
    }

    function _assertTransferThenEvent(AgentSpendPolicy v, address token, address caller, bytes memory data, bytes32 topic0) internal {
        vm.recordLogs();
        vm.prank(caller);
        (bool ok, ) = address(v).call(data);
        assertTrue(ok, "call failed");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "log count");
        assertEq(logs[0].emitter, token);
        assertEq(logs[0].topics[0], LoggingUSDC.Transfer.selector);
        assertEq(logs[1].emitter, address(v));
        assertEq(logs[1].topics[0], topic0);
    }

    /// The vault's event follows the token's Transfer. Cosmetic: no funds depend on it, but an
    /// indexer reading a receipt in order sees it, and the reordering is otherwise invisible.
    function test_gap_vaultEventFollowsTheTokenTransfer() public {
        LoggingUSDC t = new LoggingUSDC();
        AgentSpendPolicy v = new AgentSpendPolicy(owner, operator, address(t), CAP, CEILING);
        t.mint(address(v), 10);
        _assertTransferThenEvent(v, address(t), operator, abi.encodeCall(v.pay, (payee, 1)), AgentSpendPolicy.Paid.selector);
        _assertTransferThenEvent(v, address(t), owner, abi.encodeCall(v.ownerPay, (payee, 1)), AgentSpendPolicy.Paid.selector);
        _assertTransferThenEvent(v, address(t), owner, abi.encodeCall(v.withdraw, (owner, 1)), AgentSpendPolicy.Withdrawn.selector);
    }

    // -------------------------------------------- permissive behaviour, pinned on purpose
    // None of these is a promise from the spec, but owners deploy with values of their own.
    // Tightening one of them must be a decision, not a side effect.

    function test_gap_constructor_documentsItAcceptsAnyBounds() public {
        AgentSpendPolicy unbounded = new AgentSpendPolicy(owner, operator, address(usdc), 0, CEILING);
        assertEq(unbounded.dailyCap(), 0);
        AgentSpendPolicy inverted = new AgentSpendPolicy(owner, operator, address(usdc), CAP, CAP + 1);
        assertEq(inverted.autoApproveMax(), CAP + 1);
        // It cannot tell whether the token address has code: that check belongs to the deployer.
        AgentSpendPolicy codeless = new AgentSpendPolicy(owner, operator, makeAddr("notAToken"), CAP, CEILING);
        assertEq(address(codeless.usdc()), makeAddr("notAToken"));
    }

    function test_gap_pay_documentsOwnerAndOperatorMayBePayees() public {
        vm.startPrank(operator);
        vault.pay(owner, 1);
        vault.pay(operator, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 1);
        assertEq(usdc.balanceOf(operator), 1);
    }

    function test_gap_ownerPayAndWithdraw_documentZeroAndAnyRecipient() public {
        vm.startPrank(owner);
        vault.ownerPay(payee, 0);
        vault.ownerPay(owner, 1);
        vault.ownerPay(operator, 1);
        vault.withdraw(payee, 0);
        vault.withdraw(operator, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 1);
        assertEq(usdc.balanceOf(operator), 2);
    }

    function test_gap_setters_documentNoOpsAreAccepted() public {
        vm.startPrank(owner);
        vault.setOperator(operator);
        vault.setOperator(owner);
        assertEq(vault.operator(), owner);
        vault.setAllowed(payee, false);
        vault.setAllowed(address(0), true);
        assertTrue(vault.allowed(address(0)));
        vm.stopPrank();
    }
}
