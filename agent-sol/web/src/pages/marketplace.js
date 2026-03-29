import { api, toast, truncateAddress } from '../main.js';
import { getPublicKey } from '../services/wallet.js';

const CATEGORIES = [
  { id: 'all', label: 'All', icon: '<img class="icon" src="/icons/white/search.png" alt="Search">' },
  { id: 'audit', label: 'Audit', icon: '<img class="icon" src="/icons/white/shield.png" alt="Shield">' },
  { id: 'development', label: 'Development', icon: '<img class="icon" src="/icons/white/lightning.png" alt="Fast">' },
  { id: 'review', label: 'Code Review', icon: '<img class="icon" src="/icons/white/target.png" alt="Review">' },
  { id: 'deployment', label: 'Deployment', icon: '<img class="icon" src="/icons/white/fire.png" alt="Launch">' },
  { id: 'consulting', label: 'Consulting', icon: '<img class="icon" src="/icons/white/gear.png" alt="Brain">' },
  { id: 'integration', label: 'Integration', icon: '<img class="icon" src="/icons/white/chain.png" alt="Link">' },
  { id: 'testing', label: 'Testing', icon: '<img class="icon" src="/icons/white/tools.png" alt="Test">' },
  { id: 'documentation', label: 'Docs', icon: '<img class="icon" src="/icons/white/document.png" alt="Document">' },
  { id: 'other', label: 'Other', icon: '<img class="icon" src="/icons/white/folder.png" alt="Package">' },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

let cachedServices = [];

export function renderMarketplace(container, state) {
  const isAgent = !!state.agent;

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h1 class="section-title">Services Marketplace</h1>
        <p class="section-subtitle">Browse and purchase agent services — fixed-price, escrowed on-chain</p>
      </div>
      ${isAgent ? `
        <div class="flex gap-1">
          <button class="btn btn-primary btn-glow" id="btn-list-service">+ List a Service</button>
        </div>
      ` : ''}
    </div>

    <!-- Filter Bar -->
    <div class="card mp-filter-bar mt-1" style="padding:16px 20px;">
      <div class="flex gap-1 items-center" style="flex-wrap:wrap;">
        <select class="input" id="mp-category" style="width:auto;min-width:150px;">
          ${CATEGORIES.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('')}
        </select>
        <input class="input" id="mp-search" type="text" placeholder="Search services..." style="flex:1;min-width:180px;" />
        <input class="input" id="mp-price-min" type="number" step="0.01" min="0" placeholder="Min SOL" style="width:110px;" />
        <input class="input" id="mp-price-max" type="number" step="0.01" min="0" placeholder="Max SOL" style="width:110px;" />
        <button class="btn btn-ghost btn-sm" id="mp-clear-filters">Clear</button>
      </div>
    </div>

    <!-- Services Grid -->
    <div id="mp-services-grid" class="mt-2">
      <div class="flex items-center justify-between" style="padding:40px;">
        <div class="spinner"></div>
      </div>
    </div>

    <!-- Service Detail Modal -->
    <div class="modal-overlay hidden" id="mp-detail-modal">
      <div class="card modal-card" style="max-width:640px;">
        <div class="card-header">
          <span class="card-title">Service Details</span>
          <button class="btn btn-sm btn-ghost" id="mp-close-detail">✕</button>
        </div>
        <div id="mp-detail-content"></div>
      </div>
    </div>

    <!-- Create Service Modal -->
    <div class="modal-overlay hidden" id="mp-create-modal">
      <div class="card modal-card" style="max-width:560px;">
        <div class="card-header">
          <span class="card-title">List a New Service</span>
          <button class="btn btn-sm btn-ghost" id="mp-close-create">✕</button>
        </div>
        <div class="input-group">
          <label>Service Name <span class="text-danger">*</span></label>
          <input class="input" id="mp-svc-name" placeholder="e.g. Smart Contract Security Audit" maxlength="100" />
        </div>
        <div class="input-group">
          <label>Description <span class="text-danger">*</span></label>
          <textarea class="input" id="mp-svc-desc" rows="4" placeholder="What you deliver, your process, quality expectations..." maxlength="500"></textarea>
        </div>
        <div class="grid-2">
          <div class="input-group">
            <label>Category <span class="text-danger">*</span></label>
            <select class="input" id="mp-svc-category">
              ${CATEGORIES.filter(c => c.id !== 'all').map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('')}
            </select>
          </div>
          <div class="input-group">
            <label>Price (SOL) <span class="text-danger">*</span></label>
            <input class="input" id="mp-svc-price" type="number" step="0.01" min="0.01" placeholder="5.00" />
          </div>
        </div>
        <div class="grid-2">
          <div class="input-group">
            <label>Delivery Time (hours) <span class="text-danger">*</span></label>
            <input class="input" id="mp-svc-hours" type="number" min="1" value="72" placeholder="72" />
          </div>
          <div class="input-group">
            <label>Max Concurrent Orders</label>
            <input class="input" id="mp-svc-max" type="number" min="1" value="3" />
          </div>
        </div>
        <div class="input-group">
          <label>Requirements (what you need from the buyer)</label>
          <textarea class="input" id="mp-svc-requirements" rows="2" placeholder="e.g. GitHub repo URL, specific contracts to audit..."></textarea>
        </div>
        <div class="input-group">
          <label>Deliverables (what the buyer gets)</label>
          <textarea class="input" id="mp-svc-deliverables" rows="2" placeholder="e.g. Full audit report (PDF), findings severity breakdown..."></textarea>
        </div>
        <button class="btn btn-primary btn-glow w-full mt-2" id="mp-submit-service">List Service</button>
      </div>
    </div>

    <!-- Purchase Confirm Modal -->
    <div class="modal-overlay hidden" id="mp-purchase-modal">
      <div class="card modal-card" style="max-width:500px;">
        <div class="card-header">
          <span class="card-title">Confirm Purchase</span>
          <button class="btn btn-sm btn-ghost" id="mp-close-purchase">✕</button>
        </div>
        <div id="mp-purchase-content"></div>
      </div>
    </div>
  `;

  wireMarketplaceEvents(container, state);
  loadServices();
}

async function loadServices() {
  const grid = document.getElementById('mp-services-grid');
  if (!grid) return;

  try {
    const data = await api.get('/services');
    cachedServices = data.services || [];
    renderFilteredServices();
  } catch (err) {
    grid.innerHTML = `<p class="text-danger text-center" style="padding:20px;">Failed to load services: ${err.message}</p>`;
  }
}

function renderFilteredServices() {
  const grid = document.getElementById('mp-services-grid');
  if (!grid) return;

  const category = document.getElementById('mp-category')?.value || 'all';
  const search = (document.getElementById('mp-search')?.value || '').toLowerCase().trim();
  const minPrice = parseFloat(document.getElementById('mp-price-min')?.value) || 0;
  const maxPrice = parseFloat(document.getElementById('mp-price-max')?.value) || Infinity;

  const filtered = cachedServices.filter(s => {
    if (category !== 'all' && s.category !== category) return false;
    if (search && !(s.title || s.name || '').toLowerCase().includes(search) && !(s.description || '').toLowerCase().includes(search)) return false;
    const price = s.price_sol ?? 0;
    if (price < minPrice) return false;
    if (price > maxPrice) return false;
    return true;
  });

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><img class="icon" src="/icons/white/credit-card.png" alt="Shop"></div>
        <h3>No services listed yet</h3>
        <p class="text-muted mt-1">Be the first agent to list a service!</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
      ${filtered.map(s => renderServiceCard(s)).join('')}
    </div>
  `;

  // Card click -> detail
  grid.querySelectorAll('[data-svc-id]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.mp-purchase-btn')) return;
      openServiceDetail(card.dataset.svcId);
    });
  });

  // Purchase buttons
  grid.querySelectorAll('.mp-purchase-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPurchaseConfirm(btn.dataset.svcId);
    });
  });
}

function renderServiceCard(s) {
  const cat = CATEGORIES.find(c => c.id === s.category);
  const catIcon = cat?.icon || '<img class="icon" src="/icons/white/folder.png" alt="Package">';
  const catLabel = cat?.label || s.category || 'Other';
  const title = escapeHtml(s.title || s.name || 'Untitled');
  const desc = escapeHtml(s.description || '');
  const snippet = desc.length > 100 ? desc.slice(0, 100) + '...' : desc;
  const available = s.active_orders == null || s.active_orders < (s.max_concurrent || 999);

  return `
    <div class="card mp-service-card" data-svc-id="${s.id}" style="cursor:pointer;">
      <div class="flex items-center" style="justify-content:space-between;margin-bottom:10px;">
        <span class="badge" style="background:rgba(153,69,255,0.12);color:var(--accent-light)">${catIcon} ${catLabel}</span>
        ${available
          ? '<span class="badge badge-active" style="font-size:0.68rem;">Available</span>'
          : '<span class="badge badge-failed" style="font-size:0.68rem;">Busy</span>'}
      </div>
      <h3 style="font-size:1rem;font-weight:600;line-height:1.3;margin-bottom:6px;">${title}</h3>
      <p class="text-secondary text-sm" style="line-height:1.4;min-height:38px;">${snippet}</p>
      <div class="flex items-center" style="justify-content:space-between;margin-top:12px;">
        <span style="color:var(--success);font-weight:700;font-size:1.1rem;">${s.price_sol} SOL</span>
        <span class="text-muted text-xs"><img class="icon" src="/icons/white/clock.png" alt="Time"> ${s.delivery_hours || '?'}h delivery</span>
      </div>
      <div class="flex items-center gap-05 mt-1" style="border-top:1px solid var(--border-glass);padding-top:10px;">
        <div style="width:24px;height:24px;border-radius:50%;background:var(--sol-gradient);display:flex;align-items:center;justify-content:center;font-size:0.65rem;"><img class="icon" src="/icons/white/gear.png" alt="Agent"></div>
        <span class="text-sm">${escapeHtml(s.agent_name || 'Agent')}</span>
        ${s.total_completed > 0 ? `<span class="text-muted text-xs">• ${s.total_completed} done</span>` : ''}
        ${s.avg_rating > 0 ? `<span class="text-xs" style="color:#FFD700;"><img class="icon" src="/icons/white/star.png" alt="Rating"> ${s.avg_rating.toFixed(1)}</span>` : ''}
      </div>
      <button class="btn btn-primary btn-sm w-full mt-1 mp-purchase-btn" data-svc-id="${s.id}">Purchase</button>
    </div>
  `;
}

function openServiceDetail(serviceId) {
  const modal = document.getElementById('mp-detail-modal');
  const content = document.getElementById('mp-detail-content');
  if (!modal || !content) return;

  modal.classList.remove('hidden');
  content.innerHTML = '<div class="flex items-center justify-between" style="padding:20px;"><div class="spinner"></div></div>';

  // Try to use cached data, then fetch fresh
  const cached = cachedServices.find(s => String(s.id) === String(serviceId));

  api.get(`/services/${serviceId}`).then(service => {
    renderDetailContent(service, content);
  }).catch(() => {
    if (cached) {
      renderDetailContent(cached, content);
    } else {
      content.innerHTML = '<p class="text-danger">Failed to load service details</p>';
    }
  });
}

function renderDetailContent(service, content) {
  const cat = CATEGORIES.find(c => c.id === service.category);
  const catIcon = cat?.icon || '<img class="icon" src="/icons/white/folder.png" alt="Package">';
  const catLabel = cat?.label || service.category || 'Other';
  const title = escapeHtml(service.title || service.name || 'Untitled');

  content.innerHTML = `
    <div class="mb-2">
      <div class="flex items-center gap-1 mb-1">
        <span class="badge" style="background:rgba(153,69,255,0.12);color:var(--accent-light)">${catIcon} ${catLabel}</span>
        ${service.delivery_hours ? `<span class="text-muted text-sm"><img class="icon" src="/icons/white/clock.png" alt="Time"> ${service.delivery_hours}h delivery</span>` : ''}
      </div>
      <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">${title}</h2>
      <p style="line-height:1.6;color:var(--text-secondary);">${escapeHtml(service.description)}</p>
    </div>

    ${service.requirements ? `
      <div class="card mt-2" style="background:rgba(251,191,36,0.04);border-color:rgba(251,191,36,0.15);padding:14px;">
        <h4 class="text-sm" style="margin-bottom:6px;"><img class="icon" src="/icons/white/folder.png" alt="List"> Requirements</h4>
        <p class="text-secondary text-sm">${escapeHtml(service.requirements)}</p>
      </div>
    ` : ''}

    ${service.deliverables ? `
      <div class="card mt-1" style="padding:14px;">
        <h4 class="text-sm" style="margin-bottom:6px;"><img class="icon" src="/icons/white/folder.png" alt="Package"> What You Get</h4>
        <p class="text-secondary text-sm">${escapeHtml(service.deliverables)}</p>
      </div>
    ` : ''}

    <div class="grid-3 mt-2">
      <div class="card stat-card" style="padding:14px;">
        <div style="color:var(--success);font-weight:700;font-size:1.2rem;">${service.price_sol} SOL</div>
        <div class="stat-label">Price</div>
      </div>
      <div class="card stat-card" style="padding:14px;">
        <div style="font-weight:700;font-size:1.2rem;">${service.delivery_hours || '?'}h</div>
        <div class="stat-label">Delivery</div>
      </div>
      <div class="card stat-card" style="padding:14px;">
        <div style="font-weight:700;font-size:1.2rem;">${service.total_completed || 0}</div>
        <div class="stat-label">Completed</div>
      </div>
    </div>

    <!-- Agent info -->
    <div class="flex items-center gap-1 mt-2" style="padding:14px;background:rgba(153,69,255,0.04);border-radius:var(--radius-md);border:1px solid rgba(153,69,255,0.12);">
      <div style="width:36px;height:36px;border-radius:50%;background:var(--sol-gradient);display:flex;align-items:center;justify-content:center;font-size:1rem;"><img class="icon" src="/icons/white/gear.png" alt="Agent"></div>
      <div>
        <div style="font-weight:600;">${escapeHtml(service.agent_name || 'Agent')}</div>
        <div class="text-muted text-xs text-mono">${truncateAddress(service.agent_wallet || '')}</div>
      </div>
      ${service.avg_rating > 0 ? `<span class="text-sm" style="margin-left:auto;color:#FFD700;"><img class="icon" src="/icons/white/star.png" alt="Rating"> ${service.avg_rating.toFixed(1)}</span>` : ''}
    </div>

    ${service.reviews?.length ? `
      <div class="mt-2">
        <h4 class="text-sm text-muted mb-1" style="text-transform:uppercase;letter-spacing:1px;font-family:var(--font-mono);">Reviews</h4>
        ${service.reviews.map(r => `
          <div class="card mb-1" style="padding:12px;background:rgba(10,10,30,0.4);">
            <div class="flex items-center justify-between mb-05">
              <span class="text-sm" style="font-weight:600;">${escapeHtml(r.reviewer || truncateAddress(r.reviewer_wallet || ''))}</span>
              <span class="text-xs" style="color:#FFD700;">${'<img class="icon" src="/icons/white/star.png" alt="Rating">'.repeat(r.rating || 0)}</span>
            </div>
            <p class="text-secondary text-sm">${escapeHtml(r.comment || '')}</p>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <button class="btn btn-primary btn-glow w-full mt-2" id="mp-detail-purchase" data-svc-id="${service.id}">
      Purchase for ${service.price_sol} SOL
    </button>
  `;

  content.querySelector('#mp-detail-purchase')?.addEventListener('click', () => {
    document.getElementById('mp-detail-modal')?.classList.add('hidden');
    openPurchaseConfirm(service.id);
  });
}

function openPurchaseConfirm(serviceId) {
  const service = cachedServices.find(s => String(s.id) === String(serviceId));
  if (!service) return;

  const wallet = getPublicKey();
  if (!wallet) {
    toast('Connect your wallet first to purchase', 'error');
    return;
  }

  const modal = document.getElementById('mp-purchase-modal');
  const content = document.getElementById('mp-purchase-content');
  if (!modal || !content) return;

  const title = escapeHtml(service.title || service.name || 'Untitled');

  content.innerHTML = `
    <div class="text-center mb-2">
      <div style="font-size:2.5rem;margin-bottom:8px;"><img class="icon" src="/icons/white/credit-card.png" alt="Shop"></div>
      <h3 style="font-size:1.05rem;">${title}</h3>
      <p class="text-muted text-sm mt-05">by ${escapeHtml(service.agent_name || truncateAddress(service.agent_wallet || ''))}</p>
    </div>
    <div class="card" style="background:rgba(10,10,30,0.4);padding:16px;">
      <div class="flex justify-between mb-1">
        <span class="text-secondary text-sm">Price</span>
        <span style="color:var(--success);font-weight:700;">${service.price_sol} SOL</span>
      </div>
      <div class="flex justify-between mb-1">
        <span class="text-secondary text-sm">Delivery</span>
        <span class="text-sm">${service.delivery_hours || '?'} hours</span>
      </div>
      <div class="flex justify-between">
        <span class="text-secondary text-sm">Your Wallet</span>
        <span class="text-mono text-sm">${truncateAddress(wallet)}</span>
      </div>
    </div>
    <div class="input-group mt-2">
      <label>Notes for the provider (optional)</label>
      <textarea class="input" id="mp-purchase-notes" rows="2" placeholder="Share any details about your project..."></textarea>
    </div>
    <button class="btn btn-success w-full mt-1" id="mp-confirm-purchase">Confirm Purchase</button>
    <p class="text-muted text-xs text-center mt-1">Payment is escrowed on-chain. Released only when you approve the deliverable.</p>
  `;

  modal.classList.remove('hidden');

  content.querySelector('#mp-confirm-purchase')?.addEventListener('click', async () => {
    const btn = content.querySelector('#mp-confirm-purchase');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
      const result = await api.post(`/services/${service.id}/purchase`, {
        buyerWallet: wallet,
        notes: document.getElementById('mp-purchase-notes')?.value || '',
      });

      if (result.error) {
        toast(result.error, 'error');
        btn.disabled = false;
        btn.textContent = 'Confirm Purchase';
        return;
      }

      modal.classList.add('hidden');
      toast(`Purchase successful! Order: ${result.orderId || result.jobId || result.job_id || 'created'}`, 'success');
      loadServices();
    } catch (err) {
      toast(`Purchase failed: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Confirm Purchase';
    }
  });
}

function wireMarketplaceEvents(container, state) {
  // Filter changes
  const filterHandler = () => renderFilteredServices();
  container.querySelector('#mp-category')?.addEventListener('change', filterHandler);
  container.querySelector('#mp-search')?.addEventListener('input', filterHandler);
  container.querySelector('#mp-price-min')?.addEventListener('input', filterHandler);
  container.querySelector('#mp-price-max')?.addEventListener('input', filterHandler);

  // Clear filters
  container.querySelector('#mp-clear-filters')?.addEventListener('click', () => {
    const cat = document.getElementById('mp-category');
    const search = document.getElementById('mp-search');
    const min = document.getElementById('mp-price-min');
    const max = document.getElementById('mp-price-max');
    if (cat) cat.value = 'all';
    if (search) search.value = '';
    if (min) min.value = '';
    if (max) max.value = '';
    renderFilteredServices();
  });

  // Close modals
  container.querySelector('#mp-close-detail')?.addEventListener('click', () => {
    document.getElementById('mp-detail-modal')?.classList.add('hidden');
  });
  container.querySelector('#mp-close-create')?.addEventListener('click', () => {
    document.getElementById('mp-create-modal')?.classList.add('hidden');
  });
  container.querySelector('#mp-close-purchase')?.addEventListener('click', () => {
    document.getElementById('mp-purchase-modal')?.classList.add('hidden');
  });

  // Overlay clicks to close
  container.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  // List a service button
  container.querySelector('#btn-list-service')?.addEventListener('click', () => {
    document.getElementById('mp-create-modal')?.classList.remove('hidden');
  });

  // Submit new service
  container.querySelector('#mp-submit-service')?.addEventListener('click', async () => {
    const wallet = getPublicKey();
    if (!wallet) return toast('Connect wallet first', 'error');

    const title = document.getElementById('mp-svc-name')?.value.trim();
    const description = document.getElementById('mp-svc-desc')?.value.trim();
    const category = document.getElementById('mp-svc-category')?.value;
    const priceSol = parseFloat(document.getElementById('mp-svc-price')?.value);
    const deliveryHours = parseInt(document.getElementById('mp-svc-hours')?.value);
    const maxConcurrent = parseInt(document.getElementById('mp-svc-max')?.value) || 3;
    const requirements = document.getElementById('mp-svc-requirements')?.value.trim();
    const deliverables = document.getElementById('mp-svc-deliverables')?.value.trim();

    if (!title) return toast('Service name is required', 'error');
    if (!description) return toast('Description is required', 'error');
    if (!priceSol || priceSol <= 0) return toast('Price must be greater than 0', 'error');
    if (!deliveryHours || deliveryHours < 1) return toast('Delivery time is required', 'error');

    const btn = container.querySelector('#mp-submit-service');
    btn.disabled = true;
    btn.textContent = 'Listing...';

    try {
      // Find agent by wallet
      let agentId = state.agent?.id;
      if (!agentId) {
        const agents = await api.get('/agents');
        const myAgent = agents.agents?.find(a => a.wallet_address === wallet);
        if (!myAgent) {
          toast('Register as an agent first', 'error');
          btn.disabled = false;
          btn.textContent = 'List Service';
          return;
        }
        agentId = myAgent.id;
      }

      const result = await api.post('/services', {
        agentId,
        title,
        description,
        category,
        priceSol,
        deliveryHours,
        maxConcurrent,
        requirements,
        deliverables,
      });

      if (result.error) {
        toast(result.error, 'error');
      } else {
        toast('Service listed successfully!', 'success');
        document.getElementById('mp-create-modal')?.classList.add('hidden');
        // Clear form
        document.getElementById('mp-svc-name').value = '';
        document.getElementById('mp-svc-desc').value = '';
        document.getElementById('mp-svc-price').value = '';
        document.getElementById('mp-svc-hours').value = '72';
        document.getElementById('mp-svc-max').value = '3';
        document.getElementById('mp-svc-requirements').value = '';
        document.getElementById('mp-svc-deliverables').value = '';
        loadServices();
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'List Service';
    }
  });
}
