/**
 * Wallet Service - Solana Wallet Adapter (multi-wallet support)
 *
 * Supports: Phantom, Solflare, Backpack, Coinbase, Ledger + any injected wallet
 * Mobile: deep-link buttons to open site inside wallet app browser
 * Provides: connect (with modal), disconnect, sign, send, auto-reconnect
 */

import { Connection, Transaction } from '@solana/web3.js';

// Config
const RPC_ENDPOINT = 'https://api.devnet.solana.com';

// Adapters (lazy-initialized to avoid crashes on mobile)
let _wallets = null;

async function getWallets() {
  if (_wallets) return _wallets;
  _wallets = [];
  try {
    const { PhantomWalletAdapter } = await import('@solana/wallet-adapter-phantom');
    _wallets.push(new PhantomWalletAdapter());
  } catch {}
  try {
    const { SolflareWalletAdapter } = await import('@solana/wallet-adapter-solflare');
    _wallets.push(new SolflareWalletAdapter());
  } catch {}
  try {
    const { CoinbaseWalletAdapter } = await import('@solana/wallet-adapter-coinbase');
    _wallets.push(new CoinbaseWalletAdapter());
  } catch {}
  // Ledger requires WebHID - skip on mobile/browsers that don't support it
  if (typeof navigator !== 'undefined' && navigator.hid) {
    try {
      const { LedgerWalletAdapter } = await import('@solana/wallet-adapter-ledger');
      _wallets.push(new LedgerWalletAdapter());
    } catch {}
  }
  return _wallets;
}

// State
let _adapter = null;
let _onConnectCallbacks = [];
let _onDisconnectCallbacks = [];

// Public API

export function getPublicKey() {
  return _adapter?.publicKey?.toBase58() ?? null;
}

export function isConnected() {
  return !!_adapter?.connected;
}

export function getWalletName() {
  return _adapter?.name ?? null;
}

export function onConnect(cb) {
  _onConnectCallbacks.push(cb);
}

export function onDisconnect(cb) {
  _onDisconnectCallbacks.push(cb);
}

// Connect (shows modal)

export async function connectWallet() {
  const wallets = await getWallets();
  const detected = wallets.filter(w => w.readyState === 'Installed');
  const allWallets = [...detected, ...wallets.filter(w => !detected.includes(w))];

  // Always show modal - mobile deep links are in there too
  return new Promise((resolve, reject) => {
    _showWalletModal(allWallets, resolve, reject);
  });
}

export async function disconnectWallet() {
  if (_adapter) {
    try { await _adapter.disconnect(); } catch {}
  }
  _adapter = null;
  localStorage.removeItem('walletConnected');
  localStorage.removeItem('walletName');
  _onDisconnectCallbacks.forEach(cb => cb());
}

// Auto-reconnect

export async function tryAutoConnect() {
  const savedName = localStorage.getItem('walletName');
  if (!savedName || localStorage.getItem('walletConnected') !== 'true') return null;

  const wallets = await getWallets();
  const adapter = wallets.find(w => w.name === savedName);
  if (!adapter || adapter.readyState !== 'Installed') return null;

  try {
    await adapter.connect();
    _adapter = adapter;
    _setupListeners(adapter);
    _onConnectCallbacks.forEach(cb => cb(adapter.publicKey.toBase58()));
    return adapter.publicKey.toBase58();
  } catch {
    localStorage.removeItem('walletConnected');
    localStorage.removeItem('walletName');
    return null;
  }
}

// Signing

/**
 * Sign a UTF-8 message string. Returns { signature: Uint8Array }.
 */
export async function signMessage(message) {
  if (!_adapter?.connected) throw new Error('Wallet not connected');
  if (!_adapter.signMessage) throw new Error(`${_adapter.name} does not support message signing`);

  const encoded = new TextEncoder().encode(message);
  const signature = await _adapter.signMessage(encoded);
  return { signature };
}

/**
 * Sign and send a base64-encoded transaction from the server.
 * Returns: transaction signature (string)
 */
export async function signAndSendTransaction(base64Tx, options = {}) {
  if (!_adapter?.connected) throw new Error('Wallet not connected');

  const txBuffer = _base64ToBytes(base64Tx);
  const transaction = Transaction.from(txBuffer);
  const signed = await _adapter.signTransaction(transaction);

  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const rawTx = signed.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: options.skipPreflight ?? false,
    maxRetries: options.maxRetries ?? 3,
    preflightCommitment: 'confirmed',
  });

  if (options.skipConfirm) return signature;

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value?.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

/**
 * Sign a transaction without sending (returns base64 serialized)
 */
export async function signTransaction(base64Tx) {
  if (!_adapter?.connected) throw new Error('Wallet not connected');

  const txBuffer = _base64ToBytes(base64Tx);
  const transaction = Transaction.from(txBuffer);
  const signed = await _adapter.signTransaction(transaction);
  const bytes = signed.serialize();
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

// Wallet Button UI

export function renderWalletButton(container, onConnectCb) {
  const pubkey = getPublicKey();

  if (pubkey) {
    const icon = _adapter?.icon
      ? `<img src="${_adapter.icon}" alt="" style="width:18px;height:18px;border-radius:4px;margin-right:6px;vertical-align:middle">`
      : '';
    container.innerHTML = `
      <button class="btn btn-sm wallet-btn connected" id="wallet-btn">
        <span class="wallet-dot"></span>
        ${icon}${_truncateAddress(pubkey)}
      </button>
    `;
    container.querySelector('#wallet-btn').addEventListener('click', async () => {
      if (confirm('Disconnect wallet?')) {
        await disconnectWallet();
        renderWalletButton(container, onConnectCb);
      }
    });
  } else {
    container.innerHTML = `
      <button class="btn btn-sm btn-primary wallet-btn" id="wallet-btn">
        Connect Wallet
      </button>
    `;
    container.querySelector('#wallet-btn').addEventListener('click', async () => {
      try {
        const pk = await connectWallet();
        renderWalletButton(container, onConnectCb);
        if (onConnectCb) onConnectCb(pk);
      } catch (err) {
        if (err.message !== 'Wallet selection cancelled') alert(err.message);
      }
    });
  }
}

// Internal

async function _connectAdapter(adapter) {
  await adapter.connect();
  _adapter = adapter;
  _setupListeners(adapter);

  localStorage.setItem('walletConnected', 'true');
  localStorage.setItem('walletName', adapter.name);

  const pubkey = adapter.publicKey.toBase58();
  _onConnectCallbacks.forEach(cb => cb(pubkey));
  return pubkey;
}

function _setupListeners(adapter) {
  adapter.on('disconnect', () => {
    _adapter = null;
    localStorage.removeItem('walletConnected');
    localStorage.removeItem('walletName');
    _onDisconnectCallbacks.forEach(cb => cb());
  });
}

function _truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function _base64ToBytes(b64) {
  const cleaned = b64.replace(/\s/g, '');
  const padded = cleaned + '=='.slice(0, (4 - cleaned.length % 4) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function _isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// Mobile deep-link wallets (open site inside wallet's built-in browser)
const MOBILE_WALLETS = [
  {
    name: 'Phantom',
    icon: 'https://raw.githubusercontent.com/solana-labs/wallet-adapter/master/packages/wallets/phantom/icon.png',
    getUrl() {
      const url = encodeURIComponent(window.location.href);
      return `https://phantom.app/ul/browse/${url}?ref=${url}`;
    },
  },
  {
    name: 'Solflare',
    icon: 'https://solflare.com/favicon-32x32.png',
    getUrl() {
      const url = encodeURIComponent(window.location.href);
      return `https://solflare.com/ul/v1/browse/${url}?ref=${url}`;
    },
  },
  {
    name: 'Backpack',
    icon: 'https://backpack.app/favicon.png',
    getUrl() { return 'https://backpack.app/'; },
  },
];

// Wallet Selection Modal

function _showWalletModal(wallets, resolve, reject) {
  document.getElementById('wallet-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'wallet-modal-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);animation:walletFadeIn 0.2s ease;';

  const installed = wallets.filter(w => w.readyState === 'Installed');
  const notInstalled = wallets.filter(w => w.readyState !== 'Installed');
  const onMobile = _isMobile();

  const baseItemStyle =
    'display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;' +
    'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);' +
    'border-radius:12px;color:#fff;cursor:pointer;transition:all 0.2s;';

  const walletItems = (list, dim = false) => list.map(w =>
    `<button class="wallet-option" data-wallet="${w.name}" style="${baseItemStyle}${dim ? 'opacity:0.5;' : ''}">` +
    `<img src="${w.icon}" alt="${w.name}" style="width:36px;height:36px;border-radius:8px">` +
    `<div style="flex:1;text-align:left">` +
    `<div style="font-weight:600;font-size:0.95rem">${w.name}</div>` +
    `<div style="font-size:0.75rem;color:rgba(255,255,255,0.5)">${w.readyState === 'Installed' ? 'Detected' : 'Not installed'}</div>` +
    `</div>` +
    (w.readyState === 'Installed' ? '<span style="color:#FFD700;font-size:0.8rem">&#9679;</span>' : '') +
    `</button>`
  ).join('');

  const mobileItems = () => MOBILE_WALLETS.map(w =>
    `<a class="wallet-mobile-option" href="${w.getUrl()}" style="${baseItemStyle}text-decoration:none;" target="_blank" rel="noopener">` +
    `<img src="${w.icon}" alt="${w.name}" style="width:36px;height:36px;border-radius:8px;background:#333;" onerror="this.style.display='none'">` +
    `<div style="flex:1;text-align:left">` +
    `<div style="font-weight:600;font-size:0.95rem">${w.name}</div>` +
    `<div style="font-size:0.75rem;color:rgba(255,255,255,0.5)">Open in app</div>` +
    `</div>` +
    `<span style="font-size:0.9rem;color:rgba(255,255,255,0.35)">&#8599;</span>` +
    `</a>`
  ).join('');

  const sectionLabel = (text) =>
    `<div style="font-size:0.75rem;color:rgba(255,255,255,0.4);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">${text}</div>`;

  let body = '';

  // Mobile: show deep-link options first
  if (onMobile) {
    body += sectionLabel('Open in wallet app');
    body += `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:${installed.length ? '16px' : '0'}">${mobileItems()}</div>`;
  }

  // Desktop: installed wallets
  if (installed.length > 0) {
    if (onMobile) body += sectionLabel('Detected');
    body += `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:${notInstalled.length && !onMobile ? '16px' : '0'}">${walletItems(installed)}</div>`;
  }

  // Desktop: uninstalled wallets (skip on mobile - deep links cover it)
  if (notInstalled.length > 0 && !onMobile) {
    body += sectionLabel('Other Wallets');
    body += `<div style="display:flex;flex-direction:column;gap:8px">${walletItems(notInstalled, true)}</div>`;
  }

  overlay.innerHTML =
    `<div style="background:rgba(10,10,15,0.95);backdrop-filter:blur(20px);` +
    `border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:28px;` +
    `max-width:400px;width:90%;max-height:80vh;overflow-y:auto;` +
    `box-shadow:0 24px 48px rgba(0,0,0,0.5);animation:walletSlideUp 0.25s ease;">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">` +
    `<h2 style="margin:0;font-size:1.2rem;color:#fff">Connect Wallet</h2>` +
    `<button id="wallet-modal-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:1.4rem;cursor:pointer;padding:4px 8px;line-height:1;">&#x2715;</button>` +
    `</div>${body}</div>` +
    `<style>` +
    `@keyframes walletFadeIn{from{opacity:0}to{opacity:1}}` +
    `@keyframes walletSlideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}` +
    `.wallet-option:hover,.wallet-mobile-option:hover{background:rgba(255,215,0,0.1)!important;border-color:rgba(255,215,0,0.3)!important;}` +
    `</style>`;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    reject(new Error('Wallet selection cancelled'));
  };

  overlay.querySelector('#wallet-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelectorAll('.wallet-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.wallet;
      const adapter = wallets.find(w => w.name === name);
      if (!adapter) return;

      if (adapter.readyState !== 'Installed') {
        if (adapter.url) window.open(adapter.url, '_blank');
        return;
      }

      const labels = btn.querySelectorAll('div > div');
      labels[0].textContent = 'Connecting...';
      try {
        const pubkey = await _connectAdapter(adapter);
        overlay.remove();
        resolve(pubkey);
      } catch (err) {
        labels[0].textContent = adapter.name;
        labels[1].textContent = err.message;
      }
    });
  });
}
