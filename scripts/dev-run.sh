#!/usr/bin/env bash
set -euo pipefail

# Dev run: generates the OpenAPI spec, builds the full workspace, then runs
# the ensemble CLI with any provided arguments.
# Run from the repo root.
#
# Usage:
#   ./scripts/dev-run.sh                    # run with no args
#   ./scripts/dev-run.sh -- --help          # pass --help to ensemble
#   ./scripts/dev-run.sh --skip-ui -- run   # skip UI build, then run
#   ./scripts/dev-run.sh --skip-ui          # skip UI build only

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$REPO_ROOT/crates/ensemble-ui/src-ui"

skip_ui=false
passthrough_args=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ui)
      skip_ui=true
      shift
      ;;
    --)
      # Everything after -- goes to cargo run
      shift
      passthrough_args=("$@")
      break
      ;;
    *)
      # Unknown option before -- is an error
      echo "Unknown option: $1"
      echo "Use -- to separate script options from cargo run arguments"
      exit 1
      ;;
  esac
done

if [ "$skip_ui" = true ]; then
  echo "==> Skipping UI build (--skip-ui)"
  export SKIP_UI_BUILD=1
  echo "==> Running: cargo run --workspace --exclude ensemble-desktop -- ${passthrough_args[*]}"
  cargo run --workspace --exclude ensemble-desktop -- "${passthrough_args[@]}"
  exit 0
fi

# 1. Generate OpenAPI spec (requires ensemble-core to compile)
echo "==> Generating openapi.json"
cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored

# 2. Install frontend dependencies + build
echo "==> Installing frontend dependencies"
(cd "$UI_DIR" && pnpm install --frozen-lockfile)

# 3. Build and run the workspace (build.rs will run codegen:client + tsc + vite via build:embed)
echo "==> Building and running workspace"
echo "==> Running: cargo run --workspace --exclude ensemble-desktop -- ${passthrough_args[*]}"
cargo run --workspace --exclude ensemble-desktop -- "${passthrough_args[@]}"
