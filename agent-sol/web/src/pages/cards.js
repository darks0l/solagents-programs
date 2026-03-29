import { api, toast } from '../main.js';

export function renderCards(container, state) {
  container.innerHTML = `
    <div class="section-header">
      <div>
        <h1 class="section-title">Prepaid Cards</h1>
        <p class="section-subtitle">Order Visa/Mastercard prepaid cards • Pay with SOL or SPL tokens</p>
      </div>
    </div>

    <!-- Info -->
    <div class="card info-banner" style="border-left: 3px solid var(--warning); background: rgba(255,170,44,0.06);">
      <div class="flex gap-2 items-center">
        <div style="font-size: 1.5rem;"><img class="icon" src="/icons/white/credit-card.png" alt="Card"></div>
        <div>
          <p class="text-sm"><strong>How it works:</strong> Choose a card type and amount. Pay with SOL, USDC, or other SPL tokens. Card details are delivered securely to your encrypted inbox.</p>
        </div>
      </div>
    </div>

    <!-- Card Options -->
    <div class="grid-3 mt-2">
      <div class="card card-option" data-type="visa-virtual" data-amount="25">
        <div style="font-size: 2.5rem; margin-bottom: 12px;"><img class="icon" src="/icons/white/credit-card.png" alt="Card"></div>
        <h3>Virtual Visa</h3>
        <p class="text-secondary text-sm mb-2">Instant delivery. Use online anywhere Visa is accepted.</p>
        <div class="flex justify-between items-center">
          <span class="stat-value" style="font-size: 1.3rem;">$25</span>
          <span class="text-muted text-sm">+ fees</span>
        </div>
      </div>
      <div class="card card-option" data-type="visa-virtual" data-amount="50">
        <div style="font-size: 2.5rem; margin-bottom: 12px;"><img class="icon" src="/icons/white/credit-card.png" alt="Card"></div>
        <h3>Virtual Visa</h3>
        <p class="text-secondary text-sm mb-2">Instant delivery. Higher limit for bigger purchases.</p>
        <div class="flex justify-between items-center">
          <span class="stat-value" style="font-size: 1.3rem;">$50</span>
          <span class="text-muted text-sm">+ fees</span>
        </div>
      </div>
      <div class="card card-option" data-type="visa-virtual" data-amount="100">
        <div style="font-size: 2.5rem; margin-bottom: 12px;"><img class="icon" src="/icons/white/credit-card.png" alt="Card"></div>
        <h3>Virtual Visa</h3>
        <p class="text-secondary text-sm mb-2">Premium tier. Maximum flexibility for any online purchase.</p>
        <div class="flex justify-between items-center">
          <span class="stat-value" style="font-size: 1.3rem;">$100</span>
          <span class="text-muted text-sm">+ fees</span>
        </div>
      </div>
      <div class="card card-option" data-type="mastercard-virtual" data-amount="25">
        <div style="font-size: 2.5rem; margin-bottom: 12px;"><img class="icon" src="/icons/white/safe.png" alt="Bank"></div>
        <h3>Virtual Mastercard</h3>
        <p class="text-secondary text-sm mb-2">Instant delivery. Accepted at millions of merchants worldwide.</p>
        <div class="flex justify-between items-center">
          <span class="stat-value" style="font-size: 1.3rem;">$25</span>
          <span class="text-muted text-sm">+ fees</span>
        </div>
      </div>
      <div class="card card-option" data-type="mastercard-virtual" data-amount="50">
        <div style="font-size: 2.5rem; margin-bottom: 12px;"><img class="icon" src="/icons/white/safe.png" alt="Bank"></div>
        <h3>Virtual Mastercard</h3>
        <p class="text-secondary text-sm mb-2">Mid-tier balance for everyday online spending.</p>
        <div class="flex justify-between items-center">
          <span class="stat-value" style="font-size: 1.3rem;">$50</span>
          <span class="text-muted text-sm">+ fees</span>
        </div>
      </div>
      <div class="card card-option" data-type="custom" data-amount="custom">
        <div style="font-size: 2.5rem; margin-bottom: 12px;"><img class="icon" src="/icons/white/star.png" alt="Special"></div>
        <h3>Custom Amount</h3>
        <p class="text-secondary text-sm mb-2">Choose your own amount. Visa or Mastercard. $10-$500.</p>
        <div class="flex justify-between items-center">
          <span class="stat-value" style="font-size: 1.3rem;">$10-500</span>
          <span class="text-muted text-sm">+ fees</span>
        </div>
      </div>
    </div>

    <!-- Order Section -->
    <div class="card mt-2" id="order-section" style="display: none;">
      <div class="card-header">
        <span class="card-title">Order Card</span>
        <button class="btn btn-sm btn-ghost" id="btn-cancel-order">✕</button>
      </div>
      <div class="grid-2">
        <div class="input-group">
          <label>Card Type</label>
          <input class="input" id="order-type" readonly />
        </div>
        <div class="input-group">
          <label>Amount (USD)</label>
          <input class="input" id="order-amount" type="number" min="10" max="500" />
        </div>
      </div>
      <div class="input-group">
        <label>Pay With</label>
        <select class="input" id="order-currency">
          <option value="SOL">SOL</option>
          <option value="USDC" selected>USDC</option>
          <option value="USDT">USDT</option>
        </select>
      </div>
      <div class="card mt-1" style="background: rgba(10,10,30,0.4); padding: 12px;">
        <div class="flex justify-between text-sm">
          <span class="text-muted">Card Value</span>
          <span id="order-value">—</span>
        </div>
        <div class="flex justify-between text-sm mt-1">
          <span class="text-muted">Processing Fee</span>
          <span id="order-fee">—</span>
        </div>
        <div class="flex justify-between text-sm mt-1" style="border-top: 1px solid var(--border-glass); padding-top: 8px;">
          <span><strong>Total</strong></span>
          <span id="order-total"><strong>—</strong></span>
        </div>
      </div>
      <button class="btn btn-primary btn-glow w-full mt-2" id="btn-place-order" ${!state.connected ? 'disabled' : ''}>
        ${state.connected ? '<img class="icon" src="/icons/white/credit-card.png" alt="Card"> Place Order' : 'Connect Wallet'}
      </button>
    </div>

    <!-- Order History -->
    <div class="card mt-2">
      <div class="card-header">
        <span class="card-title">Order History</span>
      </div>
      <div id="card-history">
        <div class="empty-state" style="padding: 30px;">
          <div class="empty-state-icon"><img class="icon" src="/icons/white/folder.png" alt="Package"></div>
          <p class="text-sm text-muted">No orders yet</p>
        </div>
      </div>
    </div>

    <!-- FAQ -->
    <div class="card mt-2">
      <div class="card-header">
        <span class="card-title">FAQ</span>
      </div>
      <div class="faq-item">
        <h4>How long does delivery take?</h4>
        <p class="text-secondary text-sm">Virtual cards are delivered instantly to your encrypted SolAgents inbox after payment confirmation.</p>
      </div>
      <div class="faq-item mt-2">
        <h4>What can I use the cards for?</h4>
        <p class="text-secondary text-sm">Online purchases anywhere Visa/Mastercard is accepted. Subscriptions, services, digital goods — anything online.</p>
      </div>
      <div class="faq-item mt-2">
        <h4>Is there KYC?</h4>
        <p class="text-secondary text-sm">No KYC for virtual prepaid cards up to $100. Higher amounts may require additional verification depending on the provider.</p>
      </div>
      <div class="faq-item mt-2">
        <h4>What are the fees?</h4>
        <p class="text-secondary text-sm">A small processing fee (3-5%) covers provider costs and network fees. The exact amount is shown before you confirm.</p>
      </div>
    </div>
  `;

  // Wire card selection
  container.querySelectorAll('.card-option').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      const type = card.dataset.type;
      const amount = card.dataset.amount;
      const orderSection = document.getElementById('order-section');
      orderSection.style.display = 'block';
      document.getElementById('order-type').value = type;
      document.getElementById('order-amount').value = amount === 'custom' ? '' : amount;
      orderSection.scrollIntoView({ behavior: 'smooth' });
    });
  });

  container.querySelector('#btn-cancel-order')?.addEventListener('click', () => {
    document.getElementById('order-section').style.display = 'none';
  });

  // Load order history
  if (state.connected) loadCardHistory(state);

  container.querySelector('#btn-place-order')?.addEventListener('click', async () => {
    if (!state.connected) return toast('Connect wallet first', 'error');

    const cardType = document.getElementById('order-type')?.value;
    const amount = parseInt(document.getElementById('order-amount')?.value);
    const currency = document.getElementById('order-currency')?.value || 'USDC';

    if (!cardType || !amount || amount < 10 || amount > 500) {
      return toast('Please select a valid card and amount ($10-$500)', 'error');
    }

    const btn = container.querySelector('#btn-place-order');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
      const result = await api.post('/cards/order', {
        cardType: cardType.replace('-virtual', ''),
        denomination: amount,
        currency: 'USD',
        paymentToken: currency,
        paymentTx: 'pending', // TODO: actual payment tx
      });

      if (result.error) {
        toast(result.error, 'error');
      } else {
        toast(`<img class="icon" src="/icons/white/checkmark.png" alt="Yes"> Card order submitted! Order ID: ${result.orderId}`, 'success');
        loadCardHistory(state);
      }
    } catch (err) {
      toast(`Order failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '<img class="icon" src="/icons/white/credit-card.png" alt="Card"> Place Order';
    }
  });
}

async function loadCardHistory(state) {
  const historyEl = document.getElementById('card-history');
  if (!historyEl || !state.connected) return;

  try {
    const data = await api.get('/cards');
    const orders = data?.orders || [];

    if (orders.length === 0) {
      historyEl.innerHTML = `
        <div class="empty-state" style="padding: 30px;">
          <div class="empty-state-icon"><img class="icon" src="/icons/white/folder.png" alt="Package"></div>
          <p class="text-sm text-muted">No orders yet</p>
        </div>
      `;
      return;
    }

    historyEl.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Order ID</th>
              <th style="padding:10px;text-align:left;color:var(--text-muted)">Type</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Amount</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Status</th>
              <th style="padding:10px;text-align:right;color:var(--text-muted)">Date</th>
            </tr>
          </thead>
          <tbody>
            ${orders.map(o => `
              <tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
                <td style="padding:10px;font-family:var(--font-mono);font-size:0.8rem">${o.orderId?.slice(0, 16) || '—'}...</td>
                <td style="padding:10px">${o.cardType || '—'}</td>
                <td style="padding:10px;text-align:right">$${o.amount || '0'}</td>
                <td style="padding:10px;text-align:right">
                  <span style="padding:2px 8px;border-radius:8px;font-size:0.8rem;background:${
                    o.status === 'completed' ? 'rgba(20,241,149,0.15);color:#14F195' :
                    o.status === 'failed' ? 'rgba(255,68,68,0.15);color:#FF4444' :
                    'rgba(255,170,44,0.15);color:#FFAA2C'
                  }">${o.status || 'pending'}</span>
                </td>
                <td style="padding:10px;text-align:right;font-size:0.8rem;color:var(--text-muted)">${o.createdAt ? new Date(o.createdAt * 1000).toLocaleDateString() : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch {
    // Auth required or API unavailable — keep empty state
  }
}
