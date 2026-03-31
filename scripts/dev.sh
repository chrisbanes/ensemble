#!/usr/bin/env bash
set -euo pipefail

# Dev script: unified build/run commands for ensemble development.
# Run from the repo root.
#
# Usage:
#   ./scripts/dev.sh build              # full build with UI
#   ./scripts/dev.sh build --skip-ui    # Rust-only build
#   ./scripts/dev.sh run                # run with no args
#   ./scripts/dev.sh run -- --help      # pass --help to ensemble
#   ./scripts/dev.sh run --skip-ui -- run  # skip UI build, run 'ensemble run'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$REPO_ROOT/crates/ensemble-ui/src-ui"

# Show usage
usage() {
  cat << 'EOF'
Usage: ./scripts/dev.sh <command> [options] [-- [args]]

Commands:
  build                Build the workspace
  run                  Build and run the ensemble CLI

Options:
  --skip-ui            Skip UI build (Rust-only)

For 'run' command, use -- to pass arguments to ensemble:
  ./scripts/dev.sh run -- --help
  ./scripts/dev.sh run --skip-ui -- run

Examples:
  ./scripts/dev.sh build              # Full build
  ./scripts/dev.sh build --skip-ui    # Rust-only build
  ./scripts/dev.sh run                # Run ensemble with no args
  ./scripts/dev.sh run -- --help      # Show ensemble help
EOF
}

# Common build logic
run_build() {
  local skip_ui=$1

  if [ "$skip_ui" = true ]; then
    echo "==> Skipping UI build (--skip-ui)"
    export SKIP_UI_BUILD=1
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
  local skip_ui=$1
  shift
  local passthrough_args=("$@")

  if [ "$skip_ui" = true ]; then
    echo "==> Skipping UI build (--skip-ui)"
    export SKIP_UI_BUILD=1
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

skip_ui=false
passthrough_args=()

# Parse options
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ui)
      skip_ui=true
      shift
      ;;
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
    run_build "$skip_ui"
    echo "==> Done"
    ;;
  run)
    run_dev "$skip_ui" "${passthrough_args[@]}"
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
