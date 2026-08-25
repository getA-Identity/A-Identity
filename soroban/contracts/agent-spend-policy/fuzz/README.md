# Fuzzing the policy ladder

The Soroban fuzzing rule is the one worth remembering: **any `panic!` is a bug.** A contract
is expected to refuse with `panic_with_error!` and a typed `contracterror`, so a raw panic
reaching the fuzzer means an input found a path the error table does not describe.

```bash
rustup component add rust-src --toolchain nightly     # once
cargo +nightly fuzz run policy_ladder --sanitizer=thread --build-std -- -max_total_time=300
```

Four things are not obvious, and each costs an hour if you rediscover it. All four were
hit while committing this target, so the flags above are the ones that actually work rather
than the ones that ought to.

1. `fuzz/Cargo.toml` ends with an empty `[workspace]` table. Without it cargo tries to
   inherit the parent workspace and refuses to build.
2. `--sanitizer=thread` is required on macOS, and it is not the default. The default
   address sanitizer fails at link time with `initializer pointer has no target`, because
   the contract is built `crate-type = ["lib", "cdylib"]` and ASAN cannot produce the dylib.
3. `--build-std` is required alongside it, or the sanitizer is a `-Zsanitizer` ABI mismatch
   against the prebuilt std.
4. `arbitrary` must be a DIRECT dependency of the fuzz crate. soroban-sdk re-exports the
   `Arbitrary` derive, but the code that derive expands to refers to `arbitrary::` at the
   crate root, so without it the build fails with E0433.
5. The contract's `testutils` feature has to be on for the target to construct an `Env`.
   It is opt-in and absent from `default`, which is why the fuzz manifest asks for it
   explicitly. It cannot leak into the release artifact: soroban-sdk's testutils does not
   compile for `wasm32v1-none` at all, so a release build asking for it fails rather than
   silently shipping test hooks.

## What has been run

2026-08-24, audit agent A6: **51,218 executions, no panic reached.**

2026-08-25, this committed target: **20,136 executions in 61 s, no panic reached.**

2026-08-25, re-run of that same committed target to check that "re-runnable" is true
rather than asserted: **20,136 executions, no panic reached, exit 0**, archived at
`audit/tool-output/P5-fuzz-rerun.txt`. It took 168 s rather than 61 s on the same machine.
The run COUNT is fixed by `-runs=`, so it is the wall clock that varies and neither number
is a property of the contract; the point of the re-run is that the target still builds and
still finds nothing, not that it finds it at a particular speed.

Two earlier runs crashed, both on the same assertion, and the story is worth keeping. The
target asserted the invariant as it was written in the threat model at the time: that the
sum of `pay` and `owner_pay` in a UTC day stays under `daily_cap`. It does not.
`check_owner_pay` accumulates into the day total and is never compared against the cap.

```
INV-05 violated: spent 18446743094943547164 > cap 18446743094540894209
```

That is finding A3-07 / A5-01, reached independently by three methods: reading the ladder,
differential comparison against the Solidity original, and random input. The invariant text
was the defect, not the contract.

The crash input was NOT preserved. This file used to say it was archived at
`audit/tool-output/A6-fuzz-crash-1-inv05.bin`; that file has never existed on any branch,
and the same claim was corrected in `findings/A6-panics-dos.md` and `AUDIT_REPORT.md`
without this third copy being noticed. The finding does not depend on it: A3-07 and A5-01
were each reached by reading the ladder and by differential comparison, and both carry
committed tests.

The corpus is not committed. 51k executions at about 11 per second is a shallow campaign by
fuzzing standards, and it found nothing new; a longer run with a committed seed corpus is
listed as unfinished work in the audit report rather than claimed as done.
