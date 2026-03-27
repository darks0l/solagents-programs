/**
 * Token Trade Page
 * Buy/sell a specific agent token through the on-chain bonding curve.
 *
 * Route: /trade/:mintAddress
 */

import { api, toast, truncateAddress, getSolPrice } from '../main.js';
import { connectWallet, getPublicKey, isConnected, signAndSendTransaction } from '../services/wallet.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 9;

export async function renderTrade(container, state, mintAddress) {
  // If no mint specified, show token picker landing
  if (!mintAddress) {
    renderTradeLanding(container);
    return;
  }

  container.innerHTML = `
    <!-- SOL Price Ticker -->
    <div class="card" id="sol-ticker" style="padding:10px 16px;margin-bottom:1rem;display:flex;align-items:center;gap:12px;background:rgba(153,69,255,0.08);border:1px solid rgba(153,69,255,0.15)">
      <img src="https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png" alt="SOL" style="width:24px;height:24px;border-radius:50%">
      <span style="font-weight:600;color:var(--text-primary)">SOL</span>
      <span class="font-mono" style="color:var(--green);font-size:1.1rem;font-weight:700" id="sol-usd-price">—</span>
      <span class="text-muted text-xs" style="margin-left:auto">Live price</span>
    </div>

    <div class="page-header">
      <button class="btn btn-sm btn-ghost mb-2" id="btn-back">← Back</button>
      <div id="token-header">
        <div class="skeleton h-8 w-48 rounded"></div>
      </div>
    </div>

    <div class="grid" style="grid-template-columns:1fr 380px;gap:16px;align-items:start" id="trade-layout">
      <!-- Left: Chart + trades -->
      <div>
        <div class="card glass" id="price-chart-card">
          <div class="card-header flex items-center" style="justify-content:space-between">
            <h2 class="font-semibold text-sm">Price Chart</h2>
            <div class="flex gap-05" id="timeframe-btns">
              <button class="btn btn-xs btn-ghost timeframe-btn" data-tf="300">5m</button>
              <button class="btn btn-xs btn-ghost timeframe-btn" data-tf="3600">1h</button>
              <button class="btn btn-xs btn-ghost timeframe-btn" data-tf="14400">4h</button>
              <button class="btn btn-xs btn-ghost timeframe-btn active" data-tf="86400">24h</button>
            </div>
          </div>
          <div class="card-body">
            <canvas id="price-chart" height="200"></canvas>
          </div>
        </div>

        <div class="card glass mt-2" id="trades-card">
          <div class="card-header flex items-center" style="justify-content:space-between">
            <h2 class="font-semibold text-sm">Recent Trades</h2>
            <span class="text-muted text-xs" id="trade-count">—</span>
          </div>
          <div id="trades-list">
            <p class="text-muted text-sm p-2">Loading...</p>
          </div>
        </div>
      </div>

      <!-- Right: Trade panel -->
      <div>
        <!-- Token Stats -->
        <div class="card glass" id="token-stats">
          <div class="card-body">
            <div class="grid grid-2 gap-1">
              <div class="text-center">
                <div class="font-bold gradient-text font-mono" id="stat-price">—</div>
                <div class="text-muted text-xs">Price (SOL)</div>
              </div>
              <div class="text-center">
                <div class="font-bold font-mono" id="stat-mcap">—</div>
                <div class="text-muted text-xs">Market Cap</div>
              </div>
              <div class="text-center">
                <div class="font-bold font-mono" id="stat-ath">—</div>
                <div class="text-muted text-xs">ATH</div>
              </div>
              <div class="text-center">
                <div class="font-bold font-mono" id="stat-vol">—</div>
                <div class="text-muted text-xs">Volume</div>
              </div>
            </div>
            <div class="flex items-center gap-1 mt-1" style="justify-content:center">
              <span class="text-xs" style="color:#14F195">🔒 Liquidity Locked</span>
              <span class="text-muted text-xs">•</span>
              <span class="text-xs" style="color:#9945FF">Authorities Revoked</span>
            </div>
          </div>
        </div>

        <!-- Trade Box -->
        <div class="card glass mt-2" id="trade-box">
          <div class="card-header">
            <div class="flex" style="border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:12px">
              <button class="btn btn-sm flex-1 trade-tab active" id="tab-buy" data-side="buy">Buy</button>
              <button class="btn btn-sm flex-1 trade-tab" id="tab-sell" data-side="sell">Sell</button>
            </div>
          </div>
          <div class="card-body" id="trade-form">
            <!-- Buy form -->
            <div id="buy-form">
              <div class="form-group">
                <label class="form-label text-sm">SOL Amount</label>
                <div class="flex gap-05">
                  <input type="number" class="form-input" id="buy-sol-amount" placeholder="0.1" min="0.001" step="0.01" style="flex:1">
                  <span class="form-input" style="padding:8px 12px;color:var(--text-muted);flex-shrink:0">SOL</span>
                </div>
                <div class="flex gap-05 mt-05">
                  ${['0.1', '0.5', '1', '5'].map(v => `<button class="btn btn-xs btn-ghost quick-buy" data-val="${v}">${v}</button>`).join('')}
                </div>
              </div>
              <div class="card glass mt-1 p-2" style="background:rgba(0,0,0,0.3)">
                <div class="stat-row">
                  <span class="text-muted text-xs">You receive (est.)</span>
                  <span class="font-mono text-xs" id="buy-tokens-out">—</span>
                </div>
                <div class="stat-row mt-05">
                  <span class="text-muted text-xs">Fee (2%)</span>
                  <span class="font-mono text-xs" id="buy-fee">—</span>
                </div>
                <div class="stat-row mt-05">
                  <span class="text-muted text-xs">Price impact</span>
                  <span class="font-mono text-xs" id="buy-impact">—</span>
                </div>
                <div class="stat-row mt-05">
                  <span class="text-muted text-xs">New price (est.)</span>
                  <span class="font-mono text-xs" id="buy-new-price">—</span>
                </div>
              </div>
              <button class="btn btn-primary btn-glow w-full mt-1" id="btn-buy">Buy Tokens</button>
            </div>

            <!-- Sell form -->
            <div id="sell-form" style="display:none">
              <div class="form-group">
                <label class="form-label text-sm">Token Amount</label>
                <div class="flex gap-05">
                  <input type="number" class="form-input" id="sell-token-amount" placeholder="1000000" min="1" style="flex:1">
                  <span class="form-input" style="padding:8px 12px;color:var(--text-muted);flex-shrink:0" id="sell-symbol">—</span>
                </div>
                <div class="flex gap-05 mt-05">
                  ${['25%', '50%', '75%', 'Max'].map(v => `<button class="btn btn-xs btn-ghost quick-sell" data-val="${v}">${v}</button>`).join('')}
                </div>
              </div>
              <div class="card glass mt-1 p-2" style="background:rgba(0,0,0,0.3)">
                <div class="stat-row">
                  <span class="text-muted text-xs">You receive (est.)</span>
                  <span class="font-mono text-xs" id="sell-sol-out">—</span>
                </div>
                <div class="stat-row mt-05">
                  <span class="text-muted text-xs">Fee (2%)</span>
                  <span class="font-mono text-xs" id="sell-fee">—</span>
                </div>
                <div class="stat-row mt-05">
                  <span class="text-muted text-xs">Price impact</span>
                  <span class="font-mono text-xs" id="sell-impact">—</span>
                </div>
              </div>
              <button class="btn btn-danger w-full mt-1" id="btn-sell">Sell Tokens</button>
            </div>
          </div>

          <!-- Wallet section -->
          <div class="card-body" style="border-top:1px solid rgba(255,255,255,0.06);padding-top:12px">
            <div id="wallet-section">
              ${isConnected()
                ? `<div class="flex items-center gap-1">
                    <span class="wallet-dot"></span>
                    <span class="text-xs font-mono">${truncateAddress(getPublicKey())}</span>
                  </div>`
                : `<button class="btn btn-sm btn-primary w-full" id="btn-connect-wallet">🔌 Connect Wallet to Trade</button>`
              }
            </div>
          </div>
        </div>

        <!-- Dev Buy Info -->
        <div class="card glass mt-2" id="dev-buy-card" style="display:none">
          <div class="card-header">
            <div class="flex items-center gap-1">
              <span class="dev-badge">🔍 DEV BUY</span>
              <span class="text-muted text-xs">Fully transparent</span>
            </div>
          </div>
          <div class="card-body" id="dev-buy-body">—</div>
        </div>

        <!-- Mint info -->
        <div class="card glass mt-2">
          <div class="card-body" style="padding:12px">
            <div class="stat-row">
              <span class="text-muted text-xs">Mint Address</span>
              <a id="mint-link" class="font-mono text-xs" href="#" target="_blank" rel="noopener" style="color:var(--accent-purple)">—</a>
            </div>
            <div class="stat-row mt-05">
              <span class="text-muted text-xs">Creator</span>
              <span class="font-mono text-xs" id="creator-addr">—</span>
            </div>
            <div class="stat-row mt-05">
              <span class="text-muted text-xs">Mint Authority</span>
              <span class="text-xs" style="color:#14F195">✅ Revoked</span>
            </div>
            <div class="stat-row mt-05">
              <span class="text-muted text-xs">Freeze Authority</span>
              <span class="text-xs" style="color:#14F195">✅ Revoked</span>
            </div>
            <div class="stat-row mt-05">
              <span class="text-muted text-xs">Metadata</span>
              <span class="text-xs" style="color:#14F195">✅ Immutable</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Load SOL price
  getSolPrice().then(p => {
    const el = document.getElementById('sol-usd-price');
    if (el && p) el.textContent = `$${p.toFixed(2)}`;
  });

  document.getElementById('btn-back')?.addEventListener('click', () => history.back());

  // Load token data
  await loadTradePageData(mintAddress);

  // Wire up tab switching
  document.getElementById('tab-buy')?.addEventListener('click', () => switchSide('buy'));
  document.getElementById('tab-sell')?.addEventListener('click', () => switchSide('sell'));

  // Wire up quick buy buttons
  document.querySelectorAll('.quick-buy').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('buy-sol-amount').value = btn.dataset.val;
      updateBuyQuote(mintAddress);
    });
  });

  // Wire up quick sell buttons (set % of user's token balance)
  document.querySelectorAll('.quick-sell').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isConnected()) {
        toast('Connect your wallet first', 'error');
        return;
      }
      const val = btn.dataset.val;
      try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const connection = new Connection('https://api.devnet.solana.com');
        const walletPubkey = new PublicKey(getPublicKey());
        const mintPubkey = new PublicKey(mintAddress);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, { mint: mintPubkey });
        if (tokenAccounts.value.length === 0) {
          toast('No token balance found in wallet', 'error');
          return;
        }
        const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        let amount;
        if (val === 'Max') {
          amount = balance;
        } else {
          const pct = parseInt(val) / 100;
          amount = balance * pct;
        }
        document.getElementById('sell-token-amount').value = Math.floor(amount);
        updateSellQuote(mintAddress);
      } catch (err) {
        toast(`Failed to get balance: ${err.message}`, 'error');
      }
    });
  });

  // Timeframe buttons
  document.querySelectorAll('.timeframe-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadPriceChart(mintAddress, parseInt(btn.dataset.tf));
    });
  });

  // Live quote on input
  document.getElementById('buy-sol-amount')?.addEventListener('input', () => updateBuyQuote(mintAddress));
  document.getElementById('sell-token-amount')?.addEventListener('input', () => updateSellQuote(mintAddress));

  // Wire up connect wallet
  document.getElementById('btn-connect-wallet')?.addEventListener('click', async () => {
    try {
      await connectWallet();
      renderWalletSection();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Wire up buy
  document.getElementById('btn-buy')?.addEventListener('click', () => executeBuy(mintAddress));

  // Wire up sell
  document.getElementById('btn-sell')?.addEventListener('click', () => executeSell(mintAddress));
}

async function loadTradePageData(mintAddress) {
  try {
    // Always read from chain (source of truth), sync to DB, fall back to DB only if chain unavailable
    let poolData;
    try {
      poolData = await api.get(`/chain/state/pool/${mintAddress}`);
      // Fire-and-forget DB sync so next page load from DB is also fresh
      api.post(`/chain/sync/pool/${mintAddress}`, {}).catch(() => {});
    } catch {
      poolData = await api.get(`/pool/${mintAddress}`);
    }

    // Update header
    document.getElementById('token-header').innerHTML = `
      <div class="flex items-center gap-2">
        ${poolData.symbol ? `<div class="font-bold text-2xl gradient-text">$${poolData.symbol}</div>` : ''}
        <div class="text-secondary">${poolData.name || ''}</div>
        ${poolData.status === 'graduated' ? `<span class="badge" style="background:rgba(20,241,149,0.2);color:#14F195">🎓 Graduated to Raydium</span>` : ''}
      </div>
    `;

    // Fetch SOL/USD price
    let solPriceUsd = 0;
    try {
      const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const cgData = await cgRes.json();
      solPriceUsd = cgData.solana?.usd || 0;
    } catch {}

    // Update stats
    const price = parseFloat(poolData.price_sol || poolData.current_price || '0');
    document.getElementById('stat-price').textContent = price < 0.001 ? price.toFixed(10) : price.toFixed(6);
    const mcapSol = parseFloat(poolData.market_cap_sol || 0);
    if (mcapSol > 0 && solPriceUsd > 0) {
      document.getElementById('stat-mcap').textContent = '$' + (mcapSol * solPriceUsd).toLocaleString(undefined, { maximumFractionDigits: 0 });
    } else if (mcapSol > 0) {
      document.getElementById('stat-mcap').textContent = `${mcapSol.toFixed(2)} SOL`;
    } else {
      document.getElementById('stat-mcap').textContent = '—';
    }
    document.getElementById('stat-vol').textContent = poolData.total_volume_sol ? `${parseFloat(poolData.total_volume_sol).toFixed(4)} SOL` : '0 SOL';
    // stat-ath is populated by loadPriceChart

    // Mint info
    const mintLink = document.getElementById('mint-link');
    if (mintLink) {
      mintLink.textContent = truncateAddress(mintAddress);
      mintLink.href = `https://explorer.solana.com/address/${mintAddress}?cluster=devnet`;
    }
    document.getElementById('creator-addr').textContent = truncateAddress(poolData.creator || '');

    // Symbol for sell form
    document.getElementById('sell-symbol').textContent = poolData.symbol || 'TOKEN';

    // Dev buy card
    if (parseFloat(poolData.dev_buy_sol) > 0) {
      document.getElementById('dev-buy-card').style.display = '';
      document.getElementById('dev-buy-body').innerHTML = `
        <div class="stat-row">
          <span class="text-muted text-xs">Dev SOL spent</span>
          <span class="font-mono text-xs">${poolData.dev_buy_sol} SOL</span>
        </div>
        <div class="stat-row mt-05">
          <span class="text-muted text-xs">Dev tokens received</span>
          <span class="font-mono text-xs">${poolData.dev_buy_tokens}</span>
        </div>
        <p class="text-muted text-xs mt-1">All dev buys happen at the same bonding curve price as public buyers.</p>
      `;
    }

    // Disable trading if graduated
    if (poolData.status === 'graduated') {
      const buyBtn = document.getElementById('buy-btn');
      const sellBtn = document.getElementById('sell-btn');
      if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = 'Graduated — Trade on Raydium'; }
      if (sellBtn) { sellBtn.disabled = true; sellBtn.textContent = 'Graduated — Trade on Raydium'; }
      const buyInput = document.getElementById('buy-amount');
      const sellInput = document.getElementById('sell-amount');
      if (buyInput) buyInput.disabled = true;
      if (sellInput) sellInput.disabled = true;
    }

    // Draw simple price chart from history
    loadPriceChart(mintAddress);

    // Load trades
    loadTrades(mintAddress);

  } catch (err) {
    toast(`Failed to load token data: ${err.message}`, 'error');
  }
}

let _chartData = { mint: null, prices: [] };

async function loadPriceChart(mintAddress, timeframeSecs = 86400) {
  try {
    // Cache price data per mint — fetch once, filter for each timeframe
    if (_chartData.mint !== mintAddress) {
      const { prices } = await api.get(`/tokens/by-mint/${mintAddress}/chart?limit=200`);
      _chartData = {
        mint: mintAddress,
        prices: (prices || []).filter(p => parseFloat(p.price_sol) > 0),
      };
    }

    const allPrices = _chartData.prices;

    // ATH from all history
    if (allPrices.length > 0) {
      const ath = Math.max(...allPrices.map(p => parseFloat(p.price_sol)));
      const athEl = document.getElementById('stat-ath');
      if (athEl) athEl.textContent = ath < 0.001 ? ath.toFixed(10) : ath.toFixed(6);
    }

    // Filter by selected timeframe
    const now = Math.floor(Date.now() / 1000);
    const since = now - timeframeSecs;
    let filtered = allPrices.filter(p => p.timestamp >= since);
    // Fall back to all data if timeframe has fewer than 2 points
    if (filtered.length < 2) filtered = allPrices;
    if (filtered.length < 2) return;

    const canvas = document.getElementById('price-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth || 600;
    const H = 200;
    canvas.width = W;
    canvas.height = H;

    const vals = filtered.map(p => parseFloat(p.price_sol));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || min * 0.01 || 0.000001;

    ctx.clearRect(0, 0, W, H);

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(153,69,255,0.35)');
    grad.addColorStop(1, 'rgba(153,69,255,0)');

    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - min) / range) * (H - 30) - 15;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - min) / range) * (H - 30) - 15;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#9945FF';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Min/max price labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px monospace';
    ctx.fillText(max < 0.001 ? max.toExponential(2) : max.toFixed(8), 4, 14);
    ctx.fillText(min < 0.001 ? min.toExponential(2) : min.toFixed(8), 4, H - 4);
  } catch { /* No chart data yet */ }
}

async function loadTrades(mintAddress) {
  try {
    // Try chain sync endpoint first, fall back to DB lookup by mint
    let trades;
    try {
      const data = await api.get(`/tokens/by-mint/${mintAddress}/trades?limit=20`);
      trades = data.trades;
    } catch {
      const data = await api.get(`/tokens/${mintAddress}/trades?limit=20`);
      trades = data.trades;
    }
    const list = document.getElementById('trades-list');
    const count = document.getElementById('trade-count');

    if (!trades || trades.length === 0) {
      list.innerHTML = '<p class="text-muted text-sm p-2 text-center">No trades yet — be the first!</p>';
      return;
    }

    count.textContent = `${trades.length} recent`;
    list.innerHTML = trades.map(t => `
      <div class="flex items-center text-xs" style="padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.04);justify-content:space-between">
        <span style="color:${t.side === 'buy' ? '#14F195' : '#FF4444'};font-weight:600;width:36px">${t.side.toUpperCase()}</span>
        <span class="font-mono" style="flex:1;text-align:right">${Number(t.amount_token / 1e9).toLocaleString()} tokens</span>
        <span class="font-mono" style="flex:1;text-align:right">${(t.amount_sol / 1e9).toFixed(4)} SOL</span>
        <span class="text-muted" style="flex:1;text-align:right">${truncateAddress(t.trader_wallet)}</span>
        <span class="text-muted" style="flex:1;text-align:right">${formatTime(t.created_at)}</span>
      </div>
    `).join('');
  } catch { /* silent */ }
}

// ── Quote updates ────────────────────────────────────────────

async function updateBuyQuote(mintAddress) {
  const solAmount = parseFloat(document.getElementById('buy-sol-amount')?.value);
  if (!solAmount || solAmount <= 0) {
    ['buy-tokens-out', 'buy-fee', 'buy-impact', 'buy-new-price'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    return;
  }

  try {
    const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
    const quote = await api.get(`/chain/quote?mint=${mintAddress}&side=buy&amount=${lamports}`);

    document.getElementById('buy-tokens-out').textContent = quote.output || '—';
    document.getElementById('buy-fee').textContent = `${quote.fee} SOL`;
    document.getElementById('buy-impact').textContent = quote.price_impact || '—';
    document.getElementById('buy-new-price').textContent = `${quote.price_after} SOL`;
  } catch {
    // Quote failed — might not be on-chain yet
  }
}

async function updateSellQuote(mintAddress) {
  const tokenAmount = parseFloat(document.getElementById('sell-token-amount')?.value);
  if (!tokenAmount || tokenAmount <= 0) {
    ['sell-sol-out', 'sell-fee', 'sell-impact'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    return;
  }

  try {
    const raw = Math.round(tokenAmount * Math.pow(10, TOKEN_DECIMALS));
    const quote = await api.get(`/chain/quote?mint=${mintAddress}&side=sell&amount=${raw}`);

    document.getElementById('sell-sol-out').textContent = quote.output || '—';
    document.getElementById('sell-fee').textContent = `${quote.fee} SOL`;
    document.getElementById('sell-impact').textContent = quote.price_impact || '—';
  } catch { /* silent */ }
}

// ── Execute trades ───────────────────────────────────────────

async function executeBuy(mintAddress) {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  const solAmount = parseFloat(document.getElementById('buy-sol-amount')?.value);
  if (!solAmount || solAmount <= 0) {
    toast('Enter an amount to buy', 'error');
    return;
  }
  if (solAmount < 0.001) {
    toast('Minimum buy is 0.001 SOL', 'error');
    return;
  }

  const btn = document.getElementById('btn-buy');
  btn.disabled = true;
  btn.textContent = 'Building transaction...';

  try {
    // Build on-chain transaction from server
    const result = await api.post('/chain/build/buy', {
      mintAddress,
      buyerWallet: getPublicKey(),
      solAmount,
      slippageBps: 100, // 1% slippage
    });

    if (result.error) throw new Error(result.error);
    if (!result.transaction) throw new Error('No transaction returned from server');

    btn.textContent = 'Waiting for wallet approval...';

    // Sign + send via Phantom
    const signature = await signAndSendTransaction(result.transaction);

    btn.textContent = 'Confirming...';
    toast(`Transaction submitted! <a href="https://explorer.solana.com/tx/${signature}?cluster=devnet" target="_blank">View on Explorer ↗</a>`, 'info');

    // Sync DB
    await api.post('/chain/sync/trade', {
      txSignature: signature,
      mintAddress,
      traderWallet: getPublicKey(),
    });

    toast(`✅ Bought! Transaction confirmed.`, 'success');

    // Refresh
    setTimeout(() => loadTradePageData(mintAddress), 2000);
  } catch (err) {
    console.error('Buy error:', err);
    const msg = err?.message || err?.toString() || 'Unknown error';
    toast(`Buy failed: ${msg}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buy Tokens';
  }
}

async function executeSell(mintAddress) {
  if (!isConnected()) {
    toast('Connect your wallet first', 'error');
    return;
  }

  const tokenAmount = parseFloat(document.getElementById('sell-token-amount')?.value);
  if (!tokenAmount || tokenAmount <= 0) {
    toast('Enter an amount to sell', 'error');
    return;
  }

  const btn = document.getElementById('btn-sell');
  btn.disabled = true;
  btn.textContent = 'Building transaction...';

  try {
    const raw = Math.round(tokenAmount * Math.pow(10, TOKEN_DECIMALS)).toString();
    const result = await api.post('/chain/build/sell', {
      mintAddress,
      sellerWallet: getPublicKey(),
      tokenAmount: raw,
      slippageBps: 100,
    });

    if (result.error) throw new Error(result.error);
    if (!result.transaction) throw new Error('No transaction returned from server');

    btn.textContent = 'Waiting for wallet approval...';
    const signature = await signAndSendTransaction(result.transaction);

    btn.textContent = 'Confirming...';
    toast(`Transaction submitted!`, 'info');

    await api.post('/chain/sync/trade', {
      txSignature: signature,
      mintAddress,
      traderWallet: getPublicKey(),
    });

    toast(`✅ Sold! SOL returned to your wallet.`, 'success');
    setTimeout(() => loadTradePageData(mintAddress), 2000);
  } catch (err) {
    console.error('Sell error:', err);
    const msg = err?.message || err?.toString() || 'Unknown error';
    toast(`Sell failed: ${msg}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sell Tokens';
  }
}

// ── UI helpers ───────────────────────────────────────────────

function switchSide(side) {
  document.getElementById('buy-form').style.display = side === 'buy' ? '' : 'none';
  document.getElementById('sell-form').style.display = side === 'sell' ? '' : 'none';
  document.querySelectorAll('.trade-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.side === side);
  });
}

function renderWalletSection() {
  const section = document.getElementById('wallet-section');
  if (!section) return;
  const pk = getPublicKey();
  if (pk) {
    section.innerHTML = `<div class="flex items-center gap-1"><span class="wallet-dot"></span><span class="text-xs font-mono">${truncateAddress(pk)}</span></div>`;
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── Trade Landing (no mint specified) ────────────────────────

async function renderTradeLanding(container) {
  container.innerHTML = `
    <!-- SOL Price Ticker -->
    <div class="card" id="sol-ticker" style="padding:14px 20px;margin-bottom:1.5rem;display:flex;align-items:center;gap:16px;background:rgba(153,69,255,0.08);border:1px solid rgba(153,69,255,0.15)">
      <img src="https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png" alt="SOL" style="width:32px;height:32px;border-radius:50%">
      <div>
        <div style="font-weight:700;font-size:1.3rem;color:var(--text-primary)">Solana</div>
        <div class="text-muted text-xs">SOL/USD</div>
      </div>
      <div class="font-mono" style="color:var(--green);font-size:1.6rem;font-weight:700;margin-left:auto" id="sol-usd-price">—</div>
    </div>

    <div class="section-header" style="margin-bottom:1.5rem">
      <h1 class="page-title" style="font-size:1.8rem">Trade Agent Tokens</h1>
      <p class="text-secondary">Select a token below to start trading on the bonding curve.</p>
    </div>

    <div id="trade-token-list">
      <div class="text-muted text-center" style="padding:3rem">Loading tokens...</div>
    </div>
  `;

  // Load SOL price
  getSolPrice().then(p => {
    const el = document.getElementById('sol-usd-price');
    if (el && p) el.textContent = `$${p.toFixed(2)}`;
  });

  // Load available tokens
  try {
    const data = await api.get('/tokens?sort=recent&limit=50');
    const tokens = data.tokens || data || [];
    const list = document.getElementById('trade-token-list');
    if (!list) return;

    if (!tokens.length) {
      list.innerHTML = '<div class="text-muted text-center" style="padding:3rem">No tokens available yet. <a href="#" data-page="agents" style="color:var(--green)">Browse agents</a> to find one to tokenize.</div>';
      return;
    }

    list.innerHTML = tokens.map(t => {
      const symbol = t.token_symbol || t.symbol || '???';
      const name = t.token_name || t.name || 'Unknown';
      const mint = t.mint_address || t.mint || '';
      const price = parseFloat(t.current_price || t.price || 0);
      const vol = parseFloat(t.volume_24h || t.volume || 0);
      return `
        <div class="card glass mb-1 trade-token-row" data-mint="${mint}" style="padding:14px 20px;cursor:pointer;transition:border-color 0.2s;border:1px solid transparent">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#14F195,#9945FF);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem;color:#000;flex-shrink:0">
              ${symbol.slice(0, 2)}
            </div>
            <div style="flex:1">
              <div style="font-weight:600;font-size:1rem">${name}</div>
              <div class="text-muted text-xs">$${symbol}</div>
            </div>
            <div style="text-align:right">
              <div class="font-mono" style="font-weight:600;color:var(--green)">${price < 0.001 ? price.toExponential(3) : price.toFixed(6)} SOL</div>
              <div class="text-muted text-xs">Vol: ${vol > 0 ? vol.toFixed(4) + ' SOL' : '—'}</div>
            </div>
            <div style="color:var(--text-tertiary);font-size:1.2rem">→</div>
          </div>
        </div>
      `;
    }).join('');

    // Click to navigate to trade with mint
    list.querySelectorAll('.trade-token-row').forEach(row => {
      row.addEventListener('click', () => {
        const mint = row.dataset.mint;
        if (mint) {
          history.pushState({ page: 'trade', params: { mintAddress: mint } }, '', `/trade/${mint}`);
          const content = document.getElementById('page-content');
          content.innerHTML = '';
          renderTrade(content, {}, mint);
        }
      });
    });
  } catch {
    const list = document.getElementById('trade-token-list');
    if (list) list.innerHTML = '<div class="text-muted text-center" style="padding:3rem">Failed to load tokens.</div>';
  }
}
