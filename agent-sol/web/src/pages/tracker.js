import { api, toast, truncateAddress, timeAgo, getSolPrice } from '../main.js';

/**
 * Token Tracker Page
 * - All launched agent tokens in a sortable table
 * - Click token → detail view with chart, trades, stats
 */

export function renderTracker(container) {
  container.innerHTML = `
    <!-- SOL Price Ticker -->
    <div class="card" id="sol-ticker" style="padding:10px 16px;margin-bottom:1rem;display:flex;align-items:center;gap:12px;background:rgba(153,69,255,0.08);border:1px solid rgba(153,69,255,0.15)">
      <img src="https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png" alt="SOL" style="width:24px;height:24px;border-radius:50%">
      <span style="font-weight:600;color:var(--text-primary)">SOL</span>
      <span class="font-mono" style="color:var(--green);font-size:1.1rem;font-weight:700" id="sol-usd-price">—</span>
      <span class="text-muted text-xs" style="margin-left:auto">Live price</span>
    </div>

    <div class="section-header" style="margin-bottom: 1.5rem;">
      <h1 class="page-title" style="font-size: 2rem;">
        <span style="color: var(--green);">📊</span> Token Tracker
      </h1>
      <p class="text-secondary">All launched agent tokens. Click any token for chart, trades, and analytics.</p>
    </div>

    <!-- Stats Bar -->
    <div class="grid-4 gap-2 mb-3" id="tracker-stats">
      <div class="card card-compact">
        <div class="stat-label">Total Tokens</div>
        <div class="stat-value" id="stat-total">—</div>
      </div>
      <div class="card card-compact">
        <div class="stat-label">24h Volume</div>
        <div class="stat-value" id="stat-volume">—</div>
      </div>
      <div class="card card-compact">
        <div class="stat-label">Total Liquidity</div>
        <div class="stat-value" id="stat-liquidity">—</div>
      </div>
      <div class="card card-compact">
        <div class="stat-label">Graduated</div>
        <div class="stat-value" id="stat-graduated">—</div>
      </div>
    </div>

    <!-- Filters -->
    <div class="card mb-2" style="padding: 1rem; display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
      <select id="tracker-sort" class="input" style="width: auto; min-width: 160px;">
        <option value="recent">Most Recent</option>
        <option value="volume">Highest Volume</option>
        <option value="price">Highest Price</option>
        <option value="holders">Most Holders</option>
        <option value="marketcap">Market Cap</option>
      </select>
      <input type="text" id="tracker-search" class="input" placeholder="Search by name or symbol..." style="flex: 1; min-width: 200px;" />
      <button class="btn btn-ghost" id="tracker-refresh" title="Refresh">⟳</button>
    </div>

    <!-- Token Table -->
    <div class="card" id="tracker-table-wrap">
      <div class="table-responsive">
        <table class="table" id="tracker-table">
          <thead>
            <tr>
              <th style="width: 40px;">#</th>
              <th>Token</th>
              <th style="text-align: right;">Price (SOL)</th>
              <th style="text-align: right;">Market Cap</th>
              <th style="text-align: right;">Volume</th>
              <th style="text-align: right;">Holders</th>
              <th style="text-align: right;">Status</th>
              <th style="text-align: right;">Created</th>
            </tr>
          </thead>
          <tbody id="tracker-tbody">
            <tr><td colspan="8" style="text-align: center; padding: 3rem; color: var(--text-tertiary);">Loading tokens...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Token Detail Modal -->
    <div id="token-detail-modal" class="modal-overlay hidden">
      <div class="modal glass" style="max-width: 900px; width: 95%;">
        <button class="modal-close" id="token-detail-close">✕</button>
        <div id="token-detail-content">
          <!-- Filled dynamically -->
        </div>
      </div>
    </div>
  `;

  // Load SOL price
  getSolPrice().then(p => {
    const el = document.getElementById('sol-usd-price');
    if (el && p) el.textContent = `$${p.toFixed(2)}`;
  });

  // Wire up
  loadTokens();
  document.getElementById('tracker-refresh')?.addEventListener('click', loadTokens);
  document.getElementById('tracker-sort')?.addEventListener('change', loadTokens);
  document.getElementById('tracker-search')?.addEventListener('input', debounce(loadTokens, 300));
  document.getElementById('token-detail-close')?.addEventListener('click', () => {
    document.getElementById('token-detail-modal')?.classList.add('hidden');
  });
  document.getElementById('token-detail-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
}

let allTokens = [];
let _cachedChartPoints = [];

async function loadTokens() {
  const sort = document.getElementById('tracker-sort')?.value || 'recent';
  const search = document.getElementById('tracker-search')?.value?.toLowerCase() || '';

  try {
    const data = await api.get(`/tokens?sort=${sort}&limit=100`);
    const rawTokens = data.tokens || data || [];
    // Normalize API field names to what the UI expects
    const tokens = rawTokens.map(t => ({
      ...t,
      name: t.token_name || t.name || 'Unknown',
      symbol: t.token_symbol || t.symbol || '???',
      mint: t.mint_address || t.mint || '',
      price: parseFloat(t.current_price || t.price || 0),
      marketCap: parseFloat(t.market_cap || t.marketCap || 0),
      volume: parseFloat(t.volume_24h || t.volume || 0),
      holders: t.holders || t.holderCount || 0,
      creator: t.creator_wallet || t.creator || '',
    }));
    allTokens = tokens;

    // Update stats
    const totalTokens = tokens.length;
    const graduated = tokens.filter(t => t.status === 'graduated').length;
    const totalVolume = tokens.reduce((sum, t) => sum + (t.volume || 0), 0);
    const totalLiquidity = tokens.reduce((sum, t) => sum + (t.realSolBalance || t.liquidity || 0), 0);

    setText('stat-total', totalTokens.toString());
    setText('stat-volume', formatSol(totalVolume));
    setText('stat-liquidity', formatSol(totalLiquidity));
    setText('stat-graduated', graduated.toString());

    // Filter
    const filtered = search
      ? tokens.filter(t =>
          (t.name || '').toLowerCase().includes(search) ||
          (t.symbol || '').toLowerCase().includes(search) ||
          (t.mint || t.mintAddress || '').toLowerCase().includes(search)
        )
      : tokens;

    renderTable(filtered);
  } catch (err) {
    console.error('Failed to load tokens:', err);
    const tbody = document.getElementById('tracker-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 3rem; color: var(--text-tertiary);">
        No tokens launched yet. Be the first — <a href="#" data-page="tokenize" style="color: var(--green);">Tokenize an Agent</a>
      </td></tr>`;
    }
  }
}

function renderTable(tokens) {
  const tbody = document.getElementById('tracker-tbody');
  if (!tbody) return;

  if (!tokens.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 3rem; color: var(--text-tertiary);">
      No tokens found. ${allTokens.length ? 'Try a different search.' : 'Be the first to launch!'}
    </td></tr>`;
    return;
  }

  tbody.innerHTML = tokens.map((token, i) => {
    const mint = token.mint || token.mintAddress || '';
    const price = token.price || token.currentPrice || 0;
    const mcap = token.marketCap || (price * (token.totalSupply || 1e9));
    const vol = token.volume || token.totalVolume || 0;
    const holders = token.holders || token.holderCount || 0;
    const status = token.status || 'active';
    const created = token.createdAt || token.created_at || 0;

    const statusBadge = status === 'graduated'
      ? '<span style="color: #9945FF; font-size: 0.8rem;">🎓 Raydium</span>'
      : '<span style="color: var(--green); font-size: 0.8rem;">● Bonding</span>';

    return `
      <tr class="token-row" data-id="${token.id}" data-mint="${mint}" style="cursor: pointer;">
        <td style="color: var(--text-tertiary);">${i + 1}</td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <div style="width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #14F195, #9945FF); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem; color: #000; flex-shrink: 0;">
              ${(token.symbol || '??').slice(0, 2)}
            </div>
            <div>
              <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(token.name || 'Unknown')}</div>
              <div style="font-size: 0.78rem; color: var(--text-tertiary);">$${escapeHtml(token.symbol || '???')}</div>
            </div>
          </div>
        </td>
        <td style="text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem;">${formatPrice(price)}</td>
        <td style="text-align: right; font-size: 0.88rem;">${formatSol(mcap)}</td>
        <td style="text-align: right; font-size: 0.88rem;">${formatSol(vol)}</td>
        <td style="text-align: right;">${holders}</td>
        <td style="text-align: right;">${statusBadge}</td>
        <td style="text-align: right; font-size: 0.82rem; color: var(--text-tertiary);">${formatTime(created)}</td>
      </tr>
    `;
  }).join('');

  // Click handlers — pass token ID (UUID) for API lookups, mint for display
  tbody.querySelectorAll('.token-row').forEach(row => {
    row.addEventListener('click', () => openTokenDetail(row.dataset.id, row.dataset.mint));
  });
}

async function openTokenDetail(tokenId, mint) {
  const modal = document.getElementById('token-detail-modal');
  const content = document.getElementById('token-detail-content');
  if (!modal || !content) return;

  content.innerHTML = '<div style="text-align: center; padding: 3rem; color: var(--text-tertiary);">Loading token data...</div>';
  modal.classList.remove('hidden');

  try {
    // Fetch pool data from chain (source of truth), sync DB, fall back to DB pool
    const [poolData, tradesData] = await Promise.all([
      (mint
        ? api.get(`/chain/state/pool/${mint}`).then(async d => {
            api.post(`/chain/sync/pool/${mint}`, {}).catch(() => {});
            return d;
          }).catch(() => api.get(`/pool/${tokenId}`).catch(() => null))
        : api.get(`/pool/${tokenId}`).catch(() => null)
      ),
      (mint
        ? api.get(`/tokens/by-mint/${mint}/trades?limit=50`).catch(() => api.get(`/tokens/${tokenId}/trades?limit=50`).catch(() => ({ trades: [] })))
        : api.get(`/tokens/${tokenId}/trades?limit=50`).catch(() => ({ trades: [] }))
      ),
    ]);

    const pool = poolData?.pool || poolData || {};
    const rawTrades = tradesData?.trades || [];
    // Normalize trade fields
    const trades = (Array.isArray(rawTrades) ? rawTrades : []).map(t => ({
      ...t,
      type: t.side || t.type || 'buy',
      solAmount: parseInt(t.amount_sol || t.solAmount || 0),
      tokenAmount: parseInt(t.amount_token || t.tokenAmount || 0),
      price: parseFloat(t.price_per_token || t.price || 0),
      wallet: t.trader_wallet || t.wallet || t.trader || '',
      timestamp: t.timestamp || t.created_at || 0,
    }));
    const token = allTokens.find(t => t.id === tokenId) || {};

    const name = token.name || pool.name || 'Unknown';
    const symbol = token.symbol || pool.symbol || '???';
    const price = parseFloat(pool.price_sol || pool.currentPrice || pool.price || token.price || 0);
    const virtualSol = parseFloat(pool.virtual_sol_reserve || pool.virtualSolReserve || 0);
    const virtualToken = parseFloat(pool.virtual_token_reserve || pool.virtualTokenReserve || 0);
    const realSol = parseFloat(pool.pool_sol || pool.realSolBalance || 0);
    const totalBuys = pool.total_buys || pool.totalBuys || 0;
    const totalSells = pool.total_sells || pool.totalSells || 0;
    const totalVolume = parseFloat(pool.total_volume_sol || pool.totalVolumeSol || pool.volume || 0);
    const creatorFees = parseFloat(pool.creator_fees_earned || pool.creatorFeesEarned || 0);
    const platformFees = parseFloat(pool.platform_fees_earned || pool.platformFeesEarned || 0);
    const creator = token.creator || pool.creator || '';
    const status = (pool.status === 'graduated' || pool.graduated) ? 'graduated' : 'active';

    content.innerHTML = `
      <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem;">
        <div style="width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #14F195, #9945FF); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.2rem; color: #000; flex-shrink: 0;">
          ${symbol.slice(0, 2)}
        </div>
        <div>
          <h2 style="margin: 0; font-size: 1.5rem;">${escapeHtml(name)}</h2>
          <span style="color: var(--text-tertiary); font-size: 0.9rem;">$${escapeHtml(symbol)} · ${status === 'graduated' ? '🎓 Raydium' : '● Bonding Curve'}</span>
        </div>
        <div style="margin-left: auto; text-align: right;">
          <div style="font-size: 1.4rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--green);">${formatPrice(price)} SOL</div>
          <div style="font-size: 0.8rem; color: var(--text-tertiary);">Current Price</div>
        </div>
      </div>

      <!-- Price Chart -->
      <div class="card mb-2" style="padding: 1rem; background: rgba(0,0,0,0.3);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <span style="font-weight: 600; font-size: 0.9rem;">Price Chart</span>
          <div class="flex gap-1">
            <button class="btn btn-ghost chart-range" data-range="1h" style="padding: 2px 8px; font-size: 0.75rem;">1H</button>
            <button class="btn btn-ghost chart-range" data-range="24h" style="padding: 2px 8px; font-size: 0.75rem;">24H</button>
            <button class="btn btn-ghost chart-range" data-range="7d" style="padding: 2px 8px; font-size: 0.75rem;">7D</button>
            <button class="btn btn-ghost chart-range active" data-range="all" style="padding: 2px 8px; font-size: 0.75rem;">ALL</button>
          </div>
        </div>
        <canvas id="price-chart" width="850" height="280" style="width: 100%; height: 280px;"></canvas>
      </div>

      <!-- Stats Grid -->
      <div class="grid-4 gap-2 mb-2">
        <div class="card card-compact">
          <div class="stat-label">Virtual SOL</div>
          <div class="stat-value" style="font-size: 1rem;">${formatSol(virtualSol)}</div>
        </div>
        <div class="card card-compact">
          <div class="stat-label">Real SOL</div>
          <div class="stat-value" style="font-size: 1rem;">${formatSol(realSol)}</div>
        </div>
        <div class="card card-compact">
          <div class="stat-label">Total Buys</div>
          <div class="stat-value" style="font-size: 1rem; color: var(--green);">${totalBuys}</div>
        </div>
        <div class="card card-compact">
          <div class="stat-label">Total Sells</div>
          <div class="stat-value" style="font-size: 1rem; color: #ff6b6b;">${totalSells}</div>
        </div>
      </div>

      <div class="grid-3 gap-2 mb-2">
        <div class="card card-compact">
          <div class="stat-label">Total Volume</div>
          <div class="stat-value" style="font-size: 1rem;">${formatSol(totalVolume)}</div>
        </div>
        <div class="card card-compact">
          <div class="stat-label">Creator Fees Earned</div>
          <div class="stat-value" style="font-size: 1rem; color: var(--green);">${formatSol(creatorFees)}</div>
        </div>
        <div class="card card-compact">
          <div class="stat-label">Platform Fees</div>
          <div class="stat-value" style="font-size: 1rem;">${formatSol(platformFees)}</div>
        </div>
      </div>

      <!-- Creator / Mint -->
      <div class="card mb-2" style="padding: 0.75rem; font-size: 0.85rem;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
          <span class="text-secondary">Creator</span>
          <a href="https://explorer.solana.com/address/${creator}?cluster=devnet" target="_blank" style="color: var(--green); font-family: 'JetBrains Mono', monospace;">${truncateAddress(creator)}</a>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span class="text-secondary">Mint</span>
          <a href="https://explorer.solana.com/address/${mint}?cluster=devnet" target="_blank" style="color: var(--green); font-family: 'JetBrains Mono', monospace;">${truncateAddress(mint)}</a>
        </div>
      </div>

      <!-- Trade Actions -->
      <div class="flex gap-2 mb-2">
        <button class="btn btn-success" style="flex: 1;" id="detail-buy-btn">Buy $${escapeHtml(symbol)}</button>
        <button class="btn btn-ghost" style="flex: 1; border-color: #ff6b6b; color: #ff6b6b;" id="detail-sell-btn">Sell $${escapeHtml(symbol)}</button>
      </div>

      <!-- Recent Trades -->
      <div class="card" style="padding: 0;">
        <div style="padding: 1rem 1rem 0.5rem; font-weight: 600; font-size: 0.9rem;">Recent Trades</div>
        <div class="table-responsive">
          <table class="table" style="margin: 0;">
            <thead>
              <tr>
                <th>Type</th>
                <th style="text-align: right;">SOL</th>
                <th style="text-align: right;">Tokens</th>
                <th style="text-align: right;">Price</th>
                <th style="text-align: right;">Wallet</th>
                <th style="text-align: right;">Time</th>
              </tr>
            </thead>
            <tbody>
              ${trades.length ? trades.map(t => `
                <tr>
                  <td><span style="color: ${t.type === 'buy' ? 'var(--green)' : '#ff6b6b'}; font-weight: 600;">${t.type === 'buy' ? '🟢 Buy' : '🔴 Sell'}</span></td>
                  <td style="text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;">${formatSol(t.solAmount / 1e9)}</td>
                  <td style="text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;">${formatTokenAmount(t.tokenAmount)}</td>
                  <td style="text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;">${formatPrice(t.price)}</td>
                  <td style="text-align: right;"><a href="https://explorer.solana.com/address/${t.wallet}?cluster=devnet" target="_blank" style="color: var(--text-secondary); font-size: 0.8rem;">${truncateAddress(t.wallet)}</a></td>
                  <td style="text-align: right; font-size: 0.8rem; color: var(--text-tertiary);">${formatTime(t.timestamp)}</td>
                </tr>
              `).join('') : `
                <tr><td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-tertiary);">No trades yet. Be the first!</td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Draw chart — try price history first (more data points), fall back to trades
    let chartPoints = [];
    try {
      const chartData = mint
        ? await api.get(`/tokens/by-mint/${mint}/chart?limit=500`)
        : await api.get(`/tokens/${tokenId}/chart?limit=500`);
      chartPoints = (chartData?.prices || [])
        .map(p => ({
          time: p.timestamp || 0,
          price: parseFloat(p.price_sol || 0),
        }))
        .filter(p => p.price > 0);
    } catch { /* silent */ }

    // Fall back to trades if price history is too sparse
    if (chartPoints.length < 2) {
      chartPoints = trades
        .filter(t => t.price > 0)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .map(t => ({ time: t.timestamp || 0, price: t.price }));
    }

    // Store for range button reuse
    _cachedChartPoints = chartPoints;
    drawPriceChart(chartPoints, 'all');

    // Buy/Sell buttons → navigate to trade page
    document.getElementById('detail-buy-btn')?.addEventListener('click', () => {
      modal.classList.add('hidden');
      document.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'trade', mintAddress: mint } }));
    });
    document.getElementById('detail-sell-btn')?.addEventListener('click', () => {
      modal.classList.add('hidden');
      document.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'trade', mintAddress: mint } }));
    });

    // Chart range buttons
    content.querySelectorAll('.chart-range').forEach(btn => {
      btn.addEventListener('click', () => {
        content.querySelectorAll('.chart-range').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        drawPriceChart(_cachedChartPoints, btn.dataset.range);
      });
    });

  } catch (err) {
    content.innerHTML = `<div style="text-align: center; padding: 3rem; color: #ff6b6b;">Failed to load token data: ${err.message}</div>`;
  }
}

function drawPriceChart(dataPoints, range = 'all') {
  const canvas = document.getElementById('price-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Filter by range
  const now = Date.now() / 1000;
  const ranges = { '1h': 3600, '24h': 86400, '7d': 604800, 'all': Infinity };
  const cutoff = now - (ranges[range] || Infinity);

  if (!Array.isArray(dataPoints)) { dataPoints = []; }
  let points = dataPoints
    .filter(p => p.price > 0 && (p.time || 0) >= cutoff)
    .sort((a, b) => a.time - b.time);

  // Fall back to all data if range yields too few points
  if (points.length < 2) {
    points = dataPoints.filter(p => p.price > 0).sort((a, b) => a.time - b.time);
  }

  if (points.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough trade data for chart', W / 2, H / 2);
    return;
  }

  const prices = points.map(p => p.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = maxP - minP || 1;

  const pad = { top: 20, right: 20, bottom: 30, left: 60 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const toX = (i) => pad.left + (i / (points.length - 1)) * cW;
  const toY = (p) => pad.top + cH - ((p - minP) / pRange) * cH;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * cH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();

    // Price labels
    const pVal = maxP - (i / 4) * pRange;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(formatPrice(pVal), pad.left - 8, y + 4);
  }

  // Price line gradient
  const isUp = prices[prices.length - 1] >= prices[0];
  const lineColor = isUp ? '#14F195' : '#ff6b6b';
  const gradColor = isUp ? 'rgba(20, 241, 149,' : 'rgba(255, 107, 107,';

  // Area fill
  const gradient = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  gradient.addColorStop(0, gradColor + '0.2)');
  gradient.addColorStop(1, gradColor + '0.0)');

  ctx.beginPath();
  ctx.moveTo(toX(0), H - pad.bottom);
  points.forEach((p, i) => ctx.lineTo(toX(i), toY(p.price)));
  ctx.lineTo(toX(points.length - 1), H - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Price line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0].price));
  points.forEach((p, i) => ctx.lineTo(toX(i), toY(p.price)));
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Current price dot
  const lastPt = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(toX(points.length - 1), toY(lastPt.price), 4, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ── Helpers ──

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatSol(lamportsOrSol) {
  const sol = typeof lamportsOrSol === 'number' ? lamportsOrSol : 0;
  if (sol === 0) return '0 SOL';
  if (sol >= 1000) return `${(sol / 1000).toFixed(1)}K SOL`;
  if (sol >= 1) return `${sol.toFixed(2)} SOL`;
  return `${sol.toFixed(4)} SOL`;
}

function formatPrice(price) {
  if (!price || price === 0) return '0.000000';
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.001) return price.toFixed(6);
  return price.toExponential(3);
}

function formatTokenAmount(amount) {
  if (!amount) return '0';
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(1)}K`;
  return amount.toString();
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
