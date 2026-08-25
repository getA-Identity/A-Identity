# Unconfirmed - suspected but not proven

Collected from every Phase 3 agent. Listed so the audit report's confidence can be read
against what it could not establish, rather than only against what it could.

## Could not be exercised because the rules forbid it

- **CAP-0066 restoration on a live network.** A2 proved by test that an archived instance
  entry is restored with its value, and the CAP says the same. Neither is a live-network
  demonstration; the audit was not permitted to transact. The restoration rent was also not
  quantified.
- **CAP-0077 entry freezing.** Protocol 26 lets validators freeze ledger entries by settings
  upgrade, and pubnet currently lists 3 frozen keys. If this contract's entries were frozen,
  `withdraw` would be unreachable and no contract code could prevent it. Stated as a residual
  risk rather than a finding.

## Could not be reproduced with the tools available

- **The classic-account shared-signer collapse of INV-03.** A1 could not give an address a
  signer set through soroban-sdk testutils, so the claim that `owner != operator` separates
  authority rests on host source semantics rather than a demonstration.
- **The Wasm code entry's TTL** could not be measured in-test, because the SDK registers
  natively. Code-entry coverage rests on the SDK documentation plus a live read.
- **Stellar's in-ledger transaction ordering.** A5 proved the contract half of its
  front-running analysis and declined to assert the network half.

## Not investigated, and named so

- **Whether any live deployment ever ran with `daily_cap == 0`.** With a zero cap the
  operator can drain the vault in a single day, which A5 proved in test. Establishing it for
  the live contracts needs a historical read that was not made. Both currently read
  non-zero.
- **Whether any `mcp/` consumer computes `daily_cap - spent_today`** and can now receive a
  negative number, given `owner_pay` can push the accumulator past the cap. `mcp/` is out of
  scope.
- **No published Soroban reentrancy finding was located.** R2 searched and found none, which
  is consistent with the host prohibiting re-entry, but absence of a published finding is not
  evidence of absence.
- **No auditor write-up was found** of SAC clawback or `AUTH_REQUIRED` bricking a custody
  contract. A4 proved the mechanism by test against a mock token; nobody else appears to have
  published it.

## Weak by budget rather than by method

- **The fuzzing campaign.** About 71,000 executions total at roughly 11 per second. It found
  nothing new after the known INV-05 defect, but that is a shallow campaign and the absence
  is correspondingly weak evidence.
