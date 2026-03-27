import { api, toast, truncateAddress } from '../main.js';

export async function renderAgentProfile(container, state, agentId) {
  if (!agentId) {
    container.innerHTML = `<div class="card glass p-3 text-center"><p class="text-muted">No agent specified.</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <button class="btn btn-sm btn-ghost mb-1" id="back-to-agents">← Back to Agents</button>
      <div class="card glass p-3" id="profile-loading">
        <div class="text-center">
          <div class="spinner" style="margin:0 auto 12px"></div>
          <p class="text-muted">Loading agent profile...</p>
        </div>
      </div>
    </div>
    <div id="profile-content" style="display:none"></div>
  `;

  document.getElementById('back-to-agents')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('navigate', { detail: 'agents' }));
  });

  try {
    const data = await api.get(`/agents/${agentId}/dashboard`);
    let feesData = null;
    try { feesData = await api.get(`/agents/${agentId}/fees`); } catch {}

    // Fetch SOL/USD price for market cap display
    let _solPriceUsd = 0;
    try {
      const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const cgData = await cgRes.json();
      _solPriceUsd = cgData.solana?.usd || 0;
    } catch {}
    // Attach to data so buildProfileHTML can use it
    data._solPriceUsd = _solPriceUsd;

    // Fetch jobs where this agent is client OR provider (by wallet)
    const wallet = data.agent.walletAddress;
    let jobsData = { jobs: [] };
    try {
      const [asClient, asProvider] = await Promise.all([
        api.get(`/jobs?client=${wallet}&limit=20`).catch(() => ({ jobs: [] })),
        api.get(`/jobs?provider=${wallet}&limit=20`).catch(() => ({ jobs: [] })),
      ]);
      // Merge and deduplicate by job id
      const seen = new Set();
      const merged = [];
      for (const j of [...(asClient.jobs || []), ...(asProvider.jobs || [])]) {
        if (!seen.has(j.id)) { seen.add(j.id); merged.push(j); }
      }
      merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      jobsData = { jobs: merged };
    } catch {}

    let servicesData = null;
    try { servicesData = await api.get(`/services/agent/${agentId}`); } catch {}

    document.getElementById('profile-loading').style.display = 'none';
    const content = document.getElementById('profile-content');
    content.style.display = 'block';
    content.innerHTML = buildProfileHTML(data, feesData, jobsData, servicesData, agentId);

    // Wire up event handlers
    wireProfileEvents(content, data, agentId, state);

  } catch (err) {
    document.getElementById('profile-loading').innerHTML = `
      <div class="text-center">
        <div style="font-size:3rem;margin-bottom:12px">⚠️</div>
        <h3 class="font-semibold">Agent Not Found</h3>
        <p class="text-secondary mt-1">${err.message}</p>
      </div>
    `;
  }
}

function buildProfileHTML(data, feesData, jobsData, servicesData, agentId) {
  const agent = data.agent;
  const stats = data.stats;
  const token = data.token;
  const pool = data.pool;
  const fees = data.fees || {};
  const _solPriceUsd = data._solPriceUsd || 0;
  const devBuys = data.devBuys || { buys: [], totals: [] };
  const isOwner = window.solana?.publicKey?.toString() === agent.walletAddress;
  const allJobs = jobsData?.jobs || data.recentJobs || [];
  const services = servicesData?.services || servicesData || [];
  const unclaimedFees = feesData?.unclaimed_fees || [];

  // Derive dev buys from trades if devBuys table is empty
  const creatorWallet = token?.creator_wallet || agent.walletAddress;
  let derivedDevBuys = devBuys;
  if ((!devBuys.buys || devBuys.buys.length === 0) && token?.recent_trades?.length > 0) {
    const creatorTrades = token.recent_trades.filter(t => t.trader_wallet === creatorWallet && t.side === 'buy');
    if (creatorTrades.length > 0) {
      const totalSolLamports = creatorTrades.reduce((s, t) => s + parseFloat(t.amount_sol || 0), 0);
      const totalTokens = creatorTrades.reduce((s, t) => s + parseFloat(t.amount_token || 0), 0);
      const totalSupply = parseFloat(String(token.total_supply || 1e9).replace(/,/g, '')) * 1e9; // raw supply (9 decimals)
      const pct = totalSupply > 0 ? ((totalTokens / totalSupply) * 100).toFixed(2) : '0';
      derivedDevBuys = {
        buys: creatorTrades.map(t => ({
          wallet: t.trader_wallet,
          sol_amount: (parseFloat(t.amount_sol) / 1e9).toFixed(4),
          token_amount: t.amount_token,
          tx_signature: t.tx_signature,
          timestamp: t.timestamp,
        })),
        totals: [{
          wallet: creatorWallet,
          total_sol: (totalSolLamports / 1e9).toFixed(4),
          total_tokens: totalTokens.toString(),
          pct_of_supply: pct,
          buy_count: creatorTrades.length,
        }],
      };
    }
  }

  // Compute revenue from jobs
  const jobRevenue = allJobs
    .filter(j => j.status === 'completed')
    .reduce((sum, j) => sum + parseFloat(j.budget || 0), 0);

  return `
    <!-- Hero Section -->
    <div class="card glass" style="border-color:rgba(153,69,255,0.15)">
      <div class="card-body" style="padding:24px">
        <div class="flex items-center gap-2" style="flex-wrap:wrap">
          ${token?.logo_url
            ? `<img src="${token.logo_url}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid rgba(153,69,255,0.3)" onerror="this.outerHTML='<div style=\\'width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:2.5rem\\'>🤖</div>'" />`
            : `<div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:2.5rem">🤖</div>`
          }
          <div style="flex:1;min-width:200px">
            <div class="flex items-center gap-1" style="flex-wrap:wrap">
              <h1 class="text-2xl font-bold" style="margin:0">${agent.name || 'Unnamed Agent'}</h1>
              ${data.tokenized ? '<span style="background:rgba(20,241,149,0.15);color:#14F195;padding:3px 10px;border-radius:12px;font-size:0.8rem;font-weight:600">🪙 Tokenized</span>' : ''}
              ${isOwner ? '<span style="background:rgba(153,69,255,0.15);color:#9945FF;padding:3px 10px;border-radius:12px;font-size:0.8rem;font-weight:600">👤 You</span>' : ''}
            </div>
            <p class="text-muted text-sm mt-05" style="font-family:var(--font-mono)">
              <a href="https://explorer.solana.com/address/${agent.walletAddress}?cluster=devnet" target="_blank" style="color:inherit;text-decoration:none;opacity:0.7">${agent.walletAddress}</a>
            </p>
            <p class="text-muted text-xs mt-05">Registered ${new Date(agent.registeredAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          </div>
          <div style="text-align:right">
            ${data.tokenized && token?.token_symbol ? `
              <button class="btn btn-primary btn-glow" id="btn-trade-token">
                Trade $${token.token_symbol} →
              </button>
            ` : `
              <button class="btn" id="btn-trade-token" disabled style="opacity:0.35;cursor:not-allowed;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.3);border:1px solid rgba(255,255,255,0.08)">
                Not Tokenized
              </button>
            `}
          </div>
        </div>

        <!-- Description -->
        ${agent.description || token?.description ? `<p class="text-secondary mt-2" style="line-height:1.6">${agent.description || token.description}</p>` : ''}

        <!-- Social Links -->
        ${agent.github || agent.twitter ? `
          <div class="flex gap-1 mt-2" style="flex-wrap:wrap">
            ${agent.github ? `<a href="${agent.github}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:inherit;text-decoration:none;font-size:0.85rem;transition:all 0.2s" onmouseenter="this.style.background='rgba(255,255,255,0.1)'" onmouseleave="this.style.background='rgba(255,255,255,0.06)'"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>GitHub</a>` : ''}
            ${agent.twitter ? `<a href="${agent.twitter}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:inherit;text-decoration:none;font-size:0.85rem;transition:all 0.2s" onmouseenter="this.style.background='rgba(255,255,255,0.1)'" onmouseleave="this.style.background='rgba(255,255,255,0.06)'"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>𝕏</a>` : ''}
          </div>
        ` : ''}

        <!-- Capabilities -->
        ${Array.isArray(agent.capabilities) && agent.capabilities.length > 0 ? `
          <div class="flex gap-05 mt-2" style="flex-wrap:wrap">
            ${agent.capabilities.map(c => `
              <span style="background:rgba(153,69,255,0.1);color:#c4a0ff;padding:4px 12px;border-radius:8px;font-size:0.8rem;border:1px solid rgba(153,69,255,0.2)">${c}</span>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>

    <!-- Stats Overview -->
    <div class="grid grid-5 gap-1 mt-2" style="grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))">
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold gradient-text">${stats.totalJobs}</div>
        <div class="text-muted text-xs">Total Jobs</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold" style="color:#14F195">${stats.completedJobs}</div>
        <div class="text-muted text-xs">Completed</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold">${stats.totalJobs > 0 ? (stats.successRate * 100).toFixed(0) : '—'}%</div>
        <div class="text-muted text-xs">Success Rate</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold" style="color:#14F195">${jobRevenue > 0 ? jobRevenue.toFixed(2) : stats.totalEarned || '0'}</div>
        <div class="text-muted text-xs">Earned (USDC)</div>
      </div>
      <div class="card glass text-center p-2">
        <div class="text-2xl font-bold" style="color:#9945FF">${fees.total_sol || '0'}</div>
        <div class="text-muted text-xs">Trading Fees (SOL)</div>
      </div>
    </div>

    <!-- Two Column Layout: Token + Fees -->
    <div class="grid gap-2 mt-2" style="grid-template-columns:${data.tokenized ? '1fr 1fr' : '1fr'};align-items:start">

      <!-- Token Info -->
      ${data.tokenized && token ? `
        <div class="card glass" style="border-color:rgba(153,69,255,0.15)">
          <div class="card-header">
            <div class="flex items-center gap-1">
              <h2 class="font-semibold">🪙 $${token.token_symbol} Token</h2>
              <span class="badge" style="background:rgba(20,241,149,0.15);color:#14F195">${token.status || 'active'}</span>
            </div>
          </div>
          <div class="card-body">
            <div class="grid grid-2 gap-1">
              <div>
                <p class="text-muted text-xs">Price</p>
                <p class="font-bold" style="color:#14F195;font-family:var(--font-mono)">${fmtPrice(token.current_price)} SOL</p>
              </div>
              <div>
                <p class="text-muted text-xs">Market Cap</p>
                <p class="font-bold">${(() => {
                  // FDV: (virtual_sol / virtual_token) * total_supply * SOL_USD
                  // API now provides pool.market_cap_sol as FDV in SOL
                  const mcapSol = parseFloat(pool?.market_cap_sol || 0);
                  if (mcapSol > 0 && _solPriceUsd > 0) {
                    return '$' + (mcapSol * _solPriceUsd).toLocaleString(undefined, { maximumFractionDigits: 0 });
                  } else if (mcapSol > 0) {
                    return fmtSol(mcapSol) + ' SOL';
                  }
                  return '—';
                })()} </p>
              </div>
              <div>
                <p class="text-muted text-xs">Pool Liquidity</p>
                <p class="font-bold">${pool?.pool_sol || '0'} SOL</p>
              </div>
              <div>
                <p class="text-muted text-xs">24h Volume</p>
                <p class="font-bold">${fmtSol(token.volume_24h)} SOL</p>
              </div>
              <div>
                <p class="text-muted text-xs">Total Supply</p>
                <p class="font-bold">${token.total_supply || '—'}</p>
              </div>
              <div>
                <p class="text-muted text-xs">Held (Circulating)</p>
                <p class="font-bold">${token.circulating ? parseFloat(String(token.circulating).replace(/,/g, '')).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'}</p>
              </div>
              <div>
                <p class="text-muted text-xs">Holders</p>
                <p class="font-bold">${(() => {
                  const trades = token.recent_trades || [];
                  const unique = new Set(trades.map(t => t.trader_wallet));
                  return unique.size > 0 ? unique.size : '—';
                })()}</p>
              </div>
            </div>

            <!-- Mint Address -->
            <div style="margin-top:12px;padding:10px;background:rgba(0,0,0,0.3);border-radius:8px">
              <p class="text-muted text-xs">Mint Address</p>
              <p class="text-xs" style="font-family:var(--font-mono);word-break:break-all;opacity:0.7">
                <a href="https://explorer.solana.com/address/${token.mint_address}?cluster=devnet" target="_blank" style="color:inherit">${token.mint_address}</a>
              </p>
            </div>

            <!-- Bonding Curve Info -->
            <div style="margin-top:12px;padding:10px;background:rgba(20,241,149,0.03);border:1px solid rgba(20,241,149,0.1);border-radius:8px">
              <div class="flex items-center" style="justify-content:space-between">
                <span class="text-muted text-xs">Bonding Curve</span>
                <span class="text-xs" style="color:#14F195">🔒 LP Locked</span>
              </div>
              <div class="flex items-center mt-05" style="justify-content:space-between">
                <span class="text-muted text-xs">Fees</span>
                <span class="text-xs">2% — <span style="color:#14F195">1.4%</span> creator / <span style="color:#9945FF">0.6%</span> platform</span>
              </div>
              <div class="flex items-center mt-05" style="justify-content:space-between">
                <span class="text-muted text-xs">Graduation</span>
                <span class="text-xs">85 SOL → Raydium CPMM</span>
              </div>
            </div>

            <!-- Dev Buy Transparency -->
            ${derivedDevBuys.totals && derivedDevBuys.totals.length > 0 ? `
              <div style="margin-top:12px;padding:10px;background:rgba(255,200,0,0.05);border:1px solid rgba(255,200,0,0.15);border-radius:8px">
                <p class="text-xs font-semibold mb-05" style="color:#FFD700">🔍 Dev Buys (Public)</p>
                ${derivedDevBuys.totals.map(t => `
                  <div class="flex items-center text-xs" style="justify-content:space-between;padding:3px 0">
                    <span class="text-muted">${truncateAddress(t.wallet)}</span>
                    <span style="font-family:var(--font-mono)">${t.total_sol} SOL · ${t.buy_count || 1} buy${(t.buy_count || 1) > 1 ? 's' : ''} · ${t.pct_of_supply}% supply</span>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div style="margin-top:12px;padding:10px;background:rgba(20,241,149,0.03);border:1px solid rgba(20,241,149,0.1);border-radius:8px;text-align:center">
                <span class="text-xs" style="color:#14F195">✅ No dev buys — 100% community-owned</span>
              </div>
            `}
          </div>
        </div>
      ` : ''}

      <!-- Fee Earnings -->
      ${data.tokenized ? `
        <div>
          <div class="card glass" style="border-color:rgba(20,241,149,0.15)">
            <div class="card-header">
              <h2 class="font-semibold">💰 Trading Fee Revenue</h2>
            </div>
            <div class="card-body">
              <div class="grid grid-3 gap-1">
                <div class="text-center">
                  <div class="font-bold text-lg" style="color:#14F195">${fees.unclaimed_sol || '0'}</div>
                  <div class="text-muted text-xs">Unclaimed SOL</div>
                </div>
                <div class="text-center">
                  <div class="font-bold text-lg">${fees.claimed_sol || '0'}</div>
                  <div class="text-muted text-xs">Claimed SOL</div>
                </div>
                <div class="text-center">
                  <div class="font-bold text-lg">${fees.total_sol || '0'}</div>
                  <div class="text-muted text-xs">Total SOL</div>
                </div>
              </div>

              ${isOwner && parseFloat(fees.unclaimed_sol || '0') > 0 ? `
                <button class="btn btn-primary btn-glow mt-2" style="width:100%" id="btn-claim-fees" data-agent-id="${agentId}">
                  💰 Claim ${fees.unclaimed_sol} SOL
                </button>
              ` : ''}

              <!-- Fee History -->
              ${unclaimedFees.length > 0 ? `
                <div class="mt-2">
                  <p class="text-muted text-xs font-semibold mb-1">Fee History</p>
                  ${unclaimedFees.slice(0, 10).map(f => `
                    <div class="flex items-center text-xs" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);justify-content:space-between">
                      <span class="text-muted">${f.source === 'token_trade' ? '🔄 Trade' : f.source}</span>
                      <span class="font-bold" style="color:#14F195;font-family:var(--font-mono)">+${f.amount_sol} SOL</span>
                      <span class="text-muted">${timeAgo(f.created_at)}</span>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Tokenize Prompt (if not tokenized and is owner) -->
          ${!data.tokenized && isOwner ? `
            <div class="card glass mt-2" style="border-color:rgba(153,69,255,0.15);background:rgba(153,69,255,0.04)">
              <div class="card-body text-center p-3">
                <div style="font-size:2.5rem;margin-bottom:8px">🚀</div>
                <h3 class="font-semibold">Tokenize This Agent</h3>
                <p class="text-secondary text-sm mt-1">Launch a token, earn 1.4% of every trade. Free except gas.</p>
                <button class="btn btn-primary btn-glow mt-2" id="btn-open-tokenize">Launch Token →</button>
              </div>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>

    <!-- Recent Trades -->
    ${token?.recent_trades?.length > 0 ? `
      <div class="card glass mt-2">
        <div class="card-header flex items-center" style="justify-content:space-between">
          <h2 class="font-semibold">📊 Recent Trades</h2>
          ${token.mint_address ? `<button class="btn btn-sm btn-ghost" id="btn-view-chart">View Chart →</button>` : ''}
        </div>
        <div class="card-body">
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
              <thead>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
                  <th style="padding:8px;text-align:left;color:var(--text-muted)">Side</th>
                  <th style="padding:8px;text-align:right;color:var(--text-muted)">Tokens</th>
                  <th style="padding:8px;text-align:right;color:var(--text-muted)">SOL</th>
                  <th style="padding:8px;text-align:right;color:var(--text-muted)">Price</th>
                  <th style="padding:8px;text-align:left;color:var(--text-muted)">Trader</th>
                  <th style="padding:8px;text-align:right;color:var(--text-muted)">When</th>
                </tr>
              </thead>
              <tbody>
                ${token.recent_trades.map(t => `
                  <tr style="border-bottom:1px solid rgba(255,255,255,0.03)">
                    <td style="padding:8px">
                      <span style="color:${t.side === 'buy' ? '#14F195' : '#FF4444'};font-weight:600">${t.side.toUpperCase()}</span>
                    </td>
                    <td style="padding:8px;text-align:right;font-family:var(--font-mono)">${fmtTokenAmount(t.amount_token)}</td>
                    <td style="padding:8px;text-align:right;font-family:var(--font-mono)">${fmtSol(t.amount_sol, true)}</td>
                    <td style="padding:8px;text-align:right;font-family:var(--font-mono)">${fmtPrice(t.price_per_token)}</td>
                    <td style="padding:8px">
                      <a href="https://explorer.solana.com/address/${t.trader_wallet}?cluster=devnet" target="_blank" style="color:var(--text-muted);text-decoration:none;font-family:var(--font-mono);font-size:0.8rem">${truncateAddress(t.trader_wallet)}</a>
                    </td>
                    <td style="padding:8px;text-align:right;color:var(--text-muted)">${timeAgo(t.timestamp)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- Job History -->
    <div class="card glass mt-2">
      <div class="card-header flex items-center" style="justify-content:space-between">
        <h2 class="font-semibold">📋 Job History</h2>
        <span class="text-muted text-xs">${allJobs.length} job${allJobs.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-body">
        ${allJobs.length > 0 ? allJobs.map(j => {
          const role = j.provider === agent.walletAddress ? 'provider' : j.client === agent.walletAddress ? 'client' : 'evaluator';
          const roleLabel = role === 'provider' ? '🔧 Provider' : role === 'client' ? '📋 Client' : '⚖️ Evaluator';
          const roleBg = role === 'provider' ? 'rgba(20,241,149,0.1)' : role === 'client' ? 'rgba(59,130,246,0.1)' : 'rgba(153,69,255,0.1)';
          const roleFg = role === 'provider' ? '#14F195' : role === 'client' ? '#3B82F6' : '#9945FF';
          const budgetDisplay = j.budget >= 1e6 ? (j.budget / 1e6).toFixed(2) : j.budget;
          return `
          <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
            <div class="flex items-center" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
              <div style="flex:1;min-width:200px">
                <div class="flex items-center gap-05" style="margin-bottom:4px">
                  <span style="padding:2px 8px;border-radius:8px;font-size:0.7rem;font-weight:600;background:${roleBg};color:${roleFg}">${roleLabel}</span>
                </div>
                <p class="font-semibold text-sm">${j.description?.substring(0, 80) || 'Untitled Job'}${j.description?.length > 80 ? '...' : ''}</p>
                <p class="text-muted text-xs mt-05">${timeAgo(j.created_at || j.createdAt)}</p>
              </div>
              <div class="flex items-center gap-1">
                ${j.budget ? `<span class="text-sm font-bold" style="font-family:var(--font-mono)">${budgetDisplay} USDC</span>` : ''}
                <span style="
                  padding:3px 10px;border-radius:12px;font-size:0.75rem;font-weight:600;
                  background:${statusColor(j.status).bg};color:${statusColor(j.status).fg}
                ">${j.status}</span>
              </div>
            </div>
          </div>
        `}).join('') : `
          <div class="text-center p-3">
            <p class="text-muted">No jobs yet</p>
            <p class="text-muted text-xs mt-1">This agent hasn't completed any jobs on the platform.</p>
          </div>
        `}
      </div>
    </div>

    <!-- Services Offered -->
    ${services.length > 0 ? `
      <div class="card glass mt-2">
        <div class="card-header">
          <h2 class="font-semibold">🛠️ Services Offered</h2>
        </div>
        <div class="card-body">
          <div class="grid grid-2 gap-1">
            ${services.map(s => `
              <div class="card glass" style="background:rgba(0,0,0,0.2)">
                <div class="card-body" style="padding:14px">
                  <h4 class="font-semibold text-sm">${s.name || s.title || 'Service'}</h4>
                  <p class="text-muted text-xs mt-05">${s.description?.substring(0, 100) || ''}</p>
                  ${s.price ? `<p class="font-bold mt-1" style="color:#14F195">${s.price} ${s.currency || 'USDC'}</p>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    ` : ''}
  `;
}

function wireProfileEvents(content, data, agentId, state) {
  // Trade button
  content.querySelector('#btn-trade-token')?.addEventListener('click', () => {
    if (data.token?.mint_address) {
      document.dispatchEvent(new CustomEvent('navigate', {
        detail: { page: 'trade', mintAddress: data.token.mint_address }
      }));
    }
  });

  // View chart
  content.querySelector('#btn-view-chart')?.addEventListener('click', () => {
    if (data.token?.mint_address) {
      document.dispatchEvent(new CustomEvent('navigate', {
        detail: { page: 'trade', mintAddress: data.token.mint_address }
      }));
    }
  });

  // Claim fees
  content.querySelector('#btn-claim-fees')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Claiming...';
    try {
      if (!window.solana?.isConnected) {
        toast('Connect your wallet first', 'error');
        btn.disabled = false;
        btn.textContent = '💰 Claim fees';
        return;
      }
      const wallet = window.solana.publicKey.toString();
      const result = await api.post(`/agents/${agentId}/fees/claim`, { callerWallet: wallet });
      if (result.error) throw new Error(result.error);
      toast(`✅ Claimed ${result.creator_payout} SOL!`, 'success');
      setTimeout(() => renderAgentProfile(content.closest('.main-content') || content.parentElement, state, agentId), 1500);
    } catch (err) {
      toast(`Claim failed: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = '💰 Claim fees';
    }
  });

  // Tokenize
  content.querySelector('#btn-open-tokenize')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('navigate', { detail: 'tokenize' }));
  });
}

// === Formatting Helpers ===

function fmtPrice(price) {
  const p = parseFloat(price || '0');
  if (p === 0) return '0';
  if (p < 0.000001) return p.toExponential(2);
  if (p < 0.001) return p.toFixed(9);
  if (p < 1) return p.toFixed(6);
  return p.toFixed(4);
}

function fmtSol(value, fromLamports = false) {
  let v = parseFloat(value || '0');
  if (fromLamports && v > 1e6) v = v / 1e9; // lamports → SOL
  if (v === 0) return '0';
  if (v < 0.001) return v.toFixed(6);
  if (v < 1) return v.toFixed(4);
  if (v < 1000) return v.toFixed(3);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtTokenAmount(amount) {
  const a = parseFloat(amount || '0');
  if (a === 0) return '0';
  if (a > 1e15) return (a / 1e15).toFixed(2) + 'Q';
  if (a > 1e12) return (a / 1e12).toFixed(2) + 'T';
  if (a > 1e9) return (a / 1e9).toFixed(2) + 'B';
  if (a > 1e6) return (a / 1e6).toFixed(2) + 'M';
  if (a > 1e3) return (a / 1e3).toFixed(1) + 'K';
  return a.toLocaleString();
}

function timeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function statusColor(status) {
  const map = {
    completed: { bg: 'rgba(20,241,149,0.15)', fg: '#14F195' },
    active: { bg: 'rgba(153,69,255,0.15)', fg: '#9945FF' },
    open: { bg: 'rgba(59,130,246,0.15)', fg: '#3B82F6' },
    funded: { bg: 'rgba(59,130,246,0.15)', fg: '#3B82F6' },
    submitted: { bg: 'rgba(251,191,36,0.15)', fg: '#FBBF24' },
    rejected: { bg: 'rgba(255,68,68,0.15)', fg: '#FF4444' },
    expired: { bg: 'rgba(255,255,255,0.08)', fg: '#888' },
  };
  return map[status] || { bg: 'rgba(255,255,255,0.08)', fg: '#aaa' };
}
