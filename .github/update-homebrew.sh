#!/usr/bin/env bash
set -euo pipefail

# Update Homebrew tap with new release artifacts.
#
# Required environment variables:
#   TAG            - Git tag (e.g. v0.2.0)
#   REPO           - GitHub repository (e.g. chrisbanes/ensemble)
#   TAP_TOKEN      - GitHub PAT for pushing to the tap repo
#   ARTIFACTS_DIR  - Path to directory containing release artifacts

VERSION="${TAG#v}"

# Verify artifacts exist
if ! ls ${ARTIFACTS_DIR}/ensemble-${TAG}-*.tar.gz 1>/dev/null 2>&1; then
  echo "ERROR: No CLI tarballs found in ${ARTIFACTS_DIR}"
  echo "Looking for: ensemble-${TAG}-*.tar.gz"
  exit 1
fi

if ! ls ${ARTIFACTS_DIR}/*.dmg 1>/dev/null 2>&1; then
  echo "ERROR: No .dmg file found in ${ARTIFACTS_DIR}"
  exit 1
fi

# Compute checksums for CLI tarballs
echo "==> Computing checksums"
declare -A CHECKSUMS
for f in ${ARTIFACTS_DIR}/ensemble-${TAG}-*.tar.gz; do
  TARGET=$(basename "$f" | sed "s/ensemble-${TAG}-//" | sed 's/\.tar\.gz//')
  CHECKSUMS[$TARGET]=$(sha256sum "$f" | awk '{print $1}')
  echo "  ${TARGET}: ${CHECKSUMS[$TARGET]}"
done

# Compute checksum for desktop .dmg
DMG=$(ls ${ARTIFACTS_DIR}/*.dmg | head -1)
DMG_NAME=$(basename "$DMG")
DMG_SHA256=$(sha256sum "$DMG" | awk '{print $1}')
echo "  dmg: ${DMG_SHA256}"

# Clone tap
echo "==> Cloning homebrew-tap"
git clone "https://x-access-token:${TAP_TOKEN}@github.com/chrisbanes/homebrew-tap.git" tap
cd tap
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# Generate formula
echo "==> Generating formula"
mkdir -p Formula
cat > Formula/ensemble.rb << FORMULA
class Ensemble < Formula
  desc "Multi-agent pipeline orchestrator"
  homepage "https://github.com/${REPO}"
  license "MIT"
  version "${VERSION}"

  on_macos do
    on_arm do
      url "https://github.com/${REPO}/releases/download/${TAG}/ensemble-${TAG}-aarch64-apple-darwin.tar.gz"
      sha256 "${CHECKSUMS[aarch64-apple-darwin]}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/${REPO}/releases/download/${TAG}/ensemble-${TAG}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "${CHECKSUMS[aarch64-unknown-linux-gnu]}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/${TAG}/ensemble-${TAG}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "${CHECKSUMS[x86_64-unknown-linux-gnu]}"
    end
  end

  def install
    bin.install "ensemble"
  end

  test do
    assert_match "ensemble", shell_output("\#{bin}/ensemble --help")
  end
end
FORMULA

# Generate cask
echo "==> Generating cask"
mkdir -p Casks
cat > Casks/ensemble-desktop.rb << CASK
cask "ensemble-desktop" do
  version "${VERSION}"
  sha256 "${DMG_SHA256}"

  url "https://github.com/${REPO}/releases/download/${TAG}/${DMG_NAME}"
  name "Ensemble"
  desc "Multi-agent pipeline orchestrator"
  homepage "https://github.com/${REPO}"

  depends_on arch: :arm64

  app "Ensemble.app"
end
CASK

# Push to tap
echo "==> Pushing to tap"
git add Formula/ensemble.rb Casks/ensemble-desktop.rb
if ! git diff --cached --quiet; then
  git commit -m "Update ensemble to ${VERSION}"
  git push
else
  echo "No changes to commit; skipping push"
fi

echo "==> Done"
