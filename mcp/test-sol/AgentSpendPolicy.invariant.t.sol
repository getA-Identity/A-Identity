// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSpendPolicy} from "../contracts/AgentSpendPolicy.sol";
import {MockUSDC} from "./mocks/Tokens.sol";

/// Drives the vault through random sequences of agent payments, owner settlements,
/// withdrawals, top-ups, freezes, expiry changes, allowlist edits and clock moves, and
/// keeps its own ledger of what succeeded plus a model of what should have. The
/// invariants compare both against the contract. The cap and ceiling stay fixed so "the agent never beat the policy" has
/// one meaning across the whole run.
contract VaultHandler is Test {
    AgentSpendPolicy public immutable vault;
    MockUSDC public immutable usdc;
    address public immutable owner;
    address public immutable operator;
    uint256 public immutable cap;
    uint256 public immutable ceiling;
    address[3] internal payees;

    uint256 public ghostFunded;
    uint256 public ghostPaidOut;
    uint256 public ghostWithdrawn;
    uint256 public ghostMaxOperatorPay;
    uint256 public ghostPaysWhileFrozen;
    uint256 public ghostPaysAfterExpiry;
    uint256 public ghostPaysToUnlisted;
    uint256 public ghostOperatorPays;
    uint256 public ghostCalls;
    uint256 public ghostUnexpectedSuccess;
    uint256 public ghostUnexpectedRefusal;
    mapping(uint256 => uint256) public ghostOperatorSpent;
    mapping(uint256 => uint256) public ghostOwnerSpent;
    uint256[] internal days_;
    mapping(uint256 => bool) internal seen;

    constructor(AgentSpendPolicy v, MockUSDC u, address o, address op, uint256 funded) {
        vault = v;
        usdc = u;
        owner = o;
        operator = op;
        cap = v.dailyCap();
        ceiling = v.autoApproveMax();
        ghostFunded = funded;
        payees[0] = makeAddr("payeeA");
        payees[1] = makeAddr("payeeB");
        payees[2] = makeAddr("payeeC");
    }

    function pay(uint256 seed, uint256 amount) external {
        ghostCalls++;
        address to = payees[seed % 3];
        amount = bound(amount, 0, ceiling * 2);
        _operatorPay(to, amount);
    }

    /// Puts the vault back inside the policy and pays within the room left today, so every
    /// run lands agent payments however early it froze or expired the key. Without it some
    /// runs never move a cent and the safety invariants hold vacuously. Two ownerPay calls
    /// can push the day past the cap (finding F-2), and then even a zero payment is refused
    /// until midnight, so in that case the clock moves to the next UTC day first.
    function payWithinPolicy(uint256 seed, uint256 amount) external {
        ghostCalls++;
        address to = payees[seed % 3];
        vm.startPrank(owner);
        vault.setFrozen(false);
        vault.setSessionKeyExpiry(0);
        vault.setAllowed(to, true);
        vm.stopPrank();
        if (vault.spentToday() > cap) vm.warp((block.timestamp / 1 days + 1) * 1 days);
        uint256 room = cap - _min(cap, vault.spentToday());
        uint256 max = _min(_min(ceiling, room), usdc.balanceOf(address(vault)));
        _operatorPay(to, bound(amount, 0, max));
    }

    /// The model: an independent restatement of every gate in `pay`. A payment the model
    /// allows must succeed (liveness: no false refusals) and one it refuses must revert
    /// (safety), so even a reverted attempt is a checked prediction.
    function _expectedOk(address to, uint256 amount) internal view returns (bool) {
        if (vault.frozen()) return false;
        uint256 expiry = vault.sessionKeyExpiry();
        if (expiry != 0 && block.timestamp > expiry) return false;
        if (vault.allowlistEnabled() && !vault.allowed(to)) return false;
        if (amount > ceiling) return false;
        if (vault.spentToday() + amount > cap) return false;
        if (usdc.balanceOf(address(vault)) < amount) return false;
        return true;
    }

    function _operatorPay(address to, uint256 amount) internal {
        bool expectedOk = _expectedOk(to, amount);
        bool wasFrozen = vault.frozen();
        uint256 expiry = vault.sessionKeyExpiry();
        bool unlisted = vault.allowlistEnabled() && !vault.allowed(to);
        uint256 d = vault.today();

        vm.prank(operator);
        try vault.pay(to, amount) {
            if (!expectedOk) ghostUnexpectedSuccess++;
            _touch(d);
            ghostOperatorPays++;
            ghostOperatorSpent[d] += amount;
            ghostPaidOut += amount;
            if (amount > ghostMaxOperatorPay) ghostMaxOperatorPay = amount;
            if (wasFrozen) ghostPaysWhileFrozen++;
            if (expiry != 0 && block.timestamp > expiry) ghostPaysAfterExpiry++;
            if (unlisted) ghostPaysToUnlisted++;
        } catch {
            if (expectedOk) ghostUnexpectedRefusal++;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function ownerPay(uint256 seed, uint256 amount) external {
        ghostCalls++;
        address to = payees[seed % 3];
        amount = bound(amount, 0, cap);
        uint256 d = vault.today();
        vm.prank(owner);
        try vault.ownerPay(to, amount) {
            _touch(d);
            ghostOwnerSpent[d] += amount;
            ghostPaidOut += amount;
        } catch {}
    }

    function withdraw(uint256 amount) external {
        ghostCalls++;
        amount = bound(amount, 0, cap);
        vm.prank(owner);
        try vault.withdraw(owner, amount) {
            ghostWithdrawn += amount;
        } catch {}
    }

    function fund(uint256 amount) external {
        ghostCalls++;
        amount = bound(amount, 0, 5 * cap);
        usdc.mint(address(vault), amount);
        ghostFunded += amount;
    }

    function warp(uint256 secs) external {
        ghostCalls++;
        secs = bound(secs, 0, 2 days);
        vm.warp(block.timestamp + secs);
    }

    function setFrozen(bool frozen) external {
        ghostCalls++;
        vm.prank(owner);
        vault.setFrozen(frozen);
    }

    function setExpiry(uint256 at, bool unbounded) external {
        ghostCalls++;
        uint256 expiry = unbounded ? 0 : bound(at, block.timestamp - 1 days, block.timestamp + 1 days);
        vm.prank(owner);
        vault.setSessionKeyExpiry(expiry);
    }

    function setAllowlist(uint256 seed, bool allowed, bool enabled) external {
        ghostCalls++;
        vm.startPrank(owner);
        vault.setAllowed(payees[seed % 3], allowed);
        vault.setPolicy(cap, ceiling, enabled);
        vm.stopPrank();
    }

    function _touch(uint256 d) internal {
        if (!seen[d]) {
            seen[d] = true;
            days_.push(d);
        }
    }

    function daysTouched() external view returns (uint256[] memory) {
        return days_;
    }
}

contract AgentSpendPolicyInvariantTest is Test {
    uint256 internal constant CAP = 1_000_000;
    uint256 internal constant CEILING = 250_000;
    uint256 internal constant FUNDED = 20 * CAP;

    AgentSpendPolicy internal vault;
    MockUSDC internal usdc;
    VaultHandler internal handler;

    function setUp() public {
        vm.warp(1_790_985_600 + 12 hours);
        address owner = makeAddr("owner");
        address operator = makeAddr("operator");
        usdc = new MockUSDC();
        vault = new AgentSpendPolicy(owner, operator, address(usdc), CAP, CEILING);
        usdc.mint(address(vault), FUNDED);
        handler = new VaultHandler(vault, usdc, owner, operator, FUNDED);
        targetContract(address(handler));
    }

    /// The core promise: whatever the sequence, the agent's own spending on any UTC day
    /// never passes the daily cap.
    function invariant_agentSpendPerDayNeverExceedsTheCap() public view {
        uint256[] memory ds = handler.daysTouched();
        for (uint256 i = 0; i < ds.length; i++) {
            assertLe(handler.ghostOperatorSpent(ds[i]), CAP);
        }
    }

    function invariant_dayLedgerMatchesEverySuccessfulPayment() public view {
        uint256[] memory ds = handler.daysTouched();
        for (uint256 i = 0; i < ds.length; i++) {
            assertEq(vault.spentOnDay(ds[i]), handler.ghostOperatorSpent(ds[i]) + handler.ghostOwnerSpent(ds[i]));
        }
    }

    function invariant_noAgentPaymentAboveTheCeiling() public view {
        assertLe(handler.ghostMaxOperatorPay(), CEILING);
    }

    function invariant_noAgentPaymentWhileFrozenExpiredOrUnlisted() public view {
        assertEq(handler.ghostPaysWhileFrozen(), 0);
        assertEq(handler.ghostPaysAfterExpiry(), 0);
        assertEq(handler.ghostPaysToUnlisted(), 0);
    }

    function invariant_fundsAreConserved() public view {
        assertEq(usdc.balanceOf(address(vault)) + handler.ghostPaidOut() + handler.ghostWithdrawn(), handler.ghostFunded());
    }

    function invariant_everyPaymentMatchesTheModel() public view {
        assertEq(handler.ghostUnexpectedSuccess(), 0, "pay succeeded where the policy refuses");
        assertEq(handler.ghostUnexpectedRefusal(), 0, "pay reverted where the policy allows");
    }

    /// Non-vacuity, checked per run: the safety invariants above mean nothing in a run
    /// where the agent never paid. payWithinPolicy makes a full-depth run without one
    /// vanishingly rare. Short runs are exempt: forge replays a persisted counterexample
    /// shrunk to a few calls, and that replay has no reason to contain a payment.
    function afterInvariant() public view {
        if (handler.ghostCalls() < 64) return;
        assertGt(handler.ghostOperatorPays(), 0, "no agent payment succeeded in this run");
    }
}
