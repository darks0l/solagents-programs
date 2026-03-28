/**
 * SolAgents — Frontend Entry Point
 * SPA with glassmorphism UI, Solana wallet connect, page routing
 */

import { renderDashboard } from './pages/dashboard.js';
import { renderJobs } from './pages/jobs.js';
import { renderMessages } from './pages/messages.js';
import { renderTrade } from './pages/trade.js';
import { renderCards } from './pages/cards.js';
import { renderAgents } from './pages/agents.js';
import { renderTokenize } from './pages/tokenize.js';
import { renderSkills } from './pages/skills.js';
import { renderTracker } from './pages/tracker.js';
import { renderMarketplace } from './pages/marketplace.js';
import { renderAgentProfile } from './pages/agent-profile.js';
import { renderAdmin } from './pages/admin.js';

// === State ===
const state = {
  currentPage: 'dashboard',
  agent: null,
  wallet: null,
  connected: false,
  authToken: null,
  authTokenExpiry: 0,
};

// === API Client ===
// VITE_API_URL lets us point at a remote API server (e.g. Railway) while the
// frontend is served from Vercel.  Falls back to same-origin /api for local dev.
const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

/**
 * Get a cached auth token, re-signing with Phantom only when expired.
 * Token format: agentId:base64Signature:timestamp
 * Cached for 4 minutes (server allows 5 min TTL).
 */
async function getAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  if (state.authToken && state.authTokenExpiry > now) {
    return state.authToken;
  }
  if (!state.agent?.id || !window.solana?.isConnected) return null;

  const ts = now.toString();
  const message = `AgentSol:${state.agent.id}:${ts}`;
  const encoded = new TextEncoder().encode(message);
  const { signature } = await window.solana.signMessage(encoded, 'utf8');
  const sigB64 = btoa(String.fromCharCode(...signature));
  state.authToken = `${state.agent.id}:${sigB64}:${ts}`;
  state.authTokenExpiry = now + 240; // refresh 1 min before server's 5 min expiry
  return state.authToken;
}

export const api = {
  base: API_BASE,

  async get(path) {
    const headers = {};
    if (state.agent) {
      const token = await getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(this.base + path, { headers });
    return res.json();
  },

  async post(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.agent) {
      const token = await getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

// === SOL/USD Price ===
let _solPrice = { usd: 0, ts: 0 };
export async function getSolPrice() {
  // Cache for 60 seconds
  if (_solPrice.usd && Date.now() - _solPrice.ts < 60_000) return _solPrice.usd;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    _solPrice = { usd: data.solana.usd, ts: Date.now() };
    return _solPrice.usd;
  } catch {
    return _solPrice.usd || 0;
  }
}

// === Toast Notifications ===
export function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// === Router ===
const pages = {
  dashboard: renderDashboard,
  jobs: renderJobs,
  messages: renderMessages,
  trade: renderTrade,
  cards: renderCards,
  agents: renderAgents,
  agent: renderAgentProfile,
  marketplace: renderMarketplace,
  tokenize: renderTokenize,
  skills: renderSkills,
  tracker: renderTracker,
  admin: renderAdmin,
};

// === URL helpers ===
function pathForPage(page, params = {}) {
  if (page === 'dashboard') return '/';
  if (page === 'trade' && params.mintAddress) return `/trade/${params.mintAddress}`;
  if (page === 'agent' && (params.agentId || params.id)) return `/agent/${params.agentId || params.id}`;
  if (page === 'admin') return '/admin';
  return `/${page}`;
}

function pageFromPath(path) {
  if (!path || path === '/') return { page: 'dashboard', params: {} };
  const tradeMatch = path.match(/^\/trade\/([^/]+)$/);
  if (tradeMatch) return { page: 'trade', params: { mintAddress: tradeMatch[1] } };
  const agentMatch = path.match(/^\/agent\/([^/]+)$/);
  if (agentMatch) return { page: 'agent', params: { agentId: agentMatch[1] } };
  const pageMatch = path.match(/^\/([a-z]+)$/);
  if (pageMatch && pages[pageMatch[1]]) return { page: pageMatch[1], params: {} };
  return { page: 'dashboard', params: {} };
}

function navigate(page, params = {}, skipHistory = false) {
  state.currentPage = page;
  state.routeParams = params;

  // Update browser URL
  const path = pathForPage(page, params);
  if (!skipHistory && window.location.pathname !== path) {
    history.pushState({ page, params }, '', path);
  } else if (skipHistory) {
    history.replaceState({ page, params }, '', path);
  }

  // Update nav active states
  document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
    // Keep "Agents" nav active when viewing an agent profile
    const navPage = link.dataset.page;
    link.classList.toggle('active', navPage === page || (navPage === 'agents' && page === 'agent'));
  });

  // Hide mobile nav
  document.querySelector('.mobile-nav-overlay')?.classList.add('hidden');

  // Render page
  const content = document.getElementById('page-content');
  content.innerHTML = '';
  content.className = 'main-content page-enter';

  if (pages[page]) {
    pages[page](content, state, params.mintAddress || params.agentId || params.id);
  }
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  if (e.state?.page) {
    navigate(e.state.page, e.state.params || {}, true);
  } else {
    const { page, params } = pageFromPath(window.location.pathname);
    navigate(page, params, true);
  }
});

// === Wallet Connect (Phantom) ===
async function connectWallet() {
  const btn = document.getElementById('btn-connect');

  if (state.connected) {
    state.connected = false;
    state.wallet = null;
    state.agent = null;
    state.authToken = null;
    state.authTokenExpiry = 0;
    btn.textContent = 'Connect Wallet';
    btn.className = 'btn btn-primary btn-glow';
    toast('Wallet disconnected', 'info');
    navigate(state.currentPage);
    return;
  }

  // Check for Phantom
  if (!window.solana?.isPhantom) {
    toast('Phantom wallet not found. Install it at phantom.app', 'error');
    window.open('https://phantom.app/', '_blank');
    return;
  }

  try {
    btn.textContent = 'Connecting...';
    const resp = await window.solana.connect();
    const walletAddress = resp.publicKey.toString();

    state.wallet = walletAddress;
    state.connected = true;

    // Check if agent exists
    try {
      const agentData = await api.get(`/agents/wallet/${walletAddress}`);
      if (agentData.id) {
        state.agent = agentData;
        toast(`Welcome back, ${agentData.name}!`, 'success');
      }
    } catch {
      // Not registered yet — that's fine
      toast('Wallet connected! Register as an agent to get started.', 'info');
    }

    btn.textContent = truncateAddress(walletAddress);
    btn.className = 'btn btn-ghost';
    navigate(state.currentPage);

  } catch (err) {
    btn.textContent = 'Connect Wallet';
    toast(`Connection failed: ${err.message}`, 'error');
  }
}

// === Utility ===
export function truncateAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

export function timeAgo(unixTimestamp) {
  const diff = Math.floor(Date.now() / 1000) - unixTimestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function getState() { return state; }

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  // Nav links
  document.querySelectorAll('[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.page);
    });
  });

  // Mobile toggle
  document.querySelector('.nav-mobile-toggle')?.addEventListener('click', () => {
    document.querySelector('.mobile-nav-overlay')?.classList.toggle('hidden');
  });

  // Close mobile nav on overlay click
  document.querySelector('.mobile-nav-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
    }
  });

  // Connect wallet button
  document.getElementById('btn-connect')?.addEventListener('click', connectWallet);

  // Auto-connect if Phantom is available and was previously connected
  if (window.solana?.isPhantom && window.solana?.isConnected) {
    connectWallet();
  }

  // Custom navigate events from pages
  // Support: navigate('tokenize') or navigate({ page: 'trade', mintAddress: '...' })
  document.addEventListener('navigate', (e) => {
    if (!e.detail) return;
    if (typeof e.detail === 'string') {
      if (pages[e.detail]) navigate(e.detail);
    } else if (e.detail.page) {
      navigate(e.detail.page, e.detail);
    }
  });

  // Show admin nav link if admin wallet stored
  function updateAdminNavVisibility() {
    const isAdmin = !!localStorage.getItem('adminWallet');
    document.querySelectorAll('.admin-nav-link').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
  }
  updateAdminNavVisibility();
  // Re-check on storage changes and after navigation
  window.addEventListener('storage', updateAdminNavVisibility);
  const _origNavigate = navigate;
  // Periodically check (covers login/logout within same tab)
  setInterval(updateAdminNavVisibility, 2000);

  // Initial render — parse URL so deep links and refresh work
  const { page: initPage, params: initParams } = pageFromPath(window.location.pathname);
  navigate(initPage, initParams, true);
});
