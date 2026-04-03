#!/bin/bash
# Agent Sol — Deploy to Solana devnet
set -e

export PATH="/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin"

WORKSPACE="/mnt/c/Users/favcr/.openclaw/workspace/agent-sol"
cd "$WORKSPACE"

echo "=== Agent Sol — Devnet Deploy ==="

# Ensure devnet
solana config set --url devnet

WALLET=$(solana address)
echo "Deployer wallet: $WALLET"

# Airdrop if needed
BALANCE=$(solana balance --lamports | awk '{print $1}')
echo "Balance: $BALANCE lamports"
if [ "$BALANCE" -lt 2000000000 ]; then
  echo "Low balance — requesting airdrop..."
  solana airdrop 2 || echo "Airdrop may have failed (rate limited) — fund manually"
  sleep 3
fi

echo ""
echo "=== Deploying ==="
anchor deploy

echo ""
echo "=== Deploy complete ==="
PROGRAM_ID=$(solana address -k target/deploy/agentic_commerce-keypair.json)
echo "Program ID: $PROGRAM_ID"
echo ""
echo "Next steps:"
echo "  1. Update COMMERCE_PROGRAM_ID in .env with: $PROGRAM_ID"
echo "  2. Update declare_id! in programs/agentic-commerce/src/lib.rs"
echo "  3. Update Anchor.toml [programs.devnet] section"
echo "  4. Rebuild: bash scripts/build.sh"
echo "  5. Initialize platform: anchor run initialize"
