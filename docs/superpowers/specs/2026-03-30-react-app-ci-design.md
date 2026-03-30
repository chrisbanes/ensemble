# React App CI — Design Spec

## Goal

Add GitHub Actions coverage for the React app so every PR verifies the frontend test and production build flow, including the existing OpenAPI/codegen step that depends on Rust.

## Decisions

| Topic | Decision |
|---|---|
| CI scope | Run frontend `npm test` and `npm run build` on every PR to `main` |
| Workflow structure | Add a separate frontend job instead of folding checks into the existing Rust job |
| Codegen validation | Reuse the existing frontend scripts so CI exercises the real `codegen -> test/build` path |
| Rust dependency | Install Rust in the frontend job because `npm run build` invokes `cargo test -p ensemble-core --test openapi_spec ... -- --ignored` |
| Cache strategy | Keep Rust cache in the existing job; add a separate npm dependency cache for the frontend job |

## Context

The repository already has a single GitHub Actions workflow at `.github/workflows/ci.yml` with one Rust-focused job that runs:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace -- -D warnings`
- `cargo test --workspace`

The React app lives in `crates/ensemble-ui/src-ui`. Its current scripts are:

- `npm test` -> `vitest run`
- `npm run build` -> `npm run codegen && tsc && vite build`
- `npm run codegen` -> Rust-generated OpenAPI spec + Orval client generation

That means a valid frontend CI check must cover more than plain TypeScript/Vite compilation. It must also prove that:

1. npm dependencies install cleanly,
2. Rust-backed OpenAPI generation works in CI,
3. frontend tests pass, and
4. the production build succeeds from a clean checkout.

## Approaches Considered

### 1. Separate frontend job in the existing workflow

Add a second job alongside the current Rust job.

**Pros**
- Preserves clean responsibility boundaries between Rust and frontend checks
- Faster failure diagnosis because GitHub shows frontend failures separately
- Matches the user’s requested direction
- Allows frontend-specific setup and caching without complicating the Rust job

**Cons**
- Slightly longer workflow file
- Some duplicated setup (checkout, toolchain installation)

### 2. Fold frontend steps into the existing Rust job

Extend the current `ci` job with Node setup, npm install, frontend test, and frontend build steps.

**Pros**
- Fewer jobs in the workflow file
- Simple linear execution model

**Cons**
- Mixed concerns in one job
- Slower feedback because frontend failures wait behind Rust steps (or vice versa)
- Harder to see whether breakage is Rust-only or frontend-only

### 3. Build-only frontend job

Add a frontend job that runs only `npm run build`.

**Pros**
- Lowest extra CI cost
- Still validates codegen + TypeScript + Vite build

**Cons**
- Misses Vitest regressions already added to the app
- Does not satisfy the requested “test + build” scope

## Chosen Design

Use **Approach 1**: add a **separate frontend job** to `.github/workflows/ci.yml` that runs both `npm test` and `npm run build`.

This keeps frontend CI isolated while validating the exact workflow contributors use locally.

## Workflow Design

### Triggering

The frontend job should run under the same triggers as the existing workflow:

- pushes to `main`
- pull requests targeting `main`

No path filtering is added in this first version. The goal is correctness and merge protection, not workflow minimization.

### Job layout

Add a new job, for example `frontend`, with a name such as `Frontend Test and Build`.

Recommended step order:

1. `actions/checkout@v4`
2. `actions/setup-node@v4`
   - pin `node-version: 22`
   - enable npm caching rooted at `crates/ensemble-ui/src-ui/package-lock.json`
3. `dtolnay/rust-toolchain@stable`
   - required because frontend build triggers Rust-backed OpenAPI generation
4. `Swatinem/rust-cache@v2`
   - optional but recommended so the codegen-backed build does not recompile Rust from scratch each run
5. `npm ci` in `crates/ensemble-ui/src-ui`
6. `npm run codegen` in `crates/ensemble-ui/src-ui`
7. `npm test` in `crates/ensemble-ui/src-ui`
8. `npm run build` in `crates/ensemble-ui/src-ui`

### Why codegen runs before test

This repository does not check generated frontend OpenAPI artifacts into Git. A clean checkout therefore needs codegen before frontend commands that import from `src/generated/...`.

After that initial codegen step, `npm test` still runs before `npm run build` so unit failures surface before the heavier production build path.

### Directory handling

Each frontend npm step should execute with `working-directory: crates/ensemble-ui/src-ui` rather than using inline `cd` commands. This keeps the workflow consistent and easier to read.

## Data Flow

The frontend job validates this chain end-to-end:

1. GitHub runner checks out the repo
2. Node installs frontend dependencies
3. Rust toolchain is available for the codegen spec step
4. `npm run codegen` generates the OpenAPI spec and Orval client from a clean checkout
5. `npm test` runs Vitest unit tests
6. `npm run build` triggers the existing production build path:
   - `npm run codegen`
   - `cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored`
   - `orval`
   - `tsc`
   - `vite build`

If any part of that path breaks, the frontend job fails independently of Rust fmt/clippy/workspace tests.

The current scripts mean CI runs codegen twice: once explicitly before tests, and once again inside `npm run build`. That duplication is acceptable in this first version because it keeps CI aligned with the existing local scripts. Reducing duplicate codegen can be a later cleanup once the workflow is established.

## Error Handling

- If npm dependency install fails, the job stops before spending time on Rust/codegen.
- If the ignored OpenAPI writer test fails, the dedicated codegen step fails and surfaces a codegen contract issue before tests or build run.
- If generated client output becomes incompatible with current frontend code, `tsc` or `vite build` fails.
- If frontend regressions exist in unit-tested helpers, `npm test` fails before the build step runs.

## Testing Strategy

After implementation, validate the workflow by checking that:

1. workflow YAML remains valid,
2. `npm test` still passes locally in `crates/ensemble-ui/src-ui`,
3. `npm run build` still passes locally in `crates/ensemble-ui/src-ui`, and
4. the new GitHub Actions job appears alongside the existing Rust CI job.

## Files to Change

- Modify: `.github/workflows/ci.yml` — add the frontend CI job and toolchain/cache setup for React app checks

## Non-goals

- Splitting the Rust job into multiple parallel Rust jobs
- Adding path-based workflow filtering
- Publishing frontend build artifacts
- Adding browser/E2E test coverage
- Reworking the existing frontend build scripts
