/**
 * Wallet Service — Phantom + Solana wallet integration
 *
 * Supports: Phantom, Backpack, Solflare (all use window.solana or window.solana-like APIs)
 * Handles: connect, disconnect, sign, sendTransaction, getBalance
 */

// ── State ────────────────────────────────────────────────────
let _wallet = null;
let _publicKey = null;
let _onConnectCallbacks = [];
let _onDisconnectCallbacks = [];

// ── Detection ────────────────────────────────────────────────

export function getPhantom() {
  if ('phantom' in window) return window.phantom?.solana;
  if ('solana' in window && window.solana?.isPhantom) return window.solana;
  return null;
}

export function getSolflare() {
  return window.solflare?.isSolflare ? window.solflare : null;
}

export function getBackpack() {
  return window.xnft?.solana || window.backpack;
}

export function getAnyWallet() {
  return getPhantom() || getSolflare() || getBackpack();
}

export function isWalletAvailable() {
  return !!getAnyWallet();
}

// ── Connection ───────────────────────────────────────────────

export async function connectWallet() {
  const provider = getAnyWallet();
  if (!provider) {
    // No wallet detected — try to open Phantom install
    window.open('https://phantom.app/', '_blank');
    throw new Error('No Solana wallet detected. Please install Phantom.');
  }

  try {
    const resp = await provider.connect();
    _wallet = provider;
    _publicKey = resp.publicKey;

    // Set up disconnect listener
    provider.on('disconnect', () => {
      _wallet = null;
      _publicKey = null;
      _onDisconnectCallbacks.forEach(cb => cb());
      localStorage.removeItem('walletConnected');
    });

    // Set up account change listener
    provider.on('accountChanged', (newPublicKey) => {
      if (newPublicKey) {
        _publicKey = newPublicKey;
        _onConnectCallbacks.forEach(cb => cb(newPublicKey.toBase58()));
      } else {
        disconnectWallet();
      }
    });

    localStorage.setItem('walletConnected', 'true');
    _onConnectCallbacks.forEach(cb => cb(_publicKey.toBase58()));

    return _publicKey.toBase58();
  } catch (err) {
    if (err.code === 4001) throw new Error('Wallet connection rejected by user');
    throw err;
  }
}

export async function disconnectWallet() {
  if (_wallet) {
    try { await _wallet.disconnect(); } catch {}
  }
  _wallet = null;
  _publicKey = null;
  localStorage.removeItem('walletConnected');
  _onDisconnectCallbacks.forEach(cb => cb());
}

export function getPublicKey() {
  return _publicKey?.toBase58() ?? null;
}

export function isConnected() {
  return !!_publicKey;
}

export function onConnect(cb) {
  _onConnectCallbacks.push(cb);
}

export function onDisconnect(cb) {
  _onDisconnectCallbacks.push(cb);
}

// ── Auto-reconnect (if user was connected before) ───────────

export async function tryAutoConnect() {
  if (localStorage.getItem('walletConnected') !== 'true') return null;
  const provider = getAnyWallet();
  if (!provider) return null;

  try {
    const resp = await provider.connect({ onlyIfTrusted: true });
    _wallet = provider;
    _publicKey = resp.publicKey;

    provider.on('disconnect', () => {
      _wallet = null;
      _publicKey = null;
      _onDisconnectCallbacks.forEach(cb => cb());
      localStorage.removeItem('walletConnected');
    });

    _onConnectCallbacks.forEach(cb => cb(_publicKey.toBase58()));
    return _publicKey.toBase58();
  } catch {
    localStorage.removeItem('walletConnected');
    return null;
  }
}

// ── Transaction Signing + Sending ────────────────────────────

/**
 * Sign and send a base64-encoded transaction from the server.
 * The server partially signs the transaction (e.g., mint keypair).
 * User wallet adds their signature.
 *
 * Returns: transaction signature (string)
 */
export async function signAndSendTransaction(base64Tx, options = {}) {
  if (!_wallet || !_publicKey) throw new Error('Wallet not connected');

  // Deserialize the transaction (browser-native base64 decode)
  const txBuffer = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));

  const { Transaction, Connection } = await import('@solana/web3.js');

  // Deserialize as legacy Transaction
  const transaction = Transaction.from(txBuffer);

  // Sign with user wallet (Phantom signs but does NOT send)
  const signed = await _wallet.signTransaction(transaction);

  // Send via our own RPC connection (devnet)
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const rawTx = signed.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: options.skipPreflight ?? false,
    maxRetries: options.maxRetries ?? 3,
    preflightCommitment: 'confirmed',
  });

  return signature;
}

/**
 * Sign a transaction without sending (for inspection or custom submission)
 */
export async function signTransaction(base64Tx) {
  if (!_wallet || !_publicKey) throw new Error('Wallet not connected');

  const txBuffer = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));
  const { Transaction } = await import('@solana/web3.js');
  const transaction = Transaction.from(txBuffer);

  const signed = await _wallet.signTransaction(transaction);
  const bytes = signed.serialize();
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

// ── Wallet UI Components ──────────────────────────────────────

/**
 * Render a "Connect Wallet" button or show connected address
 */
export function renderWalletButton(container, onConnect) {
  const pubkey = getPublicKey();

  if (pubkey) {
    container.innerHTML = `
      <button class="btn btn-sm wallet-btn connected" id="wallet-btn">
        <span class="wallet-dot"></span>
        ${truncateAddress(pubkey)}
      </button>
    `;
    container.querySelector('#wallet-btn').addEventListener('click', async () => {
      if (confirm('Disconnect wallet?')) {
        await disconnectWallet();
        renderWalletButton(container, onConnect);
      }
    });
  } else {
    container.innerHTML = `
      <button class="btn btn-sm btn-primary wallet-btn" id="wallet-btn">
        🔌 Connect Wallet
      </button>
    `;
    container.querySelector('#wallet-btn').addEventListener('click', async () => {
      try {
        const pk = await connectWallet();
        renderWalletButton(container, onConnect);
        if (onConnect) onConnect(pk);
      } catch (err) {
        alert(err.message);
      }
    });
  }
}

function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}
