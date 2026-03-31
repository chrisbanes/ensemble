#!/usr/bin/env bash
set -euo pipefail

# Dev build: generates the OpenAPI spec, then builds the full workspace
# (including the embedded UI). Run from the repo root.
#
# Usage:
#   ./scripts/dev-build.sh          # full build with UI
#   ./scripts/dev-build.sh --skip-ui # Rust-only, no UI embed

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$REPO_ROOT/crates/ensemble-ui/src-ui"

skip_ui=false
for arg in "$@"; do
  case "$arg" in
    --skip-ui) skip_ui=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

if [ "$skip_ui" = true ]; then
  echo "==> Skipping UI build (--skip-ui)"
  export SKIP_UI_BUILD=1
  cargo build --workspace --exclude ensemble-desktop
  exit 0
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

echo "==> Done"
