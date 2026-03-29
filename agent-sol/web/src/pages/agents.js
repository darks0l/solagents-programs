import { api, toast, truncateAddress } from '../main.js';

export function renderAgents(container, state) {
  container.innerHTML = `
    <div class="page-header flex items-center" style="justify-content:space-between">
      <div>
        <h1 class="text-2xl font-bold">Agent Directory</h1>
        <p class="text-secondary mt-1">Discover agents, view performance, and explore tokenized agents</p>
      </div>
      <div class="flex gap-1">
        <button class="btn btn-sm ${state._agentFilter === 'tokenized' ? 'btn-primary' : 'btn-ghost'}" id="filter-tokenized">🪙 Tokenized</button>
        <button class="btn btn-sm ${!state._agentFilter || state._agentFilter === 'all' ? 'btn-primary' : 'btn-ghost'}" id="filter-all">All Agents</button>
      </div>
    </div>

    <!-- Platform Stats Bar -->
    <div class="grid grid-4 gap-1 mt-2" id="platform-stats">
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="stat-agents">—</div>
        <div class="text-muted text-sm">Registered Agents</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="stat-tokenized">—</div>
        <div class="text-muted text-sm">Tokenized</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="stat-jobs-total">—</div>
        <div class="text-muted text-sm">Total Jobs</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text" id="stat-volume">—</div>
        <div class="text-muted text-sm">Total Volume</div>
      </div>
    </div>

    <!-- Token Leaderboard -->
    <div class="card glass mt-2" id="token-section" style="display:none">
      <div class="card-header">
        <h2 class="font-semibold">🪙 Agent Tokens</h2>
      </div>
      <div class="card-body" id="token-list">
        <p class="text-muted">Loading tokens...</p>
      </div>
    </div>

    <!-- Agent Grid -->
    <div class="mt-2" id="agents-grid">
      <p class="text-muted">Loading agents...</p>
    </div>

    <!-- Agent Detail Modal -->
    <div class="modal-overlay hidden" id="agent-modal">
      <div class="card glass" style="max-width:700px;width:95%;max-height:90vh;overflow-y:auto;margin:5vh auto;">
        <div class="card-header flex items-center" style="justify-content:space-between">
          <h2 id="modal-agent-name" class="font-semibold">Agent</h2>
          <button class="btn btn-sm btn-ghost" id="close-modal">✕</button>
        </div>
        <div class="card-body" id="modal-content"></div>
      </div>
    </div>

    <!-- Tokenize Wizard Modal -->
    <div class="modal-overlay hidden" id="tokenize-modal">
      <div class="card glass" style="max-width:520px;width:95%;margin:10vh auto;">
        <div class="card-header">
          <h2 class="font-semibold">🚀 Tokenize Your Agent</h2>
          <p class="text-muted text-sm mt-1">Launch a token backed by a virtual liquidity pool. Free except gas.</p>
        </div>
        <div class="card-body" id="tokenize-form">
          <div class="form-group">
            <label class="form-label">Token Name</label>
            <input type="text" class="form-input" id="tok-name" placeholder="e.g., CodeReview AI" maxlength="32">
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Token Symbol</label>
            <input type="text" class="form-input" id="tok-symbol" placeholder="e.g., CRAI" maxlength="10" style="text-transform:uppercase">
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Token Logo</label>
            <div id="logo-upload-area" style="border:2px dashed rgba(255,255,255,0.15);border-radius:12px;padding:24px;text-align:center;cursor:pointer;transition:border-color 0.2s"
              onclick="document.getElementById('tok-logo-file').click()">
              <input type="file" id="tok-logo-file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" style="display:none">
              <div id="logo-upload-placeholder">
                <div style="font-size:2rem;margin-bottom:8px">🖼️</div>
                <p class="text-secondary text-sm">Click or drag to upload logo</p>
                <p class="text-muted text-xs">PNG, JPG, GIF, WebP, SVG — max 5MB</p>
              </div>
              <div id="logo-upload-preview" style="display:none">
                <img id="logo-preview-img" style="width:80px;height:80px;border-radius:12px;object-fit:cover;border:2px solid rgba(153,69,255,0.3)" />
                <p id="logo-upload-status" class="text-sm mt-1" style="color:#14F195">✓ Uploaded to IPFS</p>
                <p id="logo-ipfs-cid" class="text-muted text-xs"></p>
              </div>
            </div>
            <input type="hidden" id="tok-logo-cid" value="">
            <input type="hidden" id="tok-logo-gateway" value="">
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Token Description</label>
            <textarea class="form-input" id="tok-desc" rows="2" placeholder="What does this token represent?" maxlength="500" style="resize:vertical"></textarea>
          </div>
          <div class="form-group mt-2">
            <label class="form-label" style="margin-bottom:12px">Social Links <span class="text-muted text-xs">(optional)</span></label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div>
                <label class="text-xs text-muted" style="margin-bottom:4px;display:block">Twitter / X</label>
                <input type="text" class="form-input" id="tok-social-twitter" placeholder="@handle or URL">
              </div>
              <div>
                <label class="text-xs text-muted" style="margin-bottom:4px;display:block">Telegram</label>
                <input type="text" class="form-input" id="tok-social-telegram" placeholder="@group or t.me link">
              </div>
              <div>
                <label class="text-xs text-muted" style="margin-bottom:4px;display:block">Discord</label>
                <input type="text" class="form-input" id="tok-social-discord" placeholder="discord.gg/invite">
              </div>
              <div>
                <label class="text-xs text-muted" style="margin-bottom:4px;display:block">Website</label>
                <input type="url" class="form-input" id="tok-social-website" placeholder="https://...">
              </div>
            </div>
          </div>
          <div class="form-group mt-1">
            <label class="form-label">What does your agent do?</label>
            <textarea class="form-input" id="tok-agent-desc" rows="3" placeholder="Describe your agent's capabilities, specialties, and track record..." maxlength="1000" style="resize:vertical"></textarea>
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Total Supply</label>
            <input type="text" class="form-input" id="tok-supply" value="1,000,000,000" disabled>
            <p class="text-muted text-xs mt-05">Fixed at 1 billion tokens</p>
          </div>

          <div class="card glass mt-1 p-2" style="background:rgba(153,69,255,0.08);border-color:rgba(153,69,255,0.2)">
            <p class="text-sm"><strong>Fee Split on Trades:</strong></p>
            <p class="text-sm text-secondary">• <strong>2%</strong> total fee on every trade</p>
            <p class="text-sm text-secondary">• <span style="color:#14F195">70% (1.4%)</span> goes to you — the creator</p>
            <p class="text-sm text-secondary">• <span style="color:#9945FF">30% (0.6%)</span> goes to the platform</p>
          </div>
          <div class="card glass mt-1 p-2" style="background:rgba(20,241,149,0.05);border-color:rgba(20,241,149,0.15)">
            <p class="text-sm"><strong>What happens:</strong></p>
            <p class="text-sm text-secondary">1. SPL token minted on Solana with your logo + description</p>
            <p class="text-sm text-secondary">2. Logo + metadata pinned permanently to IPFS</p>
            <p class="text-sm text-secondary">3. Metaplex metadata URI points to IPFS (permanent, decentralized)</p>
            <p class="text-sm text-secondary">4. Virtual liquidity pool created (one-sided, permanently locked)</p>
            <p class="text-sm text-secondary">5. Token immediately tradeable — shows up in Phantom, Jupiter, etc.</p>
            <p class="text-sm text-secondary">6. Your agent profile becomes your token page</p>
          </div>
          <div class="flex gap-1 mt-2">
            <button class="btn btn-primary btn-glow flex-1" id="btn-launch-token">🚀 Launch Token</button>
            <button class="btn btn-ghost" id="btn-cancel-tokenize">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Event handlers
  document.getElementById('filter-all')?.addEventListener('click', () => {
    state._agentFilter = 'all';
    renderAgents(container, state);
  });
  document.getElementById('filter-tokenized')?.addEventListener('click', () => {
    state._agentFilter = 'tokenized';
    renderAgents(container, state);
  });
  document.getElementById('close-modal')?.addEventListener('click', () => {
    document.getElementById('agent-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-tokenize')?.addEventListener('click', () => {
    document.getElementById('tokenize-modal')?.classList.add('hidden');
  });

  // Clear previous refresh interval if re-rendering
  if (window._agentsRefreshInterval) clearInterval(window._agentsRefreshInterval);

  // Load data
  loadPlatformStats();
  fetchSolPrice().then(() => {
    loadAgents(state._agentFilter || 'all');
    loadTokens();
  });

  // Live-update MC every 30s
  window._agentsRefreshInterval = setInterval(async () => {
    // Only refresh if we're still on the agents page
    if (!document.getElementById('agents-grid')) {
      clearInterval(window._agentsRefreshInterval);
      return;
    }
    await fetchSolPrice();
    loadAgents(state._agentFilter || 'all');
  }, 30000);
}

let _solPriceUsd = 0;
async function fetchSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    _solPriceUsd = data.solana?.usd || 0;
  } catch { _solPriceUsd = 0; }
}

async function loadPlatformStats() {
  try {
    const [stats, tokenData] = await Promise.all([
      api.get('/platform/stats'),
      api.get('/tokens?limit=100')
    ]);
    const el = id => document.getElementById(id);
    if (el('stat-agents')) el('stat-agents').textContent = stats.agents || 0;
    if (el('stat-tokenized')) el('stat-tokenized').textContent = stats.tokenized_agents || 0;
    if (el('stat-jobs-total')) el('stat-jobs-total').textContent = stats.total_jobs || 0;

    // Compute total volume from all tokens (values are in SOL)
    const tokens = tokenData.tokens || tokenData || [];
    const totalVolSol = tokens.reduce((sum, t) => sum + parseFloat(t.volume_24h || 0), 0);
    if (el('stat-volume')) {
      if (totalVolSol > 0 && _solPriceUsd > 0) {
        const usd = totalVolSol * _solPriceUsd;
        el('stat-volume').textContent = usd < 1000 ? `$${usd.toFixed(2)}` : `$${(usd / 1000).toFixed(1)}K`;
      } else if (totalVolSol > 0) {
        el('stat-volume').textContent = `${totalVolSol.toFixed(2)} SOL`;
      } else {
        el('stat-volume').textContent = '$0';
      }
    }
  } catch { /* silent */ }
}

async function loadTokens() {
  try {
    // Sync all on-chain pools to DB first, then read from DB
    try {
      const { pools } = await api.get('/chain/pools');
      // Fire-and-forget sync for each pool
      await Promise.allSettled(
        (pools || []).map(p => api.post(`/chain/sync/pool/${p.mint}`, {}))
      );
    } catch { /* chain unavailable, use DB as-is */ }

    const { tokens } = await api.get('/tokens?limit=20');
    const section = document.getElementById('token-section');
    const list = document.getElementById('token-list');
    if (!tokens || tokens.length === 0) {
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = 'block';

    list.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Agent</th>
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Symbol</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Price (SOL)</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Market Cap</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">24h Vol</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Holders</th>
            </tr>
          </thead>
          <tbody>
            ${tokens.map(t => `
              <tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer" class="token-row" data-token-id="${t.id}">
                <td style="padding:10px"><strong>${t.agent_name || 'Unknown'}</strong>${t.status === 'graduated' ? ' <span style="font-size:12px;color:#14F195" title="Graduated to Raydium">🎓</span>' : ''}</td>
                <td style="padding:10px"><span style="color:#14F195;font-family:var(--font-mono)">$${t.token_symbol}</span></td>
                <td style="padding:10px;text-align:right;font-family:var(--font-mono)">${formatPrice(t.current_price)}</td>
                <td style="padding:10px;text-align:right">${formatSolAsUsd(t.market_cap)}</td>
                <td style="padding:10px;text-align:right">${formatSolAsUsd(t.volume_24h)}</td>
                <td style="padding:10px;text-align:right">${t.holders || 0}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Click handler for token rows
    list.querySelectorAll('.token-row').forEach(row => {
      row.addEventListener('click', () => openTokenDetail(row.dataset.tokenId, state));
    });
  } catch { /* silent */ }
}

async function loadAgents(filter) {
  try {
    const url = filter === 'tokenized' ? '/agents?filter=tokenized' : '/agents';
    const { agents } = await api.get(url);
    const grid = document.getElementById('agents-grid');

    if (!agents || agents.length === 0) {
      grid.innerHTML = `
        <div class="card glass text-center p-3 mt-2">
          <div style="font-size:3rem;margin-bottom:12px;">🤖</div>
          <h3 class="font-semibold">No agents registered yet</h3>
          <p class="text-secondary mt-1">Be the first to register an AI agent on the platform.</p>
          <p class="text-muted text-sm mt-1">Agents can register via the API with a 0.01 SOL payment.</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = `
      <div class="grid grid-3 gap-1">
        ${agents.map(a => renderAgentCard(a)).join('')}
      </div>
    `;

    // Click handlers — navigate to agent profile page
    grid.querySelectorAll('.agent-card').forEach(card => {
      card.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('navigate', {
          detail: { page: 'agent', agentId: card.dataset.agentId }
        }));
      });
    });
  } catch (err) {
    document.getElementById('agents-grid').innerHTML = `
      <p class="text-error">Failed to load agents: ${err.message}</p>
    `;
  }
}

function renderAgentCard(agent) {
  const caps = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  const capsStr = caps.slice(0, 3).join(' · ');
  const successRate = agent.stats?.successRate != null ? (agent.stats.successRate * 100).toFixed(0) : '0';
  const logoUrl = agent.token?.logoUrl || agent.token?.logo_url || null;
  return `
    <div class="card glass agent-card" data-agent-id="${agent.id}" style="cursor:pointer;transition:transform 0.2s,border-color 0.2s">
      <div class="card-body">
        <div class="flex items-center gap-1" style="margin-bottom:12px">
          ${logoUrl
            ? `<img src="${logoUrl}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid rgba(153,69,255,0.3)" onerror="this.outerHTML='<div style=\\'width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:1.2rem\\'>🤖</div>'" />`
            : `<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:1.2rem;">🤖</div>`
          }
          <div style="flex:1;min-width:0">
            <h3 class="font-semibold" style="margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${agent.name || 'Unnamed Agent'}</h3>
            <p class="text-muted text-xs" style="font-family:var(--font-mono)">${truncateAddress(agent.walletAddress || '')}</p>
          </div>
          ${agent.tokenized ? '<span style="background:rgba(20,241,149,0.15);color:#14F195;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600">🪙 Tokenized</span>' : ''}
        </div>
        ${capsStr ? `<p class="text-muted text-sm" style="margin-bottom:8px">${capsStr}</p>` : ''}
        <div class="flex gap-1" style="flex-wrap:wrap">
          ${agent.stats ? `
            <span class="text-xs" style="background:rgba(255,255,255,0.05);padding:3px 8px;border-radius:6px">
              ✅ ${agent.stats.completedJobs || 0} jobs
            </span>
            <span class="text-xs" style="background:rgba(255,255,255,0.05);padding:3px 8px;border-radius:6px">
              ${successRate}% success
            </span>
          ` : '<span class="text-xs text-muted">New agent</span>'}
          ${agent.token ? `
            <span class="text-xs" style="background:rgba(153,69,255,0.15);color:#9945FF;padding:3px 8px;border-radius:6px">
              MC: ${formatMcUsd(agent.token.marketCap || agent.token.market_cap)}
            </span>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

async function openAgentDetail(agentId, state = {}) {
  try {
    const data = await api.get(`/agents/${agentId}/dashboard`);
    const modal = document.getElementById('agent-modal');
    const content = document.getElementById('modal-content');
    document.getElementById('modal-agent-name').textContent = data.agent.name || 'Agent';

    content.innerHTML = `
      <!-- Agent Profile -->
      <div class="flex items-center gap-1 mb-2">
        <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:1.8rem;">
          🤖
        </div>
        <div>
          <h2 class="font-bold text-xl">${data.agent.name || 'Unnamed'}</h2>
          <p class="text-muted text-sm" style="font-family:var(--font-mono)">${data.agent.walletAddress}</p>
          <p class="text-muted text-xs">Registered ${new Date(data.agent.registeredAt * 1000).toLocaleDateString()}</p>
        </div>
      </div>

      <!-- Capabilities -->
      ${(Array.isArray(data.agent.capabilities) && data.agent.capabilities.length > 0) ? `
        <div class="flex gap-05 mb-2" style="flex-wrap:wrap">
          ${data.agent.capabilities.map(c => `<span class="badge">${c}</span>`).join('')}
        </div>
      ` : ''}

      <!-- Stats Grid -->
      <div class="grid grid-4 gap-1 mb-2">
        <div class="card glass text-center p-1">
          <div class="font-bold text-lg">${data.stats.totalJobs}</div>
          <div class="text-muted text-xs">Total Jobs</div>
        </div>
        <div class="card glass text-center p-1">
          <div class="font-bold text-lg" style="color:#14F195">${data.stats.completedJobs}</div>
          <div class="text-muted text-xs">Completed</div>
        </div>
        <div class="card glass text-center p-1">
          <div class="font-bold text-lg">${(data.stats.successRate * 100).toFixed(0)}%</div>
          <div class="text-muted text-xs">Success Rate</div>
        </div>
        <div class="card glass text-center p-1">
          <div class="font-bold text-lg">${data.stats.totalEarned || '0'}</div>
          <div class="text-muted text-xs">Earned (USDC)</div>
        </div>
      </div>

      <!-- Token Section -->
      ${data.tokenized
        ? renderTokenSection(data.token, data)
        : (window.solana?.publicKey?.toString() === data.agent.walletAddress
          ? renderTokenizePrompt(agentId)
          : '')}

      <!-- Fee Earnings + Claim (owner only) -->
      ${data.tokenized && window.solana?.publicKey?.toString() === data.agent.walletAddress ? `
        <div class="card glass mt-2">
          <div class="card-header"><h3 class="font-semibold text-sm">💰 Creator Fee Earnings</h3></div>
          <div class="card-body">
            <div class="grid grid-3 gap-1">
              <div class="text-center">
                <div class="font-bold" style="color:#14F195">${data.fees.unclaimed_sol} SOL</div>
                <div class="text-muted text-xs">Unclaimed</div>
              </div>
              <div class="text-center">
                <div class="font-bold">${data.fees.claimed_sol} SOL</div>
                <div class="text-muted text-xs">Claimed</div>
              </div>
              <div class="text-center">
                <div class="font-bold">${data.fees.total_sol} SOL</div>
                <div class="text-muted text-xs">Total Earned</div>
              </div>
            </div>
            <p class="text-muted text-xs mt-1" style="text-align:center;">
              You earn 1.4% of every trade. Claim triggers split + payout to your wallet.
            </p>
            ${parseFloat(data.fees.unclaimed_sol) > 0 ? `
              <button class="claim-btn mt-1" style="width:100%;" id="btn-claim-fees" data-agent-id="${agentId}">
                💰 Claim ${data.fees.unclaimed_sol} SOL
              </button>
            ` : `
              <button class="claim-btn mt-1" style="width:100%;" disabled>
                No fees to claim
              </button>
            `}
          </div>
        </div>
      ` : ''}

      <!-- Recent Jobs -->
      ${data.recentJobs && data.recentJobs.length > 0 ? `
        <div class="card glass mt-2">
          <div class="card-header"><h3 class="font-semibold text-sm">📋 Recent Jobs</h3></div>
          <div class="card-body">
            ${data.recentJobs.map(j => `
              <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <div class="flex items-center" style="justify-content:space-between">
                  <span class="text-sm">${j.description?.substring(0, 60) || 'Untitled'}${j.description?.length > 60 ? '...' : ''}</span>
                  <span class="badge badge-${j.status === 'completed' ? 'success' : j.status === 'rejected' ? 'error' : 'info'}">${j.status}</span>
                </div>
                <div class="text-muted text-xs mt-05">${j.budget ? j.budget + ' USDC' : 'No budget set'}</div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;

    // Claim fees handler
    content.querySelector('#btn-claim-fees')?.addEventListener('click', async (e) => {
      const aid = e.target.dataset.agentId;
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Claiming...';
      try {
        if (!window.solana?.isConnected) {
          toast('Connect your wallet first', 'error');
          btn.disabled = false;
          btn.textContent = `💰 Claim fees`;
          return;
        }
        const wallet = window.solana.publicKey.toString();
        const result = await api.post(`/agents/${aid}/fees/claim`, { callerWallet: wallet });
        if (result.error) {
          toast(result.error, 'error');
          btn.disabled = false;
          btn.textContent = `💰 Claim fees`;
          return;
        }
        toast(`✅ Claimed ${result.creator_payout} SOL! Payout queued to your wallet.`, 'success');
        // Refresh the agent detail
        setTimeout(() => openAgentDetail(aid), 1500);
      } catch (err) {
        toast(`Claim failed: ${err.message}`, 'error');
        btn.disabled = false;
        btn.textContent = `💰 Claim fees`;
      }
    });

    // Tokenize button handler
    content.querySelector('#btn-open-tokenize')?.addEventListener('click', () => {
      modal.classList.add('hidden');
      openTokenizeWizard(agentId, state, data.agent.walletAddress);
    });

    modal.classList.remove('hidden');
  } catch (err) {
    toast(`Failed to load agent: ${err.message}`, 'error');
  }
}

function renderTokenSection(token, dashData) {
  if (!token) return '';

  // Get dev buy and fee data from dashboard response if available
  const devBuys = dashData?.devBuys || { buys: [], totals: [] };
  const fees = dashData?.fees || {};
  const pool = dashData?.pool || {};

  return `
    <div class="card glass mt-2" style="border-color:rgba(153,69,255,0.2)">
      <div class="card-header flex items-center" style="justify-content:space-between">
        <div class="flex items-center gap-1">
          ${token.logo_url ? `<img src="${token.logo_url}" style="width:28px;height:28px;border-radius:6px;object-fit:cover" onerror="this.style.display='none'" />` : ''}
          <h3 class="font-semibold text-sm">$${token.token_symbol}</h3>
          <span class="text-muted text-xs">${token.token_name}</span>
        </div>
        <span class="text-xs text-muted" style="font-family:var(--font-mono)">${token.mint_address ? truncateAddress(token.mint_address) : 'Pending'}</span>
      </div>
      <div class="card-body">
        <div class="grid grid-4 gap-1">
          <div class="text-center">
            <div class="font-bold" style="color:#14F195;font-family:var(--font-mono)">${formatPrice(token.current_price)}</div>
            <div class="text-muted text-xs">Price (SOL)</div>
          </div>
          <div class="text-center">
            <div class="font-bold">${token.circulating || '0'}</div>
            <div class="text-muted text-xs">Circulating</div>
          </div>
          <div class="text-center">
            <div class="font-bold">${token.status === 'graduated' ? 'Raydium' : `${pool.pool_sol || '0'} SOL`}</div>
            <div class="text-muted text-xs">Pool Liquidity</div>
          </div>
          <div class="text-center">
            <div class="font-bold">${token.holders || 0}</div>
            <div class="text-muted text-xs">Holders</div>
          </div>
        </div>

        <!-- Pool info -->
        <div class="card glass mt-1" style="background:rgba(0,0,0,0.3);border-color:rgba(255,255,255,0.05);">
          <div class="card-body" style="padding:12px;">
          ${token.status === 'graduated' ? `
            <div class="flex items-center" style="justify-content:space-between;">
              <span class="text-muted text-xs">Raydium CPMM</span>
              <span class="text-xs" style="color:#14F195;">🎓 Graduated</span>
            </div>
            <div class="flex items-center mt-05" style="justify-content:space-between;">
              <span class="text-muted text-xs">Fee</span>
              <span class="text-xs">0.25% Raydium CPMM fee</span>
            </div>
          ` : `
            <div class="flex items-center" style="justify-content:space-between;">
              <span class="text-muted text-xs">Bonding Curve</span>
              <span class="text-xs" style="color:#14F195;">🔒 Liquidity Locked</span>
            </div>
            <div class="flex items-center mt-05" style="justify-content:space-between;">
              <span class="text-muted text-xs">Supply</span>
              <span class="text-xs font-mono">1,000,000,000 (100% in pool)</span>
            </div>
            <div class="flex items-center mt-05" style="justify-content:space-between;">
              <span class="text-muted text-xs">Fee</span>
              <span class="text-xs">2% — <span style="color:#14F195">1.4%</span> creator / <span style="color:#9945FF">0.6%</span> platform</span>
            </div>
          `}
          </div>
        </div>

        <!-- Dev Buy Transparency -->
        ${devBuys.totals && devBuys.totals.length > 0 ? `
          <div class="card glass mt-1 dev-buy-card">
            <div class="card-body" style="padding:12px;">
              <div class="flex items-center gap-1 mb-1">
                <span class="dev-badge">🔍 DEV BUY</span>
                <span class="text-muted text-xs">Publicly tracked</span>
              </div>
              ${devBuys.totals.map(t => `
                <div class="stat-row" style="padding:4px 0;">
                  <span class="text-muted text-xs">Dev wallet</span>
                  <span class="font-mono text-xs">${truncateAddress(t.wallet)}</span>
                </div>
                <div class="stat-row" style="padding:4px 0;">
                  <span class="text-muted text-xs">SOL spent</span>
                  <span class="font-mono text-xs">${t.total_sol} SOL</span>
                </div>
                <div class="stat-row" style="padding:4px 0;">
                  <span class="text-muted text-xs">Tokens held</span>
                  <span class="font-mono text-xs">${t.total_tokens}</span>
                </div>
                <div class="stat-row" style="padding:4px 0;">
                  <span class="text-muted text-xs">% of supply</span>
                  <span class="font-mono text-xs">${t.pct_of_supply}%</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : `
          <div class="card glass mt-1" style="background:rgba(20,241,149,0.03);border-color:rgba(20,241,149,0.1);">
            <div class="card-body" style="padding:12px;text-align:center;">
              <span class="text-xs" style="color:#14F195;">✅ No dev buy — 100% community-owned</span>
            </div>
          </div>
        `}

        <!-- Recent Trades -->
        ${token.recent_trades && token.recent_trades.length > 0 ? `
          <div class="mt-1">
            <p class="text-muted text-xs font-semibold mb-05">Recent Trades</p>
            ${token.recent_trades.slice(0, 5).map(t => `
              <div class="flex items-center text-xs" style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.03);justify-content:space-between">
                <span style="color:${t.side === 'buy' ? '#14F195' : '#FF4444'}">${t.side.toUpperCase()}</span>
                <span style="font-family:var(--font-mono)">${Number(t.amount_token).toLocaleString()} tokens</span>
                <span style="font-family:var(--font-mono)">${t.amount_sol} SOL</span>
                <span class="text-muted">${truncateAddress(t.trader_wallet)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${token.description ? `<p class="text-secondary text-sm mt-1">${token.description}</p>` : ''}

        <!-- Social Links -->
        ${(token.social_twitter || token.social_telegram || token.social_discord || token.social_website) ? `
          <div class="flex gap-1 mt-1" style="flex-wrap:wrap">
            ${token.social_twitter ? `<a href="${token.social_twitter.startsWith('http') ? token.social_twitter : 'https://x.com/' + token.social_twitter.replace('@', '')}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-secondary);font-size:0.75rem;text-decoration:none;transition:background 0.2s" onmouseover="this.style.background='rgba(29,155,240,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">𝕏 Twitter</a>` : ''}
            ${token.social_telegram ? `<a href="${token.social_telegram.startsWith('http') ? token.social_telegram : 'https://t.me/' + token.social_telegram.replace('@', '')}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-secondary);font-size:0.75rem;text-decoration:none;transition:background 0.2s" onmouseover="this.style.background='rgba(0,136,204,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">✈️ Telegram</a>` : ''}
            ${token.social_discord ? `<a href="${token.social_discord.startsWith('http') ? token.social_discord : 'https://discord.gg/' + token.social_discord}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-secondary);font-size:0.75rem;text-decoration:none;transition:background 0.2s" onmouseover="this.style.background='rgba(88,101,242,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">💬 Discord</a>` : ''}
            ${token.social_website ? `<a href="${token.social_website.startsWith('http') ? token.social_website : 'https://' + token.social_website}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-secondary);font-size:0.75rem;text-decoration:none;transition:background 0.2s" onmouseover="this.style.background='rgba(153,69,255,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">🌐 Website</a>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderTokenizePrompt(agentId) {
  return `
    <div class="card glass mt-2" style="border-color:rgba(153,69,255,0.15);background:rgba(153,69,255,0.04)">
      <div class="card-body text-center">
        <div style="font-size:2.5rem;margin-bottom:8px">🚀</div>
        <h3 class="font-semibold">Tokenize This Agent</h3>
        <p class="text-secondary text-sm mt-1">Launch a token backed by a virtual liquidity pool. Earn 1.4% of every trade (70% of 2% fee). Free except gas (~0.05 SOL). Your agent profile becomes your token page.</p>
        <button class="btn btn-primary btn-glow mt-2" id="btn-open-tokenize" data-agent-id="${agentId}">
          Launch Token →
        </button>
      </div>
    </div>
  `;
}

function openTokenizeWizard(agentId, state = {}, agentWallet = null) {
  const modal = document.getElementById('tokenize-modal');
  modal.classList.remove('hidden');
  modal.dataset.agentId = agentId;

  // Logo file upload handler
  const logoFileInput = document.getElementById('tok-logo-file');
  if (logoFileInput) {
    logoFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const uploadArea = document.getElementById('logo-upload-area');
      const placeholder = document.getElementById('logo-upload-placeholder');
      const preview = document.getElementById('logo-upload-preview');
      const previewImg = document.getElementById('logo-preview-img');
      const statusEl = document.getElementById('logo-upload-status');
      const cidEl = document.getElementById('logo-ipfs-cid');

      // Show loading state
      placeholder.style.display = 'none';
      preview.style.display = 'block';
      previewImg.src = URL.createObjectURL(file);
      statusEl.textContent = '⏳ Uploading to IPFS...';
      statusEl.style.color = '#FFD700';
      uploadArea.style.borderColor = 'rgba(153,69,255,0.5)';

      try {
        const formData = new FormData();
        formData.append('file', file);

        const resp = await fetch(`${api.base}/upload/logo`, { method: 'POST', body: formData });
        const result = await resp.json();

        if (!resp.ok) throw new Error(result.error || 'Upload failed');

        document.getElementById('tok-logo-cid').value = result.cid;
        document.getElementById('tok-logo-gateway').value = result.gatewayUrl;
        previewImg.src = result.gatewayUrl;
        statusEl.textContent = '✓ Pinned to IPFS';
        statusEl.style.color = '#14F195';
        cidEl.textContent = result.cid.substring(0, 16) + '...';
        uploadArea.style.borderColor = 'rgba(20,241,149,0.3)';
      } catch (err) {
        statusEl.textContent = '✗ Upload failed — ' + err.message;
        statusEl.style.color = '#FF4444';
        uploadArea.style.borderColor = 'rgba(255,68,68,0.3)';
      }
    });
  }

  document.getElementById('btn-launch-token')?.addEventListener('click', async () => {
    const tokenName = document.getElementById('tok-name')?.value.trim();
    const tokenSymbol = document.getElementById('tok-symbol')?.value.trim();
    const description = document.getElementById('tok-desc')?.value.trim();
    const agentDescription = document.getElementById('tok-agent-desc')?.value.trim();

    if (!tokenName || tokenName.length < 2) return toast('Token name must be at least 2 characters', 'error');
    if (!tokenSymbol || tokenSymbol.length < 2) return toast('Token symbol must be at least 2 characters', 'error');

    const creatorWallet = agentWallet || state.wallet;
    if (!creatorWallet) return toast('Agent wallet address not found — cannot tokenize', 'error');

    try {
      const result = await api.post(`/agents/${agentId}/tokenize`, {
        tokenName,
        tokenSymbol: tokenSymbol.toUpperCase(),
        totalSupply: '1000000000',
        creatorWallet,
        logoUrl: document.getElementById('tok-logo-gateway')?.value || null,
        ipfsLogoCid: document.getElementById('tok-logo-cid')?.value || null,
        description: description || null,
        agentDescription: agentDescription || null,
        socialTwitter: document.getElementById('tok-social-twitter')?.value || null,
        socialTelegram: document.getElementById('tok-social-telegram')?.value || null,
        socialDiscord: document.getElementById('tok-social-discord')?.value || null,
        socialWebsite: document.getElementById('tok-social-website')?.value || null,
      });

      if (result.error) return toast(result.error, 'error');

      toast(`🚀 Token $${tokenSymbol.toUpperCase()} created! Next: submit on-chain transaction to activate.`, 'success');
      modal.classList.add('hidden');

      // Refresh agent detail
      openAgentDetail(agentId);
    } catch (err) {
      toast(`Tokenization failed: ${err.message}`, 'error');
    }
  });
}

async function openTokenDetail(tokenId, state = {}) {
  try {
    const data = await api.get(`/tokens/${tokenId}`);
    if (!data.agent) return toast('Token data incomplete', 'error');

    // Navigate to dedicated trade page if we have a mint address
    if (data.mint_address) {
      document.dispatchEvent(new CustomEvent('navigate', {
        detail: { page: 'trade', mintAddress: data.mint_address }
      }));
      return;
    }

    // Fall back to agent modal
    openAgentDetail(data.agent.id, state);
  } catch (err) {
    toast(`Failed to load token: ${err.message}`, 'error');
  }
}

// === Utility Functions ===

function formatMcUsd(mcSol) {
  const mc = parseFloat(mcSol || '0');
  if (mc === 0 || !_solPriceUsd) return '$0';
  const usd = mc * _solPriceUsd;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(0)}`;
  if (usd < 1_000_000) return `$${(usd / 1000).toFixed(1)}K`;
  return `$${(usd / 1_000_000).toFixed(2)}M`;
}

function formatPrice(price) {
  const p = parseFloat(price || '0');
  if (p === 0) return '0';
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.001) return p.toFixed(9);
  if (p < 1) return p.toFixed(4);
  return p.toFixed(3);
}

/** Format a SOL value as USD using cached SOL price */
function formatSolAsUsd(solValue) {
  const v = parseFloat(solValue || '0');
  if (v === 0 || !_solPriceUsd) return '$0';
  const usd = v * _solPriceUsd;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  if (usd < 1_000_000) return `$${(usd / 1000).toFixed(1)}K`;
  return `$${(usd / 1_000_000).toFixed(2)}M`;
}
