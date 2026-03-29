import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'agent-sol.db'));

// WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === Schema ===

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    wallet_address TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    name TEXT,
    capabilities TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    registration_tx TEXT NOT NULL,
    registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen INTEGER,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned'))
  );

  CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet_address);

  -- User accounts (humans + agents unified)
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    wallet_address TEXT UNIQUE NOT NULL,
    display_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    account_type TEXT NOT NULL DEFAULT 'human' CHECK(account_type IN ('human', 'agent')),
    agent_id TEXT REFERENCES agents(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active INTEGER DEFAULT (unixepoch()),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned'))
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_wallet ON accounts(wallet_address);
  CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(account_type);

  -- Forum channels
  CREATE TABLE IF NOT EXISTS forum_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '💬',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Forum threads
  CREATE TABLE IF NOT EXISTS forum_threads (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES forum_channels(id),
    author_id TEXT NOT NULL REFERENCES accounts(id),
    title TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    last_reply_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_forum_threads_channel ON forum_threads(channel_id, pinned DESC, last_reply_at DESC);
  CREATE INDEX IF NOT EXISTS idx_forum_threads_author ON forum_threads(author_id);

  -- Forum posts (first post = thread body, rest = replies)
  CREATE TABLE IF NOT EXISTS forum_posts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES forum_threads(id),
    author_id TEXT NOT NULL REFERENCES accounts(id),
    content TEXT NOT NULL,
    is_op INTEGER DEFAULT 0,
    edited_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_forum_posts_thread ON forum_posts(thread_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_forum_posts_author ON forum_posts(author_id);

  -- Seed default forum channels
  INSERT OR IGNORE INTO forum_channels (id, name, slug, description, icon, sort_order) VALUES
    ('ch-general', 'General', 'general', 'General discussion about SolAgents, AI agents, and the platform', '💬', 1),
    ('ch-showcase', 'Agent Showcase', 'showcase', 'Show off your agents — share what they can do and their results', '🤖', 2),
    ('ch-help', 'Help & Support', 'help', 'Get help with the platform, agent registration, tokenization, or jobs', '❓', 3),
    ('ch-ideas', 'Feature Requests', 'ideas', 'Suggest new features and improvements for SolAgents', '💡', 4),
    ('ch-trading', 'Token Trading', 'trading', 'Discuss agent tokens, trading strategies, and market analysis', '📈', 5);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES agents(id),
    recipient_id TEXT NOT NULL REFERENCES agents(id),
    thread_id TEXT,
    encrypted_payload TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ephemeral_pubkey TEXT,
    content_type TEXT DEFAULT 'text',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    read_at INTEGER,
    FOREIGN KEY (thread_id) REFERENCES messages(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    type TEXT NOT NULL CHECK(type IN ('swap', 'perp_open', 'perp_close', 'perp_modify')),
    input_token TEXT,
    output_token TEXT,
    amount TEXT,
    result TEXT,
    tx_signature TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'submitted', 'confirmed', 'failed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES agents(id),
    recipient_id TEXT NOT NULL REFERENCES agents(id),
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    tx_signature TEXT,
    escrow_id TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'failed', 'escrowed', 'released', 'refunded')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS escrows (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES agents(id),
    counterparty_id TEXT NOT NULL REFERENCES agents(id),
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    condition TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'released', 'refunded', 'expired')),
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS card_orders (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    card_type TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    payment_tx TEXT,
    provider_ref TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'delivered', 'failed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );

  -- Agentic Commerce Protocol (EIP-8183 on Solana) —
  -- Local index of on-chain job state for fast API queries.
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    provider TEXT,
    evaluator TEXT NOT NULL,
    description TEXT NOT NULL,
    budget INTEGER DEFAULT 0,
    expired_at INTEGER NOT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'funded', 'submitted', 'completed', 'rejected', 'expired', 'pending_open', 'pending_funded', 'pending_submitted', 'pending_completed', 'pending_rejected', 'pending_expired')),
    deliverable TEXT,
    reason TEXT,
    hook TEXT,
    onchain_address TEXT,
    onchain_job_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
  CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs(provider);
  CREATE INDEX IF NOT EXISTS idx_jobs_evaluator ON jobs(evaluator);
  CREATE INDEX IF NOT EXISTS idx_jobs_expired ON jobs(expired_at);

  -- Agent Tokens — tokenized agents with trading data
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    token_name TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    mint_address TEXT UNIQUE,
    pool_address TEXT,
    total_supply TEXT NOT NULL DEFAULT '1000000000',
    creator_wallet TEXT NOT NULL,
    creator_fee_bps INTEGER NOT NULL DEFAULT 140,
    platform_fee_bps INTEGER NOT NULL DEFAULT 60,
    logo_url TEXT,
    description TEXT,
    agent_description TEXT,
    social_twitter TEXT,
    social_telegram TEXT,
    social_discord TEXT,
    social_website TEXT,
    ipfs_logo_cid TEXT,
    ipfs_metadata_cid TEXT,
    metadata_uri TEXT,
    lp_locked INTEGER NOT NULL DEFAULT 1,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'minting', 'active', 'graduating', 'graduated', 'failed')),
    launch_tx TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    launched_at INTEGER,
    UNIQUE(agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_tokens_mint ON agent_tokens(mint_address);
  CREATE INDEX IF NOT EXISTS idx_agent_tokens_status ON agent_tokens(status);

  -- Token price snapshots for charts
  CREATE TABLE IF NOT EXISTS token_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL REFERENCES agent_tokens(id),
    price_sol TEXT NOT NULL,
    price_usd TEXT,
    volume_24h TEXT DEFAULT '0',
    market_cap TEXT DEFAULT '0',
    holders INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_token_prices_token ON token_prices(token_id, timestamp DESC);

  -- Token trades for history
  CREATE TABLE IF NOT EXISTS token_trades (
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES agent_tokens(id),
    trader_wallet TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
    amount_token TEXT NOT NULL,
    amount_sol TEXT NOT NULL,
    price_per_token TEXT NOT NULL,
    tx_signature TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_token_trades_token ON token_trades(token_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_token_trades_trader ON token_trades(trader_wallet, timestamp DESC);

  -- Fee accruals for agents (from token trading + job completion)
  CREATE TABLE IF NOT EXISTS fee_accruals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    source TEXT NOT NULL CHECK(source IN ('token_trade', 'job_completion', 'platform_fee')),
    amount_lamports INTEGER NOT NULL DEFAULT 0,
    amount_token TEXT,
    token_mint TEXT,
    reference_id TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    claim_tx TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    claimed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_fee_accruals_agent ON fee_accruals(agent_id, claimed);
  CREATE INDEX IF NOT EXISTS idx_fee_accruals_source ON fee_accruals(source);

  -- Bonding curve pool state for agent tokens
  CREATE TABLE IF NOT EXISTS token_pools (
    token_id TEXT PRIMARY KEY REFERENCES agent_tokens(id),
    virtual_sol_reserve TEXT NOT NULL DEFAULT '30000000000',
    virtual_token_reserve TEXT NOT NULL DEFAULT '1000000000000000000',
    real_sol_reserve TEXT NOT NULL DEFAULT '0',
    real_token_reserve TEXT NOT NULL DEFAULT '1000000000000000000',
    k TEXT NOT NULL,
    total_supply TEXT NOT NULL DEFAULT '1000000000000000000',
    circulating_supply TEXT NOT NULL DEFAULT '0',
    current_price_lamports TEXT NOT NULL DEFAULT '30',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'graduated')),
    graduated_at INTEGER,
    raydium_pool_address TEXT,
    creator_fees_earned TEXT NOT NULL DEFAULT '0',
    creator_fees_claimed TEXT NOT NULL DEFAULT '0',
    platform_fees_earned TEXT NOT NULL DEFAULT '0',
    platform_fees_claimed TEXT NOT NULL DEFAULT '0',
    total_volume_sol TEXT NOT NULL DEFAULT '0',
    total_trades INTEGER NOT NULL DEFAULT 0,
    total_buys INTEGER NOT NULL DEFAULT 0,
    total_sells INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Migrations (safe to re-run)
  -- v2: add total_buys/total_sells to token_pools

  -- Dev buy tracking
  CREATE TABLE IF NOT EXISTS dev_buys (
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES agent_tokens(id),
    dev_wallet TEXT NOT NULL,
    amount_sol TEXT NOT NULL,
    amount_token TEXT NOT NULL,
    price_per_token TEXT NOT NULL,
    tx_signature TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_dev_buys_token ON dev_buys(token_id);

  -- Fee claims (tracks when creators claim their accrued fees)
  CREATE TABLE IF NOT EXISTS fee_claims (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    creator_amount_lamports INTEGER NOT NULL,
    platform_amount_lamports INTEGER NOT NULL,
    total_amount_lamports INTEGER NOT NULL,
    payout_tx TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_fee_claims_agent ON fee_claims(agent_id, created_at DESC);

  -- Service Listings — agents offering services for purchase
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    agent_wallet TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('audit', 'development', 'review', 'deployment', 'consulting', 'integration', 'testing', 'documentation', 'other')),
    price_lamports INTEGER NOT NULL,
    delivery_hours INTEGER NOT NULL DEFAULT 72,
    max_concurrent INTEGER NOT NULL DEFAULT 3,
    active_orders INTEGER NOT NULL DEFAULT 0,
    requirements TEXT DEFAULT '',
    deliverables TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
    total_completed INTEGER NOT NULL DEFAULT 0,
    total_earned_lamports INTEGER NOT NULL DEFAULT 0,
    avg_rating REAL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_services_agent ON services(agent_id);
  CREATE INDEX IF NOT EXISTS idx_services_category ON services(category, status);
  CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

  -- Service Orders — when someone purchases a service
  CREATE TABLE IF NOT EXISTS service_orders (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id),
    job_id TEXT REFERENCES jobs(id),
    buyer_wallet TEXT NOT NULL,
    provider_wallet TEXT NOT NULL,
    price_lamports INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'funded', 'in_progress', 'submitted', 'completed', 'rejected', 'refunded', 'expired')),
    buyer_notes TEXT,
    deliverable TEXT,
    rating INTEGER CHECK(rating >= 1 AND rating <= 5),
    review TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_service_orders_service ON service_orders(service_id);
  CREATE INDEX IF NOT EXISTS idx_service_orders_buyer ON service_orders(buyer_wallet);
  CREATE INDEX IF NOT EXISTS idx_service_orders_provider ON service_orders(provider_wallet);
  CREATE INDEX IF NOT EXISTS idx_service_orders_status ON service_orders(status);

  -- Job Applications — agents applying to job postings
  CREATE TABLE IF NOT EXISTS job_applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    applicant_wallet TEXT NOT NULL,
    agent_id TEXT REFERENCES agents(id),
    proposal TEXT NOT NULL,
    price_lamports INTEGER,
    estimated_hours INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(job_id, applicant_wallet)
  );

  CREATE INDEX IF NOT EXISTS idx_job_applications_job ON job_applications(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_job_applications_applicant ON job_applications(applicant_wallet);

  -- Agent stats cache (updated on job completion)
  CREATE TABLE IF NOT EXISTS agent_stats (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    total_jobs INTEGER DEFAULT 0,
    completed_jobs INTEGER DEFAULT 0,
    rejected_jobs INTEGER DEFAULT 0,
    total_earned TEXT DEFAULT '0',
    avg_rating REAL DEFAULT 0,
    success_rate REAL DEFAULT 0,
    total_fees_earned TEXT DEFAULT '0',
    total_fees_claimed TEXT DEFAULT '0',
    token_id TEXT REFERENCES agent_tokens(id),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// === Migrations (safe to re-run) ===
try { db.exec('ALTER TABLE token_pools ADD COLUMN total_buys INTEGER NOT NULL DEFAULT 0'); } catch (_) { /* already exists */ }
try { db.exec('ALTER TABLE token_pools ADD COLUMN total_sells INTEGER NOT NULL DEFAULT 0'); } catch (_) { /* already exists */ }

// v4: Social + IPFS columns for agent_tokens
const socialIpfsMigrations = [
  `ALTER TABLE agent_tokens ADD COLUMN social_twitter TEXT`,
  `ALTER TABLE agent_tokens ADD COLUMN social_telegram TEXT`,
  `ALTER TABLE agent_tokens ADD COLUMN social_discord TEXT`,
  `ALTER TABLE agent_tokens ADD COLUMN social_website TEXT`,
  `ALTER TABLE agent_tokens ADD COLUMN ipfs_logo_cid TEXT`,
  `ALTER TABLE agent_tokens ADD COLUMN ipfs_metadata_cid TEXT`,
];
for (const sql of socialIpfsMigrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// v5: Expand jobs status CHECK to include pending_* states (SQLite requires table recreate)
try {
  const hasOldConstraint = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`).get();
  if (hasOldConstraint && hasOldConstraint.sql && !hasOldConstraint.sql.includes('pending_open')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs_new (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        provider TEXT,
        evaluator TEXT NOT NULL,
        description TEXT NOT NULL,
        budget INTEGER DEFAULT 0,
        expired_at INTEGER NOT NULL,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'funded', 'submitted', 'completed', 'rejected', 'expired', 'pending_open', 'pending_funded', 'pending_submitted', 'pending_completed', 'pending_rejected', 'pending_expired')),
        deliverable TEXT,
        reason TEXT,
        hook TEXT,
        onchain_address TEXT,
        onchain_job_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        auto_release_at INTEGER DEFAULT NULL,
        settled_at INTEGER DEFAULT NULL,
        funded_at INTEGER DEFAULT NULL,
        submitted_at INTEGER DEFAULT NULL,
        dispute_status TEXT DEFAULT NULL
      );
      INSERT INTO jobs_new SELECT id, client, provider, evaluator, description, budget, expired_at, status, deliverable, reason, hook, onchain_address, onchain_job_id, created_at, completed_at, auto_release_at, settled_at, funded_at, submitted_at, dispute_status FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
      CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs(provider);
    `);
  }
} catch (e) { console.warn('jobs migration:', e.message); }

// v3: Job lifecycle columns
try { db.exec('ALTER TABLE jobs ADD COLUMN auto_release_at INTEGER DEFAULT NULL'); } catch (_) { /* already exists */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN settled_at INTEGER DEFAULT NULL'); } catch (_) { /* already exists */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN funded_at INTEGER DEFAULT NULL'); } catch (_) { /* already exists */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN submitted_at INTEGER DEFAULT NULL'); } catch (_) { /* already exists */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN dispute_status TEXT DEFAULT NULL'); } catch (_) { /* already exists */ }

// v3: Disputes table
db.exec(`
  CREATE TABLE IF NOT EXISTS disputes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    raised_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
    resolution TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    resolved_at INTEGER,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_disputes_job ON disputes(job_id);
  CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
`);

// v5: Add 'graduating' to agent_tokens status CHECK constraint
// SQLite doesn't support ALTER CHECK — must recreate the table
try {
  const hasGraduating = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_tokens'"
  ).get();
  if (hasGraduating?.sql && !hasGraduating.sql.includes('graduating')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS agent_tokens_new');
    db.exec(`
      CREATE TABLE agent_tokens_new (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        token_name TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        mint_address TEXT UNIQUE,
        pool_address TEXT,
        total_supply TEXT NOT NULL DEFAULT '1000000000',
        creator_wallet TEXT NOT NULL,
        creator_fee_bps INTEGER NOT NULL DEFAULT 140,
        platform_fee_bps INTEGER NOT NULL DEFAULT 60,
        logo_url TEXT,
        description TEXT,
        agent_description TEXT,
        social_twitter TEXT,
        social_telegram TEXT,
        social_discord TEXT,
        social_website TEXT,
        ipfs_logo_cid TEXT,
        ipfs_metadata_cid TEXT,
        metadata_uri TEXT,
        lp_locked INTEGER NOT NULL DEFAULT 1,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'minting', 'active', 'graduating', 'graduated', 'failed')),
        launch_tx TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        launched_at INTEGER,
        UNIQUE(agent_id)
      );
      INSERT INTO agent_tokens_new SELECT
        id, agent_id, token_name, token_symbol, mint_address, pool_address, total_supply,
        creator_wallet, creator_fee_bps, platform_fee_bps, logo_url, description, agent_description,
        social_twitter, social_telegram, social_discord, social_website, ipfs_logo_cid, ipfs_metadata_cid,
        metadata_uri, COALESCE(lp_locked, 1), status, launch_tx, created_at, launched_at
      FROM agent_tokens;
      DROP TABLE agent_tokens;
      ALTER TABLE agent_tokens_new RENAME TO agent_tokens;
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_mint ON agent_tokens(mint_address);
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_status ON agent_tokens(status);
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[migration] v5: Added graduating status to agent_tokens');
  }
} catch (e) {
  console.error('[migration] v5 failed:', e.message);
}

// === Prepared Statements ===

export const stmts = {
  // Agents
  insertAgent: db.prepare(`
    INSERT INTO agents (id, wallet_address, public_key, name, capabilities, metadata, registration_tx)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  getAgentByWallet: db.prepare('SELECT * FROM agents WHERE wallet_address = ?'),
  listAgents: db.prepare('SELECT id, wallet_address, name, capabilities, registered_at, status FROM agents WHERE status = ? ORDER BY registered_at DESC LIMIT ? OFFSET ?'),
  updateLastSeen: db.prepare('UPDATE agents SET last_seen = unixepoch() WHERE id = ?'),

  // Messages
  insertMessage: db.prepare(`
    INSERT INTO messages (id, sender_id, recipient_id, thread_id, encrypted_payload, nonce, ephemeral_pubkey, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getInbox: db.prepare(`
    SELECT m.*, a.name as sender_name, a.wallet_address as sender_wallet
    FROM messages m JOIN agents a ON m.sender_id = a.id
    WHERE m.recipient_id = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `),
  getOutbox: db.prepare(`
    SELECT m.*, a.name as recipient_name, a.wallet_address as recipient_wallet
    FROM messages m JOIN agents a ON m.recipient_id = a.id
    WHERE m.sender_id = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `),
  getThread: db.prepare(`
    SELECT m.*, a.name as sender_name FROM messages m
    JOIN agents a ON m.sender_id = a.id
    WHERE m.thread_id = ? OR m.id = ? ORDER BY m.created_at ASC
  `),
  markRead: db.prepare('UPDATE messages SET read_at = unixepoch() WHERE id = ? AND recipient_id = ?'),

  // Trades
  insertTrade: db.prepare(`
    INSERT INTO trades (id, agent_id, type, input_token, output_token, amount, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `),
  updateTrade: db.prepare('UPDATE trades SET status = ?, result = ?, tx_signature = ?, completed_at = unixepoch() WHERE id = ?'),
  getAgentTrades: db.prepare('SELECT * FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),

  // Transfers
  insertTransfer: db.prepare(`
    INSERT INTO transfers (id, sender_id, recipient_id, token, amount, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `),
  updateTransfer: db.prepare('UPDATE transfers SET status = ?, tx_signature = ?, completed_at = unixepoch() WHERE id = ?'),

  // Escrows
  insertEscrow: db.prepare(`
    INSERT INTO escrows (id, creator_id, counterparty_id, token, amount, condition, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateEscrow: db.prepare('UPDATE escrows SET status = ? WHERE id = ?'),
  getEscrow: db.prepare('SELECT * FROM escrows WHERE id = ?'),

  // Cards
  insertCardOrder: db.prepare(`
    INSERT INTO card_orders (id, agent_id, card_type, amount, currency)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateCardOrder: db.prepare('UPDATE card_orders SET status = ?, provider_ref = ?, payment_tx = ?, completed_at = unixepoch() WHERE id = ?'),
  getAgentCards: db.prepare('SELECT * FROM card_orders WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'),

  // Jobs (Agentic Commerce / EIP-8183)
  insertJob: db.prepare(`
    INSERT INTO jobs (id, client, provider, evaluator, description, budget, expired_at, status, hook, onchain_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `),
  getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
  listAllJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  listJobsByStatus: db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  listJobsByClient: db.prepare('SELECT * FROM jobs WHERE client = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  listJobsByProvider: db.prepare('SELECT * FROM jobs WHERE provider = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  updateJobProvider: db.prepare('UPDATE jobs SET provider = ? WHERE id = ?'),
  updateJobBudget: db.prepare('UPDATE jobs SET budget = ? WHERE id = ?'),
  updateJobStatus: db.prepare('UPDATE jobs SET status = ? WHERE id = ?'),
  updateJobSubmit: db.prepare("UPDATE jobs SET status = 'submitted', deliverable = ? WHERE id = ?"),
  updateJobComplete: db.prepare("UPDATE jobs SET status = 'completed', reason = ?, completed_at = unixepoch() WHERE id = ?"),
  updateJobReject: db.prepare("UPDATE jobs SET status = 'rejected', reason = ?, completed_at = unixepoch() WHERE id = ?"),
  updateJobExpired: db.prepare("UPDATE jobs SET status = 'expired', completed_at = unixepoch() WHERE id = ?"),
  updateJobOnchain: db.prepare('UPDATE jobs SET onchain_address = ?, onchain_job_id = ? WHERE id = ?'),
  updateJobFundedAt: db.prepare('UPDATE jobs SET funded_at = unixepoch() WHERE id = ?'),
  updateJobSubmittedAt: db.prepare('UPDATE jobs SET submitted_at = unixepoch(), auto_release_at = ? WHERE id = ?'),
  updateJobSettledAt: db.prepare('UPDATE jobs SET settled_at = ? WHERE id = ?'),
  updateJobDisputeStatus: db.prepare('UPDATE jobs SET dispute_status = ? WHERE id = ?'),

  // Job stats — only counts on-chain confirmed jobs for public display
  jobStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'funded' AND onchain_address IS NOT NULL THEN 1 ELSE 0 END) as funded,
      SUM(CASE WHEN status = 'submitted' AND onchain_address IS NOT NULL THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
      SUM(CASE WHEN status = 'completed' AND onchain_address IS NOT NULL THEN budget ELSE 0 END) as total_paid
    FROM jobs
  `),

  // All job stats (admin — counts everything including test jobs)
  allJobStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'funded' THEN 1 ELSE 0 END) as funded,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
      SUM(CASE WHEN status = 'completed' THEN budget ELSE 0 END) as total_paid
    FROM jobs
  `),

  // Admin: delete test jobs with no on-chain backing
  deleteTestJobs: db.prepare("DELETE FROM jobs WHERE onchain_address IS NULL AND status = 'completed'"),
  resetAgentEarnings: db.prepare("UPDATE agent_stats SET total_earned = '0', completed_jobs = 0"),

  // Disputes
  insertDispute: db.prepare(`
    INSERT INTO disputes (id, job_id, raised_by, reason) VALUES (?, ?, ?, ?)
  `),
  getDisputesByJob: db.prepare('SELECT * FROM disputes WHERE job_id = ? ORDER BY created_at DESC'),
  getOpenDispute: db.prepare("SELECT * FROM disputes WHERE job_id = ? AND status = 'open' LIMIT 1"),
  resolveDispute: db.prepare("UPDATE disputes SET status = 'resolved', resolution = ?, resolved_at = unixepoch() WHERE id = ?"),

  // Accounts
  insertAccount: db.prepare(`
    INSERT INTO accounts (id, wallet_address, display_name, bio, avatar_url, account_type, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  getAccountByWallet: db.prepare('SELECT * FROM accounts WHERE wallet_address = ?'),
  updateAccount: db.prepare('UPDATE accounts SET display_name = ?, bio = ?, avatar_url = ?, last_active = unixepoch() WHERE id = ?'),
  touchAccount: db.prepare('UPDATE accounts SET last_active = unixepoch() WHERE id = ?'),
  listAccounts: db.prepare('SELECT id, wallet_address, display_name, avatar_url, account_type, created_at FROM accounts WHERE status = ? ORDER BY last_active DESC LIMIT ? OFFSET ?'),

  // Forum Channels
  listForumChannels: db.prepare('SELECT * FROM forum_channels ORDER BY sort_order ASC'),
  getForumChannel: db.prepare('SELECT * FROM forum_channels WHERE slug = ?'),
  getForumChannelById: db.prepare('SELECT * FROM forum_channels WHERE id = ?'),

  // Forum Threads
  insertThread: db.prepare(`
    INSERT INTO forum_threads (id, channel_id, author_id, title, last_reply_at)
    VALUES (?, ?, ?, ?, unixepoch())
  `),
  getThread: db.prepare(`
    SELECT t.*, a.display_name as author_name, a.avatar_url as author_avatar, a.account_type as author_type, a.wallet_address as author_wallet
    FROM forum_threads t JOIN accounts a ON t.author_id = a.id WHERE t.id = ?
  `),
  listThreads: db.prepare(`
    SELECT t.*, a.display_name as author_name, a.avatar_url as author_avatar, a.account_type as author_type,
           (SELECT content FROM forum_posts WHERE thread_id = t.id AND is_op = 1 LIMIT 1) as preview
    FROM forum_threads t JOIN accounts a ON t.author_id = a.id
    WHERE t.channel_id = ?
    ORDER BY t.pinned DESC, t.last_reply_at DESC LIMIT ? OFFSET ?
  `),
  updateThreadReply: db.prepare('UPDATE forum_threads SET reply_count = reply_count + 1, last_reply_at = unixepoch() WHERE id = ?'),
  countThreadsInChannel: db.prepare('SELECT COUNT(*) as count FROM forum_threads WHERE channel_id = ?'),

  // Forum Posts
  insertPost: db.prepare(`
    INSERT INTO forum_posts (id, thread_id, author_id, content, is_op)
    VALUES (?, ?, ?, ?, ?)
  `),
  getPost: db.prepare('SELECT * FROM forum_posts WHERE id = ?'),
  listPosts: db.prepare(`
    SELECT p.*, a.display_name as author_name, a.avatar_url as author_avatar, a.account_type as author_type, a.wallet_address as author_wallet
    FROM forum_posts p JOIN accounts a ON p.author_id = a.id
    WHERE p.thread_id = ? ORDER BY p.created_at ASC LIMIT ? OFFSET ?
  `),
  updatePost: db.prepare('UPDATE forum_posts SET content = ?, edited_at = unixepoch() WHERE id = ?'),
  countPostsInThread: db.prepare('SELECT COUNT(*) as count FROM forum_posts WHERE thread_id = ?'),

  // Agent Tokens
  insertAgentToken: db.prepare(`
    INSERT INTO agent_tokens (id, agent_id, token_name, token_symbol, total_supply, creator_wallet, creator_fee_bps, platform_fee_bps, logo_url, description, agent_description, social_twitter, social_telegram, social_discord, social_website, ipfs_logo_cid, ipfs_metadata_cid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAgentToken: db.prepare('SELECT * FROM agent_tokens WHERE id = ?'),
  getAgentTokenByAgent: db.prepare('SELECT * FROM agent_tokens WHERE agent_id = ?'),
  getAgentTokenByMint: db.prepare('SELECT * FROM agent_tokens WHERE mint_address = ?'),
  deletePendingToken: db.prepare('DELETE FROM agent_tokens WHERE id = ? AND status = \'pending\''),
  listActiveTokens: db.prepare(`
    SELECT at.*, a.name as agent_name, a.wallet_address as agent_wallet,
           (SELECT price_sol FROM token_prices WHERE token_id = at.id ORDER BY timestamp DESC LIMIT 1) as current_price,
           (SELECT market_cap FROM token_prices WHERE token_id = at.id ORDER BY timestamp DESC LIMIT 1) as market_cap,
           (SELECT volume_24h FROM token_prices WHERE token_id = at.id ORDER BY timestamp DESC LIMIT 1) as volume_24h,
           (SELECT holders FROM token_prices WHERE token_id = at.id ORDER BY timestamp DESC LIMIT 1) as holders
    FROM agent_tokens at JOIN agents a ON at.agent_id = a.id
    WHERE at.status IN ('active', 'graduated', 'graduating')
    ORDER BY at.launched_at DESC LIMIT ? OFFSET ?
  `),
  // Top agents sorted by combined revenue (token trading fees + job earnings)
  listTopAgentsByRevenue: db.prepare(`
    SELECT a.*,
           COALESCE(ast.total_earned, '0') as job_revenue,
           COALESCE(ast.completed_jobs, 0) as completed_jobs,
           COALESCE(tp.creator_fees_earned, '0') as token_fees_earned,
           COALESCE(tp.platform_fees_earned, '0') as token_platform_fees,
           COALESCE(tp.total_volume_sol, '0') as token_volume_sol,
           COALESCE(tp.total_trades, 0) as token_trades,
           at.token_symbol, at.token_name, at.mint_address, at.status as token_status,
           (CAST(COALESCE(tp.creator_fees_earned, '0') AS REAL) + CAST(COALESCE(tp.platform_fees_earned, '0') AS REAL) + CAST(COALESCE(ast.total_earned, '0') AS REAL)) as combined_revenue
    FROM agents a
    LEFT JOIN agent_stats ast ON ast.agent_id = a.id
    LEFT JOIN agent_tokens at ON at.agent_id = a.id
    LEFT JOIN token_pools tp ON tp.token_id = at.id
    ORDER BY combined_revenue DESC
    LIMIT ? OFFSET ?
  `),
  updateAgentTokenStatus: db.prepare('UPDATE agent_tokens SET status = ?, mint_address = ?, pool_address = ?, launch_tx = ?, launched_at = unixepoch() WHERE id = ?'),


  // Token Prices
  insertTokenPrice: db.prepare(`
    INSERT INTO token_prices (token_id, price_sol, price_usd, volume_24h, market_cap, holders)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getTokenPriceHistory: db.prepare(`
    SELECT * FROM token_prices WHERE token_id = ? ORDER BY timestamp DESC LIMIT ?
  `),
  getLatestTokenPrice: db.prepare(`
    SELECT * FROM token_prices WHERE token_id = ? ORDER BY timestamp DESC LIMIT 1
  `),

  // Token Trades
  insertTokenTrade: db.prepare(`
    INSERT INTO token_trades (id, token_id, trader_wallet, side, amount_token, amount_sol, price_per_token, tx_signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTokenTrades: db.prepare('SELECT * FROM token_trades WHERE token_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'),
  deleteTokenTrades: db.prepare('DELETE FROM token_trades WHERE token_id = ?'),
  deleteDevBuys: db.prepare('DELETE FROM dev_buys WHERE token_id = ?'),
  getTraderHistory: db.prepare('SELECT * FROM token_trades WHERE trader_wallet = ? ORDER BY timestamp DESC LIMIT ?'),

  // Fee Accruals
  insertFeeAccrual: db.prepare(`
    INSERT INTO fee_accruals (id, agent_id, source, amount_lamports, amount_token, token_mint, reference_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getUnclaimedFees: db.prepare(`
    SELECT * FROM fee_accruals WHERE agent_id = ? AND claimed = 0 ORDER BY created_at DESC
  `),
  getFeeSummary: db.prepare(`
    SELECT
      SUM(CASE WHEN claimed = 0 THEN amount_lamports ELSE 0 END) as unclaimed_lamports,
      SUM(CASE WHEN claimed = 1 THEN amount_lamports ELSE 0 END) as claimed_lamports,
      COUNT(CASE WHEN claimed = 0 THEN 1 END) as unclaimed_count,
      COUNT(CASE WHEN claimed = 1 THEN 1 END) as claimed_count,
      SUM(amount_lamports) as total_lamports
    FROM fee_accruals WHERE agent_id = ?
  `),
  claimFees: db.prepare('UPDATE fee_accruals SET claimed = 1, claim_tx = ?, claimed_at = unixepoch() WHERE agent_id = ? AND claimed = 0'),
  getFeeHistory: db.prepare('SELECT * FROM fee_accruals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),

  // Agent Stats
  upsertAgentStats: db.prepare(`
    INSERT INTO agent_stats (agent_id, total_jobs, completed_jobs, rejected_jobs, total_earned, success_rate, token_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      total_jobs = excluded.total_jobs,
      completed_jobs = excluded.completed_jobs,
      rejected_jobs = excluded.rejected_jobs,
      total_earned = excluded.total_earned,
      success_rate = excluded.success_rate,
      token_id = COALESCE(excluded.token_id, agent_stats.token_id),
      updated_at = unixepoch()
  `),
  getAgentStats: db.prepare('SELECT * FROM agent_stats WHERE agent_id = ?'),

  // Token Pools (bonding curve)
  insertPool: db.prepare(`
    INSERT INTO token_pools (token_id, virtual_sol_reserve, virtual_token_reserve, real_sol_reserve, real_token_reserve, k, total_supply, circulating_supply, current_price_lamports)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getPool: db.prepare('SELECT * FROM token_pools WHERE token_id = ?'),
  updatePool: db.prepare(`
    UPDATE token_pools SET
      virtual_sol_reserve = ?, virtual_token_reserve = ?, real_sol_reserve = ?,
      real_token_reserve = ?, circulating_supply = ?, current_price_lamports = ?,
      updated_at = unixepoch()
    WHERE token_id = ?
  `),

  graduatePool: db.prepare(`
    UPDATE token_pools SET
      status = 'graduated', graduated_at = unixepoch(), raydium_pool_address = ?,
      updated_at = unixepoch()
    WHERE token_id = ?
  `),
  updatePoolFees: db.prepare(`
    UPDATE token_pools SET
      creator_fees_earned = ?, creator_fees_claimed = ?,
      platform_fees_earned = ?, platform_fees_claimed = ?,
      total_volume_sol = ?, total_trades = ?,
      total_buys = ?, total_sells = ?,
      updated_at = unixepoch()
    WHERE token_id = ?
  `),

  // Dev Buys
  insertDevBuy: db.prepare(`
    INSERT INTO dev_buys (id, token_id, dev_wallet, amount_sol, amount_token, price_per_token, tx_signature)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getDevBuys: db.prepare('SELECT * FROM dev_buys WHERE token_id = ? ORDER BY created_at ASC'),
  getDevBuyTotal: db.prepare(`
    SELECT
      COALESCE(SUM(CAST(amount_sol AS REAL)), 0) as total_sol,
      COALESCE(SUM(CAST(amount_token AS REAL)), 0) as total_tokens,
      dev_wallet
    FROM dev_buys WHERE token_id = ? GROUP BY dev_wallet
  `),

  // Fee Claims
  insertFeeClaim: db.prepare(`
    INSERT INTO fee_claims (id, agent_id, creator_amount_lamports, platform_amount_lamports, total_amount_lamports, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `),
  updateFeeClaim: db.prepare('UPDATE fee_claims SET status = ?, payout_tx = ?, completed_at = unixepoch() WHERE id = ?'),
  getFeeClaims: db.prepare('SELECT * FROM fee_claims WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  getFeeClaimStats: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'completed' THEN creator_amount_lamports ELSE 0 END), 0) as total_claimed_lamports,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN platform_amount_lamports ELSE 0 END), 0) as total_platform_lamports,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_claims,
      COUNT(*) as total_claims
    FROM fee_claims WHERE agent_id = ?
  `),

  // Services
  insertService: db.prepare(`
    INSERT INTO services (id, agent_id, agent_wallet, title, description, category, price_lamports, delivery_hours, max_concurrent, requirements, deliverables)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getService: db.prepare('SELECT s.*, a.name as agent_name FROM services s JOIN agents a ON s.agent_id = a.id WHERE s.id = ?'),
  listServices: db.prepare(`
    SELECT s.*, a.name as agent_name, a.wallet_address as agent_wallet_addr,
           a.capabilities as agent_capabilities
    FROM services s JOIN agents a ON s.agent_id = a.id
    WHERE s.status = 'active'
    ORDER BY s.total_completed DESC, s.created_at DESC LIMIT ? OFFSET ?
  `),
  listServicesByCategory: db.prepare(`
    SELECT s.*, a.name as agent_name, a.wallet_address as agent_wallet_addr
    FROM services s JOIN agents a ON s.agent_id = a.id
    WHERE s.status = 'active' AND s.category = ?
    ORDER BY s.total_completed DESC, s.created_at DESC LIMIT ? OFFSET ?
  `),
  listServicesByAgent: db.prepare(`
    SELECT * FROM services WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),
  updateService: db.prepare(`
    UPDATE services SET title = ?, description = ?, category = ?, price_lamports = ?,
    delivery_hours = ?, max_concurrent = ?, requirements = ?, deliverables = ?,
    status = ?, updated_at = unixepoch() WHERE id = ?
  `),
  updateServiceStatus: db.prepare('UPDATE services SET status = ?, updated_at = unixepoch() WHERE id = ?'),
  incrementServiceOrders: db.prepare('UPDATE services SET active_orders = active_orders + 1 WHERE id = ?'),
  decrementServiceOrders: db.prepare('UPDATE services SET active_orders = MAX(0, active_orders - 1) WHERE id = ?'),
  completeServiceStats: db.prepare(`
    UPDATE services SET
      total_completed = total_completed + 1,
      total_earned_lamports = total_earned_lamports + ?,
      active_orders = MAX(0, active_orders - 1),
      updated_at = unixepoch()
    WHERE id = ?
  `),

  // Service Orders
  insertServiceOrder: db.prepare(`
    INSERT INTO service_orders (id, service_id, job_id, buyer_wallet, provider_wallet, price_lamports, buyer_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getServiceOrder: db.prepare(`
    SELECT so.*, s.title as service_title, s.category as service_category
    FROM service_orders so JOIN services s ON so.service_id = s.id WHERE so.id = ?
  `),
  listOrdersByBuyer: db.prepare(`
    SELECT so.*, s.title as service_title, s.category as service_category, a.name as provider_name
    FROM service_orders so JOIN services s ON so.service_id = s.id JOIN agents a ON s.agent_id = a.id
    WHERE so.buyer_wallet = ? ORDER BY so.created_at DESC LIMIT ? OFFSET ?
  `),
  listOrdersByProvider: db.prepare(`
    SELECT so.*, s.title as service_title, s.category as service_category
    FROM service_orders so JOIN services s ON so.service_id = s.id
    WHERE so.provider_wallet = ? ORDER BY so.created_at DESC LIMIT ? OFFSET ?
  `),
  updateServiceOrderStatus: db.prepare('UPDATE service_orders SET status = ? WHERE id = ?'),
  updateServiceOrderSubmit: db.prepare("UPDATE service_orders SET status = 'submitted', deliverable = ? WHERE id = ?"),
  updateServiceOrderComplete: db.prepare("UPDATE service_orders SET status = 'completed', completed_at = unixepoch() WHERE id = ?"),
  updateServiceOrderReview: db.prepare('UPDATE service_orders SET rating = ?, review = ? WHERE id = ?'),

  // Job Applications
  insertApplication: db.prepare(`
    INSERT INTO job_applications (id, job_id, applicant_wallet, agent_id, proposal, price_lamports, estimated_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getApplication: db.prepare('SELECT * FROM job_applications WHERE id = ?'),
  listApplicationsByJob: db.prepare(`
    SELECT ja.*, a.name as agent_name, a.capabilities as agent_capabilities,
           ast.total_jobs, ast.completed_jobs, ast.success_rate
    FROM job_applications ja
    LEFT JOIN agents a ON ja.agent_id = a.id
    LEFT JOIN agent_stats ast ON ja.agent_id = ast.agent_id
    WHERE ja.job_id = ? AND ja.status = ?
    ORDER BY ja.created_at ASC
  `),
  listApplicationsByAgent: db.prepare(`
    SELECT ja.*, j.description as job_description, j.budget as job_budget, j.status as job_status
    FROM job_applications ja JOIN jobs j ON ja.job_id = j.id
    WHERE ja.applicant_wallet = ? ORDER BY ja.created_at DESC LIMIT ? OFFSET ?
  `),
  updateApplicationStatus: db.prepare('UPDATE job_applications SET status = ? WHERE id = ?'),
  rejectOtherApplications: db.prepare("UPDATE job_applications SET status = 'rejected' WHERE job_id = ? AND id != ? AND status = 'pending'"),

  // Platform stats (global — only on-chain confirmed for volume)
  platformStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agents WHERE status = 'active') as total_agents,
      (SELECT COUNT(*) FROM agent_tokens WHERE status IN ('active', 'graduated', 'graduating')) as tokenized_agents,
      (SELECT COUNT(*) FROM jobs) as total_jobs,
      (SELECT COUNT(*) FROM jobs WHERE status = 'completed' AND onchain_address IS NOT NULL) as onchain_completed_jobs,
      (SELECT COALESCE(SUM(budget), 0) FROM jobs WHERE status = 'completed' AND onchain_address IS NOT NULL) as total_volume,
      (SELECT COUNT(*) FROM token_trades) as total_token_trades,
      (SELECT COUNT(*) FROM jobs WHERE status IN ('funded', 'submitted') AND onchain_address IS NOT NULL) as active_onchain_jobs
  `),
};

export default db;
