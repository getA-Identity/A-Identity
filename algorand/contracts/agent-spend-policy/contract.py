# AgentSpendPolicy, third implementation: Solidity on the EVM chains, Rust on
# Soroban, Algorand Python here. Same policy, this chain's idioms:
#
#   - The vault is an application holding a USDC ASA. It must opt in to the
#     asset (Algorand's trustline), which costs the app account a 0.1 ALGO
#     minimum-balance step; opt_in_asset exists for exactly that.
#   - Payouts are inner transactions, fee 0: the outer app call's pooled fee
#     covers them, so the app account never needs fee ALGO of its own.
#   - Refusals are assert messages. Like Soroban, a refused call fails in
#     SIMULATION and nothing reaches the ledger, so a refusal has no
#     transaction hash; the simulate response carries the message instead.
#   - Immutability is the ARC-4 router's default: no update or delete handler
#     is declared, so both actions are rejected. Like the Soroban vault there
#     is no owner-transfer entrypoint; the owner is fixed at creation.
#
# Policy semantics, identical to the other two implementations: the OPERATOR
# (the agent) may pay while unfrozen, per-payment at most auto_approve_max,
# per-UTC-day at most daily_cap, optionally only to allowlisted payees. The
# OWNER (the human) may freeze, change policy, manage the allowlist, pay
# through a freeze, and withdraw. Compile with puyapy; deploy via
# mcp/scripts/algo-vault-deploy.mjs.
from algopy import (
    Account,
    Asset,
    Global,
    Txn,
    UInt64,
    arc4,
    gtxn,
    itxn,
    op,
)

SECONDS_PER_DAY = 86400


class AgentSpendPolicy(arc4.ARC4Contract):
    def __init__(self) -> None:
        self.owner = Account()
        self.operator = Account()
        self.asset_id = UInt64(0)
        self.daily_cap = UInt64(0)
        self.auto_approve_max = UInt64(0)
        self.spent_today = UInt64(0)
        self.day = UInt64(0)
        self.frozen = UInt64(0)
        self.allowlist_enabled = UInt64(0)

    @arc4.abimethod(create="require")
    def create(
        self,
        owner: Account,
        operator: Account,
        asset: Asset,
        daily_cap: UInt64,
        auto_approve_max: UInt64,
    ) -> None:
        assert auto_approve_max <= daily_cap, "CEILING_ABOVE_CAP"
        self.owner = owner
        self.operator = operator
        self.asset_id = asset.id
        self.daily_cap = daily_cap
        self.auto_approve_max = auto_approve_max
        self.day = Global.latest_timestamp // SECONDS_PER_DAY

    @arc4.abimethod
    def opt_in_asset(self) -> None:
        # Owner-only, and the app account must already hold the 0.1 ALGO step.
        assert Txn.sender == self.owner, "NOT_OWNER"
        itxn.AssetTransfer(
            xfer_asset=self.asset_id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()

    def _roll_day(self) -> None:
        today = Global.latest_timestamp // SECONDS_PER_DAY
        if today != self.day:
            self.day = today
            self.spent_today = UInt64(0)

    def _send(self, payee: Account, amount: UInt64) -> None:
        itxn.AssetTransfer(
            xfer_asset=self.asset_id,
            asset_receiver=payee,
            asset_amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def pay(self, payee: Account, amount: UInt64) -> None:
        assert Txn.sender == self.operator, "NOT_OPERATOR"
        assert self.frozen == UInt64(0), "FROZEN"
        assert amount > UInt64(0), "ZERO_AMOUNT"
        assert amount <= self.auto_approve_max, "ABOVE_AUTO_APPROVE"
        self._roll_day()
        assert self.spent_today + amount <= self.daily_cap, "DAILY_CAP_EXCEEDED"
        if self.allowlist_enabled != UInt64(0):
            allowed, exists = op.Box.get(payee.bytes)
            assert exists and allowed == b"1", "PAYEE_NOT_ALLOWED"
        self.spent_today += amount
        self._send(payee, amount)

    @arc4.abimethod
    def owner_pay(self, payee: Account, amount: UInt64) -> None:
        # The human override: ignores freeze, ceiling and cap on purpose, and
        # still counts against today so the agent cannot ride on top of it.
        assert Txn.sender == self.owner, "NOT_OWNER"
        assert amount > UInt64(0), "ZERO_AMOUNT"
        self._roll_day()
        self.spent_today += amount
        self._send(payee, amount)

    @arc4.abimethod
    def withdraw(self, to: Account, amount: UInt64) -> None:
        assert Txn.sender == self.owner, "NOT_OWNER"
        self._send(to, amount)

    @arc4.abimethod
    def set_policy(self, daily_cap: UInt64, auto_approve_max: UInt64, allowlist_enabled: UInt64) -> None:
        assert Txn.sender == self.owner, "NOT_OWNER"
        assert auto_approve_max <= daily_cap, "CEILING_ABOVE_CAP"
        self.daily_cap = daily_cap
        self.auto_approve_max = auto_approve_max
        self.allowlist_enabled = allowlist_enabled

    @arc4.abimethod
    def set_frozen(self, frozen: UInt64) -> None:
        assert Txn.sender == self.owner, "NOT_OWNER"
        self.frozen = frozen

    @arc4.abimethod
    def set_operator(self, operator: Account) -> None:
        assert Txn.sender == self.owner, "NOT_OWNER"
        self.operator = operator

    @arc4.abimethod
    def set_allowed(self, payee: Account, allowed: UInt64) -> None:
        assert Txn.sender == self.owner, "NOT_OWNER"
        if allowed != UInt64(0):
            op.Box.put(payee.bytes, b"1")
        else:
            _deleted = op.Box.delete(payee.bytes)

    @arc4.abimethod(readonly=True)
    def policy(self) -> arc4.Tuple[arc4.UInt64, arc4.UInt64, arc4.UInt64, arc4.UInt64, arc4.UInt64, arc4.UInt64]:
        return arc4.Tuple(
            (
                arc4.UInt64(self.daily_cap),
                arc4.UInt64(self.auto_approve_max),
                arc4.UInt64(self.spent_today),
                arc4.UInt64(self.day),
                arc4.UInt64(self.frozen),
                arc4.UInt64(self.allowlist_enabled),
            )
        )
