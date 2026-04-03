/**
 * Per-Token Dividend Detail Page
 * Shows BOTH staking panel AND buyback/burn dashboard simultaneously.
 *
 * Route: /dividends/:mint
 */

import { api, toast, truncateAddress } from '../main.js';
import { connectWallet, getPublicKey, isConnected } from '../services/wallet.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

function lamToSol(l) { return (Number(l) / LAMPORTS_PER_SOL).toFixed(4); }
function lamToSolShort(l) {
  const v = Number(l) / LAMPORTS_PER_SOL;
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(4);
}

function tokDisplay(raw) {
  const n = Number(raw) / 1e9;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  if (n === 0) return '0';
  return n.toFixed(2);
}

function tokRaw(human) { return Math.round(parseFloat(human || 0) * 1e9); }

function timeAgo(ts) {
  if (!ts) return '';
  const sec = typeof ts === 'number' ? ts : Math.floor(new Date(ts).getTime() / 1000);
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function pctBar(pct, color) {
  return `<div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;flex:1">
    <div style="height:100%;width:${Math.min(pct, 100)}%;background:${color};border-radius:3px;transition:width 0.6s ease"></div>
  </div>`;
}

export async function renderTokenDividends(container, state, mint) {
  if (!mint) {
    container.innerHTML = '<p class="text-muted text-center" style="padding:3rem">No token specified.</p>';
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <button class="btn btn-sm btn-ghost mb-2" id="btn-back-div">← Back to Dividends</button>
      <div id="div-token-header">
        <div class="skeleton h-8 w-48 rounded"></div>
      </div>
    </div>

    <!-- Mode Badge -->
    <div id="mode-badge-card" class="card glass" style="margin-bottom:1.5rem;padding:16px 20px;text-align:center">
      <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Dividend Mode</div>
      <div id="mode-badge" style="display:inline-block;padding:6px 16px;border-radius:8px;font-weight:700;font-size:1rem">💰 Regular</div>
    </div>

    <!-- Stats Row -->
    <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:1.5rem" id="div-stats-row">
      <div class="card glass" style="padding:16px;text-align:center">
        <div class="font-bold font-mono" style="color:#00ffa3;font-size:1.1rem" id="stat-total-revenue">—</div>
        <div class="text-muted text-xs" style="margin-top:2px">Total Revenue</div>
      </div>
      <div class="card glass" style="padding:16px;text-align:center">
        <div class="font-bold font-mono" style="color:#fff;font-size:1.1rem" id="stat-total-staked">—</div>
        <div class="text-muted text-xs" style="margin-top:2px">Total Staked</div>
      </div>
      <div class="card glass" style="padding:16px;text-align:center">
        <div class="font-bold font-mono" style="color:#9945ff;font-size:1.1rem" id="stat-total-burned">—</div>
        <div class="text-muted text-xs" style="margin-top:2px">Total Burned 🔥</div>
      </div>
      <div class="card glass" style="padding:16px;text-align:center">
        <div class="font-bold font-mono" style="color:#00ffa3;font-size:1.1rem" id="stat-apy">—</div>
        <div class="text-muted text-xs" style="margin-top:2px">Est. APY</div>
      </div>
    </div>

    <!-- Main Two-Column Layout -->
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:16px;align-items:start" id="div-main-layout">

      <!-- Left: Staking Panel -->
      <div>
        <div class="card glass" style="border:1px solid rgba(0,255,163,0.12)">
          <div class="card-header" style="display:flex;align-items:center;gap:8px">
            <span style="font-size:1.2rem">🏦</span>
            <h2 style="font-weight:600;font-size:1rem;color:#00ffa3">Stake & Earn</h2>
          </div>
          <div class="card-body">
            <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;margin-bottom:16px">Stake tokens to earn SOL from agent revenue</p>

            <!-- User Position -->
            <div id="staking-position" style="display:none;margin-bottom:16px;padding:12px;background:rgba(0,255,163,0.05);border:1px solid rgba(0,255,163,0.1);border-radius:10px">
              <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px">
                <span style="color:rgba(255,255,255,0.5)">Your Stake</span>
                <span class="font-mono" style="color:#fff" id="user-staked">0</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px">
                <span style="color:rgba(255,255,255,0.5)">Pending Rewards</span>
                <span class="font-mono" style="color:#00ffa3" id="user-pending">0 SOL</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:rgba(255,255,255,0.5)">Total Claimed</span>
                <span class="font-mono" style="color:rgba(255,255,255,0.6)" id="user-claimed">0 SOL</span>
              </div>
              <button class="btn btn-sm w-full" id="btn-claim" style="margin-top:12px;background:rgba(0,255,163,0.15);color:#00ffa3;border:1px solid rgba(0,255,163,0.3);border-radius:10px;padding:8px;font-weight:600;cursor:pointer">Claim Rewards</button>
            </div>

            <!-- Stake / Unstake Tabs -->
            <div style="display:flex;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:12px">
              <button class="btn btn-sm flex-1 stake-tab active" id="tab-stake" data-action="stake" style="border-radius:8px 8px 0 0">Stake</button>
              <button class="btn btn-sm flex-1 stake-tab" id="tab-unstake" data-action="unstake" style="border-radius:8px 8px 0 0">Unstake</button>
            </div>

            <!-- Stake Form -->
            <div id="stake-form">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <label style="font-size:0.8rem;color:rgba(255,255,255,0.5)">Amount</label>
                <span class="font-mono text-xs text-muted" id="stake-balance"></span>
              </div>
              <div style="display:flex;gap:6px;margin-bottom:8px">
                <input type="number" class="form-input" id="stake-amount-input" placeholder="0" min="0" style="flex:1">
                <button class="btn btn-xs btn-ghost" id="stake-max-btn" style="padding:6px 12px">Max</button>
              </div>
              <button class="btn btn-sm btn-primary btn-glow w-full" id="btn-stake" style="border-radius:10px;padding:10px;font-weight:600">Stake Tokens</button>
            </div>

            <!-- Unstake Form (hidden by default) -->
            <div id="unstake-form" style="display:none">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <label style="font-size:0.8rem;color:rgba(255,255,255,0.5)">Amount to Unstake</label>
                <span class="font-mono text-xs text-muted" id="unstake-balance"></span>
              </div>
              <div style="display:flex;gap:6px;margin-bottom:8px">
                <input type="number" class="form-input" id="unstake-amount-input" placeholder="0" min="0" style="flex:1">
                <button class="btn btn-xs btn-ghost" id="unstake-max-btn" style="padding:6px 12px">Max</button>
              </div>
              <button class="btn btn-sm w-full" id="btn-unstake" style="border-radius:10px;padding:10px;font-weight:600;background:rgba(255,68,68,0.15);color:#FF4444;border:1px solid rgba(255,68,68,0.3)">Unstake Tokens</button>
            </div>

            <!-- Connect Wallet CTA -->
            <div id="stake-connect-cta" style="display:none;text-align:center;padding:12px 0">
              <button class="btn btn-sm btn-primary" id="btn-connect-stake" style="border-radius:10px;padding:10px 24px"><img class="icon" src="/icons/white/wallet.png" alt=""> Connect Wallet to Stake</button>
            </div>
          </div>
        </div>

        <!-- Staker Leaderboard -->
        <div class="card glass mt-2">
          <div class="card-header">
            <h3 style="font-weight:600;font-size:0.9rem"><img class="icon" src="/icons/white/crown.png" alt=""> Top Stakers</h3>
          </div>
          <div id="staker-leaderboard">
            <p class="text-muted text-sm" style="padding:12px;text-align:center">Loading...</p>
          </div>
        </div>
      </div>

      <!-- Right: Buyback & Burn Dashboard -->
      <div>
        <div class="card glass" style="border:1px solid rgba(153,69,255,0.12)">
          <div class="card-header" style="display:flex;align-items:center;gap:8px">
            <span style="font-size:1.2rem">🔥</span>
            <h2 style="font-weight:600;font-size:1rem;color:#9945ff">Buyback & Burn</h2>
          </div>
          <div class="card-body">
            <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;margin-bottom:16px">Automatic — revenue buys and burns tokens. Just hold.</p>

            <!-- Burn Big Stats -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
              <div style="padding:14px;background:rgba(153,69,255,0.08);border:1px solid rgba(153,69,255,0.12);border-radius:10px;text-align:center">
                <div style="font-size:1.3rem;font-weight:700;color:#9945ff;font-family:monospace" id="burn-total-tokens">—</div>
                <div style="font-size:0.7rem;color:rgba(255,255,255,0.4);margin-top:4px">🔥 Tokens Burned</div>
              </div>
              <div style="padding:14px;background:rgba(153,69,255,0.08);border:1px solid rgba(153,69,255,0.12);border-radius:10px;text-align:center">
                <div style="font-size:1.3rem;font-weight:700;color:#fff;font-family:monospace" id="burn-total-sol">—</div>
                <div style="font-size:0.7rem;color:rgba(255,255,255,0.4);margin-top:4px">SOL Spent on Buybacks</div>
              </div>
            </div>

            <!-- Extra burn metrics -->
            <div style="padding:12px;background:rgba(0,0,0,0.3);border-radius:10px;margin-bottom:16px">
              <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px">
                <span style="color:rgba(255,255,255,0.5)">Avg Burn Price</span>
                <span class="font-mono" style="color:#fff" id="burn-avg-price">—</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px">
                <span style="color:rgba(255,255,255,0.5)">Deflationary %</span>
                <span class="font-mono" style="color:#9945ff" id="burn-deflation-pct">—</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:rgba(255,255,255,0.5)">Next Buyback Pool</span>
                <span class="font-mono" style="color:#00ffa3" id="burn-pending-pool">—</span>
              </div>
            </div>

            <!-- Deflationary progress bar -->
            <div style="margin-bottom:4px;display:flex;align-items:center;gap:8px">
              <span style="font-size:0.7rem;color:rgba(255,255,255,0.4)">Supply burned</span>
              <div id="deflation-bar" style="flex:1"></div>
              <span class="font-mono" style="font-size:0.7rem;color:#9945ff" id="deflation-bar-pct">0%</span>
            </div>
          </div>
        </div>

        <!-- Burn History -->
        <div class="card glass mt-2">
          <div class="card-header">
            <h3 style="font-weight:600;font-size:0.9rem"><img class="icon" src="/icons/white/fire.png" alt=""> Burn History</h3>
          </div>
          <div id="burn-history">
            <p class="text-muted text-sm" style="padding:12px;text-align:center">Loading...</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Revenue History Chart (CSS bars, no library) -->
    <div class="card glass" style="margin-top:1.5rem">
      <div class="card-header">
        <h3 style="font-weight:600;font-size:0.9rem"><img class="icon" src="/icons/white/chart.png" alt=""> Revenue History</h3>
      </div>
      <div id="revenue-chart" style="padding:16px;min-height:120px">
        <p class="text-muted text-sm" style="text-align:center">Loading...</p>
      </div>
    </div>

    <!-- Creator Controls (hidden unless creator wallet) -->
    <div id="creator-controls" style="display:none;margin-top:1.5rem">
      <div class="card glass" style="border:1px solid rgba(255,107,107,0.15)">
        <div class="card-header" style="display:flex;align-items:center;gap:8px">
          <img class="icon" src="/icons/white/gear.png" alt="">
          <h3 style="font-weight:600;font-size:0.9rem">Creator Controls</h3>
        </div>
        <div class="card-body">
          <!-- Mode Selector -->
          <div style="margin-bottom:20px">
            <label style="font-size:0.85rem;color:rgba(255,255,255,0.7);display:block;margin-bottom:10px">Dividend Mode</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap" id="mode-selector">
              <button class="mode-btn" data-mode="regular" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,215,0,0.25);background:rgba(255,215,0,0.08);color:#ffd700;font-weight:600;font-size:0.8rem;cursor:pointer;transition:all 0.2s">💰 Regular</button>
              <button class="mode-btn" data-mode="dividend" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,255,163,0.25);background:rgba(0,255,163,0.08);color:#00ffa3;font-weight:600;font-size:0.8rem;cursor:pointer;transition:all 0.2s">🏦 Dividend</button>
              <button class="mode-btn" data-mode="buyback_burn" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid rgba(153,69,255,0.25);background:rgba(153,69,255,0.08);color:#9945ff;font-weight:600;font-size:0.8rem;cursor:pointer;transition:all 0.2s">🔥 Burn</button>
            </div>
            <div class="text-muted text-xs" style="margin-top:6px">7-day cooldown between mode switches</div>
          </div>

          <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06)">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div>
                <div style="font-weight:600;font-size:0.85rem;color:var(--text-primary)">Dividends</div>
                <div class="text-muted text-xs" style="margin-top:2px">Enable or disable dividend system</div>
              </div>
              <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
                <input type="checkbox" id="toggle-dividends-input" style="opacity:0;width:0;height:0">
                <span id="toggle-div-slider" style="position:absolute;inset:0;background:rgba(255,255,255,0.1);border-radius:24px;transition:all 0.3s;border:1px solid rgba(255,255,255,0.1)"></span>
                <span id="toggle-div-knob" style="position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:all 0.3s"></span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Back button
  document.getElementById('btn-back-div')?.addEventListener('click', () => {
    history.pushState({ page: 'dividends', params: {} }, '', '/dividends');
    document.dispatchEvent(new CustomEvent('navigate', { detail: 'dividends' }));
  });

  // Stake/Unstake tab switching
  document.querySelectorAll('.stake-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const action = tab.dataset.action;
      document.querySelectorAll('.stake-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('stake-form').style.display = action === 'stake' ? '' : 'none';
      document.getElementById('unstake-form').style.display = action === 'unstake' ? '' : 'none';
    });
  });

  // Show connect CTA or staking form
  if (isConnected()) {
    document.getElementById('stake-connect-cta').style.display = 'none';
  } else {
    document.getElementById('stake-form').style.display = 'none';
    document.getElementById('stake-connect-cta').style.display = '';
  }

  document.getElementById('btn-connect-stake')?.addEventListener('click', async () => {
    try {
      await connectWallet();
      document.getElementById('stake-connect-cta').style.display = 'none';
      document.getElementById('stake-form').style.display = '';
      loadUserPosition(mint);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Stake action
  document.getElementById('btn-stake')?.addEventListener('click', () => executeStake(mint));
  document.getElementById('btn-unstake')?.addEventListener('click', () => executeUnstake(mint));
  document.getElementById('btn-claim')?.addEventListener('click', () => executeClaim(mint));

  // Max buttons
  document.getElementById('stake-max-btn')?.addEventListener('click', () => {
    const bal = document.getElementById('stake-balance')?.dataset?.raw;
    if (bal) document.getElementById('stake-amount-input').value = (Number(bal) / 1e9).toString();
  });
  document.getElementById('unstake-max-btn')?.addEventListener('click', () => {
    const bal = document.getElementById('unstake-balance')?.dataset?.raw;
    if (bal) document.getElementById('unstake-amount-input').value = (Number(bal) / 1e9).toString();
  });

  // Creator mode selector
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(mint, btn.dataset.mode));
  });
  document.getElementById('toggle-dividends-input')?.addEventListener('change', (e) => toggleDividends(mint, e.target.checked));

  // Load all data in parallel
  loadTokenDividendData(mint);
  loadUserPosition(mint);
  loadStakerLeaderboard(mint);
  loadBurnHistory(mint);
  loadRevenueChart(mint);
}

async function loadTokenDividendData(mint) {
  try {
    const [config, stats] = await Promise.all([
      api.get(`/dividends/${mint}`).catch(() => ({})),
      api.get(`/dividends/${mint}/stats`).catch(() => ({})),
    ]);

    // Header
    const headerEl = document.getElementById('div-token-header');
    if (headerEl) {
      const sym = config.symbol || stats.symbol || '???';
      const name = config.name || stats.name || '';
      headerEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#00ffa3,#9945ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem;color:#000">${sym.slice(0,2)}</div>
          <div>
            <div style="font-weight:700;font-size:1.3rem;color:#fff">${name || sym} <span style="color:rgba(255,255,255,0.4);font-size:0.9rem">$${sym}</span></div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
              <span class="font-mono text-xs text-muted">${truncateAddress(mint)}</span>
              <span style="font-size:0.65rem;padding:2px 8px;border-radius:4px;font-weight:600;background:rgba(0,255,163,0.12);color:#00ffa3">Dividends Active</span>
            </div>
          </div>
        </div>
      `;
    }

    // Mode badge
    const mode = config.mode || stats.mode || 'regular';
    const modeBadge = document.getElementById('mode-badge');
    if (modeBadge) {
      const modeMap = {
        regular: { label: '💰 Regular', bg: 'rgba(255,215,0,0.15)', color: '#ffd700' },
        dividend: { label: '🏦 Dividend', bg: 'rgba(0,255,163,0.15)', color: '#00ffa3' },
        buyback_burn: { label: '🔥 Buyback & Burn', bg: 'rgba(153,69,255,0.15)', color: '#9945ff' },
      };
      const m = modeMap[mode] || modeMap.regular;
      modeBadge.textContent = m.label;
      modeBadge.style.background = m.bg;
      modeBadge.style.color = m.color;
    }
    highlightActiveMode(mode);

    // Stats row
    const rev = stats.total_revenue || config.total_revenue || 0;
    const staked = stats.total_staked || config.total_staked || 0;
    const burned = stats.total_burned || config.total_burned || 0;
    const apy = stats.apy || config.apy || null;

    document.getElementById('stat-total-revenue').textContent = lamToSol(rev) + ' SOL';
    document.getElementById('stat-total-staked').textContent = tokDisplay(staked);
    document.getElementById('stat-total-burned').textContent = tokDisplay(burned);
    document.getElementById('stat-apy').textContent = apy ? apy + '%' : '—';

    // Burn dashboard
    const burnSol = stats.buyback_sol_spent || config.buyback_sol_spent || 0;
    const burnTokens = burned;
    const totalSupply = stats.total_supply || config.total_supply || 1;
    const deflPct = totalSupply > 0 ? ((Number(burned) / Number(totalSupply)) * 100).toFixed(2) : '0';
    const avgPrice = Number(burnSol) > 0 && Number(burnTokens) > 0
      ? ((Number(burnSol) / LAMPORTS_PER_SOL) / (Number(burnTokens) / 1e9)).toFixed(10)
      : '—';
    const pendingPool = stats.pending_buyback_pool || config.pending_buyback_pool || 0;

    document.getElementById('burn-total-tokens').textContent = tokDisplay(burnTokens);
    document.getElementById('burn-total-sol').textContent = lamToSol(burnSol) + ' SOL';
    document.getElementById('burn-avg-price').textContent = avgPrice === '—' ? '—' : avgPrice + ' SOL';
    document.getElementById('burn-deflation-pct').textContent = deflPct + '%';
    document.getElementById('burn-pending-pool').textContent = lamToSol(pendingPool) + ' SOL';

    const deflBar = document.getElementById('deflation-bar');
    if (deflBar) deflBar.innerHTML = pctBar(parseFloat(deflPct), '#9945ff');
    document.getElementById('deflation-bar-pct').textContent = deflPct + '%';

    // Creator controls
    const creatorWallet = config.creator || stats.creator || '';
    if (isConnected() && getPublicKey() === creatorWallet) {
      const cc = document.getElementById('creator-controls');
      if (cc) {
        cc.style.display = '';
        const slider = document.getElementById('split-slider');
        const label = document.getElementById('creator-split-label');
        if (slider) slider.value = stakePct;
        if (label) label.textContent = `${stakePct}% Stake / ${burnPct}% Burn`;
        const toggle = document.getElementById('toggle-dividends-input');
        const enabled = config.enabled !== false;
        if (toggle) toggle.checked = enabled;
        _updateDivToggleUI(enabled);
      }
    }
  } catch (err) {
    console.warn('Failed to load dividend data:', err);
  }
}

async function loadUserPosition(mint) {
  if (!isConnected()) return;
  const posEl = document.getElementById('staking-position');
  if (!posEl) return;

  try {
    const wallet = getPublicKey();
    const data = await api.get(`/dividends/wallet/${wallet}`);
    const positions = data.positions || data || [];
    const pos = positions.find(p => (p.token_id || p.mint) === mint);

    if (pos && Number(pos.staked_amount || 0) > 0) {
      posEl.style.display = '';
      document.getElementById('user-staked').textContent = tokDisplay(pos.staked_amount);
      document.getElementById('user-pending').textContent = lamToSol(pos.pending_rewards || 0) + ' SOL';
      document.getElementById('user-claimed').textContent = lamToSol(pos.total_claimed || 0) + ' SOL';
      // Set unstake balance
      const unstakeBal = document.getElementById('unstake-balance');
      if (unstakeBal) {
        unstakeBal.textContent = `Staked: ${tokDisplay(pos.staked_amount)}`;
        unstakeBal.dataset.raw = pos.staked_amount || '0';
      }
    } else {
      posEl.style.display = 'none';
    }

    // Set stake balance (token balance in wallet)
    // TODO: Read actual on-chain token balance
    const stakeBal = document.getElementById('stake-balance');
    if (stakeBal) stakeBal.textContent = '';
  } catch {
    posEl.style.display = 'none';
  }
}

async function loadStakerLeaderboard(mint) {
  const body = document.getElementById('staker-leaderboard');
  if (!body) return;

  try {
    const data = await api.get(`/dividends/${mint}/stakers`);
    const stakers = (data.stakers || data || []).slice(0, 10);

    if (!stakers.length) {
      body.innerHTML = '<p class="text-muted text-sm" style="padding:12px;text-align:center">No stakers yet — be the first!</p>';
      return;
    }

    body.innerHTML = stakers.map((s, i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.8rem">
        <span style="width:20px;text-align:center;font-weight:700;color:${i < 3 ? '#00ffa3' : 'rgba(255,255,255,0.4)'}">${i + 1}</span>
        <span class="font-mono" style="flex:1;color:rgba(255,255,255,0.7)">${truncateAddress(s.wallet)}</span>
        <span class="font-mono" style="color:#fff;font-weight:600">${tokDisplay(s.staked_amount || s.amount)}</span>
      </div>
    `).join('');
  } catch {
    body.innerHTML = '<p class="text-muted text-sm" style="padding:12px;text-align:center">Failed to load.</p>';
  }
}

async function loadBurnHistory(mint) {
  const body = document.getElementById('burn-history');
  if (!body) return;

  try {
    const data = await api.get(`/dividends/${mint}/buybacks`);
    const buybacks = (data.buybacks || data || []).slice(0, 10);

    if (!buybacks.length) {
      body.innerHTML = '<p class="text-muted text-sm" style="padding:12px;text-align:center">No burns yet — revenue will trigger automatic buybacks.</p>';
      return;
    }

    body.innerHTML = buybacks.map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.8rem">
        <span style="font-size:1rem">🔥</span>
        <div style="flex:1">
          <span class="font-mono" style="color:#9945ff">${tokDisplay(b.tokens_burned || b.amount)}</span>
          <span class="text-muted" style="margin:0 4px">for</span>
          <span class="font-mono" style="color:#fff">${lamToSol(b.sol_spent || b.sol_amount)} SOL</span>
        </div>
        <span class="text-muted text-xs">${timeAgo(b.created_at || b.timestamp)}</span>
      </div>
    `).join('');
  } catch {
    body.innerHTML = '<p class="text-muted text-sm" style="padding:12px;text-align:center">Failed to load.</p>';
  }
}

async function loadRevenueChart(mint) {
  const body = document.getElementById('revenue-chart');
  if (!body) return;

  try {
    const data = await api.get(`/dividends/${mint}/revenue`);
    const entries = data.revenue || data || [];

    if (!entries.length) {
      body.innerHTML = '<p class="text-muted text-sm" style="text-align:center">No revenue data yet.</p>';
      return;
    }

    // CSS bar chart — last 14 entries
    const recent = entries.slice(-14);
    const maxVal = Math.max(...recent.map(e => Number(e.amount || e.revenue || 0)));
    if (maxVal === 0) {
      body.innerHTML = '<p class="text-muted text-sm" style="text-align:center">No revenue data yet.</p>';
      return;
    }

    body.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:4px;height:100px;padding:0 4px">
        ${recent.map(e => {
          const val = Number(e.amount || e.revenue || 0);
          const h = Math.max((val / maxVal) * 100, 4);
          const solVal = (val / LAMPORTS_PER_SOL).toFixed(4);
          const label = e.date || e.period || '';
          return `
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px" title="${solVal} SOL — ${label}">
              <div style="font-size:0.55rem;color:rgba(255,255,255,0.3);font-family:monospace">${solVal > 0.01 ? solVal : ''}</div>
              <div style="width:100%;height:${h}%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,#00ffa3,rgba(153,69,255,0.6));min-height:3px;transition:height 0.3s"></div>
            </div>`;
        }).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;padding:0 4px">
        <span class="text-muted" style="font-size:0.6rem">${recent[0]?.date || recent[0]?.period || ''}</span>
        <span class="text-muted" style="font-size:0.6rem">${recent[recent.length - 1]?.date || recent[recent.length - 1]?.period || ''}</span>
      </div>
    `;
  } catch {
    body.innerHTML = '<p class="text-muted text-sm" style="text-align:center">No revenue data yet.</p>';
  }
}

// ── Actions ──────────────────────────────────────────────────

async function executeStake(mint) {
  if (!isConnected()) { toast('Connect wallet first', 'error'); return; }
  const amount = parseFloat(document.getElementById('stake-amount-input')?.value);
  if (!amount || amount <= 0) { toast('Enter an amount to stake', 'error'); return; }

  const btn = document.getElementById('btn-stake');
  btn.disabled = true;
  btn.textContent = 'Staking...';

  try {
    const raw = tokRaw(amount);
    // TODO: Build on-chain stake transaction + sign with Phantom
    await api.post(`/dividends/${mint}/stake`, { wallet: getPublicKey(), amount: raw.toString() });
    toast('Tokens staked successfully!', 'success');
    document.getElementById('stake-amount-input').value = '';
    loadUserPosition(mint);
    loadStakerLeaderboard(mint);
    loadTokenDividendData(mint);
  } catch (err) {
    toast(`Stake failed: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Stake Tokens';
  }
}

async function executeUnstake(mint) {
  if (!isConnected()) { toast('Connect wallet first', 'error'); return; }
  const amount = parseFloat(document.getElementById('unstake-amount-input')?.value);
  if (!amount || amount <= 0) { toast('Enter an amount to unstake', 'error'); return; }

  const btn = document.getElementById('btn-unstake');
  btn.disabled = true;
  btn.textContent = 'Unstaking...';

  try {
    const raw = tokRaw(amount);
    // TODO: Build on-chain unstake transaction + sign with Phantom
    await api.post(`/dividends/${mint}/unstake`, { wallet: getPublicKey(), amount: raw.toString() });
    toast('Tokens unstaked!', 'success');
    document.getElementById('unstake-amount-input').value = '';
    loadUserPosition(mint);
    loadStakerLeaderboard(mint);
    loadTokenDividendData(mint);
  } catch (err) {
    toast(`Unstake failed: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unstake Tokens';
  }
}

async function executeClaim(mint) {
  if (!isConnected()) { toast('Connect wallet first', 'error'); return; }

  const btn = document.getElementById('btn-claim');
  btn.disabled = true;
  btn.textContent = 'Claiming...';

  try {
    // TODO: Build on-chain claim transaction + sign with Phantom
    await api.post(`/dividends/${mint}/claim`, { wallet: getPublicKey() });
    toast('Rewards claimed!', 'success');
    loadUserPosition(mint);
    loadTokenDividendData(mint);
  } catch (err) {
    toast(`Claim failed: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Claim Rewards';
  }
}

async function switchMode(mint, newMode) {
  const modeLabels = { regular: '💰 Regular', dividend: '🏦 Dividend', buyback_burn: '🔥 Buyback & Burn' };

  try {
    await api.post(`/dividends/${mint}/mode`, { wallet: getPublicKey(), mode: newMode });
    toast(`Mode switched to ${modeLabels[newMode]}`, 'success');
    // Refresh the page data
    const config = await api.get(`/dividends/${mint}`);
    const modeBadge = document.getElementById('mode-badge');
    if (modeBadge) {
      const modeMap = {
        regular: { label: '💰 Regular', bg: 'rgba(255,215,0,0.15)', color: '#ffd700' },
        dividend: { label: '🏦 Dividend', bg: 'rgba(0,255,163,0.15)', color: '#00ffa3' },
        buyback_burn: { label: '🔥 Buyback & Burn', bg: 'rgba(153,69,255,0.15)', color: '#9945ff' },
      };
      const m = modeMap[config.mode] || modeMap.regular;
      modeBadge.textContent = m.label;
      modeBadge.style.background = m.bg;
      modeBadge.style.color = m.color;
    }
    highlightActiveMode(config.mode);
  } catch (err) {
    toast(`Mode switch failed: ${err.message || 'Unknown error'}`, 'error');
  }
}

function highlightActiveMode(activeMode) {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    const isActive = btn.dataset.mode === activeMode;
    btn.style.opacity = isActive ? '1' : '0.5';
    btn.style.transform = isActive ? 'scale(1.05)' : 'scale(1)';
  });
}

async function toggleDividends(mint, enabled) {
  _updateDivToggleUI(enabled);
  try {
    await api.post(`/dividends/${mint}/enable`, { wallet: getPublicKey(), enabled });
    toast(`Dividends ${enabled ? 'enabled' : 'disabled'}`, 'success');
  } catch (err) {
    // Revert
    const toggle = document.getElementById('toggle-dividends-input');
    if (toggle) toggle.checked = !enabled;
    _updateDivToggleUI(!enabled);
    toast(`Toggle failed: ${err.message || 'Unknown error'}`, 'error');
  }
}

function _updateDivToggleUI(enabled) {
  const slider = document.getElementById('toggle-div-slider');
  const knob = document.getElementById('toggle-div-knob');
  if (slider) {
    slider.style.background = enabled ? 'rgba(0,255,163,0.3)' : 'rgba(255,255,255,0.1)';
    slider.style.borderColor = enabled ? 'rgba(0,255,163,0.5)' : 'rgba(255,255,255,0.1)';
  }
  if (knob) {
    knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
    knob.style.background = enabled ? '#00ffa3' : '#fff';
  }
}
