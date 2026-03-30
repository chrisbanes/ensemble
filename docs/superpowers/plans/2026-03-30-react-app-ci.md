# React App CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate GitHub Actions frontend job that verifies React app codegen, tests, and production build on every PR and push to `main`.

**Architecture:** Extend the existing `.github/workflows/ci.yml` workflow with one new frontend-specific job rather than changing the current Rust job. The new job installs Node and Rust, runs frontend codegen from a clean checkout, then validates `npm test` and `npm run build` in `crates/ensemble-ui/src-ui` using the same scripts developers run locally.

**Tech Stack:** GitHub Actions, Node 22, npm, Rust stable toolchain, Swatinem/rust-cache, React/Vite/Vitest scripts in `crates/ensemble-ui/src-ui`

---

## File Map

- Modify: `.github/workflows/ci.yml` — add the separate frontend CI job with Node/Rust setup, caches, and frontend commands
- Reference: `docs/superpowers/specs/2026-03-30-react-app-ci-design.md` — approved design decisions and constraints
- Reference: `crates/ensemble-ui/src-ui/package.json` — source of truth for `codegen`, `test`, and `build` commands

### Task 1: Add the frontend CI job structure

**Files:**
- Modify: `.github/workflows/ci.yml`
- Reference: `docs/superpowers/specs/2026-03-30-react-app-ci-design.md`

- [ ] **Step 1: Write the failing test**

Treat workflow structure validation as the first test: define the expected job contract before editing.

Expected additions in `.github/workflows/ci.yml`:

```yaml
frontend:
  name: Frontend Test and Build
  runs-on: ubuntu-latest
```

And the job must include these setup building blocks:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: npm
    cache-dependency-path: crates/ensemble-ui/src-ui/package-lock.json
- uses: dtolnay/rust-toolchain@stable
- uses: Swatinem/rust-cache@v2
```

- [ ] **Step 2: Run a local check to verify the workflow is still missing the frontend job**

Run:

```bash
rg -n "frontend:|actions/setup-node|Frontend Test and Build" .github/workflows/ci.yml
```

Expected: no matches for the frontend job structure yet.

- [ ] **Step 3: Write the minimal implementation**

Add a new `frontend` job to `.github/workflows/ci.yml` without changing the existing Rust job. Use `working-directory` on run steps instead of inline `cd`.

Target shape:

```yaml
  frontend:
    name: Frontend Test and Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: crates/ensemble-ui/src-ui/package-lock.json

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
```

- [ ] **Step 4: Verify the workflow now contains the new job**

Run:

```bash
rg -n "frontend:|actions/setup-node|Frontend Test and Build" .github/workflows/ci.yml
```

Expected: matches for the new frontend job and Node setup.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add frontend workflow job"
```

### Task 2: Add codegen, test, and build steps in the correct order

**Files:**
- Modify: `.github/workflows/ci.yml`
- Reference: `crates/ensemble-ui/src-ui/package.json`

- [ ] **Step 1: Write the failing test**

Define the exact command sequence the job must run, in order:

```yaml
- name: Install frontend dependencies
  run: npm ci
  working-directory: crates/ensemble-ui/src-ui

- name: Generate frontend API client
  run: npm run codegen
  working-directory: crates/ensemble-ui/src-ui

- name: Frontend unit tests
  run: npm test
  working-directory: crates/ensemble-ui/src-ui

- name: Frontend build
  run: npm run build
  working-directory: crates/ensemble-ui/src-ui
```

- [ ] **Step 2: Verify those commands are not all present yet**

Run:

```bash
rg -n "npm ci|npm run codegen|npm test|npm run build|working-directory: crates/ensemble-ui/src-ui" .github/workflows/ci.yml
```

Expected: either no matches or incomplete matches.

- [ ] **Step 3: Write the minimal implementation**

Add the four run steps to the `frontend` job in the exact order above.

Important details to preserve:

- `npm run codegen` must run before `npm test`
- `npm test` must still run before `npm run build`
- every npm command must use `working-directory: crates/ensemble-ui/src-ui`

- [ ] **Step 4: Verify the workflow now contains the expected command sequence**

Run an order-aware check instead of a presence-only grep. Inspect the `frontend` job block and confirm the run-step sequence is exactly:

1. `npm ci`
2. `npm run codegen`
3. `npm test`
4. `npm run build`

Use one of these checks:

```bash
python - <<'PY'
from pathlib import Path
text = Path('.github/workflows/ci.yml').read_text()
needles = [
    'run: npm ci',
    'run: npm run codegen',
    'run: npm test',
    'run: npm run build',
]
positions = [text.index(needle) for needle in needles]
assert positions == sorted(positions), positions
print('frontend command order is correct')
PY
```

Or manually inspect the `frontend` job in:

```bash
sed -n '/frontend:/,$p' .github/workflows/ci.yml
```

Expected: all four commands are present in the correct order, each with `working-directory: crates/ensemble-ui/src-ui`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run frontend codegen test and build"
```

### Task 3: Verify the workflow matches local reality

**Files:**
- Modify: `.github/workflows/ci.yml` (only if verification reveals a mismatch)
- Reference: `crates/ensemble-ui/src-ui/package.json`

- [ ] **Step 1: Write the failing test**

Capture the exact verification commands that prove the workflow reflects the real frontend path:

```bash
npm run codegen
npm test
npm run build
```

Run those commands from `crates/ensemble-ui/src-ui`, not via inline `cd` in the workflow.

Also capture a workflow sanity check:

```bash
python - <<'PY'
import yaml
from pathlib import Path
data = yaml.safe_load(Path('.github/workflows/ci.yml').read_text())
assert 'frontend' in data['jobs']
print('frontend job present')
PY
```

- [ ] **Step 2: Run the verification commands and confirm they expose any mismatch**

Run:

```bash
npm run codegen && npm test && npm run build
```

from `crates/ensemble-ui/src-ui`, then run:

```bash
python - <<'PY'
import yaml
from pathlib import Path
data = yaml.safe_load(Path('.github/workflows/ci.yml').read_text())
assert 'frontend' in data['jobs']
print('frontend job present')
PY
```

Expected before final cleanup: commands pass, or expose an issue that must be fixed before moving on.

- [ ] **Step 3: Write the minimal implementation**

If verification exposes a workflow mismatch, make only the smallest correction needed in `.github/workflows/ci.yml` and re-run the same checks.

If verification already passes, make no further code changes in this step.

- [ ] **Step 4: Re-run verification and confirm green state**

Run from the repo root in this order:

```bash
cargo test --workspace
```

Run from `crates/ensemble-ui/src-ui`:

```bash
npm run codegen && npm test && npm run build
```

Optional YAML parse sanity check if Python with PyYAML is available:

```bash
python - <<'PY'
import yaml
from pathlib import Path
data = yaml.safe_load(Path('.github/workflows/ci.yml').read_text())
assert 'frontend' in data['jobs']
print('frontend job present')
PY
```

Expected:

- `cargo test --workspace` passes
- `npm run codegen && npm test && npm run build` passes
- workflow file still contains the `frontend` job

- [ ] **Step 5: Commit only if Task 3 changed the workflow**

If Step 3 required a correction to `.github/workflows/ci.yml`, run:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify react app checks in workflow"
```

If Step 3 made no code changes, do not create an empty commit. Record that verification passed with no further edits and move to final verification.

## Final Verification

After all tasks are complete, run the full verification set:

From repo root:

```bash
cargo test --workspace
```

From `crates/ensemble-ui/src-ui`:

```bash
npm run codegen
npm test
npm run build
```

And inspect the workflow diff:

```bash
git diff -- .github/workflows/ci.yml
```

Expected final state:

- existing Rust CI job remains intact
- new `frontend` job exists
- frontend job pins Node 22
- frontend job runs `npm ci`, `npm run codegen`, `npm test`, and `npm run build`
- all verification commands pass locally
