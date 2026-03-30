/**
 * Admin Dashboard Page
 * Platform administration — stats, admin management, token ops, system info.
 * Requires wallet auth with admin-level access.
 */

import { api, toast, truncateAddress } from '../main.js';
import { connectWallet, signMessage, getPublicKey, isConnected, signAndSendTransaction } from '../services/wallet.js';

// === Admin Auth State ===
let _adminWallet = null;
let _adminSig = null;
let _adminTs = null;
let _adminRole = null;
let _dashboardData = null;

// === Admin Fetch Helper ===
async function adminFetch(path, options = {}) {
  const wallet = _adminWallet || localStorage.getItem('adminWallet');
  if (!wallet) throw new Error('Not authenticated as admin');

  const ts = Math.floor(Date.now() / 1000);
  const msg = `SolAgentsAdmin:${wallet}:${ts}`;
  const { signature } = await signMessage(msg);
  const sigB64 = btoa(String.fromCharCode(...signature));

  const headers = {
    'X-Admin-Auth': `${wallet}:${sigB64}:${ts}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const res = await fetch(api.base + path, { ...options, headers });
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
        <div style="font-size:3rem;margin-bottom:16px"><img class="icon" src="/icons/white/lock.png" alt="Lock"></div>
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

  try {
    btn.textContent = 'Connecting...';
    btn.disabled = true;

    const walletAddress = isConnected() ? getPublicKey() : await connectWallet();

    btn.textContent = 'Signing message...';

    const ts = Math.floor(Date.now() / 1000);
    const msg = `SolAgentsAdmin:${walletAddress}:${ts}`;
    const { signature } = await signMessage(msg);
    const sigB64 = btoa(String.fromCharCode(...signature));

    btn.textContent = 'Verifying...';

    // Try to access the admin dashboard to verify access
    const headers = {
      'X-Admin-Auth': `${walletAddress}:${sigB64}:${ts}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(api.base + '/admin/dashboard', { headers });
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
        <h1 class="text-2xl font-bold"><img class="icon" src="/icons/white/gear.png" alt="Settings"> Admin Dashboard</h1>
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
        <h2 class="font-semibold"><img class="icon" src="/icons/white/person.png" alt="Users"> Admin Management</h2>
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
        <h2 class="font-semibold"><img class="icon" src="/icons/white/coin-flat.png" alt="Token"> Token Operations</h2>
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
              <img class="icon" src="/icons/white/gear.png" alt="Refresh"> Reset Token
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
              <img class="icon" src="/icons/white/document.png" alt="Edit"> Update Mint
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
              <img class="icon" src="/icons/white/rocket.png" alt="Graduated"> Graduate Token
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Platform Fees Section -->
    <div class="card glass mt-2" id="platform-fees-section">
      <div class="card-header flex items-center" style="justify-content:space-between">
        <h2 class="font-semibold">🧹 Platform Fees</h2>
        <button class="btn btn-sm btn-primary" id="btn-claim-all-fees">Claim All Fees</button>
      </div>
      <div class="card-body" id="platform-fees-table">
        <p class="text-muted text-sm">Loading fee data...</p>
      </div>
    </div>

    <!-- Pool Management Section (superAdmin only) -->
    ${isSuperAdmin ? `
    <div class="card glass mt-2" id="pool-mgmt-section">
      <div class="card-header flex items-center" style="justify-content:space-between">
        <h2 class="font-semibold">🎓 Graduated Pools</h2>
        <button class="btn btn-sm btn-ghost" id="btn-close-all-pools" style="border-color:rgba(255,68,68,0.3);color:#FF4444">Close All</button>
      </div>
      <div class="card-body" id="closeable-pools-table">
        <p class="text-muted text-sm">Loading closeable pools...</p>
      </div>
    </div>
    ` : ''}

    <!-- Emergency Controls (superAdmin only) -->
    ${isSuperAdmin ? `
    <div class="card glass mt-2" id="emergency-controls-section">
      <div class="card-header">
        <h2 class="font-semibold">⚠️ Emergency Controls</h2>
      </div>
      <div class="card-body">
        <div id="trading-pause-warning" style="display:none;margin-bottom:16px;padding:12px 16px;background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.4);border-radius:8px;color:#FF4444;font-weight:600;font-size:0.95rem">
          ⚠️ TRADING IS PAUSED — all buy/sell transactions will fail
        </div>
        <div class="flex items-center gap-1" style="flex-wrap:wrap">
          <span class="text-sm font-semibold" style="margin-right:8px">Trading Paused</span>
          <label class="toggle-switch" style="position:relative;display:inline-block;width:52px;height:28px">
            <input type="checkbox" id="trading-pause-toggle" style="opacity:0;width:0;height:0">
            <span class="toggle-slider" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.1);border-radius:28px;transition:0.3s">
              <span style="position:absolute;content:'';height:20px;width:20px;left:4px;bottom:4px;background:#fff;border-radius:50%;transition:0.3s;display:block" id="toggle-knob"></span>
            </span>
          </label>
          <span class="text-muted text-xs" id="pause-status-label" style="margin-left:8px">Loading...</span>
          <button class="btn btn-sm" id="btn-apply-trading-pause" style="margin-left:auto;background:rgba(255,68,68,0.15);border:1px solid rgba(255,68,68,0.4);color:#FF4444">Apply</button>
        </div>
      </div>
    </div>

    <!-- Admin Transfer Section (superAdmin only) -->
    <div class="card glass mt-2" id="admin-transfer-section">
      <div class="card-header">
        <h2 class="font-semibold">🔑 Admin Transfer</h2>
      </div>
      <div class="card-body">
        <div class="grid grid-2 gap-1">
          <div>
            <label class="form-label text-xs">Current Admin (on-chain)</label>
            <div class="font-mono text-xs" id="current-chain-admin" style="word-break:break-all;color:#9945FF">Loading...</div>
          </div>
          <div>
            <label class="form-label text-xs">Pending Admin</label>
            <div class="font-mono text-xs" id="pending-chain-admin" style="word-break:break-all;color:#FFD700">—</div>
          </div>
        </div>
        <div class="flex gap-1 mt-2" style="flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:200px">
            <label class="form-label text-xs">Propose New Admin</label>
            <input type="text" class="form-input" id="propose-admin-input" placeholder="New admin wallet pubkey..." style="font-family:var(--font-mono);font-size:0.85rem">
          </div>
          <button class="btn btn-sm btn-primary" id="btn-propose-admin" style="height:38px">Propose</button>
        </div>
        <div id="accept-admin-wrapper" style="display:none;margin-top:12px">
          <button class="btn btn-sm" id="btn-accept-admin" style="background:rgba(20,241,149,0.15);border:1px solid rgba(20,241,149,0.4);color:#14F195">
            ✅ Accept Admin Role (you are the pending admin)
          </button>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- System Info -->
    <div class="card glass mt-2">
      <div class="card-header">
        <h2 class="font-semibold"><img class="icon" src="/icons/white/monitor.png" alt="System"> System Info</h2>
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

  // Platform fees
  document.getElementById('btn-claim-all-fees')?.addEventListener('click', handleClaimAllFees);

  // Pool management (superAdmin)
  document.getElementById('btn-close-all-pools')?.addEventListener('click', handleCloseAllPools);

  // Emergency controls (superAdmin)
  document.getElementById('btn-apply-trading-pause')?.addEventListener('click', handleToggleTradingPause);

  // Admin transfer (superAdmin)
  document.getElementById('btn-propose-admin')?.addEventListener('click', handleProposeAdmin);
  document.getElementById('btn-accept-admin')?.addEventListener('click', handleAcceptAdmin);

  // Load data
  loadAdminDashboard();
  if (isSuperAdmin) loadAdminsList();
  loadSystemInfo();
  loadPlatformFees();
  if (isSuperAdmin) {
    loadCloseablePools();
    loadChainConfig();
  }
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
          <h3 class="font-semibold text-sm" style="margin-bottom:12px;color:#9945FF"><img class="icon" src="/icons/white/credit-card.png" alt="Card"> Deployer Wallet</h3>
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
          <h3 class="font-semibold text-sm" style="margin-bottom:12px;color:#14F195"><img class="icon" src="/icons/white/shield.png" alt="Health"> Platform Health</h3>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">Status</span>
            <span class="text-xs" style="color:#14F195">● Online</span>
          </div>
          <div class="stat-row" style="padding:4px 0">
            <span class="text-muted text-xs">API</span>
            <span class="font-mono text-xs">${api.base}</span>
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
    btn.textContent = '<img class="icon" src="/icons/white/gear.png" alt="Refresh"> Reset Token';
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
    btn.textContent = '<img class="icon" src="/icons/white/document.png" alt="Edit"> Update Mint';
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
      toast(`<img class="icon" src="/icons/white/rocket.png" alt="Graduated"> Token ${truncateAddress(mintAddress)} graduated!`, 'success');
      document.getElementById('grad-mint-address').value = '';
    }
  } catch (err) {
    toast(`Graduation failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '<img class="icon" src="/icons/white/rocket.png" alt="Graduated"> Graduate Token';
  }
}

// === Platform Fees ===

async function loadPlatformFees() {
  const el = document.getElementById('platform-fees-table');
  if (!el) return;

  try {
    const data = await adminFetch('/admin/platform-fees');
    if (data.error) {
      el.innerHTML = `<p class="text-error text-sm">${data.error}</p>`;
      return;
    }

    const pools = data.pools || [];

    if (pools.length === 0) {
      el.innerHTML = '<p class="text-muted text-sm">No unclaimed platform fees.</p>';
      return;
    }

    const rows = pools.map(p => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
        <td style="padding:10px">
          <span class="font-semibold text-sm">${escHtml(p.name)}</span>
          <span class="text-muted text-xs" style="margin-left:4px">${escHtml(p.symbol)}</span>
        </td>
        <td style="padding:10px">
          <span class="badge" style="font-size:0.7rem;background:${p.status === 'graduated' ? 'rgba(20,241,149,0.15);color:#14F195' : 'rgba(153,69,255,0.15);color:#9945FF'}">${p.status}</span>
        </td>
        <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-size:0.82rem">${(p.platformFeesEarned / 1e9).toFixed(6)} SOL</td>
        <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-size:0.82rem">${(p.platformFeesClaimed / 1e9).toFixed(6)} SOL</td>
        <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-size:0.82rem;color:#FFD700">${p.unclaimedSol.toFixed(6)} SOL</td>
      </tr>
    `).join('');

    el.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Token</th>
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Status</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Earned</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Claimed</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Unclaimed</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr style="border-top:1px solid rgba(255,215,0,0.3)">
              <td colspan="4" style="padding:10px;font-weight:600;color:#FFD700">Total Unclaimed</td>
              <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-weight:700;color:#FFD700">${(data.totalUnclaimedSol || 0).toFixed(6)} SOL</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  } catch (err) {
    if (el) el.innerHTML = `<p class="text-error text-sm">Failed to load fees: ${err.message}</p>`;
  }
}

async function handleClaimAllFees() {
  const btn = document.getElementById('btn-claim-all-fees');
  if (!btn) return;

  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Building transactions...';

  try {
    const result = await adminFetch('/admin/claim-all-fees', {
      method: 'POST',
      body: JSON.stringify({ adminPublicKey: getPublicKey() }),
    });

    if (result.error) {
      toast(result.error, 'error');
      return;
    }

    const txs = result.transactions || [];
    if (txs.length === 0) {
      toast('No unclaimed fees to collect', 'info');
      return;
    }

    toast(`Signing ${txs.length} transaction(s) for ${result.totalPools} pools...`, 'info');

    let signed = 0;
    for (const txObj of txs) {
      btn.textContent = `Signing ${signed + 1}/${txs.length}...`;
      try {
        const sig = await signAndSendTransaction(txObj.base64);
        toast(`✅ Claimed fees from ${txObj.poolCount} pools (${txObj.estimatedSol.toFixed(4)} SOL) — ${sig.slice(0, 8)}...`, 'success');
        signed++;
      } catch (err) {
        toast(`TX ${signed + 1} failed: ${err.message}`, 'error');
        break;
      }
    }

    // Refresh table
    await loadPlatformFees();

  } catch (err) {
    toast(`Claim failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Claim All Fees';
  }
}

// === Closeable Pools ===

async function loadCloseablePools() {
  const el = document.getElementById('closeable-pools-table');
  if (!el) return;

  try {
    const data = await adminFetch('/admin/closeable-pools');
    if (data.error) {
      el.innerHTML = `<p class="text-error text-sm">${data.error}</p>`;
      return;
    }

    const pools = data.pools || [];

    if (pools.length === 0) {
      el.innerHTML = '<p class="text-muted text-sm">No closeable pools — graduated pools must have all fees claimed first.</p>';
      return;
    }

    const rows = pools.map(p => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04)" data-mint="${escHtml(p.mint)}">
        <td style="padding:10px">
          <span class="font-semibold text-sm">${escHtml(p.name)}</span>
          <span class="text-muted text-xs" style="margin-left:4px">${escHtml(p.symbol)}</span>
        </td>
        <td style="padding:10px;font-family:var(--font-mono);font-size:0.78rem;color:var(--text-muted)">
          ${p.graduatedAt ? new Date(p.graduatedAt * 1000).toLocaleDateString() : '—'}
        </td>
        <td style="padding:10px;font-family:var(--font-mono);font-size:0.78rem">
          ${p.raydiumPool ? `<a href="https://explorer.solana.com/address/${p.raydiumPool}" target="_blank" style="color:#9945FF">${truncateAddress(p.raydiumPool)}</a>` : '—'}
        </td>
        <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-size:0.82rem;color:#14F195">
          ~${(p.estimatedRent / 1e9).toFixed(4)} SOL
        </td>
        <td style="padding:10px;text-align:right">
          <button class="btn btn-xs btn-ghost btn-close-pool" data-mint="${escHtml(p.mint)}" style="border-color:rgba(255,68,68,0.3);color:#FF4444;font-size:0.75rem;padding:4px 8px">
            Close
          </button>
        </td>
      </tr>
    `).join('');

    el.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Token</th>
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Graduated</th>
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Raydium Pool</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Est. Rent</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr style="border-top:1px solid rgba(20,241,149,0.2)">
              <td colspan="3" style="padding:10px;font-weight:600;color:#14F195">Total Recoverable Rent</td>
              <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-weight:700;color:#14F195">~${(data.totalRentSol || 0).toFixed(4)} SOL</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;

    // Wire close buttons
    el.querySelectorAll('.btn-close-pool').forEach(btn => {
      btn.addEventListener('click', () => handleClosePool(btn.dataset.mint));
    });

  } catch (err) {
    if (el) el.innerHTML = `<p class="text-error text-sm">Failed to load pools: ${err.message}</p>`;
  }
}

async function handleClosePool(mint) {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  if (!confirm(`Close graduated pool for ${truncateAddress(mint)}? This reclaims rent and closes the on-chain accounts.`)) return;

  try {
    const result = await adminFetch('/admin/close-pool', {
      method: 'POST',
      body: JSON.stringify({ mint, adminPublicKey: getPublicKey() }),
    });

    if (result.error) {
      toast(result.error, 'error');
      return;
    }

    const sig = await signAndSendTransaction(result.transaction);
    toast(`✅ Pool closed — reclaimed ~${(result.rentReclaimed / 1e9).toFixed(4)} SOL — ${sig.slice(0, 8)}...`, 'success');
    await loadCloseablePools();
  } catch (err) {
    toast(`Close failed: ${err.message}`, 'error');
  }
}

async function handleCloseAllPools() {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  const btn = document.getElementById('btn-close-all-pools');

  // Gather all closeable mints from current table
  const rows = document.querySelectorAll('#closeable-pools-table .btn-close-pool');
  if (rows.length === 0) {
    toast('No closeable pools found', 'info');
    return;
  }

  if (!confirm(`Close all ${rows.length} graduated pools? This cannot be undone.`)) return;

  btn.disabled = true;

  let closed = 0;
  for (const row of rows) {
    const mint = row.dataset.mint;
    try {
      btn.textContent = `Closing ${closed + 1}/${rows.length}...`;
      const result = await adminFetch('/admin/close-pool', {
        method: 'POST',
        body: JSON.stringify({ mint, adminPublicKey: getPublicKey() }),
      });
      if (result.error) {
        toast(`${truncateAddress(mint)}: ${result.error}`, 'error');
        continue;
      }
      const sig = await signAndSendTransaction(result.transaction);
      toast(`Closed ${truncateAddress(mint)} — ${sig.slice(0, 8)}...`, 'success');
      closed++;
    } catch (err) {
      toast(`Failed to close ${truncateAddress(mint)}: ${err.message}`, 'error');
    }
  }

  btn.disabled = false;
  btn.textContent = 'Close All';
  await loadCloseablePools();
}

// === Emergency Controls ===

async function loadChainConfig() {
  try {
    // Load on-chain config to show current admin and trading pause state
    const res = await fetch(api.base + '/chain/config');
    const config = await res.json();

    if (config.error) return;

    // Update admin transfer section
    const currentAdminEl = document.getElementById('current-chain-admin');
    const pendingAdminEl = document.getElementById('pending-chain-admin');
    const acceptWrapper = document.getElementById('accept-admin-wrapper');
    const pauseLabel = document.getElementById('pause-status-label');
    const pauseToggle = document.getElementById('trading-pause-toggle');
    const pauseWarning = document.getElementById('trading-pause-warning');
    const knob = document.getElementById('toggle-knob');

    if (currentAdminEl) currentAdminEl.textContent = config.admin || '—';
    if (pendingAdminEl) pendingAdminEl.textContent = config.pendingAdmin || config.pending_admin || '—';

    // Show accept button if current wallet is the pending admin
    const pendingAdmin = config.pendingAdmin || config.pending_admin;
    if (acceptWrapper && pendingAdmin && isConnected() && getPublicKey() === pendingAdmin) {
      acceptWrapper.style.display = 'block';
    }

    // Trading pause state
    const isPaused = config.tradingPaused || config.trading_paused || false;
    if (pauseToggle) pauseToggle.checked = isPaused;
    if (pauseLabel) pauseLabel.textContent = isPaused ? 'Trading is PAUSED' : 'Trading is active';
    if (pauseWarning) pauseWarning.style.display = isPaused ? 'block' : 'none';
    if (knob) knob.style.transform = isPaused ? 'translateX(24px)' : 'translateX(0)';
    if (pauseToggle && knob) {
      // Style the toggle based on state
      const slider = pauseToggle.nextElementSibling;
      if (slider) {
        slider.style.background = isPaused ? 'rgba(255,68,68,0.6)' : 'rgba(255,255,255,0.1)';
      }
    }

  } catch (_) {
    // chain config may not be available
  }
}

async function handleToggleTradingPause() {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  const toggle = document.getElementById('trading-pause-toggle');
  const paused = toggle?.checked ?? false;

  const btn = document.getElementById('btn-apply-trading-pause');
  btn.disabled = true;
  btn.textContent = 'Building TX...';

  try {
    const result = await adminFetch('/admin/toggle-trading-pause', {
      method: 'POST',
      body: JSON.stringify({ paused, adminPublicKey: getPublicKey() }),
    });

    if (result.error) {
      toast(result.error, 'error');
      return;
    }

    const sig = await signAndSendTransaction(result.transaction);
    toast(`✅ Trading ${paused ? 'PAUSED' : 'resumed'} — ${sig.slice(0, 8)}...`, paused ? 'error' : 'success');

    // Update UI
    const warning = document.getElementById('trading-pause-warning');
    const label = document.getElementById('pause-status-label');
    const knob = document.getElementById('toggle-knob');
    if (warning) warning.style.display = paused ? 'block' : 'none';
    if (label) label.textContent = paused ? 'Trading is PAUSED' : 'Trading is active';
    if (knob) knob.style.transform = paused ? 'translateX(24px)' : 'translateX(0)';

  } catch (err) {
    toast(`Toggle failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

// === Admin Transfer ===

async function handleProposeAdmin() {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  const input = document.getElementById('propose-admin-input');
  const newAdmin = input?.value.trim();
  if (!newAdmin) {
    toast('Enter the new admin wallet pubkey', 'error');
    return;
  }

  const btn = document.getElementById('btn-propose-admin');
  btn.disabled = true;
  btn.textContent = 'Building TX...';

  try {
    const result = await adminFetch('/admin/propose-admin', {
      method: 'POST',
      body: JSON.stringify({ newAdmin, adminPublicKey: getPublicKey() }),
    });

    if (result.error) {
      toast(result.error, 'error');
      return;
    }

    const sig = await signAndSendTransaction(result.transaction);
    toast(`✅ Admin transfer proposed to ${truncateAddress(newAdmin)} — ${sig.slice(0, 8)}...`, 'success');

    // Update pending admin display
    const pendingEl = document.getElementById('pending-chain-admin');
    if (pendingEl) pendingEl.textContent = newAdmin;
    if (input) input.value = '';

    // Show accept button if proposing to self (unusual but handle it)
    if (getPublicKey() === newAdmin) {
      const wrapper = document.getElementById('accept-admin-wrapper');
      if (wrapper) wrapper.style.display = 'block';
    }

  } catch (err) {
    toast(`Propose failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Propose';
  }
}

async function handleAcceptAdmin() {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  if (!confirm('Accept the admin role? This will make your wallet the new on-chain admin.')) return;

  const btn = document.getElementById('btn-accept-admin');
  btn.disabled = true;
  btn.textContent = 'Building TX...';

  try {
    // Accept admin is a separate instruction (accept_admin / claim_admin).
    // TODO: Build the actual accept_admin transaction once IDL is updated.
    // For now, show a placeholder message.
    toast('Accept admin TX not yet implemented — awaiting IDL update with two-step transfer.', 'info');
  } catch (err) {
    toast(`Accept failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Accept Admin Role (you are the pending admin)';
  }
}

// === Helpers ===

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
