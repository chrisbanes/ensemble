# Reproducible Rust Toolchain Design

## Problem

The workspace declares Rust 1.80 as its minimum supported Rust version (MSRV), but the locked dependency graph includes packages that require newer compilers. `clap 4.6.1` and `reqwest 0.13.4` require Rust 1.85, while the current graph's highest declared minimum is Rust 1.88 from packages including `agent-client-protocol-schema 0.14.0`, `serde_with 3.21.0`, `plist 1.10.0`, and `time 0.3.53`. CI installs the floating `stable` channel in every Rust job, so compiler and Clippy upgrades can change build behavior without a repository change or review. Rust 1.97 exposed this failure mode when new Clippy diagnostics broke main while local Rust 1.96 still passed.

Pull request #329 fixed the immediate Rust 1.97 Clippy diagnostics. This design addresses the underlying version contracts so future toolchain changes are explicit and reproducible.

## Goals

- Declare an MSRV that matches the resolved dependency graph.
- Verify the declared MSRV in CI.
- Pin one exact Rust release for normal development, linting, testing, packaging, and releases.
- Ensure toolchain upgrades happen through reviewed repository changes rather than changes to the floating `stable` channel.
- Document the distinction between compatibility and development toolchains.

## Non-Goals

- Preserve Rust 1.80 by downgrading or pinning dependencies.
- Run Clippy, the complete test suite, or release packaging on the MSRV.
- Change application behavior or dependency versions.
- Rework the GitHub Actions workflow beyond Rust toolchain selection and MSRV verification.

## Version Contracts

Ensemble will maintain two explicit Rust version contracts:

1. **MSRV: Rust 1.88.0.** The workspace `rust-version` is `1.88`, and CI compiles all workspace targets with Rust 1.88.0. This establishes the oldest compiler the locked source and dependency graph must support.
2. **Primary toolchain: Rust 1.97.0.** A checked-in `rust-toolchain.toml` selects Rust 1.97.0 for local development and normal CI jobs. Clippy, formatting, tests, product E2E checks, desktop builds, bundles, and release artifacts use this exact version.

The primary toolchain may advance independently of the MSRV. Raising the MSRV requires an intentional compatibility decision and corresponding `Cargo.toml`, CI, and documentation changes.

## Repository Toolchain

Add a root `rust-toolchain.toml` containing:

```toml
[toolchain]
channel = "1.97.0"
profile = "minimal"
components = ["clippy", "rustfmt"]
```

Rustup automatically discovers this file for local commands and GitHub-hosted runner commands executed inside the repository. The minimal profile avoids unnecessary CI downloads while the explicit components support the existing formatting and Clippy gates.

Normal CI jobs will stop invoking `dtolnay/rust-toolchain@stable`. This removes the floating version selector and avoids duplicating `1.97.0` across jobs. The release CLI matrix will install its dynamic cross-compilation target with `rustup target add "${{ matrix.target }}"` before building; the host target remains supplied by the pinned toolchain.

## MSRV Verification

Add an independent `msrv` job to `.github/workflows/ci.yml`. It will:

1. Check out the repository.
2. Install Rust 1.88.0 with `dtolnay/rust-toolchain@1.88.0`.
3. Restore a Rust cache isolated for the MSRV job.
4. Run `cargo +1.88.0 check --workspace --all-targets` with `SKIP_UI_BUILD=1`.

The explicit `+1.88.0` override takes precedence over `rust-toolchain.toml`, making the compiler used by the compatibility check visible in the command itself. `--all-targets` compiles library, binary, example, benchmark, and test targets without paying the cost of executing every test on the oldest compiler. `SKIP_UI_BUILD=1` keeps Rust target compilation independent of generated frontend assets. On Linux, the job installs the same WebKitGTK and AppIndicator development packages as the existing desktop check so the all-workspace check includes `ensemble-desktop` rather than silently excluding a crate that inherits the workspace MSRV.

Clippy remains exclusive to Rust 1.97.0 because lint sets change between compiler releases. The compatibility contract requires successful compilation on the MSRV, while the quality contract requires warning-free code on the pinned primary compiler.

## Intentional Upgrades

Renovate already ignores the Cargo `rust-version` dependency, so it will not raise the MSRV automatically. Add a package rule for the built-in `rust-toolchain` manager that:

- matches the `toolchain` dependency type;
- uses `rangeStrategy: "pin"` so updates retain an exact patch release;
- disables automerge for toolchain updates; and
- labels the update as a dependency change.

Renovate may then propose primary toolchain upgrades, but each upgrade must pass CI and receive normal review before merge. The upgrade PR will surface new compiler and Clippy behavior without silently changing unrelated CI runs.

## Documentation

Update `docs/contributing.md` to state:

- Rust 1.88 is the MSRV;
- Rustup automatically selects the pinned Rust 1.97.0 development toolchain from `rust-toolchain.toml`;
- normal local checks and CI use the pinned toolchain;
- the MSRV command is `cargo +1.88.0 check --workspace --all-targets`; and
- primary toolchain upgrades are Renovate-proposed, reviewed changes.

Update `AGENTS.md` so repository guidance no longer claims Rust 1.80 and so its CI description includes the explicit MSRV check and pinned primary toolchain.

No application specification update is needed because this change affects build and contribution policy rather than runtime behavior or user-facing contracts.

## Verification

Implementation is complete when the following pass:

```sh
cargo +1.88.0 check --workspace --all-targets
cargo fmt --all -- --check
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo test --workspace --exclude ensemble-desktop
SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
```

The implementation should also confirm that plain `rustc --version` resolves to 1.97.0 inside the repository and that `renovate-config-validator renovate.json` passes if the validator is available.

## Acceptance Criteria Mapping

- The workspace `rust-version = "1.88"` matches the highest declared minimum in the resolved dependency graph.
- The dedicated MSRV job runs an explicit Rust 1.88.0 all-targets check, including the desktop crate.
- `rust-toolchain.toml` pins primary development and CI behavior to Rust 1.97.0.
- Existing `-D warnings` Clippy checks run on the pinned primary toolchain; pull request #329 already resolves the currently known Rust 1.97 diagnostics.
- Renovate proposes exact toolchain updates without automerging them, making upgrades intentional and reviewable.
