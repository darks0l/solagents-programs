#!/bin/bash
# Agent Sol — WSL Solana/Anchor toolchain setup
set -e

export PATH="/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:$PATH"

# Add to bashrc if not already there
if ! grep -q 'solana/install' /root/.bashrc 2>/dev/null; then
  echo 'export PATH="/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:$PATH"' >> /root/.bashrc
  echo "Added Solana to PATH in .bashrc"
fi

echo "=== Checking Rust ==="
rustc --version
cargo --version

echo "=== Checking Solana ==="
solana --version

echo "=== Generating Solana keypair (if needed) ==="
if [ ! -f /root/.config/solana/id.json ]; then
  solana-keygen new --no-bip39-passphrase --silent
  echo "New keypair generated"
else
  echo "Keypair already exists"
fi
solana config set --url devnet

echo "=== Installing Anchor CLI ==="
cargo install --git https://github.com/coral-xyz/anchor avm --force 2>&1 | tail -3
avm install 0.30.1
avm use 0.30.1

echo "=== Verifying ==="
anchor --version

echo "=== Installing Node.js (for Anchor tests) ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

echo "=== All done! ==="
echo "Solana: $(solana --version)"
echo "Anchor: $(anchor --version)"
echo "Rust: $(rustc --version)"
echo "Node: $(node --version)"
