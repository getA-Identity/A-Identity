# AGENTS.md

Where to look and what to run in this repository. Conventions for changing code are in
[CLAUDE.md](CLAUDE.md); they apply to any coding agent.

## Evaluating the NEAR HACKATHON 2026 entry (A-Identity Guard for NEAR)

- Read [near/README.md](near/README.md) first: what the entry is, what was built in the hackathon
  window and what is baseline, and how each claim is checked.
- From the repository root, `node near/judge/judge.mjs` checks each claim in that README's claims
  table against public NEAR chain data or the repository. It needs no keys and no install (Node 22
  or later). `node near/judge/judge.mjs --offline` replays the committed RPC answers with no
  network. Each line is PASS, FAIL or SKIP, and every SKIP states its reason.
- The submitted state is the tag `hackathon-submission`; the work built in the window is
  `git diff --stat pre-hackathon hackathon-submission`.
- In `near/contracts`, never run `cargo build`: near-sdk 5.30.1 refuses host builds. Use the
  commands in near/README.md, "Reproduce from source".
- The `mcp` tests need the root install first: `npm ci` at the repository root, then
  `npm ci --prefix mcp && npm test --prefix mcp`.
