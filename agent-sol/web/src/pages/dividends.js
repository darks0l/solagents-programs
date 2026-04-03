/**
 * Dividends Hub Page
 * Overview of the 3-mode dividend system (Regular / Dividend / Buyback & Burn).
 *
 * Route: /dividends
 */

import { api, toast, truncateAddress } from '../main.js';
import { getPublicKey, isConnected } from '../services/wallet.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

function lamportsToSol(l) {
  return (Number(l) / LAMPORTS_PER_SOL).toFixed(4);
}

function tokenDisplay(raw) {
  const n = Number(raw) / 1e9;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  if (n === 0) return '0';
  return n.toFixed(2);
}

function timeAgo(ts) {
  if (!ts) return '';
  const sec = typeof ts === 'number' ? ts : Math.floor(new Date(ts).getTime() / 1000);
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export async function renderDividends(container, state) {
  container.innerHTML = `
    <!-- Hero -->
    <div style="text-align:center;padding:2.5rem 1rem 1.5rem">
      <h1 style="font-size:2rem;font-weight:700;background:linear-gradient(135deg,#00ffa3,#9945ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:0.5rem">
        Agent Dividends
      </h1>
      <p style="color:rgba(255,255,255,0.6);font-size:1rem;max-width:540px;margin:0 auto">
        Earn from AI agents — stake tokens for SOL rewards while automatic buybacks burn supply
      </p>
    </div>

    <!-- 3 Mode Feature Cards -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:2rem;max-width:900px;margin-left:auto;margin-right:auto" id="mode-cards">
      <div class="card glass" style="padding:24px;border:1px solid rgba(255,215,0,0.15);transition:transform 0.2s,border-color 0.2s" onmouseenter="this.style.transform='translateY(-4px)';this.style.borderColor='rgba(255,215,0,0.4)'" onmouseleave="this.style.transform='';this.style.borderColor='rgba(255,215,0,0.15)'">
        <div style="font-size:2rem;margin-bottom:12px">💰</div>
        <h3 style="color:#ffd700;font-weight:700;font-size:1.1rem;margin-bottom:8px">Regular</h3>
        <p style="color:rgba(255,255,255,0.55);font-size:0.85rem;line-height:1.5">
          Creator keeps 100% of their fees. The default for all tokens.
        </p>
      </div>
      <div class="card glass" style="padding:24px;border:1px solid rgba(0,255,163,0.15);transition:transform 0.2s,border-color 0.2s" onmouseenter="this.style.transform='translateY(-4px)';this.style.borderColor='rgba(0,255,163,0.4)'" onmouseleave="this.style.transform='';this.style.borderColor='rgba(0,255,163,0.15)'">
        <div style="font-size:2rem;margin-bottom:12px">🏦</div>
        <h3 style="color:#00ffa3;font-weight:700;font-size:1.1rem;margin-bottom:8px">Dividend</h3>
        <p style="color:rgba(255,255,255,0.55);font-size:0.85rem;line-height:1.5">
          Stake agent tokens to earn SOL from their revenue. Pro-rata rewards from job completions and trading fees.
        </p>
      </div>
      <div class="card glass" style="padding:24px;border:1px solid rgba(153,69,255,0.15);transition:transform 0.2s,border-color 0.2s" onmouseenter="this.style.transform='translateY(-4px)';this.style.borderColor='rgba(153,69,255,0.4)'" onmouseleave="this.style.transform='';this.style.borderColor='rgba(153,69,255,0.15)'">
        <div style="font-size:2rem;margin-bottom:12px">🔥</div>
        <h3 style="color:#9945ff;font-weight:700;font-size:1.1rem;margin-bottom:8px">Buyback & Burn</h3>
        <p style="color:rgba(255,255,255,0.55);font-size:0.85rem;line-height:1.5">
          Agent revenue automatically buys and burns tokens. Deflationary pressure — just hold.
        </p>
      </div>
    </div>

    <!-- Mode Explainer -->
    <div style="max-width:900px;margin:0 auto 2rem;padding:16px 20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;text-align:center">
      <div style="font-size:0.8rem;color:rgba(255,255,255,0.4);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">How It Works</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:16px;font-size:0.9rem;flex-wrap:wrap">
        <span style="color:#ffd700;font-weight:600">💰 Regular — keep fees</span>
        <span style="color:rgba(255,255,255,0.2)">|</span>
        <span style="color:#00ffa3;font-weight:600">🏦 Dividend — stake to earn</span>
        <span style="color:rgba(255,255,255,0.2)">|</span>
        <span style="color:#9945ff;font-weight:600">🔥 Burn — auto-deflation</span>
      </div>
      <div style="font-size:0.75rem;color:rgba(255,255,255,0.35);margin-top:6px">Creators choose one mode per token — switchable with 7-day cooldown</div>
    </div>

    <!-- My Stakes (wallet-gated) -->
    <div id="my-stakes-section" style="display:none;margin-bottom:2rem">
      <div class="card glass">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <h2 style="font-weight:600;font-size:1rem"><img class="icon" src="/icons/white/wallet.png" alt=""> My Stakes</h2>
          <span class="text-muted text-xs" id="stakes-count"></span>
        </div>
        <div id="my-stakes-body" style="overflow-x:auto">
          <p class="text-muted text-sm" style="padding:16px;text-align:center">Loading your positions...</p>
        </div>
      </div>
    </div>

    <!-- Top Dividend Tokens -->
    <div style="margin-bottom:2rem">
      <div class="card glass">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <h2 style="font-weight:600;font-size:1rem"><img class="icon" src="/icons/white/trophy.png" alt=""> Top Dividend Tokens</h2>
        </div>
        <div id="leaderboard-body">
          <p class="text-muted text-sm" style="padding:16px;text-align:center">Loading leaderboard...</p>
        </div>
      </div>
    </div>

    <!-- Recent Buybacks -->
    <div style="margin-bottom:2rem">
      <div class="card glass">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <h2 style="font-weight:600;font-size:1rem"><img class="icon" src="/icons/white/fire.png" alt=""> Recent Buybacks</h2>
        </div>
        <div id="buybacks-feed">
          <p class="text-muted text-sm" style="padding:16px;text-align:center">Loading recent burns...</p>
        </div>
      </div>
    </div>
  `;

  // Load all sections in parallel
  loadMyStakes();
  loadLeaderboard(container);
  loadRecentBuybacks();
}

async function loadMyStakes() {
  const section = document.getElementById('my-stakes-section');
  if (!section) return;
  if (!isConnected()) { section.style.display = 'none'; return; }

  section.style.display = '';
  const body = document.getElementById('my-stakes-body');
  const countEl = document.getElementById('stakes-count');

  try {
    const wallet = getPublicKey();
    const data = await api.get(`/dividends/wallet/${wallet}`);
    const positions = data.positions || data || [];

    if (!positions.length) {
      body.innerHTML = '<p class="text-muted text-sm" style="padding:16px;text-align:center">No active stakes. Browse tokens below to start earning.</p>';
      if (countEl) countEl.textContent = '0 positions';
      return;
    }

    if (countEl) countEl.textContent = `${positions.length} position${positions.length !== 1 ? 's' : ''}`;

    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <thead>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
            <th style="padding:10px 16px;text-align:left;color:rgba(255,255,255,0.5);font-weight:500">Token</th>
            <th style="padding:10px 12px;text-align:right;color:rgba(255,255,255,0.5);font-weight:500">Staked</th>
            <th style="padding:10px 12px;text-align:right;color:rgba(255,255,255,0.5);font-weight:500">Pending</th>
            <th style="padding:10px 12px;text-align:right;color:rgba(255,255,255,0.5);font-weight:500">Claimed</th>
            <th style="padding:10px 16px;text-align:right;color:rgba(255,255,255,0.5);font-weight:500">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${positions.map(p => {
            const mint = p.token_id || p.mint;
            const sym = p.symbol || p.token_symbol || '???';
            return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.04);transition:background 0.15s" onmouseenter="this.style.background='rgba(255,255,255,0.03)'" onmouseleave="this.style.background=''">
              <td style="padding:12px 16px">
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#00ffa3,#9945ff);display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:#000">${sym.slice(0,2)}</div>
                  <div>
                    <div style="font-weight:600;color:#fff">${sym}</div>
                    <div class="text-muted text-xs">${truncateAddress(mint)}</div>
                  </div>
                </div>
              </td>
              <td style="padding:12px;text-align:right;font-family:monospace;color:#fff">${tokenDisplay(p.staked_amount || 0)}</td>
              <td style="padding:12px;text-align:right;font-family:monospace;color:#00ffa3">${lamportsToSol(p.pending_rewards || 0)} SOL</td>
              <td style="padding:12px;text-align:right;font-family:monospace;color:rgba(255,255,255,0.6)">${lamportsToSol(p.total_claimed || 0)} SOL</td>
              <td style="padding:12px 16px;text-align:right;white-space:nowrap">
                <button class="btn btn-xs claim-btn" data-token="${mint}" style="margin-right:4px;background:rgba(0,255,163,0.15);color:#00ffa3;border:1px solid rgba(0,255,163,0.3);border-radius:8px;padding:4px 10px;font-size:0.75rem;cursor:pointer">Claim</button>
                <a href="/dividends/${mint}" class="btn btn-xs btn-ghost div-nav-link" data-mint="${mint}" style="border-radius:8px;padding:4px 10px;font-size:0.75rem;text-decoration:none;color:rgba(255,255,255,0.6)">View →</a>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    // Claim buttons
    body.querySelectorAll('.claim-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tokenId = btn.dataset.token;
        btn.disabled = true;
        btn.textContent = 'Claiming...';
        try {
          // TODO: Build on-chain claim transaction + sign with Phantom
          await api.post(`/dividends/${tokenId}/claim`, { wallet: getPublicKey() });
          toast('Rewards claimed!', 'success');
          loadMyStakes();
        } catch (err) {
          toast(`Claim failed: ${err.message || 'Unknown error'}`, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Claim';
        }
      });
    });

    // SPA navigation links
    body.querySelectorAll('.div-nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const mint = link.dataset.mint;
        history.pushState({ page: 'token-dividends', params: { mint } }, '', `/dividends/${mint}`);
        document.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'token-dividends', mint } }));
      });
    });
  } catch {
    body.innerHTML = '<p class="text-muted text-sm" style="padding:16px;text-align:center">Failed to load stakes.</p>';
  }
}

async function loadLeaderboard(container) {
  const body = document.getElementById('leaderboard-body');
  if (!body) return;

  try {
    const data = await api.get('/dividends/leaderboard');
    const tokens = data.tokens || data || [];

    if (!tokens.length) {
      body.innerHTML = '<p class="text-muted text-sm" style="padding:16px;text-align:center">No dividend tokens yet.</p>';
      return;
    }

    body.innerHTML = tokens.map((t, i) => {
      const mint = t.token_id || t.mint;
      const sym = t.symbol || '???';
      const modeLabel = { regular: '💰 Regular', dividend: '🏦 Dividend', buyback_burn: '🔥 Burn' }[t.mode] || '💰 Regular';
      const modeColor = { regular: 'rgba(255,215,0,0.12)', dividend: 'rgba(0,255,163,0.12)', buyback_burn: 'rgba(153,69,255,0.12)' }[t.mode] || 'rgba(255,215,0,0.12)';
      const modeTxt = { regular: '#ffd700', dividend: '#00ffa3', buyback_burn: '#9945ff' }[t.mode] || '#ffd700';
      return `
      <a href="/dividends/${mint}" class="div-lb-row" data-mint="${mint}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.04);text-decoration:none;color:inherit;transition:background 0.15s;cursor:pointer" onmouseenter="this.style.background='rgba(255,255,255,0.03)'" onmouseleave="this.style.background=''">
        <span style="width:24px;text-align:center;font-weight:700;color:${i < 3 ? '#00ffa3' : 'rgba(255,255,255,0.4)'};font-size:0.85rem">${i + 1}</span>
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#00ffa3,#9945ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.7rem;color:#000;flex-shrink:0">${sym.slice(0,2)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:#fff;font-size:0.9rem">${t.name || sym} <span style="color:rgba(255,255,255,0.4);font-size:0.8rem">$${sym}</span></div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:3px">
            <span style="font-size:0.65rem;padding:2px 6px;border-radius:4px;font-weight:600;background:${modeColor};color:${modeTxt}">${modeLabel}</span>
            ${t.apy ? `<span class="text-muted" style="font-size:0.65rem">${t.apy}% APY</span>` : ''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-family:monospace;font-weight:600;color:#fff;font-size:0.9rem">${lamportsToSol(t.total_revenue || 0)} SOL</div>
          <div class="text-muted text-xs">${t.staker_count || 0} stakers · ${tokenDisplay(t.total_burned || 0)} burned</div>
        </div>
        <span style="color:rgba(255,255,255,0.3);font-size:1rem">→</span>
      </a>`;
    }).join('');

    // SPA navigation
    body.querySelectorAll('.div-lb-row').forEach(row => {
      row.addEventListener('click', (e) => {
        e.preventDefault();
        const mint = row.dataset.mint;
        history.pushState({ page: 'token-dividends', params: { mint } }, '', `/dividends/${mint}`);
        document.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'token-dividends', mint } }));
      });
    });
  } catch {
    body.innerHTML = '<p class="text-muted text-sm" style="padding:16px;text-align:center">Failed to load leaderboard.</p>';
  }
}

async function loadRecentBuybacks() {
  const body = document.getElementById('buybacks-feed');
  if (!body) return;

  try {
    const data = await api.get('/dividends/leaderboard?buybacks=recent');
    const buybacks = data.buybacks || data.recent_buybacks || [];

    if (!buybacks.length) {
      body.innerHTML = '<p class="text-muted text-sm" style="padding:16px;text-align:center">No buybacks yet — revenue will trigger automated burns.</p>';
      return;
    }

    body.innerHTML = buybacks.slice(0, 10).map(b => `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.04)">
        <span style="font-size:1.2rem">🔥</span>
        <div style="flex:1">
          <span style="font-weight:600;color:#fff;font-size:0.85rem">${b.symbol || truncateAddress(b.token_id || '')}</span>
          <span class="text-muted text-xs" style="margin-left:6px">${lamportsToSol(b.sol_spent || 0)} SOL → ${tokenDisplay(b.tokens_burned || 0)} burned</span>
        </div>
        <span class="text-muted text-xs">${timeAgo(b.created_at || b.timestamp)}</span>
      </div>
    `).join('');
  } catch {
    body.innerHTML = '<p class="text-muted text-sm" style="padding:16px;text-align:center">No buyback data available yet.</p>';
  }
}
