/**
 * Admin Dashboard Page
 * Platform administration — stats, admin management, token ops, system info.
 * Requires Phantom wallet auth with admin-level access.
 */

import { api, toast, truncateAddress } from '../main.js';

// === Admin Auth State ===
let _adminWallet = null;
let _adminSig = null;
let _adminTs = null;
let _adminRole = null;
let _dashboardData = null;

const API_BASE = api.base;

// === Admin Fetch Helper ===
async function adminFetch(path, options = {}) {
  const wallet = _adminWallet || localStorage.getItem('adminWallet');
  if (!wallet) throw new Error('Not authenticated as admin');

  const ts = Math.floor(Date.now() / 1000);
  const message = `SolAgentsAdmin:${wallet}:${ts}`;
  const encoded = new TextEncoder().encode(message);
  const { signature } = await window.solana.signMessage(encoded, 'utf8');
  const sigB64 = btoa(String.fromCharCode(...signature));

  const headers = {
    'X-Admin-Auth': `${wallet}:${sigB64}:${ts}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const res = await fetch(API_BASE + path, { ...options, headers });
  return res.json();
}

function isAdminAuthenticated() {
  return !!localStorage.getItem('adminWallet');
}

function getAdminRole() {
  return localStorage.getItem('adminRole') || null;
}

// === Main Render ===
export function renderAdmin(container, state) {
  if (!isAdminAuthenticated()) {
    renderAdminLogin(container);
  } else {
    _adminWallet = localStorage.getItem('adminWallet');
    _adminRole = localStorage.getItem('adminRole');
    renderAdminDashboard(container);
  }
}

// === Login Section ===
function renderAdminLogin(container) {
  container.innerHTML = `
    <div style="max-width:480px;margin:80px auto;text-align:center">
      <div class="card glass" style="padding:40px">
        <div style="font-size:3rem;margin-bottom:16px">🔐</div>
        <h1 class="font-bold text-2xl" style="margin-bottom:8px">Admin Access</h1>
        <p class="text-secondary text-sm" style="margin-bottom:32px">
          Connect your wallet and sign a message to prove admin ownership.
        </p>
        <button class="btn btn-primary btn-glow" id="btn-admin-connect" style="width:100%;padding:14px">
          Connect Wallet
        </button>
        <p class="text-muted text-xs" style="margin-top:16px">
          Only authorized admin wallets can access this page.
        </p>
      </div>
    </div>
  `;

  document.getElementById('btn-admin-connect')?.addEventListener('click', handleAdminConnect);
}

async function handleAdminConnect() {
  const btn = document.getElementById('btn-admin-connect');

  if (!window.solana?.isPhantom) {
    toast('Phantom wallet not found. Install it at phantom.app', 'error');
    window.open('https://phantom.app/', '_blank');
    return;
  }

  try {
    btn.textContent = 'Connecting...';
    btn.disabled = true;

    const resp = await window.solana.connect();
    const walletAddress = resp.publicKey.toString();

    btn.textContent = 'Signing message...';

    const ts = Math.floor(Date.now() / 1000);
    const message = `SolAgentsAdmin:${walletAddress}:${ts}`;
    const encoded = new TextEncoder().encode(message);
    const { signature } = await window.solana.signMessage(encoded, 'utf8');
    const sigB64 = btoa(String.fromCharCode(...signature));

    btn.textContent = 'Verifying...';

    // Try to access the admin dashboard to verify access
    const headers = {
      'X-Admin-Auth': `${walletAddress}:${sigB64}:${ts}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(API_BASE + '/admin/dashboard', { headers });
    const data = await res.json();

    if (data.error || res.status === 403 || res.status === 401) {
      btn.textContent = 'Access Denied';
      btn.className = 'btn btn-ghost';
      btn.style.cssText = 'width:100%;padding:14px;border-color:rgba(255,68,68,0.5);color:#FF4444';
      toast('Access Denied — this wallet is not an admin', 'error');

      setTimeout(() => {
        btn.textContent = 'Connect Wallet';
        btn.className = 'btn btn-primary btn-glow';
        btn.style.cssText = 'width:100%;padding:14px';
        btn.disabled = false;
      }, 3000);
      return;
    }

    // Store admin session
    localStorage.setItem('adminWallet', walletAddress);
    localStorage.setItem('adminRole', data.role || 'admin');
    _adminWallet = walletAddress;
    _adminRole = data.role || 'admin';

    toast(`Welcome, admin ${truncateAddress(walletAddress)}`, 'success');

    // Re-render as authenticated
    const content = document.getElementById('page-content');
    content.innerHTML = '';
    renderAdmin(content, {});

  } catch (err) {
    toast(`Admin login failed: ${err.message}`, 'error');
    btn.textContent = 'Connect Wallet';
    btn.disabled = false;
  }
}

// === Authenticated Dashboard ===
function renderAdminDashboard(container) {
  const isSuperAdmin = _adminRole === 'superAdmin';

  container.innerHTML = `
    <div class="page-header flex items-center" style="justify-content:space-between">
      <div>
        <h1 class="text-2xl font-bold">⚙️ Admin Dashboard</h1>
        <p class="text-secondary mt-1">
          <span class="font-mono text-xs" style="color:#9945FF">${truncateAddress(_adminWallet)}</span>
          <span class="badge" style="margin-left:8px;background:rgba(153,69,255,0.15);color:#9945FF;font-size:0.7rem">${_adminRole}</span>
        </p>
      </div>
      <button class="btn btn-sm btn-ghost" id="btn-admin-logout" style="color:#FF4444">Disconnect</button>
    </div>

    <!-- Platform Stats -->
    <div class="grid grid-4 gap-1 mt-2" id="admin-stats">
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="astat-agents">—</div>
        <div class="text-muted text-sm">Total Agents</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="astat-tokens">—</div>
        <div class="text-muted text-sm">Active Tokens</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="astat-volume">—</div>
        <div class="text-muted text-sm">Total Volume (SOL)</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="astat-pools">—</div>
        <div class="text-muted text-sm">Active Pools</div>
      </div>
    </div>

    <!-- Admin Management (superAdmin only) -->
    ${isSuperAdmin ? `
    <div class="card glass mt-2" id="admin-mgmt-section">
      <div class="card-header flex items-center" style="justify-content:space-between">
        <h2 class="font-semibold">👥 Admin Management</h2>
        <button class="btn btn-sm btn-primary" id="btn-toggle-add-admin">+ Add Admin</button>
      </div>
      <div class="card-body">
        <!-- Add Admin Form (hidden by default) -->
        <div id="add-admin-form" style="display:none;margin-bottom:16px;padding:16px;background:rgba(0,0,0,0.3);border-radius:8px;border:1px solid rgba(255,255,255,0.06)">
          <div class="flex gap-1" style="flex-wrap:wrap;align-items:flex-end">
            <div style="flex:1;min-width:200px">
              <label class="form-label text-xs">Wallet Address</label>
              <input type="text" class="form-input" id="new-admin-wallet" placeholder="Enter wallet address..." style="font-family:var(--font-mono);font-size:0.85rem">
            </div>
            <div style="min-width:160px">
              <label class="form-label text-xs">Role</label>
              <select class="form-input" id="new-admin-role" style="font-size:0.85rem">
                <option value="admin">admin</option>
                <option value="superAdmin">superAdmin</option>
                <option value="token_manager">token_manager</option>
                <option value="pool_manager">pool_manager</option>
              </select>
            </div>
            <button class="btn btn-sm btn-primary" id="btn-add-admin" style="height:38px">Add</button>
            <button class="btn btn-sm btn-ghost" id="btn-cancel-add-admin" style="height:38px">Cancel</button>
          </div>
        </div>

        <!-- Admin Table -->
        <div id="admins-table" style="overflow-x:auto">
          <p class="text-muted text-sm">Loading admins...</p>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- Token Operations -->
    <div class="card glass mt-2">
      <div class="card-header">
        <h2 class="font-semibold">🪙 Token Operations</h2>
      </div>
      <div class="card-body">
        <div class="grid grid-3 gap-1">
          <!-- Reset Token -->
          <div class="card glass p-2" style="background:rgba(0,0,0,0.3)">
            <h3 class="font-semibold text-sm" style="margin-bottom:12px">Reset Token</h3>
            <div class="form-group">
              <label class="form-label text-xs">Token ID</label>
              <input type="text" class="form-input" id="reset-token-id" placeholder="Token ID" style="font-size:0.85rem">
            </div>
            <button class="btn btn-sm btn-ghost mt-1" id="btn-reset-token" style="width:100%;border-color:rgba(255,68,68,0.3);color:#FF4444">
              🔄 Reset Token
            </button>
          </div>

          <!-- Update Token Mint -->
          <div class="card glass p-2" style="background:rgba(0,0,0,0.3)">
            <h3 class="font-semibold text-sm" style="margin-bottom:12px">Update Token Mint</h3>
            <div class="form-group">
              <label class="form-label text-xs">Token ID</label>
              <input type="text" class="form-input" id="update-token-id" placeholder="Token ID" style="font-size:0.85rem">
            </div>
            <div class="form-group mt-1">
              <label class="form-label text-xs">New Mint Address</label>
              <input type="text" class="form-input" id="update-mint-address" placeholder="Mint address" style="font-family:var(--font-mono);font-size:0.85rem">
            </div>
            <button class="btn btn-sm btn-ghost mt-1" id="btn-update-mint" style="width:100%;border-color:rgba(153,69,255,0.3);color:#9945FF">
              ✏️ Update Mint
            </button>
          </div>

          <!-- Trigger Graduation -->
          <div class="card glass p-2" style="background:rgba(0,0,0,0.3)">
            <h3 class="font-semibold text-sm" style="margin-bottom:12px">Trigger Graduation</h3>
            <div class="form-group">
              <label class="form-label text-xs">Mint Address</label>
              <input type="text" class="form-input" id="grad-mint-address" placeholder="Mint address" style="font-family:var(--font-mono);font-size:0.85rem">
            </div>
            <button class="btn btn-sm btn-ghost mt-1" id="btn-trigger-grad" style="width:100%;border-color:rgba(20,241,149,0.3);color:#14F195">
              🎓 Graduate Token
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- System Info -->
    <div class="card glass mt-2">
      <div class="card-header">
        <h2 class="font-semibold">🖥️ System Info</h2>
      </div>
      <div class="card-body" id="system-info">
        <p class="text-muted text-sm">Loading system info...</p>
      </div>
    </div>
  `;

  // === Event Handlers ===

  // Logout
  document.getElementById('btn-admin-logout')?.addEventListener('click', () => {
    localStorage.removeItem('adminWallet');
    localStorage.removeItem('adminRole');
    _adminWallet = null;
    _adminRole = null;
    toast('Admin session ended', 'info');
    const content = document.getElementById('page-content');
    content.innerHTML = '';
    renderAdmin(content, {});
  });

  // Toggle add admin form
  document.getElementById('btn-toggle-add-admin')?.addEventListener('click', () => {
    const form = document.getElementById('add-admin-form');
    if (form) form.style.display = form.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('btn-cancel-add-admin')?.addEventListener('click', () => {
    const form = document.getElementById('add-admin-form');
    if (form) form.style.display = 'none';
  });

  // Add admin
  document.getElementById('btn-add-admin')?.addEventListener('click', handleAddAdmin);

  // Token ops
  document.getElementById('btn-reset-token')?.addEventListener('click', handleResetToken);
  document.getElementById('btn-update-mint')?.addEventListener('click', handleUpdateMint);
  document.getElementById('btn-trigger-grad')?.addEventListener('click', handleTriggerGraduation);

  // Load data
  loadAdminDashboard();
  if (isSuperAdmin) loadAdminsList();
  loadSystemInfo();
}

// === Data Loaders ===

async function loadAdminDashboard() {
  try {
    const data = await adminFetch('/admin/dashboard');
    _dashboardData = data;

    const el = id => document.getElementById(id);
    if (el('astat-agents')) el('astat-agents').textContent = data.totalAgents ?? data.total_agents ?? '—';
    if (el('astat-tokens')) el('astat-tokens').textContent = data.activeTokens ?? data.active_tokens ?? '—';
    if (el('astat-volume')) {
      const vol = parseFloat(data.totalVolume ?? data.total_volume ?? 0);
      el('astat-volume').textContent = vol > 0 ? vol.toFixed(2) : '0';
    }
    if (el('astat-pools')) el('astat-pools').textContent = data.activePools ?? data.active_pools ?? '—';

    // Store role if returned
    if (data.role) {
      _adminRole = data.role;
      localStorage.setItem('adminRole', data.role);
    }
  } catch (err) {
    toast(`Failed to load dashboard: ${err.message}`, 'error');
  }
}

async function loadAdminsList() {
  try {
    const data = await adminFetch('/admin/admins');
    const admins = data.admins || data || [];
    const table = document.getElementById('admins-table');
    if (!table) return;

    if (admins.length === 0) {
      table.innerHTML = '<p class="text-muted text-sm">No admins found.</p>';
      return;
    }

    table.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <thead>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
            <th style="padding:10px;text-align:left;color:var(--text-muted)">Wallet</th>
            <th style="padding:10px;text-align:left;color:var(--text-muted)">Role</th>
            <th style="padding:10px;text-align:left;color:var(--text-muted)">Added</th>
            <th style="padding:10px;text-align:right;color:var(--text-muted)">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${admins.map(a => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.04)" data-wallet="${a.wallet || a.walletAddress}">
              <td style="padding:10px">
                <span class="font-mono text-xs">${a.wallet || a.walletAddress || '—'}</span>
              </td>
              <td style="padding:10px">
                <span class="badge" style="background:${roleBadgeColor(a.role)};font-size:0.7rem">${a.role}</span>
              </td>
              <td style="padding:10px">
                <span class="text-muted text-xs">${a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}</span>
              </td>
              <td style="padding:10px;text-align:right">
                ${a.wallet !== _adminWallet && a.walletAddress !== _adminWallet ? `
                  <button class="btn btn-xs btn-ghost btn-remove-admin" data-wallet="${a.wallet || a.walletAddress}" style="color:#FF4444;border-color:rgba(255,68,68,0.2)">
                    Remove
                  </button>
                ` : '<span class="text-muted text-xs">You</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Wire up remove buttons
    table.querySelectorAll('.btn-remove-admin').forEach(btn => {
      btn.addEventListener('click', () => handleRemoveAdmin(btn.dataset.wallet));
    });
  } catch (err) {
    const table = document.getElementById('admins-table');
    if (table) table.innerHTML = `<p class="text-error text-sm">Failed to load admins: ${err.message}</p>`;
  }
}

async function loadSystemInfo() {
  try {
    const data = await adminFetch('/admin/deployer');
    const infoEl = document.getElementById('system-info');
    if (!infoEl) return;

    const balance = data.balance ?? data.deployer_balance ?? '—';
    const deployerWallet = data.wallet ?? data.deployer_wallet ?? data.address ?? '—';
    const cluster = data.cluster ?? 'devnet';

    infoEl.innerHTML = `
      <div class="grid grid-2 gap-1">
        <div class="card glass p-2" style="background:rgba(0,0,0,0.3)">
          <h3 class="font-semibold text-sm" style="margin-bottom:12px;color:#9945FF">💳 Deployer Wallet</h3>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Address</span>
            <span class="font-mono text-xs" style="word-break:break-all">${deployerWallet}</span>
          </div>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Balance</span>
            <span class="font-mono text-xs" style="color:#14F195">${balance} SOL</span>
          </div>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Cluster</span>
            <span class="font-mono text-xs">${cluster}</span>
          </div>
        </div>

        <div class="card glass p-2" style="background:rgba(0,0,0,0.3)">
          <h3 class="font-semibold text-sm" style="margin-bottom:12px;color:#14F195">🏥 Platform Health</h3>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Status</span>
            <span class="text-xs" style="color:#14F195">● Online</span>
          </div>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">API</span>
            <span class="font-mono text-xs">${API_BASE}</span>
          </div>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Network</span>
            <span class="font-mono text-xs">${cluster === 'devnet' ? 'Solana Devnet' : cluster === 'mainnet-beta' ? 'Solana Mainnet' : cluster}</span>
          </div>
          ${data.version ? `
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Version</span>
            <span class="font-mono text-xs">${data.version}</span>
          </div>
          ` : ''}
          ${data.uptime ? `
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Uptime</span>
            <span class="font-mono text-xs">${data.uptime}</span>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    const infoEl = document.getElementById('system-info');
    if (infoEl) infoEl.innerHTML = `<p class="text-error text-sm">Failed to load system info: ${err.message}</p>`;
  }
}

// === Action Handlers ===

async function handleAddAdmin() {
  const wallet = document.getElementById('new-admin-wallet')?.value.trim();
  const role = document.getElementById('new-admin-role')?.value;

  if (!wallet) {
    toast('Enter a wallet address', 'error');
    return;
  }

  const btn = document.getElementById('btn-add-admin');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    const result = await adminFetch('/admin/admins', {
      method: 'POST',
      body: JSON.stringify({ wallet, role }),
    });

    if (result.error) {
      toast(result.error, 'error');
    } else {
      toast(`Admin ${truncateAddress(wallet)} added as ${role}`, 'success');
      document.getElementById('new-admin-wallet').value = '';
      document.getElementById('add-admin-form').style.display = 'none';
      loadAdminsList();
    }
  } catch (err) {
    toast(`Failed to add admin: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

async function handleRemoveAdmin(wallet) {
  if (!confirm(`Remove admin ${truncateAddress(wallet)}?`)) return;

  try {
    const result = await adminFetch(`/admin/admins/${wallet}`, {
      method: 'DELETE',
    });

    if (result.error) {
      toast(result.error, 'error');
    } else {
      toast(`Admin ${truncateAddress(wallet)} removed`, 'success');
      loadAdminsList();
    }
  } catch (err) {
    toast(`Failed to remove admin: ${err.message}`, 'error');
  }
}

async function handleResetToken() {
  const tokenId = document.getElementById('reset-token-id')?.value.trim();
  if (!tokenId) {
    toast('Enter a token ID', 'error');
    return;
  }

  const btn = document.getElementById('btn-reset-token');
  btn.disabled = true;
  btn.textContent = 'Resetting...';

  try {
    const result = await adminFetch(`/admin/tokens/${tokenId}/reset`, {
      method: 'POST',
    });

    if (result.error) {
      toast(result.error, 'error');
    } else {
      toast(`Token ${tokenId} reset successfully`, 'success');
      document.getElementById('reset-token-id').value = '';
    }
  } catch (err) {
    toast(`Reset failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Reset Token';
  }
}

async function handleUpdateMint() {
  const tokenId = document.getElementById('update-token-id')?.value.trim();
  const mintAddress = document.getElementById('update-mint-address')?.value.trim();

  if (!tokenId || !mintAddress) {
    toast('Enter both token ID and mint address', 'error');
    return;
  }

  const btn = document.getElementById('btn-update-mint');
  btn.disabled = true;
  btn.textContent = 'Updating...';

  try {
    const result = await adminFetch(`/admin/tokens/${tokenId}/mint`, {
      method: 'POST',
      body: JSON.stringify({ mintAddress }),
    });

    if (result.error) {
      toast(result.error, 'error');
    } else {
      toast(`Token ${tokenId} mint updated to ${truncateAddress(mintAddress)}`, 'success');
      document.getElementById('update-token-id').value = '';
      document.getElementById('update-mint-address').value = '';
    }
  } catch (err) {
    toast(`Update failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✏️ Update Mint';
  }
}

async function handleTriggerGraduation() {
  const mintAddress = document.getElementById('grad-mint-address')?.value.trim();
  if (!mintAddress) {
    toast('Enter a mint address', 'error');
    return;
  }

  const btn = document.getElementById('btn-trigger-grad');
  btn.disabled = true;
  btn.textContent = 'Graduating...';

  try {
    const result = await adminFetch('/admin/graduate', {
      method: 'POST',
      body: JSON.stringify({ mintAddress }),
    });

    if (result.error) {
      toast(result.error, 'error');
    } else {
      toast(`🎓 Token ${truncateAddress(mintAddress)} graduated!`, 'success');
      document.getElementById('grad-mint-address').value = '';
    }
  } catch (err) {
    toast(`Graduation failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🎓 Graduate Token';
  }
}

// === Helpers ===

function roleBadgeColor(role) {
  switch (role) {
    case 'superAdmin': return 'rgba(255,68,68,0.15);color:#FF6B6B';
    case 'admin': return 'rgba(153,69,255,0.15);color:#9945FF';
    case 'token_manager': return 'rgba(20,241,149,0.15);color:#14F195';
    case 'pool_manager': return 'rgba(255,183,77,0.15);color:#FFB74D';
    default: return 'rgba(255,255,255,0.08);color:var(--text-muted)';
  }
}
