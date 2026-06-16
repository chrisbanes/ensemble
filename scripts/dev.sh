#!/usr/bin/env bash
set -euo pipefail

# Dev script: unified build/run commands for ensemble development.
# Run from the repo root.
#
# Usage:
#   ./scripts/dev.sh build                # full build with UI
#   ./scripts/dev.sh build --web-ui       # also build ensemble-cli with the web-ui feature
#   ./scripts/dev.sh run                  # run with no args
#   ./scripts/dev.sh run --help           # pass --help to ensemble
#   ./scripts/dev.sh run --web-ui web     # build with web-ui, then run `web` subcommand
#
# To skip UI build, set SKIP_UI_BUILD=1:
#   SKIP_UI_BUILD=1 ./scripts/dev.sh build
#   SKIP_UI_BUILD=1 ./scripts/dev.sh run --help

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$REPO_ROOT/crates/ensemble-ui/src-ui"

# Whether the ensemble-cli binary should be built with the web-ui feature.
WEB_UI_ENABLED=0

# Show usage for this script (not ensemble)
show_usage() {
  cat << 'EOF'
Usage: ./scripts/dev.sh <command> [args]

Commands:
  build                Build the workspace
  run                  Build and run the ensemble CLI

Flags:
  --web-ui             Build ensemble-cli with the `web-ui` Cargo feature
                       (embeds the dashboard so `ensemble web` is available)

Environment Variables:
  SKIP_UI_BUILD=1      Skip UI build (Rust-only)

Arguments after the command are passed to ensemble:
  ./scripts/dev.sh run --help
  ./scripts/dev.sh run help
  ./scripts/dev.sh run web

Examples:
  ./scripts/dev.sh build                    # Full build
  ./scripts/dev.sh build --web-ui           # Full build, embed web dashboard
  SKIP_UI_BUILD=1 ./scripts/dev.sh build    # Rust-only build
  ./scripts/dev.sh run                      # Run ensemble with no args
  ./scripts/dev.sh run --help               # Show ensemble help
  ./scripts/dev.sh run --web-ui web         # Run `web` with the dashboard
  SKIP_UI_BUILD=1 ./scripts/dev.sh run web  # Skip UI, run web command
EOF
}

# Build the workspace, then (if --web-ui) layer the web-ui feature onto
# ensemble-cli as an incremental second build.
run_build() {
  if [ -n "${SKIP_UI_BUILD:-}" ]; then
    echo "==> Skipping UI build (SKIP_UI_BUILD=1)"
    cargo build --workspace --exclude ensemble-desktop
    if [[ "$WEB_UI_ENABLED" == "1" ]]; then
      cargo build -p ensemble-cli --features web-ui
    fi
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
  if [[ "$WEB_UI_ENABLED" == "1" ]]; then
    cargo build -p ensemble-cli --features web-ui
  fi
}

# Run command logic
run_dev() {
  local web_ui_args=()
  if [[ "$WEB_UI_ENABLED" == "1" ]]; then
    web_ui_args=(--features web-ui)
  fi

  if [ -n "${SKIP_UI_BUILD:-}" ]; then
    echo "==> Skipping UI build (SKIP_UI_BUILD=1)"
    echo "==> Running: cargo run -p ensemble-cli $*"
    cargo run -p ensemble-cli "${web_ui_args[@]+"${web_ui_args[@]}"}" -- "$@"
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
  echo "==> Running: cargo run -p ensemble-cli $*"
  cargo run -p ensemble-cli "${web_ui_args[@]+"${web_ui_args[@]}"}" -- "$@"
}

# Main
if [[ $# -eq 0 ]]; then
  show_usage
  exit 1
fi

command="$1"
shift

# Handle script-level help
if [[ "$command" == "--help" || "$command" == "-h" || "$command" == "help" ]]; then
  show_usage
  exit 0
fi

case "$command" in
  build)
    for arg in "$@"; do
      case "$arg" in
        --web-ui)
          WEB_UI_ENABLED=1
          ;;
        *)
          echo "Unknown argument for build: $arg"
          show_usage
          exit 1
          ;;
      esac
    done
    run_build
    echo "==> Done"
    ;;
  run)
    REMAINING=()
    for arg in "$@"; do
      case "$arg" in
        --web-ui)
          WEB_UI_ENABLED=1
          ;;
        *)
          REMAINING+=("$arg")
          ;;
      esac
    done
    run_dev "${REMAINING[@]+"${REMAINING[@]}"}"
    ;;
  *)
    echo "Unknown command: $command"
    show_usage
    exit 1
    ;;
esac
