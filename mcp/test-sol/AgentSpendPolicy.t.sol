// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSpendPolicy} from "../contracts/AgentSpendPolicy.sol";
import {MockUSDC, FalseReturningToken, NoReturnToken, ReentrantToken} from "./mocks/Tokens.sol";

/// Unit and fuzz tests for AgentSpendPolicy. Tests named `..._documents...` pin CURRENT
/// behaviour that audit/evm/REVIEW.md lists as a finding or a parity gap with the Soroban
/// port. They are meant to fail the day the behaviour changes, so the change is deliberate.
contract AgentSpendPolicyTest is Test {
    event Paid(address indexed to, uint256 amount, uint256 indexed dayIndex, bool byOwner);
    event PolicyUpdated(uint256 dailyCap, uint256 autoApproveMax, bool allowlistEnabled);
    event FrozenSet(bool frozen);
    event AllowlistSet(address indexed payee, bool allowed);
    event OperatorSet(address indexed operator);
    event SessionKeyExpirySet(uint256 expiry);
    event Withdrawn(address indexed to, uint256 amount);

    // The policy the live mainnet vaults run: 1 USDC a day, 0.25 USDC per payment.
    uint256 internal constant CAP = 1_000_000;
    uint256 internal constant CEILING = 250_000;
    // 2026-10-03 00:00:00 UTC, so day arithmetic runs on a realistic clock.
    uint256 internal constant DAY0_START = 1_790_985_600;
    uint256 internal constant T0 = DAY0_START + 12 hours;

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

    // ---------------------------------------------------------------- constructor

    function test_constructor_setsState() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.operator(), operator);
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.dailyCap(), CAP);
        assertEq(vault.autoApproveMax(), CEILING);
        assertFalse(vault.frozen());
        assertFalse(vault.allowlistEnabled());
        assertEq(vault.sessionKeyExpiry(), 0);
        assertEq(vault.balance(), 100 * CAP);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        new AgentSpendPolicy(address(0), operator, address(usdc), CAP, CEILING);
    }

    function test_constructor_revertsOnZeroToken() public {
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        new AgentSpendPolicy(owner, operator, address(0), CAP, CEILING);
    }

    /// Parity gap PG-2: the Soroban port refuses owner == operator (OwnerIsOperator).
    function test_constructor_documentsOwnerMayEqualOperator() public {
        AgentSpendPolicy v = new AgentSpendPolicy(owner, owner, address(usdc), CAP, CEILING);
        assertEq(v.owner(), v.operator());
    }

    // ------------------------------------------------------------- access control

    function testFuzz_ownerFunctions_rejectNonOwner(address caller) public {
        vm.assume(caller != owner);
        vm.startPrank(caller);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.ownerPay(payee, 1);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setPolicy(0, 0, false);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setAllowed(payee, true);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setOperator(caller);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setSessionKeyExpiry(0);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setFrozen(false);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.withdraw(caller, 1);
        vm.stopPrank();
    }

    function testFuzz_pay_rejectsNonOperator(address caller) public {
        vm.assume(caller != operator);
        vm.prank(caller);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(payee, 1);
    }

    function test_pay_rejectsOwner() public {
        vm.prank(owner);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(payee, 1);
    }

    // ------------------------------------------------------------------ pay path

    function test_pay_movesFundsAndRecordsTheDay() public {
        uint256 d = T0 / 1 days;
        vm.expectEmit(true, true, false, true, address(vault));
        emit Paid(payee, CEILING, d, false);
        vm.prank(operator);
        vault.pay(payee, CEILING);

        assertEq(usdc.balanceOf(payee), CEILING);
        assertEq(vault.balance(), 100 * CAP - CEILING);
        assertEq(vault.spentToday(), CEILING);
        assertEq(vault.spentOnDay(d), CEILING);
    }

    function test_pay_revertsOnZeroPayee() public {
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        vault.pay(address(0), 1);
    }

    function test_pay_revertsWhenPayingTheVaultOrTheToken() public {
        vm.startPrank(operator);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.pay(address(vault), 1);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.pay(address(usdc), 1);
        vm.stopPrank();
    }

    function test_pay_revertsWhileFrozen_andResumesAfterUnfreeze() public {
        vm.prank(owner);
        vault.setFrozen(true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.IsFrozen.selector);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setFrozen(false);
        vm.prank(operator);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 1);
    }

    /// Strictly greater-than, on purpose and matching the Soroban port: a payment at
    /// exactly the expiry second goes through, one second later it does not.
    function test_pay_sessionKeyExpiry_includesTheExpirySecond() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(T0 + 100);

        vm.warp(T0 + 100);
        vm.prank(operator);
        vault.pay(payee, 1);

        vm.warp(T0 + 101);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);
    }

    function test_pay_allowlist() public {
        vm.prank(owner);
        vault.setPolicy(CAP, CEILING, true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setAllowed(payee, true);
        vm.prank(operator);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setAllowed(payee, false);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(payee, 1);
    }

    function test_pay_allowlistIgnoredWhenDisabled() public {
        assertFalse(vault.allowed(payee));
        vm.prank(operator);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 1);
    }

    function test_pay_ceilingBoundary() public {
        vm.startPrank(operator);
        vault.pay(payee, CEILING);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(payee, CEILING + 1);
        vm.stopPrank();
    }

    function test_pay_dailyCapBoundary() public {
        vm.startPrank(operator);
        for (uint256 i = 0; i < CAP / CEILING; i++) {
            vault.pay(payee, CEILING);
        }
        assertEq(vault.spentToday(), CAP);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
        vm.stopPrank();
    }

    function test_pay_zeroBoundsMeanUnbounded() public {
        vm.prank(owner);
        vault.setPolicy(0, 0, false);
        assertEq(vault.sessionKeyExpiry(), 0);

        vm.warp(T0 + 3650 days);
        vm.prank(operator);
        vault.pay(payee, 50 * CAP);
        assertEq(usdc.balanceOf(payee), 50 * CAP);
    }

    /// The order the gates fire in is part of the interface: the console and the
    /// spend-preflight API decode the first failing gate, and the Soroban port fires them
    /// in the same order. Every gate is violated at once, then fixed one at a time.
    function test_pay_gateOrder() public {
        vm.startPrank(operator);
        for (uint256 i = 0; i < CAP / CEILING; i++) {
            vault.pay(payee, CEILING);
        }
        vm.stopPrank();

        vm.startPrank(owner);
        vault.setFrozen(true);
        vault.setSessionKeyExpiry(T0 - 1);
        vault.setPolicy(CAP, CEILING, true);
        vm.stopPrank();

        _expectPayRevert(address(0), CEILING + 1, AgentSpendPolicy.ZeroAddress.selector);
        _expectPayRevert(address(vault), CEILING + 1, AgentSpendPolicy.InvalidPayee.selector);
        _expectPayRevert(payee, CEILING + 1, AgentSpendPolicy.IsFrozen.selector);

        vm.prank(owner);
        vault.setFrozen(false);
        _expectPayRevert(payee, CEILING + 1, AgentSpendPolicy.SessionKeyExpired.selector);

        vm.prank(owner);
        vault.setSessionKeyExpiry(0);
        _expectPayRevert(payee, CEILING + 1, AgentSpendPolicy.PayeeNotAllowed.selector);

        vm.prank(owner);
        vault.setAllowed(payee, true);
        _expectPayRevert(payee, CEILING + 1, AgentSpendPolicy.AboveAutoApprove.selector);
        _expectPayRevert(payee, CEILING, AgentSpendPolicy.DailyCapExceeded.selector);
    }

    function _expectPayRevert(address to, uint256 amount, bytes4 selector) internal {
        vm.prank(operator);
        vm.expectRevert(selector);
        vault.pay(to, amount);
    }

    /// Parity gap PG-1: the Soroban port refuses amount == 0 (InvalidAmount). Here a
    /// zero payment succeeds and emits a Paid event that moved nothing.
    function test_pay_documentsZeroAmountIsAccepted() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit Paid(payee, 0, T0 / 1 days, false);
        vm.prank(operator);
        vault.pay(payee, 0);
        assertEq(vault.spentToday(), 0);
    }

    // --------------------------------------------------------------- day boundary

    function testFuzz_today_isUtcDayIndex(uint256 ts) public {
        ts = bound(ts, 0, type(uint64).max);
        vm.warp(ts);
        assertEq(vault.today(), ts / 86400);
    }

    /// Finding F-3: the cap is per calendar day, not a rolling 24h window, so an operator
    /// can spend a full cap in the last second of a UTC day and another in the first.
    function test_dailyCap_documentsTwoCapsAcrossMidnight() public {
        uint256 lastSecond = DAY0_START + 1 days - 1;
        vm.warp(lastSecond);
        _spendFullCap();

        vm.warp(lastSecond + 1);
        assertEq(vault.spentToday(), 0);
        _spendFullCap();

        assertEq(usdc.balanceOf(payee), 2 * CAP);
        assertEq(vault.spentOnDay(lastSecond / 1 days), CAP);
        assertEq(vault.spentOnDay((lastSecond + 1) / 1 days), CAP);
    }

    function _spendFullCap() internal {
        vm.startPrank(operator);
        for (uint256 i = 0; i < CAP / CEILING; i++) {
            vault.pay(payee, CEILING);
        }
        vm.stopPrank();
    }

    function test_loweringTheCapBelowTodaysSpend_blocksTheRestOfTheDay() public {
        vm.prank(operator);
        vault.pay(payee, CEILING);
        vm.prank(owner);
        vault.setPolicy(CEILING - 1, CEILING, false);

        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        vm.warp(DAY0_START + 1 days);
        vm.prank(operator);
        vault.pay(payee, 1);
    }

    // ------------------------------------------------------------------- ownerPay

    function test_ownerPay_bypassesFreezeAllowlistCeilingAndExpiry() public {
        vm.startPrank(owner);
        vault.setFrozen(true);
        vault.setPolicy(CAP, CEILING, true);
        vault.setSessionKeyExpiry(T0 - 1);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Paid(payee, CEILING * 2, T0 / 1 days, true);
        vault.ownerPay(payee, CEILING * 2);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), CEILING * 2);
    }

    /// Finding F-2: ownerPay counts toward the day but is not checked against the cap, so
    /// one owner settlement can push spentOnDay past dailyCap and lock the agent out for the
    /// rest of the UTC day. Intended ("on-chain accounting stays honest"), but worth stating.
    function test_ownerPay_documentsItCanExhaustTheAgentsDay() public {
        vm.prank(owner);
        vault.ownerPay(payee, 2 * CAP);
        assertEq(vault.spentToday(), 2 * CAP);

        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
    }

    function test_ownerPay_rejectsZeroAndInvalidPayee() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        vault.ownerPay(address(0), 1);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.ownerPay(address(vault), 1);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.ownerPay(address(usdc), 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------- withdraw

    function test_withdraw_movesFundsAndDoesNotCountTowardTheDay() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit Withdrawn(owner, 10 * CAP);
        vm.prank(owner);
        vault.withdraw(owner, 10 * CAP);
        assertEq(usdc.balanceOf(owner), 10 * CAP);
        assertEq(vault.spentToday(), 0);
    }

    function test_withdraw_rejectsZeroVaultAndToken() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentSpendPolicy.ZeroAddress.selector);
        vault.withdraw(address(0), 1);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.withdraw(address(vault), 1);
        vm.expectRevert(AgentSpendPolicy.InvalidPayee.selector);
        vault.withdraw(address(usdc), 1);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------- setters

    function test_setters_updateStateAndEmit() public {
        address newOperator = makeAddr("newOperator");
        vm.startPrank(owner);

        vm.expectEmit(false, false, false, true, address(vault));
        emit PolicyUpdated(5, 3, true);
        vault.setPolicy(5, 3, true);

        vm.expectEmit(true, false, false, true, address(vault));
        emit AllowlistSet(payee, true);
        vault.setAllowed(payee, true);

        vm.expectEmit(true, false, false, false, address(vault));
        emit OperatorSet(newOperator);
        vault.setOperator(newOperator);

        vm.expectEmit(false, false, false, true, address(vault));
        emit SessionKeyExpirySet(T0 + 1 days);
        vault.setSessionKeyExpiry(T0 + 1 days);

        vm.expectEmit(false, false, false, true, address(vault));
        emit FrozenSet(true);
        vault.setFrozen(true);
        vm.stopPrank();

        assertEq(vault.dailyCap(), 5);
        assertEq(vault.autoApproveMax(), 3);
        assertTrue(vault.allowlistEnabled());
        assertTrue(vault.allowed(payee));
        assertEq(vault.operator(), newOperator);
        assertEq(vault.sessionKeyExpiry(), T0 + 1 days);
        assertTrue(vault.frozen());
    }

    // ----------------------------------------------------------------- revocation

    function test_setOperatorZero_revokesImmediately() public {
        vm.prank(owner);
        vault.setOperator(address(0));
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(payee, 1);
    }

    function test_rotatingTheOperator_locksOutTheOldKey() public {
        address next = makeAddr("next");
        vm.prank(owner);
        vault.setOperator(next);

        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(payee, 1);

        vm.prank(next);
        vault.pay(payee, 1);
    }

    /// Finding F-4: the NatSpec on setSessionKeyExpiry says block.timestamp "revokes now",
    /// but the check is strictly greater-than, so the operator can still pay for the rest
    /// of that second. Chains with sub-second blocks (Arbitrum One produces several blocks
    /// per timestamp) make that window real. setOperator(address(0)) or setFrozen(true)
    /// revoke in the same block.
    function test_revokeByExpiryNow_documentsTheSameSecondWindow() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(block.timestamp);

        vm.roll(block.number + 1); // next block, same timestamp
        vm.prank(operator);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 1);

        vm.warp(block.timestamp + 1);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);
    }

    /// 0 means "no expiry", not "expired": a caller that means revoke and passes 0 grants
    /// an unbounded key instead.
    function test_sessionKeyExpiryZero_documentsItMeansUnbounded() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(0);
        vm.warp(T0 + 3650 days);
        vm.prank(operator);
        vault.pay(payee, 1);
    }

    // --------------------------------------------------------------------- tokens

    function test_pay_revertsWithTransferFailed_andRollsBackTheDay() public {
        FalseReturningToken bad = new FalseReturningToken();
        AgentSpendPolicy v = new AgentSpendPolicy(owner, operator, address(bad), CAP, CEILING);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.TransferFailed.selector);
        v.pay(payee, 1);
        assertEq(v.spentToday(), 0);

        vm.startPrank(owner);
        vm.expectRevert(AgentSpendPolicy.TransferFailed.selector);
        v.ownerPay(payee, 1);
        vm.expectRevert(AgentSpendPolicy.TransferFailed.selector);
        v.withdraw(owner, 1);
        vm.stopPrank();
    }

    /// Parity gap PG-3: the Soroban port checks the balance inside the ladder and refuses
    /// with InsufficientBalance. Here an underfunded vault fails inside the token, with the
    /// token's own reason rather than a typed error from the vault.
    function test_pay_documentsUnderfundedVaultRevertsInsideTheToken() public {
        AgentSpendPolicy v = new AgentSpendPolicy(owner, operator, address(usdc), CAP, CEILING);
        vm.prank(operator);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds balance"));
        v.pay(payee, 1);
    }

    /// Finding F-6: the vault decodes a bool from transfer, so a token that returns no data
    /// (USDT-style) cannot be used at all. USDC and USDG both return bool.
    function test_pay_documentsNoReturnTokenIsUnusable() public {
        NoReturnToken t = new NoReturnToken();
        AgentSpendPolicy v = new AgentSpendPolicy(owner, operator, address(t), CAP, CEILING);
        t.mint(address(v), CAP);
        vm.prank(operator);
        vm.expectRevert();
        v.pay(payee, 1);
    }

    function test_reentrantToken_cannotReachPrivilegedEntryPoints() public {
        ReentrantToken t = new ReentrantToken();
        AgentSpendPolicy v = new AgentSpendPolicy(owner, operator, address(t), CAP, CEILING);
        t.mint(address(v), 10 * CAP);
        t.setVault(address(v));

        vm.prank(operator);
        v.pay(payee, CEILING);

        assertTrue(t.reentered());
        assertFalse(t.reentrySucceeded());
        assertEq(v.spentToday(), CEILING);
        assertEq(t.balanceOf(payee), CEILING);
    }

    // ----------------------------------------------------------------------- fuzz

    function testFuzz_pay_singlePaymentRespectsTheCeiling(uint256 amount) public {
        amount = bound(amount, 0, 10 * CAP);
        vm.prank(operator);
        if (amount > CEILING) {
            vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
            vault.pay(payee, amount);
        } else {
            vault.pay(payee, amount);
            assertEq(usdc.balanceOf(payee), amount);
        }
    }

    function testFuzz_pay_sequenceInOneDayNeverExceedsTheCap(uint256[16] memory amounts) public {
        uint256 spent;
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amount = bound(amounts[i], 0, CEILING);
            vm.prank(operator);
            if (spent + amount > CAP) {
                vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
                vault.pay(payee, amount);
            } else {
                vault.pay(payee, amount);
                spent += amount;
            }
            assertLe(vault.spentToday(), CAP);
        }
        assertEq(vault.spentToday(), spent);
        assertEq(usdc.balanceOf(payee), spent);
    }

    function testFuzz_policy_anyCapAndCeiling(uint256 cap, uint256 ceiling, uint256 amount) public {
        cap = bound(cap, 1, 100 * CAP);
        ceiling = bound(ceiling, 1, 100 * CAP);
        amount = bound(amount, 1, 100 * CAP);
        vm.prank(owner);
        vault.setPolicy(cap, ceiling, false);

        vm.prank(operator);
        if (amount > ceiling) {
            vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        } else if (amount > cap) {
            vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        }
        vault.pay(payee, amount);
    }
}
