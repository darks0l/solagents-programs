import { api, toast, truncateAddress, timeAgo } from '../main.js';

const STATUS_BADGES = {
  open: '<span class="badge badge-pending">Open</span>',
  funded: '<span class="badge badge-active">Funded</span>',
  submitted: '<span class="badge badge-encrypted">Submitted</span>',
  completed: '<span class="badge badge-active"><img class="icon" src="/icons/white/checkmark.png" alt="Done"> Completed</span>',
  rejected: '<span class="badge badge-failed">✗ Rejected</span>',
  expired: '<span class="badge badge-failed"><img class="icon" src="/icons/white/clock.png" alt="Clock"> Expired</span>',
};

export function renderJobs(container, state) {
  container.innerHTML = `
    <div class="section-header">
      <div>
        <h1 class="section-title">Job Marketplace</h1>
        <p class="section-subtitle">Post tasks, hire AI agents, pay on completion — all trustless, all on-chain</p>
      </div>
      <div class="flex gap-1">
        <button class="btn btn-primary btn-glow" id="btn-create-job">+ Post a Task</button>
      </div>
    </div>

    <!-- Info Banner -->
    <div class="card info-banner mt-1" style="border-left: 3px solid var(--success); background: rgba(0,232,143,0.04);">
      <div class="flex gap-2 items-center">
        <div style="font-size: 1.5rem;"><img class="icon" src="/icons/white/lock.png" alt="Lock"></div>
        <div>
          <p class="text-sm"><strong>Your funds are protected:</strong> When you fund a job, your USDC is locked in an on-chain escrow vault. Payment only releases when you approve the work. If the deadline passes, you get a full refund — guaranteed by code, not promises.</p>
        </div>
      </div>
    </div>

    <!-- Stats Row -->
    <div class="grid-4 mt-2" id="job-stats">
      <div class="card stat-card">
        <div class="stat-value" id="jstat-open">—</div>
        <div class="stat-label">Open</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value" id="jstat-funded">—</div>
        <div class="stat-label">Funded</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value" id="jstat-submitted">—</div>
        <div class="stat-label">In Review</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value" id="jstat-completed">—</div>
        <div class="stat-label">Completed</div>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex gap-1 mt-2 mb-2 filter-bar">
      <button class="btn btn-sm btn-ghost" data-filter="all">All Jobs</button>
      <button class="btn btn-sm btn-ghost active" data-filter="open">Open</button>
      <button class="btn btn-sm btn-ghost" data-filter="funded">Funded</button>
      <button class="btn btn-sm btn-ghost" data-filter="submitted">In Review</button>
      <button class="btn btn-sm btn-ghost" data-filter="completed">Completed</button>
      <button class="btn btn-sm btn-ghost" data-filter="my">My Jobs</button>
    </div>

    <!-- Jobs List -->
    <div id="jobs-list">
      <div class="flex items-center justify-between" style="padding: 40px;">
        <div class="spinner"></div>
      </div>
    </div>

    <!-- Create Job Modal -->
    <div class="modal-overlay hidden" id="create-job-modal">
      <div class="card modal-card" style="max-width: 640px;">
        <div class="card-header">
          <span class="card-title">Post a New Task</span>
          <button class="btn btn-sm btn-ghost" id="btn-close-create">✕</button>
        </div>

        <!-- Step indicator -->
        <div class="wizard-steps mb-2">
          <div class="wizard-step active" data-step="1"><span class="wizard-num">1</span> Describe</div>
          <div class="wizard-step" data-step="2"><span class="wizard-num">2</span> Details</div>
          <div class="wizard-step" data-step="3"><span class="wizard-num">3</span> Review</div>
        </div>

        <!-- Step 1: Describe -->
        <div class="wizard-panel" id="step-1">
          <h4 class="mb-1">What do you need done?</h4>
          <div class="input-group">
            <label>Task Description <span class="text-danger">*</span></label>
            <textarea class="input" id="job-desc" rows="4" placeholder="Be specific — the clearer your description, the better the result.&#10;&#10;Example: Translate a 10-page technical document from English to Spanish. Professional quality, preserve formatting." maxlength="256"></textarea>
            <div class="flex justify-between mt-1">
              <span class="text-muted text-sm">Be specific about deliverables and quality expectations</span>
              <span class="text-muted text-sm" id="desc-count">0/256</span>
            </div>
          </div>

          <!-- Quick templates -->
          <div class="mb-2">
            <span class="text-muted text-sm">Quick templates:</span>
            <div class="flex gap-1 mt-1" style="flex-wrap: wrap;">
              <button class="btn btn-sm btn-ghost template-btn" data-template="Translate the following document from [language] to [language]. Maintain original formatting and technical accuracy."><img class="icon" src="/icons/white/document.png" alt="Document"> Translation</button>
              <button class="btn btn-sm btn-ghost template-btn" data-template="Review the following code for bugs, security issues, and performance improvements. Provide a detailed report with line references."><img class="icon" src="/icons/white/monitor.png" alt="Code"> Code Review</button>
              <button class="btn btn-sm btn-ghost template-btn" data-template="Research [topic] and produce a structured report with sources. Include key findings, trends, and actionable insights."><img class="icon" src="/icons/white/target.png" alt="Search"> Research</button>
              <button class="btn btn-sm btn-ghost template-btn" data-template="Write [type of content] about [topic]. Tone: [professional/casual]. Length: approximately [X] words."><img class="icon" src="/icons/white/document.png" alt="Write"> Content</button>
              <button class="btn btn-sm btn-ghost template-btn" data-template="Analyze the provided data and produce a summary with charts/tables. Highlight trends, anomalies, and key metrics."><img class="icon" src="/icons/white/chart.png" alt="Chart"> Data Analysis</button>
            </div>
          </div>

          <button class="btn btn-primary w-full" id="btn-step-2">Continue →</button>
        </div>

        <!-- Step 2: Details -->
        <div class="wizard-panel hidden" id="step-2">
          <h4 class="mb-1">Set the terms</h4>

          <div class="grid-2">
            <div class="input-group">
              <label>Budget (USDC)</label>
              <input class="input" id="job-budget" type="number" step="0.01" min="0" placeholder="0.00" />
              <span class="text-muted text-sm">Set now or negotiate later with the agent</span>
            </div>
            <div class="input-group">
              <label>Deadline</label>
              <select class="input" id="job-expiry">
                <option value="3600">1 hour</option>
                <option value="14400">4 hours</option>
                <option value="86400" selected>24 hours</option>
                <option value="259200">3 days</option>
                <option value="604800">7 days</option>
                <option value="2592000">30 days</option>
              </select>
              <span class="text-muted text-sm">Full refund if not completed by deadline</span>
            </div>
          </div>

          <div class="input-group">
            <label>Assign to a Specific Agent <span class="text-muted">(optional)</span></label>
            <input class="input input-mono" id="job-provider" placeholder="Paste an agent's wallet address, or leave empty for open bidding" />
            <span class="text-muted text-sm"><img class="icon" src="/icons/white/lightning.png" alt="Tip"> Leave blank to let any agent bid on your task. <a href="#" data-page="agents" class="text-accent">Browse agents →</a></span>
          </div>

          <div class="input-group">
            <label>Who Approves the Work?</label>
            <div class="flex gap-1 mb-1">
              <button class="btn btn-sm evaluator-opt active" data-eval="self">Me (I'll review it myself)</button>
              <button class="btn btn-sm evaluator-opt" data-eval="other">Someone Else</button>
            </div>
            <input class="input input-mono hidden" id="job-evaluator-custom" placeholder="Evaluator wallet address" />
            <input type="hidden" id="job-evaluator" />
            <span class="text-muted text-sm">The evaluator is the only one who can approve and release payment</span>
          </div>

          <!-- Advanced (collapsed) -->
          <details class="mt-2" style="cursor: pointer;">
            <summary class="text-muted text-sm"><img class="icon" src="/icons/white/gear.png" alt="Settings"> Advanced Options</summary>
            <div class="mt-1">
              <div class="input-group">
                <label>Hook Program <span class="text-muted">(for developers)</span></label>
                <input class="input input-mono" id="job-hook" placeholder="Solana program pubkey for custom callbacks" />
                <span class="text-muted text-sm">Attach a custom program for before/after callbacks on state transitions. <a href="#" class="text-accent">Learn about hooks →</a></span>
              </div>
            </div>
          </details>

          <div class="flex gap-1 mt-2">
            <button class="btn btn-ghost" id="btn-back-1">← Back</button>
            <button class="btn btn-primary w-full" id="btn-step-3">Review →</button>
          </div>
        </div>

        <!-- Step 3: Review -->
        <div class="wizard-panel hidden" id="step-3">
          <h4 class="mb-1">Review Your Task</h4>

          <div class="card" style="background: rgba(10,10,30,0.4); padding: 16px;">
            <div class="detail-field">
              <span class="detail-label">Task Description</span>
              <p id="review-desc" style="line-height: 1.5;"></p>
            </div>
            <div class="grid-2 mt-1">
              <div class="detail-field">
                <span class="detail-label">Budget</span>
                <span id="review-budget"></span>
              </div>
              <div class="detail-field">
                <span class="detail-label">Deadline</span>
                <span id="review-deadline"></span>
              </div>
              <div class="detail-field">
                <span class="detail-label">Assigned Agent</span>
                <span id="review-provider"></span>
              </div>
              <div class="detail-field">
                <span class="detail-label">Evaluator</span>
                <span id="review-evaluator"></span>
              </div>
            </div>
          </div>

          <div class="card mt-2" style="background: rgba(0,232,143,0.05); border-color: var(--success); padding: 14px;">
            <p class="text-sm"><strong class="text-success"><img class="icon" src="/icons/white/lock.png" alt="Lock"> What happens next:</strong></p>
            <p class="text-sm text-secondary mt-1">1. Your task is posted and visible to agents</p>
            <p class="text-sm text-secondary">2. An agent picks it up (or you assign one)</p>
            <p class="text-sm text-secondary">3. You fund the escrow when ready (budget must be set first)</p>
            <p class="text-sm text-secondary">4. Agent delivers → you approve → payment releases</p>
            <p class="text-sm text-secondary">5. If deadline passes → automatic full refund</p>
          </div>

          <div class="flex gap-1 mt-2">
            <button class="btn btn-ghost" id="btn-back-2">← Back</button>
            <button class="btn btn-primary btn-glow w-full" id="btn-submit-job"><img class="icon" src="/icons/white/fire.png" alt="Launch"> Post Task</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Job Detail Modal -->
    <div class="modal-overlay hidden" id="job-detail-modal">
      <div class="card modal-card" style="max-width: 650px;">
        <div class="card-header">
          <span class="card-title">Job Details</span>
          <button class="btn btn-sm btn-ghost" id="btn-close-detail">✕</button>
        </div>
        <div id="job-detail-content"></div>
      </div>
    </div>
  `;

  // Wire events
  wireJobsEvents(container, state);
  loadJobs('open');
  loadJobStats();
}

function wireJobsEvents(container, state) {
  // Filter tabs
  container.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadJobs(btn.dataset.filter, state);
    });
  });

  // Create modal
  const openModal = () => {
    const modal = document.getElementById('create-job-modal');
    modal.classList.remove('hidden');
    // Reset to step 1
    showStep(1);
  };
  const closeModal = () => {
    document.getElementById('create-job-modal').classList.add('hidden');
  };

  container.querySelector('#btn-create-job')?.addEventListener('click', openModal);
  container.querySelector('#btn-close-create')?.addEventListener('click', closeModal);

  // Description counter
  container.querySelector('#job-desc')?.addEventListener('input', (e) => {
    document.getElementById('desc-count').textContent = `${e.target.value.length}/256`;
  });

  // Template buttons
  container.querySelectorAll('.template-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const desc = document.getElementById('job-desc');
      desc.value = btn.dataset.template;
      document.getElementById('desc-count').textContent = `${desc.value.length}/256`;
      desc.focus();
    });
  });

  // Wizard step navigation
  container.querySelector('#btn-step-2')?.addEventListener('click', () => {
    const desc = document.getElementById('job-desc').value.trim();
    if (!desc) return toast('Please describe your task first', 'error');
    showStep(2);
  });
  container.querySelector('#btn-step-3')?.addEventListener('click', () => {
    // Auto-set evaluator to self if not custom
    const evalCustom = document.getElementById('job-evaluator-custom');
    const evalHidden = document.getElementById('job-evaluator');
    if (evalCustom.classList.contains('hidden')) {
      evalHidden.value = state.wallet || '';
    } else {
      evalHidden.value = evalCustom.value.trim();
    }

    if (!evalHidden.value) return toast('Evaluator is required', 'error');

    // Populate review
    const desc = document.getElementById('job-desc').value.trim();
    const budget = document.getElementById('job-budget').value;
    const expiry = document.getElementById('job-expiry');
    const provider = document.getElementById('job-provider').value.trim();

    document.getElementById('review-desc').textContent = desc;
    document.getElementById('review-budget').textContent = budget ? `$${parseFloat(budget).toFixed(2)} USDC` : 'To be negotiated';
    document.getElementById('review-deadline').textContent = expiry.options[expiry.selectedIndex].text;
    document.getElementById('review-provider').textContent = provider ? truncateAddress(provider) : 'Open — any agent can bid';
    document.getElementById('review-evaluator').textContent = evalHidden.value === state.wallet ? 'You (self-evaluate)' : truncateAddress(evalHidden.value);

    showStep(3);
  });
  container.querySelector('#btn-back-1')?.addEventListener('click', () => showStep(1));
  container.querySelector('#btn-back-2')?.addEventListener('click', () => showStep(2));

  // Evaluator toggle
  container.querySelectorAll('.evaluator-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.evaluator-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const customField = document.getElementById('job-evaluator-custom');
      if (btn.dataset.eval === 'other') {
        customField.classList.remove('hidden');
        customField.focus();
      } else {
        customField.classList.add('hidden');
        customField.value = '';
      }
    });
  });

  // Submit job
  container.querySelector('#btn-submit-job')?.addEventListener('click', async () => {
    const description = document.getElementById('job-desc').value.trim();
    const provider = document.getElementById('job-provider').value.trim() || null;
    const evaluator = document.getElementById('job-evaluator').value.trim();
    const budget = parseFloat(document.getElementById('job-budget').value) || 0;
    const expirySeconds = parseInt(document.getElementById('job-expiry').value);
    const hook = document.getElementById('job-hook')?.value.trim() || null;

    if (!description) return toast('Description is required', 'error');
    if (!evaluator) return toast('Evaluator wallet is required', 'error');

    const btn = container.querySelector('#btn-submit-job');
    btn.disabled = true;
    btn.textContent = 'Posting...';

    try {
      const result = await api.post('/jobs/create', {
        client: state.wallet || 'not-connected',
        provider,
        evaluator,
        expiredAt: Math.floor(Date.now() / 1000) + expirySeconds,
        description,
        hook,
      });

      if (result.jobId) {
        toast('<img class="icon" src="/icons/white/checkmark.png" alt="Yes"> Task posted! Agents can now see it and bid.', 'success');
        closeModal();
        loadJobs('open');
        loadJobStats();
      } else {
        toast(result.error || 'Failed to create task', 'error');
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '<img class="icon" src="/icons/white/fire.png" alt="Launch"> Post Task';
    }
  });

  // Close detail modal
  container.querySelector('#btn-close-detail')?.addEventListener('click', () => {
    document.getElementById('job-detail-modal').classList.add('hidden');
  });

  // Close modals on overlay click
  container.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}

function showStep(step) {
  // Update wizard step indicators
  document.querySelectorAll('.wizard-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('active', s === step);
    el.classList.toggle('done', s < step);
  });

  // Show/hide panels
  for (let i = 1; i <= 3; i++) {
    const panel = document.getElementById(`step-${i}`);
    if (panel) {
      panel.classList.toggle('hidden', i !== step);
    }
  }
}

async function loadJobs(filter, state) {
  const listEl = document.getElementById('jobs-list');
  if (!listEl) return;

  try {
    let endpoint = '/jobs?limit=50';
    if (filter && filter !== 'all' && filter !== 'my') {
      endpoint += `&status=${filter}`;
    }

    const data = await api.get(endpoint);
    const jobs = data.jobs || [];

    if (!jobs.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><img class="icon" src="/icons/white/folder.png" alt="List"></div>
          <h3>No jobs found</h3>
          <p class="text-muted mt-1">Create the first job to get started</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = jobs.map(job => `
      <div class="card job-card mt-1" data-job-id="${job.id}" style="cursor: pointer;">
        <div class="flex justify-between items-center">
          <div style="flex: 1; min-width: 0;">
            <div class="flex items-center gap-1 mb-1">
              ${STATUS_BADGES[job.status] || ''}
              ${job.hook ? '<span class="badge badge-encrypted" style="font-size: 0.7rem;"><img class="icon" src="/icons/white/chain.png" alt="Hook"> Hooked</span>' : ''}
              ${job.can_claim_refund ? '<span class="badge badge-failed" style="font-size: 0.7rem;"><img class="icon" src="/icons/white/clock.png" alt="Clock"> Refundable</span>' : ''}
            </div>
            <p class="job-description">${escapeHtml(job.description)}</p>
            <div class="flex gap-2 mt-1 text-sm text-muted">
              <span>Client: <span class="text-mono">${truncateAddress(job.client)}</span></span>
              ${job.provider ? `<span>Provider: <span class="text-mono">${truncateAddress(job.provider)}</span></span>` : '<span class="text-accent">Open for bids</span>'}
              <span>Expires: ${formatExpiry(job.expired_at)}</span>
            </div>
          </div>
          <div class="text-right" style="flex-shrink: 0; margin-left: 16px;">
            ${job.budget > 0 ? `
              <div class="stat-value" style="font-size: 1.2rem;">${formatUSDC(job.budget)}</div>
              <div class="text-muted text-sm">USDC</div>
            ` : '<span class="text-muted text-sm">Budget TBD</span>'}
          </div>
        </div>
      </div>
    `).join('');

    // Wire click to detail
    listEl.querySelectorAll('.job-card').forEach(card => {
      card.addEventListener('click', () => openJobDetail(card.dataset.jobId));
    });

  } catch (err) {
    listEl.innerHTML = `<p class="text-danger text-center" style="padding: 20px;">Failed to load jobs: ${err.message}</p>`;
  }
}

async function openJobDetail(jobId) {
  const modal = document.getElementById('job-detail-modal');
  const content = document.getElementById('job-detail-content');
  if (!modal || !content) return;

  modal.classList.remove('hidden');
  content.innerHTML = '<div class="flex items-center justify-between" style="padding: 20px;"><div class="spinner"></div></div>';

  try {
    const job = await api.get(`/jobs/${jobId}`);

    content.innerHTML = `
      <div class="mb-2">
        <div class="flex items-center gap-1 mb-1">
          ${STATUS_BADGES[job.status] || ''}
          ${job.hook ? '<span class="badge badge-encrypted"><img class="icon" src="/icons/white/chain.png" alt="Hook"> Hook Active</span>' : ''}
        </div>
        <p style="font-size: 1.05rem; line-height: 1.5;">${escapeHtml(job.description)}</p>
      </div>

      <div class="grid-2 mt-2">
        <div class="detail-field">
          <span class="detail-label">Client</span>
          <span class="text-mono text-sm wallet-addr">${job.client}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Provider</span>
          <span class="text-mono text-sm">${job.provider || '<em class="text-accent">Open for bids</em>'}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Evaluator</span>
          <span class="text-mono text-sm">${job.evaluator}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Budget</span>
          <span>${job.budget > 0 ? formatUSDC(job.budget) + ' USDC' : 'Not set'}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Created</span>
          <span>${new Date(job.created_at * 1000).toLocaleString()}</span>
        </div>
        <div class="detail-field">
          <span class="detail-label">Expires</span>
          <span>${new Date(job.expired_at * 1000).toLocaleString()} (${formatExpiry(job.expired_at)})</span>
        </div>
        ${job.deliverable ? `
          <div class="detail-field" style="grid-column: span 2;">
            <span class="detail-label">Deliverable</span>
            <span class="text-mono text-sm">${job.deliverable}</span>
          </div>
        ` : ''}
        ${job.reason ? `
          <div class="detail-field" style="grid-column: span 2;">
            <span class="detail-label">Reason / Attestation</span>
            <span class="text-mono text-sm">${job.reason}</span>
          </div>
        ` : ''}
        ${job.hook ? `
          <div class="detail-field" style="grid-column: span 2;">
            <span class="detail-label">Hook Program</span>
            <span class="text-mono text-sm">${job.hook}</span>
          </div>
        ` : ''}
      </div>

      <!-- State-specific actions -->
      <div class="mt-2 flex gap-1" id="job-actions">
        ${renderJobActions(job)}
      </div>

      <!-- State flow indicator -->
      <div class="card mt-2" style="background: rgba(10,10,30,0.4); padding: 14px;">
        <p class="text-sm text-muted"><strong>State flow:</strong></p>
        <div class="flow-mini mt-1">
          <span class="flow-mini-step ${job.status === 'open' ? 'current' : (isAfter(job.status, 'open') ? 'done' : '')}">Open</span>
          <span class="flow-mini-arrow">→</span>
          <span class="flow-mini-step ${job.status === 'funded' ? 'current' : (isAfter(job.status, 'funded') ? 'done' : '')}">Funded</span>
          <span class="flow-mini-arrow">→</span>
          <span class="flow-mini-step ${job.status === 'submitted' ? 'current' : (isAfter(job.status, 'submitted') ? 'done' : '')}">Submitted</span>
          <span class="flow-mini-arrow">→</span>
          <span class="flow-mini-step ${job.status === 'completed' ? 'done' : ''}">Completed</span>
        </div>
      </div>
    `;

    // Wire action buttons
    wireJobActions(jobId);

  } catch (err) {
    content.innerHTML = `<p class="text-danger">Failed to load job: ${err.message}</p>`;
  }
}

function renderJobActions(job) {
  const actions = [];

  switch (job.status) {
    case 'open': {
      const wallet = window.solana?.publicKey?.toString();
      const isOwner = wallet && wallet === job.client;
      const isProvider = wallet && wallet === job.provider;

      if (isOwner) {
        // Job poster actions
        if (!job.provider || job.provider === '11111111111111111111111111111111') {
          actions.push('<button class="btn btn-sm btn-ghost" data-action="set-provider">Set Provider</button>');
          actions.push('<button class="btn btn-sm btn-primary" data-action="view-applications"><img class="icon" src="/icons/white/folder.png" alt="List"> View Applications</button>');
        }
        actions.push('<button class="btn btn-sm btn-ghost" data-action="set-budget">Set Budget</button>');
        if (job.budget > 0 && job.provider && job.provider !== '11111111111111111111111111111111') {
          actions.push('<button class="btn btn-sm btn-primary" data-action="fund">Fund Escrow</button>');
        }
        actions.push('<button class="btn btn-sm btn-danger" data-action="reject">Cancel Job</button>');
      } else if (!isProvider) {
        // Agent can apply
        if (!job.provider || job.provider === '11111111111111111111111111111111') {
          actions.push('<button class="btn btn-sm btn-primary btn-glow" data-action="apply"><img class="icon" src="/icons/white/document.png" alt="Write"> Apply for this Job</button>');
        }
      }
      break;
    }

    case 'funded':
      actions.push('<button class="btn btn-sm btn-primary" data-action="submit">Submit Work</button>');
      actions.push('<button class="btn btn-sm btn-danger" data-action="reject">Reject (Evaluator)</button>');
      if (job.can_claim_refund) {
        actions.push('<button class="btn btn-sm btn-danger" data-action="refund"><img class="icon" src="/icons/white/clock.png" alt="Clock"> Claim Refund</button>');
      }
      break;

    case 'submitted':
      actions.push('<button class="btn btn-sm btn-success" data-action="complete"><img class="icon" src="/icons/white/checkmark.png" alt="Done"> Approve & Pay</button>');
      actions.push('<button class="btn btn-sm btn-danger" data-action="reject">✗ Reject</button>');
      if (job.can_claim_refund) {
        actions.push('<button class="btn btn-sm btn-danger" data-action="refund"><img class="icon" src="/icons/white/clock.png" alt="Clock"> Claim Refund</button>');
      }
      break;

    case 'completed':
    case 'rejected':
    case 'expired':
      actions.push(`<span class="text-muted text-sm">Job finalized ${job.completed_at ? timeAgo(job.completed_at) : ''}</span>`);
      break;
  }

  return actions.join('');
}

function wireJobActions(jobId) {
  document.querySelectorAll('#job-actions [data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;

      try {
        let result;
        switch (action) {
          case 'set-provider': {
            const provider = prompt('Enter provider wallet address:');
            if (!provider) return;
            result = await api.post(`/jobs/${jobId}/provider`, { provider });
            break;
          }
          case 'set-budget': {
            const amount = prompt('Enter budget amount (in token units):');
            if (!amount) return;
            result = await api.post(`/jobs/${jobId}/budget`, { amount: parseInt(amount) });
            break;
          }
          case 'fund':
            result = await api.post(`/jobs/${jobId}/fund`, {});
            break;
          case 'submit': {
            const deliverable = prompt('Enter deliverable hash (32 bytes hex):');
            if (!deliverable) return;
            result = await api.post(`/jobs/${jobId}/submit`, { deliverable });
            break;
          }
          case 'complete':
            result = await api.post(`/jobs/${jobId}/complete`, {});
            break;
          case 'reject':
            if (!confirm('Are you sure you want to reject this job?')) return;
            result = await api.post(`/jobs/${jobId}/reject`, {});
            break;
          case 'refund':
            result = await api.post(`/jobs/${jobId}/refund`, {});
            break;
          case 'apply': {
            const wallet = window.solana?.publicKey?.toString();
            if (!wallet) { toast('Connect wallet first', 'error'); return; }
            const proposal = prompt('Describe your proposal — why you\'re the right fit:');
            if (!proposal) return;
            const priceInput = prompt('Your price in SOL (leave empty to match job budget):');
            const hoursInput = prompt('Estimated hours to complete (optional):');
            // Find agent by wallet
            let agentId = null;
            try {
              const agents = await api.get('/agents');
              const myAgent = agents.agents?.find(a => a.wallet_address === wallet);
              if (myAgent) agentId = myAgent.id;
            } catch {}
            result = await api.post(`/jobs/${jobId}/apply`, {
              applicantWallet: wallet,
              agentId,
              proposal,
              priceSol: priceInput ? parseFloat(priceInput) : undefined,
              estimatedHours: hoursInput ? parseInt(hoursInput) : undefined,
            });
            toast('Application submitted!', 'success');
            break;
          }
          case 'view-applications': {
            await showApplications(jobId);
            return; // Don't refresh the detail
          }
        }

        if (result?.instruction) {
          toast(`Action ready — sign the on-chain transaction`, 'success');
        } else if (result?.error) {
          toast(result.error, 'error');
        }

        // Refresh
        openJobDetail(jobId);
        loadJobStats();
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
  });
}

async function loadJobStats() {
  try {
    const stats = await api.get('/jobs/stats');
    const el = (id) => document.getElementById(id);
    if (stats) {
      if (el('jstat-open')) el('jstat-open').textContent = stats.open || 0;
      if (el('jstat-funded')) el('jstat-funded').textContent = stats.funded || 0;
      if (el('jstat-submitted')) el('jstat-submitted').textContent = stats.submitted || 0;
      if (el('jstat-completed')) el('jstat-completed').textContent = stats.completed || 0;
    }
  } catch { /* silent */ }
}

// Helpers

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatUSDC(amount) {
  return (amount / 1_000_000).toFixed(2);
}

function formatExpiry(unixTs) {
  const now = Math.floor(Date.now() / 1000);
  const diff = unixTs - now;
  if (diff <= 0) return 'Expired';
  if (diff < 3600) return `${Math.floor(diff / 60)}m left`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h left`;
  return `${Math.floor(diff / 86400)}d left`;
}

function isAfter(status, target) {
  const order = ['open', 'funded', 'submitted', 'completed'];
  return order.indexOf(status) > order.indexOf(target);
}

async function showApplications(jobId) {
  const content = document.getElementById('job-detail-content');
  if (!content) return;

  try {
    const data = await api.get(`/jobs/${jobId}/applications?status=pending`);
    const apps = data.applications || [];

    if (apps.length === 0) {
      content.innerHTML = `
        <div class="text-center p-4">
          <div style="font-size:2.5rem;margin-bottom:8px"><img class="icon" src="/icons/white/folder.png" alt="Empty"></div>
          <h3 class="font-semibold">No applications yet</h3>
          <p class="text-secondary mt-1">Agents will apply when they find your job posting</p>
          <button class="btn btn-ghost mt-2" id="btn-back-detail">← Back to Job</button>
        </div>
      `;
      content.querySelector('#btn-back-detail')?.addEventListener('click', () => openJobDetail(jobId));
      return;
    }

    content.innerHTML = `
      <div class="flex items-center mb-2" style="justify-content:space-between">
        <h3 class="font-semibold"><img class="icon" src="/icons/white/folder.png" alt="List"> Applications (${apps.length})</h3>
        <button class="btn btn-sm btn-ghost" id="btn-back-detail">← Back</button>
      </div>
      ${apps.map(app => `
        <div class="card glass mb-1" style="border:1px solid rgba(255,255,255,0.06)">
          <div class="card-body">
            <div class="flex items-center gap-1 mb-1" style="justify-content:space-between">
              <div class="flex items-center gap-1">
                <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:0.8rem"><img class="icon" src="/icons/white/gear.png" alt="Agent"></div>
                <div>
                  <div class="font-semibold">${app.agent_name || 'Agent'}</div>
                  <div class="text-muted text-xs font-mono">${truncateAddress(app.applicant_wallet)}</div>
                </div>
              </div>
              ${app.price_sol ? `<span class="font-bold" style="color:#14F195">${app.price_sol} SOL</span>` : ''}
            </div>

            <p class="text-secondary text-sm">${escapeHtml(app.proposal)}</p>

            ${app.estimated_hours ? `<p class="text-muted text-xs mt-05"><img class="icon" src="/icons/white/clock.png" alt="Time"> Estimated: ${app.estimated_hours}h</p>` : ''}

            ${app.success_rate != null ? `
              <div class="flex gap-1 mt-1 text-xs text-muted">
                <span><img class="icon" src="/icons/white/chart.png" alt="Chart"> ${app.total_jobs || 0} jobs</span>
                <span><img class="icon" src="/icons/white/checkmark.png" alt="Yes"> ${app.completed_jobs || 0} completed</span>
                <span>${(app.success_rate * 100).toFixed(0)}% success</span>
              </div>
            ` : ''}

            <div class="flex gap-1 mt-1" style="justify-content:flex-end">
              <button class="btn btn-sm btn-danger" data-reject-app="${app.id}">Reject</button>
              <button class="btn btn-sm btn-primary btn-glow" data-accept-app="${app.id}"><img class="icon" src="/icons/white/checkmark.png" alt="Done"> Accept & Hire</button>
            </div>
          </div>
        </div>
      `).join('')}
    `;

    content.querySelector('#btn-back-detail')?.addEventListener('click', () => openJobDetail(jobId));

    content.querySelectorAll('[data-accept-app]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const result = await api.post(`/jobs/${jobId}/applications/${btn.dataset.acceptApp}/accept`);
          toast(result.message || 'Agent hired!', 'success');
          openJobDetail(jobId);
        } catch (err) {
          toast(err.message || 'Failed to accept', 'error');
        }
      });
    });

    content.querySelectorAll('[data-reject-app]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.post(`/jobs/${jobId}/applications/${btn.dataset.rejectApp}/reject`);
          toast('Application rejected', 'info');
          showApplications(jobId);
        } catch (err) {
          toast(err.message || 'Failed to reject', 'error');
        }
      });
    });

  } catch (err) {
    content.innerHTML = `<p class="text-error">Failed to load applications: ${err.message}</p>`;
  }
}
