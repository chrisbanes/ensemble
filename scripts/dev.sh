#!/usr/bin/env bash
set -euo pipefail

# Dev script: unified build/run commands for ensemble development.
# Run from the repo root.
#
# Usage:
#   ./scripts/dev.sh build              # full build with UI
#   ./scripts/dev.sh run                # run with no args
#   ./scripts/dev.sh run -- --help      # pass --help to ensemble
#
# To skip UI build, set SKIP_UI_BUILD=1:
#   SKIP_UI_BUILD=1 ./scripts/dev.sh build
#   SKIP_UI_BUILD=1 ./scripts/dev.sh run -- --help

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$REPO_ROOT/crates/ensemble-ui/src-ui"

# Show usage
usage() {
  cat << 'EOF'
Usage: ./scripts/dev.sh <command> [-- [args]]

Commands:
  build                Build the workspace
  run                  Build and run the ensemble CLI

Environment Variables:
  SKIP_UI_BUILD=1      Skip UI build (Rust-only)

For 'run' command, use -- to pass arguments to ensemble:
  ./scripts/dev.sh run -- --help
  ./scripts/dev.sh run -- run

Examples:
  ./scripts/dev.sh build                    # Full build
  SKIP_UI_BUILD=1 ./scripts/dev.sh build    # Rust-only build
  ./scripts/dev.sh run                      # Run ensemble with no args
  ./scripts/dev.sh run -- --help            # Show ensemble help
  SKIP_UI_BUILD=1 ./scripts/dev.sh run -- help  # Skip UI, run help
EOF
}

# Common build logic
run_build() {
  if [ -n "${SKIP_UI_BUILD:-}" ]; then
    echo "==> Skipping UI build (SKIP_UI_BUILD=1)"
    cargo build --workspace --exclude ensemble-desktop
    return 0
  fi

  # 1. Generate OpenAPI spec (requires ensemble-core to compile)
  echo "==> Generating openapi.json"
  cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored

  # 2. Install frontend dependencies + build
  echo "==> Installing frontend dependencies"
  (cd "$UI_DIR" && pnpm install --frozen-lockfile)

  # 3. Build the workspace (build.rs will run codegen:client + tsc + vite via build:embed)
  echo "==> Building workspace"
  cargo build --workspace --exclude ensemble-desktop
}

# Run command logic
run_dev() {
  local passthrough_args=("$@")

  if [ -n "${SKIP_UI_BUILD:-}" ]; then
    echo "==> Skipping UI build (SKIP_UI_BUILD=1)"
    echo "==> Running: cargo run --workspace --exclude ensemble-desktop -- ${passthrough_args[*]}"
    cargo run --workspace --exclude ensemble-desktop -- "${passthrough_args[@]}"
    return 0
  fi

  # 1. Generate OpenAPI spec (requires ensemble-core to compile)
  echo "==> Generating openapi.json"
  cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored

  # 2. Install frontend dependencies + build
  echo "==> Installing frontend dependencies"
  (cd "$UI_DIR" && pnpm install --frozen-lockfile)

  # 3. Build and run the workspace
  echo "==> Building and running workspace"
  echo "==> Running: cargo run --workspace --exclude ensemble-desktop -- ${passthrough_args[*]}"
  cargo run --workspace --exclude ensemble-desktop -- "${passthrough_args[@]}"
}

# Main
if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

command="$1"
shift

passthrough_args=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      # Everything after -- goes to cargo
      shift
      passthrough_args=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Use -- to separate script options from cargo arguments"
      exit 1
      ;;
    *)
      # Non-option argument before --
      echo "Unexpected argument: $1"
      echo "Use -- to pass arguments to cargo run"
      exit 1
      ;;
  esac
done

case "$command" in
  build)
    run_build
    echo "==> Done"
    ;;
  run)
    run_dev "${passthrough_args[@]}"
    ;;
  --help|-h|help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
