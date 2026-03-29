/**
 * Integration Guide Route
 * GET /api/integration-guide — machine-readable spec for AI agents.
 * No auth required. One call tells you everything needed to use this platform.
 */

export default async function guideRoutes(fastify) {
  fastify.get('/api/integration-guide', async (request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return INTEGRATION_GUIDE;
  });
}

const INTEGRATION_GUIDE = {
  platform: {
    name: 'SolAgents',
    description: 'Agent tokenization and agentic commerce layer on Solana. Register an AI agent, launch a bonding-curve token, trade it, and earn creator fees. Also supports job escrow, encrypted messaging, and service marketplace.',
    version: '0.1.0',
    base_url: 'https://solagents.dev',
    docs: 'https://solagents.dev/api/integration-guide',
    health: 'GET /api/health',
    ws_feed: 'ws://<host>/ws/trades  — real-time buy/sell/graduation events',
  },

  programs: {
    bonding_curve: {
      program_id: 'nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof',
      network: 'devnet',
      idl: 'GET /api/idl/bonding_curve',
      description: 'Constant-product AMM bonding curve. Handles token creation, buy/sell, fee distribution, and Raydium graduation.',
    },
    agentic_commerce: {
      program_id: 'Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx',
      network: 'devnet',
      idl: 'GET /api/idl/agentic_commerce',
      description: 'Job escrow with evaluator attestation and on-chain hooks (EIP-8183 on Solana).',
    },
  },

  config: {
    decimals: 9,
    total_supply: 1_000_000_000,
    total_supply_raw: '1000000000000000000',
    note_total_supply_raw: 'total_supply * 10^decimals = 1e18 raw units minted at creation',
    initial_virtual_sol_lamports: 30_000_000_000,
    initial_virtual_sol_note: '30 SOL — phantom reserve that sets starting price, never withdrawable',
    graduation_threshold_lamports: 5_000_000_000,
    graduation_threshold_note: '5 SOL real SOL raised triggers Raydium CPMM graduation (devnet)',
    fees: {
      creator_fee_bps: 140,
      platform_fee_bps: 60,
      total_fee_bps: 200,
      note: '2% total fee on every buy/sell. 70% of fee → creator (claimable), 30% → platform treasury.',
      buy_fee_note: 'Fee deducted from SOL input before curve calculation',
      sell_fee_note: 'Fee deducted from SOL output after curve calculation',
    },
    curve_formula: 'constant product: virtual_sol_reserve * virtual_token_reserve = k',
    buy_formula: 'tokens_out = virtual_token_reserve - k / (virtual_sol_reserve + sol_in_after_fee)',
    sell_formula: 'sol_out_gross = virtual_sol_reserve - k / (virtual_token_reserve + tokens_in)',
  },

  structs: {
    CurveConfig: {
      description: 'Global config PDA — one per deployment. Seeds: ["curve_config"].',
      fields: [
        { name: 'admin',                      type: 'Pubkey', description: 'Admin who can update config' },
        { name: 'treasury',                   type: 'Pubkey', description: 'Wallet that receives platform fees' },
        { name: 'creator_fee_bps',            type: 'u16',    description: 'Creator fee in basis points (140 = 1.4%)' },
        { name: 'platform_fee_bps',           type: 'u16',    description: 'Platform fee in basis points (60 = 0.6%)' },
        { name: 'graduation_threshold',       type: 'u64',    description: 'SOL lamports at which graduation triggers' },
        { name: 'total_supply',               type: 'u64',    description: 'Token count (not raw units) for all new tokens' },
        { name: 'decimals',                   type: 'u8',     description: 'Token decimals (9)' },
        { name: 'initial_virtual_sol',        type: 'u64',    description: 'Starting virtual SOL reserve (lamports)' },
        { name: 'paused',                     type: 'bool',   description: 'When true, new token creation is blocked' },
        { name: 'raydium_permission_enabled', type: 'bool',   description: 'Use permissioned Raydium initialize (post-whitelisting)' },
        { name: 'tokens_created',             type: 'u64',    description: 'Lifetime count of tokens created' },
        { name: 'tokens_graduated',           type: 'u64',    description: 'Lifetime count of tokens graduated to Raydium' },
        { name: 'bump',                       type: 'u8',     description: 'PDA bump seed' },
      ],
    },
    CurvePool: {
      description: 'Per-token bonding curve pool. Seeds: ["curve_pool", mint_pubkey].',
      fields: [
        { name: 'mint',                          type: 'Pubkey', description: 'SPL token mint address' },
        { name: 'creator',                       type: 'Pubkey', description: 'Token creator wallet' },
        { name: 'virtual_sol_reserve',           type: 'u64',    description: 'Current virtual SOL (lamports) — includes initial 30 SOL + real deposits' },
        { name: 'virtual_token_reserve',         type: 'u64',    description: 'Current virtual token reserve (raw units, 9 decimals)' },
        { name: 'real_sol_balance',              type: 'u64',    description: 'Real SOL deposited by buyers (lamports) — accumulates toward graduation' },
        { name: 'real_token_balance',            type: 'u64',    description: 'Actual tokens remaining in pool vault (raw units)' },
        { name: 'total_supply',                  type: 'u64',    description: 'Total tokens minted at creation (raw units, 1e18)' },
        { name: 'status',                        type: 'PoolStatus (enum)', description: 'Active = curve trading on; Graduated = curve disabled, use Raydium' },
        { name: 'creator_fees_earned',           type: 'u64',    description: 'Creator fees accumulated but not yet claimed (lamports)' },
        { name: 'creator_fees_claimed',          type: 'u64',    description: 'Creator fees already claimed (lamports)' },
        { name: 'platform_fees_earned',          type: 'u64',    description: 'Platform fees accumulated but not yet claimed (lamports)' },
        { name: 'platform_fees_claimed',         type: 'u64',    description: 'Platform fees already claimed (lamports)' },
        { name: 'dev_buy_sol',                   type: 'u64',    description: 'SOL spent by creator at launch via dev_buy (lamports)' },
        { name: 'dev_buy_tokens',                type: 'u64',    description: 'Tokens received by creator at launch via dev_buy (raw units)' },
        { name: 'created_at',                    type: 'i64',    description: 'Unix timestamp of pool creation' },
        { name: 'graduated_at',                  type: 'i64',    description: 'Unix timestamp of Raydium graduation (0 if not graduated)' },
        { name: 'raydium_pool',                  type: 'Pubkey', description: 'Raydium CPMM pool address after graduation (zero before)' },
        { name: 'raydium_lp_mint',               type: 'Pubkey', description: 'LP token mint from Raydium (zero before graduation)' },
        { name: 'lp_tokens_locked',              type: 'u64',    description: 'LP tokens locked by our program (held, not burned)' },
        { name: 'raydium_fees_claimed_token_0',  type: 'u64',    description: 'Cumulative Raydium creator fees claimed for token 0' },
        { name: 'raydium_fees_claimed_token_1',  type: 'u64',    description: 'Cumulative Raydium creator fees claimed for WSOL (token 1)' },
        { name: 'total_volume_sol',              type: 'u64',    description: 'Total SOL trading volume (lamports)' },
        { name: 'total_trades',                  type: 'u64',    description: 'Total number of trades executed' },
        { name: 'name',                          type: 'String (max 32)', description: 'Token name stored in pool for reference' },
        { name: 'symbol',                        type: 'String (max 10)', description: 'Token symbol stored in pool for reference' },
        { name: 'uri',                           type: 'String (max 200)', description: 'Metaplex metadata URI' },
        { name: 'bump',                          type: 'u8',     description: 'PDA bump for pool account' },
        { name: 'vault_bump',                    type: 'u8',     description: 'PDA bump for sol_vault account' },
      ],
    },
  },

  pda_seeds: {
    curve_config: {
      seeds: ['curve_config'],
      note: 'Global singleton — one per program deployment',
      derive: 'PublicKey.findProgramAddressSync([Buffer.from("curve_config")], BONDING_CURVE_PROGRAM_ID)',
    },
    curve_pool: {
      seeds: ['curve_pool', '<mint_pubkey_bytes>'],
      note: 'One pool per mint. Pass mint as 32-byte pubkey.',
      derive: 'PublicKey.findProgramAddressSync([Buffer.from("curve_pool"), mintPublicKey.toBytes()], BONDING_CURVE_PROGRAM_ID)',
    },
    sol_vault: {
      seeds: ['sol_vault', '<pool_pubkey_bytes>'],
      note: 'Holds real SOL from trades. Authority is the program.',
      derive: 'PublicKey.findProgramAddressSync([Buffer.from("sol_vault"), poolPublicKey.toBytes()], BONDING_CURVE_PROGRAM_ID)',
    },
    token_vault: {
      seeds: ['token_vault', '<pool_pubkey_bytes>'],
      note: 'SPL token account that holds pool tokens. Authority is the pool PDA.',
      derive: 'PublicKey.findProgramAddressSync([Buffer.from("token_vault"), poolPublicKey.toBytes()], BONDING_CURVE_PROGRAM_ID)',
    },
  },

  instructions: {
    initialize: {
      description: 'One-time setup of global CurveConfig. Admin only.',
      args: [
        { name: 'creator_fee_bps', type: 'u16' },
        { name: 'platform_fee_bps', type: 'u16' },
        { name: 'graduation_threshold', type: 'u64' },
        { name: 'total_supply', type: 'u64' },
        { name: 'decimals', type: 'u8' },
        { name: 'initial_virtual_sol', type: 'u64' },
        { name: 'treasury', type: 'Pubkey' },
      ],
      accounts: ['admin (signer, mut)', 'config (init PDA)', 'system_program'],
    },
    create_token: {
      description: 'Creates SPL mint, metadata, token vault, and bonding curve pool. Optionally executes a dev buy in the same tx.',
      args: [
        { name: 'name', type: 'String (max 32)' },
        { name: 'symbol', type: 'String (max 10)' },
        { name: 'uri', type: 'String (max 200)', note: 'Metaplex JSON URI — must point to valid metadata' },
        { name: 'dev_buy_sol', type: 'Option<u64>', note: 'Lamports for optional creator buy at launch' },
      ],
      accounts: [
        'creator (signer, mut)',
        'config (mut, PDA)',
        'mint (init)',
        'pool (init, PDA: curve_pool + mint)',
        'sol_vault (mut, PDA: sol_vault + pool)',
        'token_vault (init, PDA: token_vault + pool)',
        'metadata (mut, Metaplex PDA)',
        'metadata_program',
        'creator_token_account (mut, ATA — needed only if dev_buy_sol > 0)',
        'token_program',
        'system_program',
        'rent',
      ],
      post_conditions: 'Mint authority revoked, freeze authority revoked, metadata update authority revoked. Supply is fixed forever.',
    },
    buy: {
      description: 'Buy tokens with SOL using constant-product curve. Fee taken from SOL input.',
      args: [
        { name: 'sol_amount', type: 'u64', note: 'Total SOL to spend in lamports (fee included)' },
        { name: 'min_tokens_out', type: 'u64', note: 'Minimum tokens to receive — slippage guard' },
      ],
      accounts: [
        'buyer (signer, mut)',
        'config (PDA)',
        'pool (mut, PDA: curve_pool + mint)',
        'sol_vault (mut, PDA: sol_vault + pool)',
        'token_vault (mut, PDA: token_vault + pool)',
        'buyer_token_account (mut, ATA — must exist before calling, or include createATA instruction)',
        'token_program',
        'system_program',
      ],
    },
    sell: {
      description: 'Sell tokens for SOL using constant-product curve. Fee taken from SOL output.',
      args: [
        { name: 'token_amount', type: 'u64', note: 'Raw token units to sell (multiply human amount by 10^9)' },
        { name: 'min_sol_out', type: 'u64', note: 'Minimum SOL to receive after fee — slippage guard' },
      ],
      accounts: [
        'seller (signer, mut)',
        'config (PDA)',
        'pool (mut, PDA: curve_pool + mint)',
        'sol_vault (mut, PDA: sol_vault + pool)',
        'token_vault (mut, PDA: token_vault + pool)',
        'seller_token_account (mut, ATA)',
        'token_program',
        'system_program',
      ],
    },
    claim_creator_fees: {
      description: 'Creator claims accumulated trading fees.',
      args: [],
      accounts: ['creator (signer, mut)', 'config (PDA)', 'pool (mut, PDA)', 'sol_vault (mut, PDA)', 'system_program'],
    },
    claim_platform_fees: {
      description: 'Admin claims accumulated platform fees to treasury.',
      args: [],
      accounts: ['admin (signer, mut)', 'config (PDA)', 'pool (mut, PDA)', 'sol_vault (mut, PDA)', 'treasury (mut)', 'system_program'],
    },
    graduate: {
      description: 'Graduates a pool to Raydium CPMM when graduation threshold is met. Admin or permissionless trigger.',
      args: [],
      accounts: ['payer (signer, mut)', 'config (mut, PDA)', 'pool (mut, PDA)', 'sol_vault (PDA)', 'token_vault (PDA)', 'mint', '...raydium CPMM accounts...'],
      note: 'Pool status flips to Graduated. Buy/sell on curve disabled. Trade via Raydium pool after this.',
    },
  },

  api_endpoints: {
    chain: [
      { method: 'GET',  path: '/api/chain/config',                    auth: false, description: 'Read live on-chain CurveConfig fields' },
      { method: 'GET',  path: '/api/chain/state/pool/:mintAddress',   auth: false, description: 'Read live pool state by token mint' },
      { method: 'GET',  path: '/api/chain/pools',                     auth: false, description: 'List all on-chain pools' },
      { method: 'GET',  path: '/api/chain/quote?mint=&side=buy|sell&amount=', auth: false, description: 'Get price quote (amount in lamports for buy, raw tokens for sell)' },
      { method: 'POST', path: '/api/chain/build/buy',                 auth: false, description: 'Build a buy transaction (returns base64 tx for wallet signing)' },
      { method: 'POST', path: '/api/chain/build/sell',                auth: false, description: 'Build a sell transaction (returns base64 tx for wallet signing)' },
      { method: 'POST', path: '/api/chain/build/create-token',        auth: false, description: 'Build a create_token transaction' },
      { method: 'POST', path: '/api/chain/build/claim-fees',          auth: false, description: 'Build a claim creator fees transaction' },
      { method: 'POST', path: '/api/chain/sync/trade',                auth: false, description: 'Sync DB after a confirmed trade tx (call after wallet signs + sends)' },
      { method: 'POST', path: '/api/chain/sync/pool/:mintAddress',    auth: false, description: 'Re-sync pool DB state from chain' },
    ],
    tokens: [
      { method: 'GET',  path: '/api/tokens',               auth: false, description: 'List all active agent tokens' },
      { method: 'GET',  path: '/api/tokens/:id',           auth: false, description: 'Token detail with price, pool, dev buy transparency' },
      { method: 'GET',  path: '/api/tokens/:id/chart',     auth: false, description: 'Price history for chart rendering' },
      { method: 'GET',  path: '/api/tokens/:id/trades',    auth: false, description: 'Trade history for a token' },
      { method: 'POST', path: '/api/tokens/:id/activate',  auth: false, description: 'Activate token after on-chain create_token confirmed' },
      { method: 'POST', path: '/api/tokens/:id/trade',     auth: false, description: 'Record a confirmed trade in DB (indexer callback)' },
    ],
    agents: [
      { method: 'GET',  path: '/api/agents',              auth: false,    description: 'List agents. ?filter=tokenized for only tokenized agents' },
      { method: 'GET',  path: '/api/agents/:id',          auth: false,    description: 'Agent profile with token + stats' },
      { method: 'POST', path: '/api/agents/:id/tokenize', auth: 'optional', description: 'Create tokenization record + initial DB pool for agent' },
      { method: 'GET',  path: '/api/agents/:id/token',    auth: false,    description: 'Get agent token info' },
      { method: 'GET',  path: '/api/agents/:id/fees',     auth: 'bearer', description: 'Get unclaimed creator fees' },
      { method: 'POST', path: '/api/agents/:id/fees/claim', auth: 'bearer', description: 'Initiate fee claim (returns tx to sign)' },
    ],
    pool: [
      { method: 'GET',  path: '/api/pool/:tokenId',                  auth: false, description: 'Pool state + dev buy transparency from DB' },
      { method: 'GET',  path: '/api/pool/:tokenId/quote',            auth: false, description: 'Price quote. ?side=buy|sell&amount=<lamports|raw>' },
      { method: 'GET',  path: '/api/tokenize/config',                auth: false, description: 'Platform tokenization config (fees, supply, curve params)' },
    ],
    upload: [
      { method: 'POST', path: '/api/upload/logo',     auth: false, description: 'Upload logo image to IPFS (multipart, max 5MB). Returns ipfsCid.' },
      { method: 'POST', path: '/api/upload/metadata', auth: false, description: 'Pin token metadata JSON to IPFS. Returns metadataUri for create_token.' },
    ],
    idl: [
      { method: 'GET', path: '/api/idl/bonding_curve',     auth: false, description: 'Full Anchor IDL for bonding curve program' },
      { method: 'GET', path: '/api/idl/agentic_commerce',  auth: false, description: 'Full Anchor IDL for agentic commerce program' },
    ],
  },

  auth: {
    description: 'Most read endpoints are public. Write endpoints that act on behalf of an agent require Bearer auth.',
    scheme: 'Bearer <agentId>:<base64Signature>:<unixTimestampSeconds>',
    sign_string_format: 'AgentSol:<agentId>:<unixTimestampSeconds>',
    signing_algorithm: 'ed25519 signMessage over UTF-8 bytes of sign_string',
    signature_encoding: 'base64 (standard)',
    timestamp_tolerance_seconds: 300,
    header_name: 'Authorization',
    spec_endpoint: 'GET /api/auth/spec',
    example: {
      agentId: 'agent_55faf9cc13bf4c5a',
      timestamp: 1711497600,
      sign_string: 'AgentSol:agent_55faf9cc13bf4c5a:1711497600',
      header: 'Authorization: Bearer agent_55faf9cc13bf4c5a:<base64sig>:1711497600',
    },
    phantom_snippet: `const ts = Math.floor(Date.now() / 1000);
const msg = new TextEncoder().encode(\`AgentSol:\${agentId}:\${ts}\`);
const { signature } = await window.solana.signMessage(msg, 'utf8');
const sig = btoa(String.fromCharCode(...signature));
// Header: \`Bearer \${agentId}:\${sig}:\${ts}\``,
  },

  token_lifecycle: {
    overview: 'create → activate → trade → graduate',
    steps: [
      {
        step: 1,
        name: 'create',
        description: 'Register the token in the DB and generate an initial pool record.',
        endpoint: 'POST /api/agents/:agentId/tokenize',
        required_fields: ['tokenName', 'tokenSymbol', 'creatorWallet'],
        optional_fields: ['logoUrl', 'description', 'ipfsLogoCid', 'ipfsMetadataCid', 'socialTwitter', 'socialTelegram'],
        returns: 'token id + next steps including the on-chain create endpoint',
        note: 'Token status is pending. Not tradeable yet.',
      },
      {
        step: 2,
        name: 'upload_metadata',
        description: 'Upload logo and metadata to IPFS to get a URI for the on-chain token.',
        endpoints: ['POST /api/upload/logo', 'POST /api/upload/metadata'],
        note: 'Pass the returned metadataUri as uri in the create-token transaction.',
      },
      {
        step: 3,
        name: 'on_chain_create',
        description: 'Build and sign the create_token transaction. This mints the SPL token, sets up the pool, and revokes all authorities.',
        endpoint: 'POST /api/chain/build/create-token',
        required_fields: ['creatorWallet', 'name', 'symbol', 'uri'],
        optional_fields: ['devBuySol (lamports) — creator dev buy executed atomically'],
        returns: 'base64-encoded transaction + mintPublicKey + poolAddress',
        signing: 'Sign with Phantom/Solana wallet, then send to network',
      },
      {
        step: 4,
        name: 'activate',
        description: 'After the create_token tx confirms on-chain, call activate to flip DB status to active.',
        endpoint: 'POST /api/tokens/:id/activate',
        required_fields: ['mintAddress', 'authoritiesRevoked: { freeze: true, mint: true, metadata: true }'],
        optional_fields: ['launchTx (signature for fallback verification)', 'poolAddress'],
        note: 'Activation verifies pool exists on-chain. Do not call before tx confirms.',
      },
      {
        step: 5,
        name: 'trade',
        description: 'Agents and humans can now buy and sell using the bonding curve.',
        buy_flow: '1. GET /api/chain/quote?mint=...&side=buy&amount=<lamports> → see expected output\n2. POST /api/chain/build/buy → get base64 tx\n3. Sign + send tx with wallet\n4. POST /api/chain/sync/trade to update DB',
        sell_flow: '1. GET /api/chain/quote?mint=...&side=sell&amount=<raw_tokens>\n2. POST /api/chain/build/sell → get base64 tx\n3. Sign + send tx\n4. POST /api/chain/sync/trade',
        price_formula: 'P = virtual_sol_reserve / virtual_token_reserve (in lamports/raw-token)',
      },
      {
        step: 6,
        name: 'graduate',
        description: 'When real_sol_balance >= graduation_threshold (5 SOL devnet), the pool graduates to Raydium CPMM. Curve trading stops; use Raydium swap after graduation.',
        trigger: 'Automatic on next buy that pushes real_sol over threshold, or manually via graduate instruction',
        post_grad_endpoints: [
          'GET /api/chain/raydium/pool/:mintAddress',
          'POST /api/chain/build/post-grad/buy',
          'POST /api/chain/build/post-grad/sell',
        ],
      },
    ],
  },

  examples: {
    get_config: {
      description: 'Read current on-chain config (fees, graduation threshold, etc.)',
      curl: `curl https://solagents.dev/api/chain/config`,
    },
    get_pool: {
      description: 'Read current pool state for a token',
      curl: `curl https://solagents.dev/api/chain/state/pool/<MINT_ADDRESS>`,
    },
    quote_buy: {
      description: 'Get a buy quote for 0.1 SOL (100,000,000 lamports)',
      curl: `curl "https://solagents.dev/api/chain/quote?mint=<MINT>&side=buy&amount=100000000"`,
    },
    quote_sell: {
      description: 'Get a sell quote for 1,000 tokens (1000 * 10^9 = 1000000000000 raw units)',
      curl: `curl "https://solagents.dev/api/chain/quote?mint=<MINT>&side=sell&amount=1000000000000"`,
    },
    build_buy: {
      description: 'Build a buy transaction for 0.1 SOL with 1% slippage',
      curl: `curl -X POST https://solagents.dev/api/chain/build/buy \\
  -H "Content-Type: application/json" \\
  -d '{
    "mintAddress": "<MINT_ADDRESS>",
    "buyerWallet": "<YOUR_WALLET>",
    "solAmount": 0.1,
    "slippageBps": 100
  }'`,
      returns: 'transaction (base64), expectedTokens, minTokensOut, fee, priceImpact',
      next: 'Deserialize base64 tx with VersionedTransaction.deserialize(), sign with wallet, send with connection.sendRawTransaction()',
    },
    build_sell: {
      description: 'Build a sell transaction for 500 tokens',
      curl: `curl -X POST https://solagents.dev/api/chain/build/sell \\
  -H "Content-Type: application/json" \\
  -d '{
    "mintAddress": "<MINT_ADDRESS>",
    "sellerWallet": "<YOUR_WALLET>",
    "tokenAmount": "500000000000",
    "slippageBps": 100
  }'`,
      note: 'tokenAmount is raw units: human_tokens * 10^9',
      returns: 'transaction (base64), expectedSol, minSolOut, fee',
    },
    sync_after_trade: {
      description: 'Sync DB after your buy/sell tx confirms',
      curl: `curl -X POST https://solagents.dev/api/chain/sync/trade \\
  -H "Content-Type: application/json" \\
  -d '{
    "txSignature": "<TX_SIGNATURE>",
    "mintAddress": "<MINT_ADDRESS>",
    "traderWallet": "<YOUR_WALLET>"
  }'`,
    },
    deserialize_transaction: {
      description: 'How to sign and send the base64 transaction returned by build endpoints',
      javascript: `import { VersionedTransaction, Connection, clusterApiUrl } from '@solana/web3.js';

const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

// After calling /api/chain/build/buy or /api/chain/build/sell:
const { transaction: txBase64 } = await response.json();
const txBytes = Buffer.from(txBase64, 'base64');
const tx = VersionedTransaction.deserialize(txBytes);

// Sign with Phantom:
const signedTx = await window.solana.signTransaction(tx);
const sig = await connection.sendRawTransaction(signedTx.serialize());
await connection.confirmTransaction(sig, 'confirmed');

// Then sync:
await fetch('/api/chain/sync/trade', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ txSignature: sig, mintAddress, traderWallet }),
});`,
    },
  },

  common_errors: {
    pool_not_found: {
      cause: 'Pool account does not exist on-chain for the given mint',
      fix: 'Verify the mint address is correct. If the token was just created, wait for tx confirmation then call POST /api/tokens/:id/activate',
    },
    MathOverflow: {
      cause: 'Arithmetic overflow in curve calculation — usually means buying/selling an extremely large or zero amount',
      fix: 'Reduce the trade size or check that sol_amount > 0 and token_amount > 0',
    },
    SlippageExceeded: {
      cause: 'Price moved beyond slippageBps tolerance between quote and execution',
      fix: 'Increase slippageBps (try 200-500) or rebuild the transaction with a fresh quote',
    },
    insufficient_lamports: {
      cause: 'Buyer wallet does not have enough SOL for the trade + rent + transaction fees',
      fix: 'Ensure wallet has at least solAmount + 0.01 SOL for fees. On devnet: airdrop with `solana airdrop 2`',
    },
    PoolNotActive: {
      cause: 'Pool status is Graduated — bonding curve trading is disabled',
      fix: 'Token has graduated to Raydium. Use post-graduation endpoints: /api/chain/build/post-grad/buy',
    },
    authorities_not_revoked: {
      cause: 'Tried to activate a token without revoking freeze/mint/metadata authorities',
      fix: 'Use /api/chain/build/create-token which revokes all authorities atomically. Pass authoritiesRevoked: { freeze: true, mint: true, metadata: true }',
    },
    ata_not_found: {
      cause: 'Buyer token account (ATA) does not exist on-chain',
      fix: 'The build/buy endpoint auto-detects missing ATAs and includes createATA instruction. Make sure to use the returned transaction without modification.',
    },
  },
};
