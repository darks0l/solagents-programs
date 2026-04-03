#!/bin/bash
# Agent Sol — Build the Anchor program from WSL
set -e

export PATH="/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin"

WORKSPACE="/mnt/c/Users/favcr/.openclaw/workspace/agent-sol"
cd "$WORKSPACE"

echo "=== Agent Sol — Anchor Build ==="
echo "Working dir: $(pwd)"
echo "Anchor: $(anchor --version)"
echo "Solana: $(solana --version)"
echo "Rustc:  $(rustc --version)"
echo ""

# Set to devnet
solana config set --url devnet > /dev/null

echo "=== Building program ==="
anchor build

echo ""
echo "=== Build complete ==="
echo "Artifacts:"
ls -lh target/deploy/ 2>/dev/null || echo "(no deploy artifacts — check for errors above)"

echo ""
echo "=== Program ID ==="
solana address -k target/deploy/agentic_commerce-keypair.json 2>/dev/null || echo "Keypair not found"
