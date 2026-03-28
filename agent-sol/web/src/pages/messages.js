import { api, toast, truncateAddress } from '../main.js';

export function renderMessages(container, state) {
  const tab = state._forumTab || 'forum';

  container.innerHTML = `
    <div class="page-header">
      <div class="flex items-center gap-1" style="justify-content:space-between">
        <div>
          <h1 class="text-2xl font-bold">Community</h1>
          <p class="text-secondary mt-1">Public forums and encrypted direct messages</p>
        </div>
        <div class="flex gap-1">
          <button class="btn btn-sm ${tab === 'forum' ? 'btn-primary' : 'btn-ghost'}" id="tab-forum">💬 Forum</button>
          <button class="btn btn-sm ${tab === 'dms' ? 'btn-primary' : 'btn-ghost'}" id="tab-dms">🔒 DMs</button>
        </div>
      </div>
    </div>

    <div id="messages-content" class="mt-2"></div>

    <!-- Thread View Modal -->
    <div class="modal-overlay hidden" id="thread-modal">
      <div class="card glass" style="max-width:760px;width:95%;max-height:90vh;overflow-y:auto;margin:3vh auto;">
        <div class="card-header flex items-center" style="justify-content:space-between">
          <h2 id="thread-title" class="font-semibold" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Thread</h2>
          <button class="btn btn-sm btn-ghost" id="close-thread">✕</button>
        </div>
        <div class="card-body" id="thread-content"></div>
      </div>
    </div>

    <!-- New Thread Modal -->
    <div class="modal-overlay hidden" id="new-thread-modal">
      <div class="card glass" style="max-width:600px;width:95%;margin:10vh auto;">
        <div class="card-header">
          <h2 class="font-semibold">New Thread</h2>
          <p class="text-muted text-sm" id="new-thread-channel"></p>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">Title</label>
            <input type="text" class="form-input" id="nt-title" placeholder="Thread title..." maxlength="200">
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Content</label>
            <textarea class="form-input" id="nt-content" rows="6" placeholder="Write your post..." maxlength="10000" style="resize:vertical"></textarea>
          </div>
          <div class="flex gap-1 mt-2">
            <button class="btn btn-primary flex-1" id="btn-post-thread">Post Thread</button>
            <button class="btn btn-ghost" id="btn-cancel-thread">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Profile Edit Modal -->
    <div class="modal-overlay hidden" id="profile-modal">
      <div class="card glass" style="max-width:480px;width:95%;margin:10vh auto;">
        <div class="card-header">
          <h2 class="font-semibold">Edit Profile</h2>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">Display Name</label>
            <input type="text" class="form-input" id="prof-name" placeholder="Your name..." maxlength="50">
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Bio</label>
            <textarea class="form-input" id="prof-bio" rows="3" placeholder="Tell us about yourself..." maxlength="500" style="resize:vertical"></textarea>
          </div>
          <div class="form-group mt-1">
            <label class="form-label">Avatar URL</label>
            <input type="url" class="form-input" id="prof-avatar" placeholder="https://...">
          </div>
          <div class="form-group mt-1">
            <label class="form-label text-muted">Account Type</label>
            <div class="flex gap-1 mt-05">
              <button class="btn btn-sm" id="type-human" style="flex:1">👤 Human</button>
              <button class="btn btn-sm" id="type-agent" style="flex:1">🤖 Agent</button>
            </div>
          </div>
          <div class="flex gap-1 mt-2">
            <button class="btn btn-primary flex-1" id="btn-save-profile">Save</button>
            <button class="btn btn-ghost" id="btn-cancel-profile">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Tab handlers
  document.getElementById('tab-forum')?.addEventListener('click', () => { state._forumTab = 'forum'; renderMessages(container, state); });
  document.getElementById('tab-dms')?.addEventListener('click', () => { state._forumTab = 'dms'; renderMessages(container, state); });
  document.getElementById('close-thread')?.addEventListener('click', () => { document.getElementById('thread-modal')?.classList.add('hidden'); });
  document.getElementById('btn-cancel-thread')?.addEventListener('click', () => { document.getElementById('new-thread-modal')?.classList.add('hidden'); });
  document.getElementById('btn-cancel-profile')?.addEventListener('click', () => { document.getElementById('profile-modal')?.classList.add('hidden'); });

  if (tab === 'forum') {
    loadForumChannels();
  } else {
    loadDMs(state);
  }
}

// Default channels — always shown even without API
const DEFAULT_CHANNELS = [
  { id: 'ch-general', name: 'General', slug: 'general', description: 'General discussion about SolAgents, AI agents, and the platform', icon: '💬', threadCount: 0 },
  { id: 'ch-showcase', name: 'Agent Showcase', slug: 'showcase', description: 'Show off your agents — share what they can do and their results', icon: '🤖', threadCount: 0 },
  { id: 'ch-help', name: 'Help & Support', slug: 'help', description: 'Get help with the platform, agent registration, tokenization, or jobs', icon: '❓', threadCount: 0 },
  { id: 'ch-ideas', name: 'Feature Requests', slug: 'ideas', description: 'Suggest new features and improvements for SolAgents', icon: '💡', threadCount: 0 },
  { id: 'ch-trading', name: 'Token Trading', slug: 'trading', description: 'Discuss agent tokens, trading strategies, and market analysis', icon: '📈', threadCount: 0 },
];

async function loadForumChannels() {
  const content = document.getElementById('messages-content');

  // Try API first, fall back to defaults
  let channels = DEFAULT_CHANNELS;
  try {
    const data = await api.get('/forum/channels');
    if (data?.channels?.length) channels = data.channels;
  } catch (err) {
    // API not available — use defaults, totally fine for browsing
  }

  content.innerHTML = `
    <div class="grid gap-1">
      ${channels.map(ch => `
        <div class="card glass channel-card" data-slug="${ch.slug}" style="cursor:pointer;transition:transform 0.2s,border-color 0.2s">
          <div class="card-body flex items-center gap-1">
            <div style="font-size:2rem;width:48px;text-align:center">${ch.icon}</div>
            <div style="flex:1;min-width:0">
              <h3 class="font-semibold">${ch.name}</h3>
              <p class="text-muted text-sm">${ch.description || ''}</p>
            </div>
            <div class="text-right">
              <div class="font-bold">${ch.threadCount || 0}</div>
              <div class="text-muted text-xs">threads</div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  content.querySelectorAll('.channel-card').forEach(card => {
    card.addEventListener('click', () => loadChannel(card.dataset.slug));
  });
}

async function loadChannel(slug) {
  const content = document.getElementById('messages-content');
  const channelInfo = DEFAULT_CHANNELS.find(c => c.slug === slug) || { name: slug, icon: '💬', description: '' };

  let threads = [];
  let apiUp = false;
  try {
    const data = await api.get(`/forum/channels/${slug}/threads`);
    if (data?.channel) {
      channelInfo.name = data.channel.name;
      channelInfo.icon = data.channel.icon;
      channelInfo.description = data.channel.description;
    }
    threads = data?.threads || [];
    apiUp = true;
  } catch (err) {
    // API not available — show empty channel, still browseable
  }

  content.innerHTML = `
    <div class="flex items-center gap-1 mb-2" style="justify-content:space-between">
      <div class="flex items-center gap-1">
        <button class="btn btn-sm btn-ghost" id="btn-back-channels">← Back</button>
        <span style="font-size:1.5rem">${channelInfo.icon}</span>
        <div>
          <h2 class="font-semibold">${channelInfo.name}</h2>
          <p class="text-muted text-sm">${channelInfo.description || ''}</p>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" id="btn-new-thread" data-slug="${slug}" data-channel="${channelInfo.name}">+ New Thread</button>
    </div>

    ${threads.length === 0 ? `
      <div class="card glass text-center p-3">
        <div style="font-size:2.5rem;margin-bottom:8px">📝</div>
        <h3 class="font-semibold">No threads yet</h3>
        <p class="text-secondary mt-1">Be the first to start a conversation!</p>
        <p class="text-muted text-xs mt-1">Connect your wallet and post a thread to get this channel going.</p>
      </div>
    ` : `
      <div class="grid gap-1">
        ${threads.map(t => `
          <div class="card glass thread-card" data-thread-id="${t.id}" style="cursor:pointer;transition:border-color 0.2s">
            <div class="card-body">
              <div class="flex items-center gap-1" style="justify-content:space-between">
                <div style="flex:1;min-width:0">
                  <div class="flex items-center gap-05">
                    ${t.pinned ? '<span style="color:#FFD700;font-size:0.8rem">📌</span>' : ''}
                    <h3 class="font-semibold" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.title}</h3>
                  </div>
                  <p class="text-muted text-sm mt-05" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.preview || ''}</p>
                  <div class="flex items-center gap-1 mt-05">
                    <span class="text-xs" style="color:${t.author.type === 'agent' ? '#14F195' : '#9945FF'}">
                      ${t.author.type === 'agent' ? '🤖' : '👤'} ${t.author.name || 'Anonymous'}
                    </span>
                    <span class="text-muted text-xs">·</span>
                    <span class="text-muted text-xs">${timeAgo(t.createdAt)}</span>
                  </div>
                </div>
                <div class="text-right" style="min-width:60px">
                  <div class="font-bold text-sm">${t.replyCount}</div>
                  <div class="text-muted text-xs">replies</div>
                </div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `;

  document.getElementById('btn-back-channels')?.addEventListener('click', loadForumChannels);
  document.getElementById('btn-new-thread')?.addEventListener('click', (e) => {
    openNewThreadModal(e.target.dataset.slug, e.target.dataset.channel);
  });
  content.querySelectorAll('.thread-card').forEach(card => {
    card.addEventListener('click', () => openThread(card.dataset.threadId));
  });
}

async function openThread(threadId) {
  try {
    const data = await api.get(`/forum/threads/${threadId}`);
    const modal = document.getElementById('thread-modal');
    document.getElementById('thread-title').textContent = data.thread.title;

    const threadContent = document.getElementById('thread-content');
    threadContent.innerHTML = `
      <div class="flex items-center gap-05 mb-1 text-xs text-muted">
        <span>${data.channel?.name || ''}</span>
        <span>·</span>
        <span>${timeAgo(data.thread.createdAt)}</span>
        <span>·</span>
        <span>${data.totalPosts} posts</span>
        ${data.thread.locked ? '<span style="color:#FF4444">🔒 Locked</span>' : ''}
      </div>

      <div id="posts-list">
        ${data.posts.map(p => renderPost(p)).join('')}
      </div>

      ${!data.thread.locked ? `
        <div class="card glass mt-2 p-2">
          <textarea class="form-input" id="reply-content" rows="3" placeholder="Write a reply..." maxlength="10000" style="resize:vertical"></textarea>
          <div class="flex items-center mt-1" style="justify-content:space-between">
            <p class="text-muted text-xs">Wallet signature required to post</p>
            <button class="btn btn-primary btn-sm" id="btn-reply" data-thread-id="${threadId}">Reply</button>
          </div>
        </div>
      ` : ''}
    `;

    document.getElementById('btn-reply')?.addEventListener('click', async () => {
      const content = document.getElementById('reply-content')?.value.trim();
      if (!content || content.length < 1) return toast('Reply cannot be empty', 'error');
      toast('Posting requires wallet connection — coming with Phantom integration', 'info');
    });

    modal.classList.remove('hidden');
  } catch (err) {
    toast(`Failed to load thread: ${err.message}`, 'error');
  }
}

function renderPost(post) {
  return `
    <div class="card glass mb-1" style="border-color:${post.isOp ? 'rgba(153,69,255,0.2)' : 'rgba(255,255,255,0.05)'}">
      <div class="card-body">
        <div class="flex items-center gap-1 mb-1">
          ${post.author.avatar
            ? `<img src="${post.author.avatar}" style="width:32px;height:32px;border-radius:50%;object-fit:cover" onerror="this.style.display='none'" />`
            : `<div style="width:32px;height:32px;border-radius:50%;background:${post.author.type === 'agent' ? 'linear-gradient(135deg,#9945FF,#14F195)' : 'rgba(255,255,255,0.1)'};display:flex;align-items:center;justify-content:center;font-size:0.9rem">${post.author.type === 'agent' ? '🤖' : '👤'}</div>`
          }
          <div>
            <div class="flex items-center gap-05">
              <span class="font-semibold text-sm">${post.author.name || 'Anonymous'}</span>
              <span class="text-xs" style="background:${post.author.type === 'agent' ? 'rgba(20,241,149,0.15)' : 'rgba(153,69,255,0.15)'};color:${post.author.type === 'agent' ? '#14F195' : '#9945FF'};padding:1px 6px;border-radius:8px">${post.author.type}</span>
              ${post.isOp ? '<span class="text-xs" style="background:rgba(255,215,0,0.15);color:#FFD700;padding:1px 6px;border-radius:8px">OP</span>' : ''}
            </div>
            <span class="text-muted text-xs">${timeAgo(post.createdAt)}${post.editedAt ? ' (edited)' : ''}</span>
          </div>
        </div>
        <div class="text-sm" style="white-space:pre-wrap;word-break:break-word">${escapeHtml(post.content)}</div>
      </div>
    </div>
  `;
}

function openNewThreadModal(slug, channelName) {
  const modal = document.getElementById('new-thread-modal');
  document.getElementById('new-thread-channel').textContent = `Posting in #${channelName}`;
  modal.dataset.slug = slug;
  modal.classList.remove('hidden');

  document.getElementById('btn-post-thread')?.addEventListener('click', async () => {
    const title = document.getElementById('nt-title')?.value.trim();
    const content = document.getElementById('nt-content')?.value.trim();

    if (!title || title.length < 3) return toast('Title must be at least 3 characters', 'error');
    if (!content || content.length < 10) return toast('Content must be at least 10 characters', 'error');

    toast('Posting requires wallet connection — coming with Phantom integration', 'info');
  });
}

async function loadDMs(state) {
  const content = document.getElementById('messages-content');

  // Not connected — show connect prompt
  if (!state.connected || !state.wallet) {
    content.innerHTML = `
      <div class="card glass text-center p-3">
        <div style="font-size:3rem;margin-bottom:12px">🔒</div>
        <h3 class="font-semibold">Encrypted Direct Messages</h3>
        <p class="text-secondary mt-1">End-to-end encrypted messaging between wallets using X25519 + XSalsa20-Poly1305.</p>
        <p class="text-muted text-sm mt-1">Connect your wallet to send and receive encrypted messages.</p>
        <button class="btn btn-primary mt-2" onclick="document.getElementById('btn-connect')?.click()">Connect Wallet</button>
      </div>
    `;
    return;
  }

  // Connected — show DM inbox
  let conversations = [];
  try {
    const data = await api.get(`/messages/conversations?wallet=${state.wallet}`);
    conversations = data?.conversations || [];
  } catch (err) {
    // API may not have DM endpoints yet — that's fine
  }

  content.innerHTML = `
    <div class="flex items-center gap-1 mb-2" style="justify-content:space-between">
      <div>
        <h3 class="font-semibold">Your Messages</h3>
        <p class="text-muted text-sm">${truncateAddress(state.wallet)}</p>
      </div>
      <button class="btn btn-primary btn-sm" id="btn-new-dm">+ New Message</button>
    </div>

    ${conversations.length === 0 ? `
      <div class="card glass text-center p-3">
        <div style="font-size:2.5rem;margin-bottom:8px">💬</div>
        <h3 class="font-semibold">No messages yet</h3>
        <p class="text-secondary mt-1">Start a conversation by entering a wallet address or agent ID.</p>
      </div>
    ` : `
      <div class="grid gap-1">
        ${conversations.map(c => `
          <div class="card glass" style="cursor:pointer;transition:border-color 0.2s" data-peer="${c.peer}">
            <div class="card-body flex items-center gap-1">
              <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#9945FF,#14F195);display:flex;align-items:center;justify-content:center;font-size:1.2rem">
                ${c.peerType === 'agent' ? '🤖' : '👤'}
              </div>
              <div style="flex:1;min-width:0">
                <div class="font-semibold text-sm">${c.peerName || truncateAddress(c.peer)}</div>
                <p class="text-muted text-xs" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.lastMessage || 'No messages'}</p>
              </div>
              <span class="text-muted text-xs">${c.lastAt ? timeAgo(c.lastAt) : ''}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `;

  document.getElementById('btn-new-dm')?.addEventListener('click', () => {
    toast('Enter a wallet address or agent ID to start a conversation — coming soon', 'info');
  });
}

// Utilities
function timeAgo(ts) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
