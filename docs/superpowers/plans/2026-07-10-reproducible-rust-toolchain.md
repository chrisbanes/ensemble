# Reproducible Rust Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ensemble's Rust 1.95 MSRV and pinned Rust 1.97.0 development/CI toolchain explicit, reproducible, continuously verified, and intentionally upgraded.

**Architecture:** Use Cargo's workspace `rust-version` as the compatibility declaration and a root `rust-toolchain.toml` as the single source of truth for normal development and CI compiler selection. Add a separate CI job that overrides the repository toolchain with Rust 1.95.0 for an all-targets compatibility check, while normal lint, test, desktop, bundle, and release jobs consume the pinned Rust 1.97.0 toolchain. Let Renovate propose exact primary-toolchain updates, but require review rather than automerge.

**Tech Stack:** Cargo workspace metadata, Rustup toolchain overrides, GitHub Actions, Renovate, Markdown

---

## File Structure

- Create `rust-toolchain.toml`: select the exact primary Rust release and required developer/CI components.
- Modify `Cargo.toml`: raise the workspace MSRV inherited by all four crates.
- Modify `.github/workflows/ci.yml`: remove floating primary toolchain installs, add the explicit MSRV check, and install release cross-targets on the pinned toolchain.
- Modify `renovate.json`: make exact Rust toolchain upgrades review-only.
- Modify `docs/contributing.md`: document the compatibility and primary toolchain contracts and their verification commands.
- Modify `AGENTS.md`: keep repository automation guidance aligned with the new MSRV and CI policy.

### Task 1: Declare the MSRV and Pin the Primary Toolchain

**Files:**
- Create: `rust-toolchain.toml`
- Modify: `Cargo.toml:5-10`

- [ ] **Step 1: Verify the current version contract is inconsistent**

Run:

```sh
test ! -f rust-toolchain.toml
cargo metadata --format-version 1 --locked |
  jq -e '[.packages[] | select(.source == null) | .rust_version] | all(. == "1.95")'
```

Expected: the file assertion passes, then the metadata assertion fails because workspace crates currently inherit `rust-version = "1.80"`.

- [ ] **Step 2: Raise the workspace MSRV**

In the root `Cargo.toml`, change `[workspace.package]` to:

```toml
[workspace.package]
version = "0.0.1"
edition = "2021"
license = "MIT"
rust-version = "1.95"
repository = "https://github.com/chrisbanes/ensemble"
```

Do not change dependency versions. The current locked graph's highest declared metadata requirement is Rust 1.88, but `libsqlite3-sys 0.38.1` declares no `rust-version` and uses `cfg_select!` in its bundled build script. Rust 1.94 fails there and Rust 1.95 passes the complete workspace check, so Rust 1.95 is the tested compiler boundary.

- [ ] **Step 3: Add the pinned primary toolchain**

Create `rust-toolchain.toml` with:

```toml
[toolchain]
channel = "1.97.0"
profile = "minimal"
components = ["clippy", "rustfmt"]
```

The exact patch version prevents local and CI compiler behavior from changing when Rust publishes a new stable release.

- [ ] **Step 4: Verify Rustup and Cargo resolve the new contracts**

Run:

```sh
rustc --version
cargo metadata --format-version 1 --locked |
  jq -e '[.packages[] | select(.source == null) | .rust_version] | all(. == "1.95")'
```

Expected: `rustc 1.97.0 (...)` and a successful `jq` assertion.

- [ ] **Step 5: Check formatting and commit the version contract**

Run:

```sh
cargo fmt --all -- --check
git diff --check
git add Cargo.toml rust-toolchain.toml
git commit -m "build: pin Rust toolchain and raise MSRV"
```

Expected: both checks pass and the commit contains only `Cargo.toml` and `rust-toolchain.toml`.

### Task 2: Enforce Primary and MSRV Toolchains in CI

**Files:**
- Modify: `.github/workflows/ci.yml:16-267`

- [ ] **Step 1: Record failing assertions for the current floating CI policy**

Run:

```sh
test "$(rg -c 'dtolnay/rust-toolchain@stable' .github/workflows/ci.yml)" -eq 0
rg -n '^  msrv:' .github/workflows/ci.yml
```

Expected: the first assertion fails because five jobs install floating `stable`; the second command finds no MSRV job.

- [ ] **Step 2: Remove floating toolchain setup from normal jobs**

Delete these blocks from the `ci`, `frontend`, `tauri-pr`, and `tauri-bundle` jobs:

```yaml
      - uses: dtolnay/rust-toolchain@stable
```

Delete the component-bearing block from the `ci` job in full:

```yaml
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
```

After deletion, each job should move directly from checkout to its next non-toolchain setup step. Plain `cargo`, `rustc`, `cargo fmt`, and `cargo clippy` commands will resolve Rust 1.97.0 and the declared components from `rust-toolchain.toml`.

- [ ] **Step 3: Add a dedicated all-workspace MSRV job**

Insert the following job after `ci` and before `frontend`:

```yaml
  msrv:
    name: MSRV (Rust 1.95.0)
    runs-on: ubuntu-latest
    env:
      RUSTUP_TOOLCHAIN: 1.95.0
      RUSTFLAGS: ""
      SKIP_UI_BUILD: 1
    steps:
      - uses: actions/checkout@v7

      - uses: dtolnay/rust-toolchain@1.95.0

      - uses: Swatinem/rust-cache@v2
        with:
          key: msrv-1.95.0

      - name: Install Tauri system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - name: Check minimum supported Rust version
        run: cargo +1.95.0 check --workspace --all-targets
```

The job-level `RUSTUP_TOOLCHAIN` ensures setup and cache helpers do not activate or download the repository's Rust 1.97.0 override. Clearing the global `RUSTFLAGS=-Dwarnings` keeps this job focused on compatibility; Clippy and warning policy remain enforced by the primary `ci` job. Installing the existing Tauri Linux dependencies allows `--workspace` to verify `ensemble-desktop` rather than excluding a crate that inherits the MSRV.

- [ ] **Step 4: Install release targets on the pinned primary toolchain**

In `build-cli`, replace:

```yaml
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
```

with:

```yaml
      - name: Install Rust target
        run: rustup target add "${{ matrix.target }}"
```

Keep the target-specific Rust cache and release build command unchanged.

- [ ] **Step 5: Verify the workflow contract locally**

Run:

```sh
brew install actionlint
test "$(rg -c 'dtolnay/rust-toolchain@stable' .github/workflows/ci.yml || true)" -eq 0
test "$(rg -c 'dtolnay/rust-toolchain@1.95.0' .github/workflows/ci.yml)" -eq 1
test "$(rg -c 'cargo \+1.95.0 check --workspace --all-targets' .github/workflows/ci.yml)" -eq 1
test "$(rg -c 'rustup target add' .github/workflows/ci.yml)" -eq 1
actionlint .github/workflows/ci.yml
```

Expected: all four assertions pass and `actionlint` emits no diagnostics.

- [ ] **Step 6: Run the MSRV check before committing**

Run:

```sh
rustup toolchain install 1.95.0 --profile minimal
RUSTFLAGS= SKIP_UI_BUILD=1 cargo +1.95.0 check --workspace --all-targets
```

Expected: all workspace targets, including `ensemble-desktop`, compile successfully with Rust 1.95.0.

- [ ] **Step 7: Commit CI enforcement**

Run:

```sh
git diff --check
git add .github/workflows/ci.yml
git commit -m "ci: verify pinned Rust and MSRV toolchains"
```

Expected: the check passes and the commit contains only the workflow change.

### Task 3: Make Upgrades Intentional and Document the Contract

**Files:**
- Modify: `renovate.json:21-106`
- Modify: `docs/contributing.md:3-29,80-85`
- Modify: `AGENTS.md:91-96,118-122`

- [ ] **Step 1: Verify the repository does not yet document or govern the new policy**

Run:

```sh
jq -e '.packageRules[] | select(.matchManagers == ["rust-toolchain"])' renovate.json
rg -n 'Rust 1\.80|Rust 1\.95|rust-toolchain\.toml|MSRV' docs/contributing.md AGENTS.md
```

Expected: the `jq` command fails because no Rust toolchain package rule exists; the documentation search finds the stale Rust 1.80 statements and no complete pinned-toolchain/MSRV policy.

- [ ] **Step 2: Add a review-only Renovate rule for exact toolchain updates**

Add this object as the first entry in `packageRules` in `renovate.json`:

```json
    {
      "description": "Require review for pinned Rust toolchain updates",
      "matchManagers": ["rust-toolchain"],
      "matchDepTypes": ["toolchain"],
      "rangeStrategy": "pin",
      "automerge": false
    },
```

Keep the existing global `"labels": ["dependencies"]` and `"ignoreDeps": ["rust-version"]`. The built-in `rust-toolchain` manager will update `rust-toolchain.toml`; ignoring Cargo's `rust-version` prevents automatic MSRV raises.

- [ ] **Step 3: Document toolchain selection and local checks for contributors**

Replace `docs/contributing.md:3-29` with:

````markdown
## Build and test

Ensemble's minimum supported Rust version (MSRV) is Rust 1.95. The repository pins Rust 1.97.0
for normal development and CI in `rust-toolchain.toml`; Rustup selects and installs that toolchain
automatically when commands run in the repository.

```sh
cargo build --workspace          # compile default targets with the pinned toolchain
cargo test --workspace           # run default Rust tests
cargo clippy --workspace -- -D warnings   # lint with the pinned toolchain
cargo fmt --all -- --check       # check formatting with the pinned toolchain
```

The CLI's embedded dashboard is optional. Default `ensemble-cli` builds are headless and do not
require Node, pnpm, OpenAPI generation, or frontend assets. To compile the web UI command from
source, generate the frontend inputs and enable the feature:

```sh
cd crates/ensemble-ui/src-ui
pnpm install --frozen-lockfile
pnpm run codegen
cd ../../..
cargo build -p ensemble-cli --features web-ui
```

For Rust-only checks that intentionally compile the `web-ui` feature without rebuilding frontend
assets, set `SKIP_UI_BUILD=1`.

To verify MSRV compatibility locally, install Rust 1.95.0 and override the pinned toolchain:

```sh
rustup toolchain install 1.95.0 --profile minimal
RUSTFLAGS= SKIP_UI_BUILD=1 cargo +1.95.0 check --workspace --all-targets
```

Run the normal format, Clippy, and test checks before pushing. CI also runs the separate MSRV
check. Renovate proposes exact primary-toolchain updates to `rust-toolchain.toml`, but those changes
do not automerge and must pass review. Raising the MSRV is a separate compatibility decision.
````

Preserve the existing `Product E2E` and later sections after this replacement.

- [ ] **Step 4: Update the contributor-facing CI description**

Replace `docs/contributing.md:80-85` with:

```markdown
## CI

GitHub Actions runs on push to `main` and all PRs. A dedicated Rust 1.95.0 job checks every
workspace target for MSRV compatibility. The main CI job uses the Rust 1.97.0 toolchain pinned in
`rust-toolchain.toml` for format, Clippy, default non-desktop Rust tests, the feature-enabled product
E2E test, and the CLI `web-ui` feature check. Frontend and desktop jobs use the same pinned primary
toolchain and run separately. All must pass. `RUSTFLAGS=-Dwarnings` applies to the primary jobs;
the MSRV job is a compile-compatibility check.
```

- [ ] **Step 5: Align repository agent guidance**

In `AGENTS.md`, replace the CI paragraph at lines 91-96 with:

```markdown
## CI

GitHub Actions runs on push to `main` and all PRs. A dedicated Rust 1.95.0 job checks all
workspace targets for MSRV compatibility. Primary Rust jobs use the exact toolchain pinned in
`rust-toolchain.toml`; the main job runs format, clippy, default non-desktop Rust tests, the
feature-enabled product E2E test, and a CLI `web-ui` feature check. Frontend and desktop jobs run
separately on the same pinned toolchain. All must pass. `RUSTFLAGS=-Dwarnings` applies to primary
jobs, so treat warnings as errors.
```

Replace the Rust convention bullet at line 121 with:

```markdown
- **Rust 2021 edition**, minimum rust-version 1.95; normal development and CI use the exact toolchain pinned in `rust-toolchain.toml`
```

- [ ] **Step 6: Validate Renovate configuration and documentation consistency**

Run:

```sh
jq -e '.packageRules[] | select(
  .matchManagers == ["rust-toolchain"] and
  .matchDepTypes == ["toolchain"] and
  .rangeStrategy == "pin" and
  .automerge == false
)' renovate.json
! rg -n 'Rust 1\.80|rust-version 1\.80' docs/contributing.md AGENTS.md
rg -n 'Rust 1\.95|Rust 1\.97\.0|rust-toolchain\.toml|MSRV' docs/contributing.md AGENTS.md
pnpm --package=renovate@43.257.5 dlx renovate-config-validator renovate.json
```

Expected: the `jq` assertion passes, no stale Rust 1.80 reference remains in current guidance, both documents describe the new contracts, and Renovate reports valid configuration.

- [ ] **Step 7: Commit upgrade policy and documentation**

Run:

```sh
git diff --check
git add renovate.json docs/contributing.md AGENTS.md
git commit -m "docs: define Rust compatibility and upgrade policy"
```

Expected: the check passes and the commit contains only Renovate policy and contributor guidance.

### Task 4: Run the Complete Toolchain Verification

**Files:**
- Verify only; no files should change.

- [ ] **Step 1: Verify the repository selects the exact primary compiler**

Run:

```sh
rustc --version
rustup show active-toolchain
```

Expected: both identify Rust 1.97.0 selected by the repository's `rust-toolchain.toml` override.

- [ ] **Step 2: Verify the MSRV contract from a clean compatibility build**

Run:

```sh
cargo clean
RUSTFLAGS= SKIP_UI_BUILD=1 cargo +1.95.0 check --workspace --all-targets
```

Expected: the complete workspace compiles successfully with Rust 1.95.0.

- [ ] **Step 3: Run all primary Rust gates on the pinned toolchain**

Run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo test --workspace --exclude ensemble-desktop
SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
```

Expected: formatting, Clippy, all non-desktop tests, product E2E, and the CLI web UI feature check pass on Rust 1.97.0.

- [ ] **Step 4: Re-run policy and workflow validation**

Run:

```sh
actionlint .github/workflows/ci.yml
pnpm --package=renovate@43.257.5 dlx renovate-config-validator renovate.json
git diff --check
git status --short
```

Expected: both validators and `git diff --check` pass. `git status --short` is empty after the three task commits.

- [ ] **Step 5: Review the branch against issue 319**

Run:

```sh
git log --oneline --decorate -4
git diff HEAD~3..HEAD -- Cargo.toml rust-toolchain.toml .github/workflows/ci.yml renovate.json docs/contributing.md AGENTS.md
```

Expected: the three implementation commits show an MSRV matching the tested compiler boundary of the current resolved graph, an explicit MSRV CI check, one pinned primary toolchain across local development and CI, warning-free Clippy on that toolchain, and review-only toolchain upgrades. No application source files or dependency versions change.
