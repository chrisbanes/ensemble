#!/usr/bin/env bash
set -euo pipefail

# Pre-build setup for cargo-dist CI.
# Installs Node/pnpm and generates openapi.json so that
# ensemble-cli's build.rs can embed the SPA.

UI_DIR="crates/ensemble-ui/src-ui"

# Install Node.js 22
echo "==> Installing Node.js 22"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22

# Install pnpm via corepack
echo "==> Enabling corepack + pnpm"
corepack enable
corepack prepare pnpm@latest --activate

# Generate openapi.json (required before cargo build)
echo "==> Generating openapi.json"
cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored

# Install frontend dependencies
echo "==> Installing frontend dependencies"
cd "$UI_DIR"
pnpm install --frozen-lockfile
cd -

echo "==> Build setup complete"
