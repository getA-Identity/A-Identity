// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSpendPolicy} from "../contracts/AgentSpendPolicy.sol";
import {MockUSDC} from "./mocks/Tokens.sol";

/// Pins of five behaviours an owner has to know about, with the size of each: what it reaches and
/// what it does not. Tests named test_OLX_5_1_n carry the issue number from an outside scan; each
/// test states the behaviour in full, so it reads without that list. Like the `..._documents...`
/// tests in AgentSpendPolicy.t.sol, they fail the day the behaviour changes, so that a change is a
/// decision. They live in their own file because pasting them into AgentSpendPolicy.t.sol stops
/// solc 0.8.36 with an internal error ("Tag too large for reserved space").
abstract contract OlxBase is Test {
    // The policy the page defaults to: 1 USDC a day, 0.25 USDC per payment.
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

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        vault = new AgentSpendPolicy(owner, operator, address(usdc), CAP, CEILING);
        usdc.mint(address(vault), 100 * CAP);
    }

    function _spendFullCap() internal {
        vm.startPrank(operator);
        for (uint256 i = 0; i < CAP / CEILING; i++) {
            vault.pay(payee, CEILING);
        }
        vm.stopPrank();
    }
}

/// 5.1.1: the daily cap is a calendar-day bucket, so a holder of the agent key can move twice the
/// cap around 00:00 UTC. These pin the exact shape of that bound, and where "never more than twice
/// a constant cap in any 24 hours" stops being the whole story.
contract AgentSpendPolicyOlx511Test is OlxBase {
    /// Two full caps, one second of chain time apart, in ceiling-sized payments, and no third.
    function test_OLX_5_1_1_twoCapsOneSecondApart_atTheDefaultPolicy() public {
        assertEq(vault.dailyCap(), 1_000_000); // the page's DEFAULT_DAILY_CAP, 1 USDC
        assertEq(vault.autoApproveMax(), 250_000); // the page's DEFAULT_AUTO_APPROVE, 0.25 USDC
        uint256 lastSecond = DAY0_START + 1 days - 1;

        vm.warp(lastSecond);
        _spendFullCap(); // 4 payments of 0.25
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        vm.warp(lastSecond + 1);
        _spendFullCap(); // 4 more
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        assertEq(usdc.balanceOf(payee), 2 * CAP);
    }

    /// 24 hours is exactly where the 2x statement stops holding: two timestamps 86400 s apart touch
    /// two buckets, two timestamps 86401 s apart can touch three.
    function test_OLX_5_1_1_twoCapsAt24hExactly_threeCapsAt24hPlusOneSecond() public {
        uint256 start = DAY0_START + 1 days - 1; // the last second of day 0
        vm.warp(start);
        _spendFullCap();

        vm.warp(start + 86400); // the last second of day 1
        _spendFullCap();
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 2 * CAP, "exactly 24h: two caps and no more");

        vm.warp(start + 86401); // the first second of day 2
        _spendFullCap();
        assertEq(usdc.balanceOf(payee), 3 * CAP, "24h + 1s: three caps");
    }

    /// The 2x statement for a constant cap, from any start: a greedy agent in a closed 86400 s
    /// window reaches 2x the cap and never passes it.
    function testFuzz_OLX_5_1_1_constantCap_exactlyTwoCapsInAClosed24hWindow(uint256 startSeed, uint256 capSeed, uint256[16] calldata gaps) public {
        uint256 cap = bound(capSeed, 1, 1e15);
        uint256 start = bound(startSeed, DAY0_START, DAY0_START + 400 days);
        usdc.mint(address(vault), 3 * cap);
        vm.prank(owner);
        vault.setPolicy(cap, 0, false); // no ceiling, so one payment can fill a day

        uint256 end = start + 86400;
        uint256 total;
        uint256 t = start;
        vm.warp(t);
        total += _payWhatTheCapLeaves();
        for (uint256 i = 0; i < gaps.length; i++) {
            t += bound(gaps[i], 0, end - t);
            vm.warp(t);
            total += _payWhatTheCapLeaves();
        }
        vm.warp(end);
        total += _payWhatTheCapLeaves();

        assertEq(total, 2 * cap);
        assertEq(usdc.balanceOf(payee), 2 * cap);
    }

    function _payWhatTheCapLeaves() internal returns (uint256 paid) {
        paid = vault.dailyCap() - vault.spentToday();
        if (paid == 0) {
            vm.prank(operator);
            vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
            vault.pay(payee, 1);
            return 0;
        }
        vm.prank(operator);
        vault.pay(payee, paid);
    }

    /// Lowering the cap claws nothing back and is not retroactive, so the agent's take in 24 hours
    /// can be many times the cap the owner sees now. The statement says "constant" for this reason.
    /// What holds from the change onward is 2x the new cap.
    function test_OLX_5_1_1_lowerTheCapBeforeMidnight_elevenTimesTheCurrentCapInOneSecond() public {
        uint256 lastSecond = DAY0_START + 1 days - 1;
        vm.prank(owner);
        vault.setPolicy(10 * CAP, 0, false);
        vm.warp(lastSecond);
        vm.prank(operator);
        vault.pay(payee, 10 * CAP);

        vm.prank(owner);
        vault.setPolicy(CAP, 0, false); // the owner reacts, in the same second
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        vm.warp(lastSecond + 1);
        vm.prank(operator);
        vault.pay(payee, CAP);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        assertEq(usdc.balanceOf(payee), 11 * CAP);
        assertEq(vault.dailyCap(), CAP);
    }

    /// Raising the cap mid-day counts what was already spent, so the bound moves to 2x the new cap
    /// and not past it.
    function test_OLX_5_1_1_raiseTheCapMidDay_twoTimesTheNewCapAndNoMore() public {
        uint256 lastSecond = DAY0_START + 1 days - 1;
        vm.warp(lastSecond);
        _spendFullCap();
        vm.prank(owner);
        vault.setPolicy(10 * CAP, 0, false);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 9 * CAP + 1);
        vm.prank(operator);
        vault.pay(payee, 9 * CAP);

        vm.warp(lastSecond + 1);
        vm.prank(operator);
        vault.pay(payee, 10 * CAP);
        assertEq(usdc.balanceOf(payee), 20 * CAP);
    }

    /// Replacing the agent key does not refresh the day: the bucket belongs to the vault.
    function test_OLX_5_1_1_replacingTheKeyDoesNotRefreshTheDay() public {
        _spendFullCap();
        vm.prank(owner);
        vault.setOperator(stranger);
        vm.prank(stranger);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
    }

    /// A cap of 0 is off, not empty: the bound is gone. The page refuses it; the contract does not.
    function test_OLX_5_1_1_capZero_noBoundAtAll() public {
        vm.prank(owner);
        vault.setPolicy(0, 0, false);
        vm.prank(operator);
        vault.pay(payee, 50 * CAP);
        assertEq(usdc.balanceOf(payee), 50 * CAP);
    }

    /// The general form, with the owner changing a nonzero cap at will: on each UTC day the agent's
    /// total never passes the highest cap in force that day, so a window that touches two days
    /// never passes the sum of those two highs.
    function testFuzz_OLX_5_1_1_changingCap_dayTotalNeverPassesTheHighestCapInForce(uint256 startSeed, uint256[12] calldata caps, uint256[12] calldata amounts, uint256[12] calldata gaps) public {
        uint256 start = bound(startSeed, DAY0_START, DAY0_START + 400 days);
        uint256 end = start + 86400;
        uint256 firstDay = start / 86400;
        uint256[2] memory total;
        uint256[2] memory highest;
        usdc.mint(address(vault), 1000 * CAP);
        highest[0] = CAP;

        uint256 t = start;
        vm.warp(t);
        for (uint256 i = 0; i < 12; i++) {
            t += bound(gaps[i], 0, end - t);
            vm.warp(t);
            uint256 idx = t / 86400 - firstDay;
            // the cap carries over a midnight, so it is in force on the new day too
            if (vault.dailyCap() > highest[idx]) highest[idx] = vault.dailyCap();
            uint256 cap = bound(caps[i], 1, 20 * CAP);
            vm.prank(owner);
            vault.setPolicy(cap, 0, false);
            if (cap > highest[idx]) highest[idx] = cap;
            uint256 amount = bound(amounts[i], 1, 20 * CAP);
            vm.prank(operator);
            try vault.pay(payee, amount) {
                total[idx] += amount;
            } catch {}
            assertLe(total[idx], highest[idx]);
        }
        assertEq(usdc.balanceOf(payee), total[0] + total[1]);
        assertLe(total[0] + total[1], highest[0] + highest[1]);
    }

    /// A MODEL, not this contract: a leaky bucket refilling at the cap per 86400 s. It cuts the
    /// one-second burst from 2x to just over 1x, but it does NOT change the 24-hour figure: two
    /// timestamps exactly 24 hours apart still move 2x. Over W seconds the calendar peak is
    /// cap * (ceil(W / 1 day) + 1) and the model's is cap * (1 + W / 1 day), so they differ by less
    /// than one cap, and by nothing at a whole number of days.
    function test_OLX_5_1_1_model_leakyBucketStillMovesTwoCapsIn24h_butNotInOneSecond() public pure {
        uint256 c = CAP;
        // spend everything at t = 0; what is available again after w seconds
        assertEq(_leakyAvailable(c, 0, 1), 11); // 1 s later: 11 units, 0.000011 USDC
        assertEq(c + _leakyAvailable(c, 0, 1), 1_000_011); // versus 2_000_000 on the calendar bucket
        assertEq(c + _leakyAvailable(c, 0, 12 hours), 1_500_000);
        assertEq(c + _leakyAvailable(c, 0, 86400), 2 * c); // exactly 24h: the same 2x
        assertEq(_leakyAvailable(c, 0, 86401), c); // capped at one cap of stored room
    }

    function _leakyAvailable(uint256 cap, uint256 availableAfterSpend, uint256 elapsed) internal pure returns (uint256) {
        uint256 refilled = availableAfterSpend + (elapsed * cap) / 86400;
        return refilled > cap ? cap : refilled;
    }
}

/// 5.1.2: ownerPay counts toward the day the agent is capped on, and withdraw does not.
contract AgentSpendPolicyOlx512Test is OlxBase {
    /// An invoice above the cap locks the agent out until 00:00 UTC, and spentToday then reports
    /// money the agent did not spend. The same payment sent through withdraw leaves the day alone.
    function test_OLX_5_1_2_ownerInvoiceLocksTheAgentOut_withdrawDoesNot() public {
        vm.prank(owner);
        vault.withdraw(stranger, 5 * CAP);
        assertEq(usdc.balanceOf(stranger), 5 * CAP);
        assertEq(vault.spentToday(), 0, "withdraw to a third party is not in the ledger");

        vm.prank(owner);
        vault.ownerPay(stranger, 5 * CAP);
        assertEq(vault.spentToday(), 5 * CAP, "owner money, in the getter documented as agent spend");

        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        vm.warp(DAY0_START + 1 days - 1); // the last second of the day: still locked
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);

        vm.warp(DAY0_START + 1 days); // 00:00 UTC: a full budget, nothing carried over
        assertEq(vault.spentToday(), 0);
        vm.prank(operator);
        vault.pay(payee, CEILING);
        assertEq(usdc.balanceOf(payee), CEILING);
    }

    /// It takes no large invoice. Four owner payments that each pass the ceiling and the day, which
    /// is all the hosted WARN hand-off ever prepares, use up the agent's day.
    function test_OLX_5_1_2_fourHandoffsWithinTheCeiling_useUpTheAgentsDay() public {
        for (uint256 i = 0; i < 4; i++) {
            assertLe(vault.spentToday() + CEILING, vault.dailyCap());
            vm.prank(owner);
            vault.ownerPay(stranger, CEILING);
        }
        assertEq(vault.spentToday(), CAP);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
    }

    /// The owner can lift the lockout in one transaction, and the price is a wider agent. Restoring
    /// the agent's full day after a 5 USDC invoice takes a 6 USDC cap, which applies to the next day
    /// as well until a second setPolicy lowers it.
    function test_OLX_5_1_2_liftingTheLockout_leavesTheAgentAWiderCap() public {
        vm.prank(owner);
        vault.ownerPay(stranger, 5 * CAP);

        vm.prank(owner);
        vault.setPolicy(6 * CAP, CEILING, false);
        vm.prank(operator);
        vault.pay(payee, CEILING);

        vm.warp(DAY0_START + 1 days);
        for (uint256 i = 0; i < 24; i++) {
            vm.prank(operator);
            vault.pay(payee, CEILING);
        }
        assertEq(vault.spentToday(), 6 * CAP, "six times the deploy-time cap in one day");
    }

    /// What the shared ledger does not buy. The agent goes first and spends the whole cap, the owner
    /// then pays as well, and one day sees cap + owner spend. The ledger limits the agent only when
    /// the owner paid first, so it is not a bound on a compromised key.
    function test_OLX_5_1_2_sharedLedgerIsNoBoundWhenTheAgentGoesFirst() public {
        uint256 start = vault.balance();
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(operator);
            vault.pay(payee, CEILING);
        }
        vm.prank(owner);
        vault.ownerPay(stranger, 5 * CAP);
        assertEq(start - vault.balance(), 6 * CAP);
    }
}

/// 5.1.3: setPolicy has no caps-only form. A caller changing the caps must send the allowlist flag
/// too, and the contract writes whatever it is sent.
contract AgentSpendPolicyOlx513Test is OlxBase {
    event PolicyUpdated(uint256 dailyCap, uint256 autoApproveMax, bool allowlistEnabled);

    function test_OLX_5_1_3_capsOnlyUpdateWithStaleFalseTurnsTheAllowlistOff() public {
        uint256 newCap = 2 * CAP;

        // The owner runs an allowlist with one payee on it.
        vm.startPrank(owner);
        vault.setPolicy(CAP, CEILING, true);
        vault.setAllowed(payee, true);
        vm.stopPrank();
        assertTrue(vault.allowlistEnabled());
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(stranger, CEILING);

        // Sent back from a fresh read, a caps-only change keeps the flag on.
        bool freshFlag = vault.allowlistEnabled();
        vm.prank(owner);
        vault.setPolicy(newCap, CEILING, freshFlag);
        assertTrue(vault.allowlistEnabled());
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(stranger, CEILING);

        // The same caps with a stale false: nothing compares it to the stored value.
        bool staleFlag = false;
        vm.expectEmit(false, false, false, true, address(vault));
        emit PolicyUpdated(newCap, CEILING, false);
        vm.prank(owner);
        vault.setPolicy(newCap, CEILING, staleFlag);
        assertEq(vault.dailyCap(), newCap);
        assertFalse(vault.allowlistEnabled());

        // Now the agent key pays a payee nobody approved.
        vm.prank(operator);
        vault.pay(stranger, CEILING);
        assertEq(usdc.balanceOf(stranger), CEILING);

        // What does not move: the ceiling and the cap still bind, and the agent cannot do this itself.
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(stranger, CEILING + 1);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setPolicy(newCap, CEILING, false);

        // The list survives, so turning the flag back on restores the same restriction.
        assertTrue(vault.allowed(payee));
        assertFalse(vault.allowed(stranger));
        vm.prank(owner);
        vault.setPolicy(newCap, CEILING, true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(stranger, CEILING);
        vm.prank(operator);
        vault.pay(payee, CEILING);
        assertEq(usdc.balanceOf(payee), CEILING);
    }

    /// The size of it at the page's defaults (cap 1 USDC, ceiling 0.25 USDC, funding 0.02 USDC, in
    /// src/lib/arc/vault-rules.ts). The agent's reach to an unapproved payee is the smaller of the
    /// balance and the cap per UTC day, and freeze and expiry still stop it at once. It is the same
    /// reach a vault that never turned the allowlist on has from its first block.
    function test_OLX_5_1_3_blastRadiusAtThePageDefaults() public {
        uint256 cap = 1_000_000;
        uint256 ceiling = 250_000;
        uint256 funding = 20_000;
        MockUSDC token = new MockUSDC();
        AgentSpendPolicy v = new AgentSpendPolicy(owner, operator, address(token), cap, ceiling);

        // A vault from the page's deploy flow starts with the allowlist off.
        assertFalse(v.allowlistEnabled());
        token.mint(address(v), funding);
        vm.startPrank(owner);
        v.setSessionKeyExpiry(block.timestamp + 7 days);
        v.setPolicy(cap, ceiling, true);
        v.setAllowed(payee, true);
        // The stale form turns it off, as a caps-only change.
        v.setPolicy(cap, ceiling, false);
        vm.stopPrank();

        // At default funding the balance is the bound: 0.02 USDC, and then the transfer fails.
        vm.prank(operator);
        v.pay(stranger, funding);
        assertEq(token.balanceOf(stranger), funding);
        vm.prank(operator);
        vm.expectRevert();
        v.pay(stranger, 1);

        // Funded well past the cap, four payments of the ceiling use up the day, and no fifth lands.
        token.mint(address(v), 100 * cap);
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(operator);
        for (uint256 i = 0; i < 4; i++) v.pay(stranger, ceiling);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        v.pay(stranger, 1);
        vm.stopPrank();
        assertEq(v.spentToday(), cap);

        // Freeze and expiry do not depend on the flag.
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        v.setFrozen(true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.IsFrozen.selector);
        v.pay(stranger, 1);
        vm.startPrank(owner);
        v.setFrozen(false);
        v.setSessionKeyExpiry(1);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        v.pay(stranger, 1);
    }

    /// Whatever the caps and whatever the list, setPolicy moves the flag to exactly what it was
    /// sent, and it moves no other policy state.
    function testFuzz_OLX_5_1_3_setPolicyWritesTheFlagItIsSentAndNothingElse(uint256 cap, uint256 ceiling, bool before, bool sent) public {
        vm.startPrank(owner);
        vault.setPolicy(CAP, CEILING, before);
        vault.setAllowed(payee, true);
        vault.setSessionKeyExpiry(T0 + 1 days);
        vm.stopPrank();
        vm.prank(operator);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setPolicy(cap, ceiling, sent);

        assertEq(vault.allowlistEnabled(), sent);
        assertEq(vault.dailyCap(), cap);
        assertEq(vault.autoApproveMax(), ceiling);
        assertTrue(vault.allowed(payee));
        assertEq(vault.operator(), operator);
        assertFalse(vault.frozen());
        assertEq(vault.sessionKeyExpiry(), T0 + 1 days);
        assertEq(vault.spentToday(), 1);
    }
}

/// 5.1.4: 0 in sessionKeyExpiry, autoApproveMax or dailyCap means no limit. Every test starts from
/// the default policy the browser page deploys (1 USDC a day, 0.25 USDC a payment, 7-day key). The
/// first four show how far each single 0 reaches. The last four show what it does not reach.
contract AgentSpendPolicyOlx514Test is OlxBase {
    uint256 internal constant BALANCE = 100 * CAP;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        vault.setSessionKeyExpiry(T0 + 7 days);
    }

    /// Expiry: an owner who writes 0 to revoke ends the time bound instead, and an expired key comes
    /// back to life. The size and day gates still hold.
    function test_OLX_5_1_4_expiryZero_doesNotRevoke_revivesAnExpiredKey_capsStillBind() public {
        vm.warp(T0 + 8 days);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setSessionKeyExpiry(0);

        vm.warp(T0 + 3650 days);
        vm.startPrank(operator);
        vault.pay(payee, CEILING);
        assertEq(usdc.balanceOf(payee), CEILING);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(payee, CEILING + 1);
        for (uint256 i = 0; i < 3; i++) vault.pay(payee, CEILING);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), CAP);
    }

    /// Ceiling: autoApproveMax 0 removes the per-payment gate, and one payment can take a whole
    /// day's cap. It still cannot pass the cap.
    function test_OLX_5_1_4_ceilingZero_oneCallTakesTheWholeCap_notMore() public {
        vm.prank(owner);
        vault.setPolicy(CAP, 0, false);

        vm.startPrank(operator);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, CAP + 1);
        vault.pay(payee, CAP);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(payee, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), CAP);
    }

    /// Day: dailyCap 0 removes the daily gate. One call is still bound by the ceiling, but nothing
    /// bounds how many calls, so the whole balance leaves in one day.
    function test_OLX_5_1_4_capZero_ceilingStillBindsEachCall_butTheBalanceDrainsInADay() public {
        vm.prank(owner);
        vault.setPolicy(0, CEILING, false);

        vm.startPrank(operator);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(payee, CEILING + 1);
        for (uint256 i = 0; i < BALANCE / CEILING; i++) vault.pay(payee, CEILING);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), BALANCE);
        assertEq(vault.spentToday(), BALANCE);
    }

    /// The worst case takes setPolicy(0, 0, _) AND setSessionKeyExpiry(0), two owner transactions,
    /// for one call to drain the balance with no time, size or day limit.
    function test_OLX_5_1_4_allThreeZero_oneCallDrainsTheBalance_tenYearsLater() public {
        vm.startPrank(owner);
        vault.setPolicy(0, 0, false);
        vault.setSessionKeyExpiry(0);
        vm.stopPrank();

        vm.warp(T0 + 3650 days);
        vm.prank(operator);
        vault.pay(payee, BALANCE);
        assertEq(usdc.balanceOf(payee), BALANCE);
        assertEq(vault.balance(), 0);
    }

    /// Not reached: only the owner can write a 0. The agent key cannot, on any of the three fields.
    function testFuzz_OLX_5_1_4_nobodyButTheOwnerCanWriteZero(address caller) public {
        vm.assume(caller != owner);
        vm.startPrank(caller);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setPolicy(0, 0, false);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setSessionKeyExpiry(0);
        vm.stopPrank();
        assertEq(vault.dailyCap(), CAP);
        assertEq(vault.autoApproveMax(), CEILING);
        assertEq(vault.sessionKeyExpiry(), T0 + 7 days);
    }

    /// Not reached: all three 0 still lose to the freeze and to a replaced key, in the same block,
    /// and a compromised key can undo neither.
    function test_OLX_5_1_4_allThreeZero_freezeAndOperatorRemovalStillStopTheKey() public {
        vm.startPrank(owner);
        vault.setPolicy(0, 0, false);
        vault.setSessionKeyExpiry(0);
        vault.setFrozen(true);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.IsFrozen.selector);
        vault.pay(payee, 1);

        vm.startPrank(owner);
        vault.setFrozen(false);
        vault.setOperator(address(0));
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 0);
    }

    /// Not reached: the value the app writes to revoke, 1, stops the key in the block it lands, and
    /// needs no change to the caps.
    function test_OLX_5_1_4_appRevokeWritesOne_stopsTheKeyAtOnce() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(1);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 0);
    }

    /// Not reached: the owner's own powers are unchanged by the sentinel. withdraw has no gate at
    /// all, so a 0 grants the agent nothing the owner key did not already have. A 0 is also visible:
    /// each write emits its event with the 0 in it.
    function test_OLX_5_1_4_zeroWriteIsPublic_andTheOwnerCanStillEmptyTheVaultFirst() public {
        vm.expectEmit(address(vault));
        emit AgentSpendPolicy.SessionKeyExpirySet(0);
        vm.prank(owner);
        vault.setSessionKeyExpiry(0);
        vm.expectEmit(address(vault));
        emit AgentSpendPolicy.PolicyUpdated(0, 0, false);
        vm.prank(owner);
        vault.setPolicy(0, 0, false);

        vm.prank(owner);
        vault.withdraw(owner, BALANCE);
        vm.prank(operator);
        vm.expectRevert();
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(payee), 0);
    }
}

/// 5.1.5: sessionKeyExpiry is one vault-wide value, not bound to the operator.
contract AgentSpendPolicyOlx515Test is OlxBase {
    address internal attacker = makeAddr("attacker");
    address internal newKey = makeAddr("newKey");

    /// Revoke, then extend before replacing the key: the revoked key pays again, up to the day's cap
    /// and no further, until the replacement lands. Nothing needs to back-run: the two owner calls
    /// are separate transactions, so polling pay() is enough.
    function test_OLX_5_1_5_revokedKeyPaysAgainWhenOwnerExtendsBeforeRotating() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(1); // what the vault page's Revoke writes
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(attacker, 1);

        // An hour later, "Extend or shorten" on the page, at its default of 7 days.
        vm.warp(T0 + 1 hours);
        vm.roll(block.number + 1);
        vm.prank(owner);
        vault.setSessionKeyExpiry(block.timestamp + 7 days);

        // The next block, before the owner's setOperator lands.
        vm.roll(block.number + 1);
        vm.startPrank(operator);
        for (uint256 i = 0; i < 4; i++) vault.pay(attacker, CEILING);
        vm.expectRevert(AgentSpendPolicy.DailyCapExceeded.selector);
        vault.pay(attacker, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(attacker), CAP, "the day's whole cap, and exactly that");

        vm.roll(block.number + 1);
        vm.prank(owner);
        vault.setOperator(newKey);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(attacker, 1);
    }

    /// The other order has no window and needs no contract change. Replace first: the leaked key is
    /// out at once, the new key starts expired, and extending arms only it.
    function test_OLX_5_1_5_rotatingBeforeExtendingHasNoWindow() public {
        vm.prank(owner);
        vault.setSessionKeyExpiry(1);
        vm.prank(owner);
        vault.setOperator(newKey);

        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(attacker, 1);
        vm.prank(newKey);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setSessionKeyExpiry(T0 + 7 days);

        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.NotOperator.selector);
        vault.pay(attacker, 1);
        vm.prank(newKey);
        vault.pay(payee, 1);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(payee), 1);
    }

    /// setOperator neither reads nor writes the expiry, so a new key takes what is there: the time
    /// left, a lapsed value (fails safe), or 0 (no time bound).
    function test_OLX_5_1_5_rotatedKeyInheritsTheExpiry_documentsIt() public {
        address second = makeAddr("second");
        address third = makeAddr("third");
        address fourth = makeAddr("fourth");

        vm.prank(owner);
        vault.setSessionKeyExpiry(T0 + 1 days);
        vm.prank(owner);
        vault.setOperator(second);
        assertEq(vault.sessionKeyExpiry(), T0 + 1 days);
        vm.prank(second);
        vault.pay(payee, 1);

        vm.warp(T0 + 1 days + 1);
        vm.prank(owner);
        vault.setOperator(third);
        vm.prank(third);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(payee, 1);

        vm.prank(owner);
        vault.setSessionKeyExpiry(0);
        vm.prank(owner);
        vault.setOperator(fourth);
        assertEq(vault.sessionKeyExpiry(), 0);
        vm.warp(T0 + 3650 days);
        vm.prank(fourth);
        vault.pay(payee, 1);
    }

    /// The bound on the loss. A re-armed key gets back what it had, never more: ceiling, allowlist
    /// and freeze still bind it, and it can reach no owner power. Left in place it can spend the cap
    /// on every UTC day the lifetime touches: a 7-day lifetime set at noon touches 8.
    function test_OLX_5_1_5_reArmedKeyStaysInsideThePolicy_andTheLossIsBounded() public {
        vm.startPrank(owner);
        vault.setSessionKeyExpiry(1);
        vault.setSessionKeyExpiry(T0 + 7 days);
        vm.stopPrank();

        vm.startPrank(operator);
        vm.expectRevert(AgentSpendPolicy.AboveAutoApprove.selector);
        vault.pay(attacker, CEILING + 1);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.setSessionKeyExpiry(T0 + 365 days);
        vm.expectRevert(AgentSpendPolicy.NotOwner.selector);
        vault.withdraw(attacker, 1);
        vm.stopPrank();

        vm.prank(owner);
        vault.setPolicy(CAP, CEILING, true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.PayeeNotAllowed.selector);
        vault.pay(attacker, 1);
        vm.prank(owner);
        vault.setPolicy(CAP, CEILING, false);

        vm.prank(owner);
        vault.setFrozen(true);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.IsFrozen.selector);
        vault.pay(attacker, 1);
        vm.prank(owner);
        vault.setFrozen(false);

        for (uint256 t = T0; t <= T0 + 7 days; t += 1 days) {
            vm.warp(t);
            vm.startPrank(operator);
            for (uint256 i = 0; i < 4; i++) vault.pay(attacker, CEILING);
            vm.stopPrank();
        }
        assertEq(usdc.balanceOf(attacker), 8 * CAP);
        vm.warp(T0 + 7 days + 1);
        vm.prank(operator);
        vm.expectRevert(AgentSpendPolicy.SessionKeyExpired.selector);
        vault.pay(attacker, 1);
    }
}
