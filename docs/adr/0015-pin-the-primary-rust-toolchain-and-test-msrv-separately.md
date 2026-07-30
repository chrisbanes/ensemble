---
status: accepted
---

# Pin the primary Rust toolchain and test MSRV separately

Normal development, linting, packaging, and releases use the exact Rust version pinned in `rust-toolchain.toml`, while `Cargo.toml` declares an independently tested minimum supported Rust version with a dedicated CI job. Toolchain upgrades and compatibility changes therefore happen through explicit repository changes instead of an unreviewed moving `stable` channel.
