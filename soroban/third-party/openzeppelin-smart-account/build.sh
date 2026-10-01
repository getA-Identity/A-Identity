#!/usr/bin/env bash
# Rebuilds OpenZeppelin's smart account, WebAuthn verifier and Ed25519 verifier from the
# audited release line (stellar-contracts v0.7.2) and prints the sha256 of each wasm, so
# anyone can check the hashes we upload against code they built themselves.
#
# Nothing here is A-Identity code. The source is fetched from OpenZeppelin's repository
# into a scratch directory and never copied into this one. The script never touches a
# network other than GitHub and never signs or submits anything.
#
# Usage:
#   soroban/third-party/openzeppelin-smart-account/build.sh [--kit-check] [WORK_DIR]
#
#   WORK_DIR     scratch directory for the clone, the cargo target and the outputs.
#                Defaults to a fresh mktemp directory. It is never deleted for you.
#   --kit-check  also rebuild OpenZeppelin/stellar-contracts@1e513890, the commit
#                smart-account-kit 0.8.0 deployed, and require its three published
#                hashes. That proves the toolchain on this machine is the one that
#                matters before you trust a v0.7.2 hash it printed.
#
# Environment:
#   STELLAR_BIN  a stellar CLI to use instead of downloading 27.0.0. It must report
#                version 27.0.0; any other version is refused, because the optimizer
#                ships inside the CLI and a different one yields different bytes.
#
# Exit status is non-zero if any hash differs from the expected value below.
set -euo pipefail

# ---- Pins. Change one and every expected hash below has to be re-derived. ----------
OZ_REPO="https://github.com/OpenZeppelin/stellar-contracts"
OZ_TAG="v0.7.2"
OZ_TAG_COMMIT="a9c42169000638da937577f592ebf61a7a3c94ca"
KIT_COMMIT="1e513890ecf79833c9d6e7ef38a9358001c0b111"
RUST_TOOLCHAIN="1.91.1"
STELLAR_CLI_VERSION="27.0.0"
TARGET="wasm32v1-none"

# Release tarball digests as GitHub publishes them for stellar-cli v27.0.0.
stellar_cli_sha256() {
  case "$1" in
    aarch64-apple-darwin) echo "70a259d10534259656b63fe7073116ec3bda0ce83839c9c72364750614beeae6" ;;
    x86_64-apple-darwin) echo "126de54c034d2fd2e902c61a9e87704bc38c20f916b1727eaa787b6988f09296" ;;
    aarch64-unknown-linux-gnu) echo "a341adcc152e1865ea61d6c332e75b3d82b1f2f32108198fac97c50878b17034" ;;
    x86_64-unknown-linux-gnu) echo "357bf712f6353c28cd33c794402a3c87231757a5b305e6ef1604365af4fdd556" ;;
    *) return 1 ;;
  esac
}

# package name | wasm file | expected sha256 at v0.7.2 | expected sha256 at the kit commit
PACKAGES=(
  "multisig-account-example|multisig_account_example.wasm|a12747ff6c139dc14fc2fd30d200d6bbb5da7b5d59812c047ce1f9cad226b289|1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a"
  "multisig-webauthn-verifier-example|multisig_webauthn_verifier_example.wasm|e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76|e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76"
  "multisig-ed25519-verifier-example|multisig_ed25519_verifier_example.wasm|60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477|60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477"
)

# ---- Arguments -------------------------------------------------------------------------
KIT_CHECK=0
WORK_DIR=""
for arg in "$@"; do
  case "$arg" in
    --kit-check) KIT_CHECK=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) WORK_DIR="$arg" ;;
  esac
done
if [ -z "$WORK_DIR" ]; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oz-smart-account-build.XXXXXX")"
fi
mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd)"
OUT_DIR="$WORK_DIR/out"
mkdir -p "$OUT_DIR"
echo "work dir: $WORK_DIR"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
bytes_of() { wc -c < "$1" | tr -d ' '; }

# ---- Rust: install the pinned toolchain beside the default one, never over it ---------
command -v rustup >/dev/null 2>&1 || { echo "rustup is required" >&2; exit 1; }
if ! rustup run "$RUST_TOOLCHAIN" rustc --version >/dev/null 2>&1; then
  rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target "$TARGET"
else
  rustup target add --toolchain "$RUST_TOOLCHAIN" "$TARGET"
fi
# OpenZeppelin's rust-toolchain.toml says channel "stable", which floats. This env var
# overrides it for every cargo and rustc this script starts.
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
RUSTC_VERSION="$(rustc --version)"
echo "rustc: $RUSTC_VERSION"

# ---- Stellar CLI: the pinned release binary, checked against GitHub's digest ----------
if [ -n "${STELLAR_BIN:-}" ]; then
  STELLAR="$STELLAR_BIN"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM="aarch64-apple-darwin" ;;
    Darwin-x86_64) PLATFORM="x86_64-apple-darwin" ;;
    Linux-aarch64) PLATFORM="aarch64-unknown-linux-gnu" ;;
    Linux-x86_64) PLATFORM="x86_64-unknown-linux-gnu" ;;
    *) echo "no pinned stellar-cli $STELLAR_CLI_VERSION digest for $(uname -s)-$(uname -m); set STELLAR_BIN" >&2; exit 1 ;;
  esac
  TARBALL="stellar-cli-$STELLAR_CLI_VERSION-$PLATFORM.tar.gz"
  mkdir -p "$WORK_DIR/stellar-cli"
  curl -fsSL -o "$WORK_DIR/stellar-cli/$TARBALL" \
    "https://github.com/stellar/stellar-cli/releases/download/v$STELLAR_CLI_VERSION/$TARBALL"
  GOT="$(sha256_of "$WORK_DIR/stellar-cli/$TARBALL")"
  WANT="$(stellar_cli_sha256 "$PLATFORM")"
  if [ "$GOT" != "$WANT" ]; then
    echo "stellar-cli tarball digest $GOT does not match the published $WANT; refusing to run it" >&2
    exit 1
  fi
  tar -xzf "$WORK_DIR/stellar-cli/$TARBALL" -C "$WORK_DIR/stellar-cli"
  STELLAR="$WORK_DIR/stellar-cli/stellar"
fi
STELLAR_VERSION="$("$STELLAR" --version | head -n 1)"
case "$STELLAR_VERSION" in
  "stellar $STELLAR_CLI_VERSION "*) ;;
  *) echo "stellar CLI reports '$STELLAR_VERSION', expected $STELLAR_CLI_VERSION" >&2; exit 1 ;;
esac
echo "stellar: $STELLAR_VERSION"

# ---- Fetch a clean source tree for one ref and build the three packages ---------------
FAILED=0
RESULTS=()

build_ref() {
  local label="$1" ref="$2" want_commit="$3" column="$4"
  local src="$WORK_DIR/src-$label"
  rm -rf "$src"
  if [ "$ref" = "$want_commit" ]; then
    # A bare commit cannot be cloned by name, so fetch exactly that object.
    git init -q "$src"
    git -C "$src" remote add origin "$OZ_REPO"
    git -C "$src" fetch -q --depth 1 origin "$ref"
    git -c advice.detachedHead=false -C "$src" checkout -q --detach FETCH_HEAD
  else
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$ref" "$OZ_REPO" "$src"
  fi
  local head
  head="$(git -C "$src" rev-parse HEAD)"
  if [ "$head" != "$want_commit" ]; then
    echo "$label: $ref resolved to $head, expected $want_commit; refusing to build" >&2
    exit 1
  fi
  echo "$label: source at $head"

  export CARGO_TARGET_DIR="$WORK_DIR/target-$label"
  local entry pkg file want got size
  for entry in "${PACKAGES[@]}"; do
    IFS='|' read -r pkg file want_tag want_kit <<<"$entry"
    if [ "$column" = "tag" ]; then want="$want_tag"; else want="$want_kit"; fi
    (cd "$src" && "$STELLAR" contract build --locked --optimize=true --package "$pkg")
    local wasm="$CARGO_TARGET_DIR/$TARGET/release/$file"
    got="$(sha256_of "$wasm")"
    size="$(bytes_of "$wasm")"
    cp "$wasm" "$OUT_DIR/$label-$file"
    if [ "$got" = "$want" ]; then
      RESULTS+=("$label $pkg $size bytes sha256 $got MATCH")
    else
      RESULTS+=("$label $pkg $size bytes sha256 $got MISMATCH (expected $want)")
      FAILED=1
    fi
  done
}

if [ "$KIT_CHECK" = "1" ]; then
  build_ref "kit-1e513890" "$KIT_COMMIT" "$KIT_COMMIT" "kit"
fi
build_ref "oz-$OZ_TAG" "$OZ_TAG" "$OZ_TAG_COMMIT" "tag"

echo
echo "OpenZeppelin stellar-contracts $OZ_TAG ($OZ_TAG_COMMIT)"
echo "toolchain: $RUSTC_VERSION; $STELLAR_VERSION; target $TARGET"
echo "command: stellar contract build --locked --optimize=true --package <package>"
for line in "${RESULTS[@]}"; do echo "  $line"; done
echo "wasm copies: $OUT_DIR"
if [ "$FAILED" != "0" ]; then
  echo "At least one hash differs. Rust wasm builds are not guaranteed bit-reproducible across" >&2
  echo "machines; compare the contract spec and the code section before concluding anything." >&2
  exit 1
fi
