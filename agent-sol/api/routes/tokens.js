import { randomUUID } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { stmts } from '../services/db.js';
import { optionalAuth, authHook } from '../middleware/auth.js';
import { createPool, POOL_CONFIG, lamportsToSol, rawToTokens } from '../services/pool.js';
import { connection } from '../services/commerce.js';

/**
 * Verify a Solana transaction was confirmed on-chain.
 * Returns true if the tx exists and succeeded (meta.err === null).
 */
async function verifyTx(signature) {
  try {
    const tx = await connection.getTransaction(signature, { commitment: 'confirmed' });
    if (!tx) return false;
    if (tx.meta && tx.meta.err !== null) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Agent Token Routes
 * Tokenization, trading data, price charts, fee management
 */
export default async function tokenRoutes(fastify) {

  // === TOKEN DIRECTORY ===

  // List all active agent tokens (with latest price data + pool reserves)
  fastify.get('/api/tokens', async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;
    const tokens = stmts.listActiveTokens.all(limit, offset);

    // Enrich with pool reserve data from DB
    const enriched = tokens.map(t => {
      const pool = stmts.getPool?.get(t.id);
      if (pool) {
        t.real_sol_reserve = (Number(BigInt(pool.real_sol_reserve)) / 1e9).toFixed(9);
        t.virtual_sol_reserve = (Number(BigInt(pool.virtual_sol_reserve)) / 1e9).toFixed(9);
        t.virtual_token_reserve = (Number(BigInt(pool.virtual_token_reserve)) / 1e9).toFixed(2);
        t.pool_status = pool.status;
      }
      return t;
    });

    return { tokens: enriched, pagination: { limit, offset } };
  });

  // Top agents sorted by combined revenue (token fees + job revenue)
  fastify.get('/api/agents/top', async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 10, 50);
    const offset = parseInt(request.query.offset) || 0;
    const agents = stmts.listTopAgentsByRevenue.all(limit, offset);
    return {
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        wallet_address: a.wallet_address,
        capabilities: JSON.parse(a.capabilities || '[]'),
        token_symbol: a.token_symbol || null,
        token_name: a.token_name || null,
        mint_address: a.mint_address || null,
        token_status: a.token_status || null,
        completed_jobs: a.completed_jobs || 0,
        token_fees_sol: (Number(a.token_fees_earned || 0) / 1e9).toFixed(6),
        platform_fees_sol: (Number(a.token_platform_fees || 0) / 1e9).toFixed(6),
        token_volume_sol: (Number(a.token_volume_sol || 0) / 1e9).toFixed(6),
        token_trades: a.token_trades || 0,
        job_revenue_usdc: (Number(a.job_revenue || 0) / 1e6).toFixed(2),
        combined_revenue_lamports: Number(a.combined_revenue || 0),
      })),
      pagination: { limit, offset },
    };
  });

  // Get specific token details (with pool + dev buy transparency)
  fastify.get('/api/tokens/:id', async (request, reply) => {
    const token = stmts.getAgentToken.get(request.params.id);
    if (!token) return reply.code(404).send({ error: 'Token not found' });

    const price = stmts.getLatestTokenPrice.get(token.id);
    const agent = stmts.getAgent.get(token.agent_id);
    const stats = stmts.getAgentStats.get(token.agent_id);
    const recentTrades = stmts.getTokenTrades.all(token.id, 20, 0);
    const pool = stmts.getPool.get(token.id);
    const devBuys = stmts.getDevBuys.all(token.id);
    const devTotals = stmts.getDevBuyTotal.all(token.id);
    const feeSummary = stmts.getFeeSummary.get(token.agent_id);
    const claimStats = stmts.getFeeClaimStats.get(token.agent_id);

    return {
      token: {
        ...token,
        current_price: pool ? lamportsToSol(pool.current_price_lamports) : (price?.price_sol || '0'),
        price_usd: price?.price_usd || '0',
        market_cap: pool ? (Number(BigInt(pool.current_price_lamports)) * Number(BigInt(pool.total_supply)) / 1e18 / 1e9).toFixed(4) : (price?.market_cap || '0'),
        volume_24h: price?.volume_24h || '0',
        holders: price?.holders || 0,
        circulating: pool ? rawToTokens(pool.circulating_supply) : '0',
        total_supply: '1,000,000,000',
      },
      pool: pool ? {
        price_sol: lamportsToSol(pool.current_price_lamports),
        pool_sol: lamportsToSol(pool.real_sol_reserve),
        circulating: rawToTokens(pool.circulating_supply),
        liquidity_locked: true,
        bonding_curve: 'constant product',
      } : null,
      agent: agent ? {
        id: agent.id,
        name: agent.name,
        walletAddress: agent.wallet_address,
        capabilities: JSON.parse(agent.capabilities || '[]'),
      } : null,
      stats: stats || null,
      devBuys: {
        buys: devBuys.map(d => ({
          wallet: d.dev_wallet,
          sol_spent: lamportsToSol(d.amount_sol),
          tokens_received: rawToTokens(d.amount_token),
          timestamp: d.created_at,
        })),
        totals: devTotals.map(t => ({
          wallet: t.dev_wallet,
          total_sol: (t.total_sol / 1e9).toFixed(9),
          total_tokens: (t.total_tokens / 1e9).toFixed(2),
          pct_of_supply: pool ? ((t.total_tokens / Number(BigInt(pool.total_supply))) * 100).toFixed(4) : '0',
        })),
      },
      fees: {
        unclaimed_sol: lamportsToSol((feeSummary?.unclaimed_lamports || 0).toString()),
        claimed_sol: lamportsToSol((claimStats?.total_claimed_lamports || 0).toString()),
        total_earned_sol: lamportsToSol(((feeSummary?.unclaimed_lamports || 0) + (claimStats?.total_claimed_lamports || 0)).toString()),
        claims_completed: claimStats?.completed_claims || 0,
      },
      recentTrades,
    };
  });

  // Get token by agent ID
  fastify.get('/api/agents/:agentId/token', async (request, reply) => {
    const token = stmts.getAgentTokenByAgent.get(request.params.agentId);
    if (!token) return reply.code(404).send({ error: 'Agent has not tokenized', tokenized: false });

    const price = stmts.getLatestTokenPrice.get(token.id);
    return {
      tokenized: true,
      token: {
        ...token,
        current_price: price?.price_sol || '0',
        price_usd: price?.price_usd || '0',
        market_cap: price?.market_cap || '0',
        volume_24h: price?.volume_24h || '0',
        holders: price?.holders || 0,
      },
    };
  });

  // === PRICE CHARTS ===

  // Get price history for charts
  fastify.get('/api/tokens/:id/chart', async (request, reply) => {
    // Try by internal ID first, then by mint address
    let token = stmts.getAgentToken.get(request.params.id);
    if (!token) token = stmts.getAgentTokenByMint?.get(request.params.id);
    if (!token) return reply.code(404).send({ error: 'Token not found' });

    const limit = Math.min(parseInt(request.query.limit) || 100, 500);
    const prices = stmts.getTokenPriceHistory.all(token.id, limit);

    return {
      tokenId: token.id,
      symbol: token.token_symbol,
      prices: prices.reverse(), // oldest first for chart rendering
    };
  });

  // Chart by mint address
  fastify.get('/api/tokens/by-mint/:mint/chart', async (request, reply) => {
    const token = stmts.getAgentTokenByMint?.get(request.params.mint);
    if (!token) return reply.code(404).send({ error: 'Token not found for mint' });

    const limit = Math.min(parseInt(request.query.limit) || 100, 500);
    const prices = stmts.getTokenPriceHistory.all(token.id, limit);

    return {
      tokenId: token.id,
      symbol: token.token_symbol,
      prices: prices.reverse(),
    };
  });

  // === TRADE HISTORY ===

  // Get trade history for a token
  fastify.get('/api/tokens/:id/trades', async (request, reply) => {
    const token = stmts.getAgentToken.get(request.params.id);
    if (!token) return reply.code(404).send({ error: 'Token not found' });

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const trades = stmts.getTokenTrades.all(token.id, limit, offset);

    return { trades, pagination: { limit, offset } };
  });

  // Get trades by mint address
  fastify.get('/api/tokens/by-mint/:mint/trades', async (request, reply) => {
    const token = stmts.getAgentTokenByMint?.get(request.params.mint);
    if (!token) return reply.code(404).send({ error: 'Token not found for mint' });

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const trades = stmts.getTokenTrades.all(token.id, limit, offset);

    return { trades, pagination: { limit, offset } };
  });

  // Get trades by wallet
  fastify.get('/api/tokens/wallet/:address/trades', async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const trades = stmts.getTraderHistory.all(request.params.address, limit);
    return { trades };
  });

  // === TOKENIZATION ===

  // Tokenize an agent (create token request)
  // Two valid flows:
  //   1. Agent self-tokenizes: Bearer auth present → creatorWallet = agent's registered wallet (DB)
  //   2. Human tokenizes agent: no Bearer auth → creatorWallet must be supplied in body (human's Phantom wallet)
  fastify.post('/api/agents/:agentId/tokenize', {
    preHandler: [optionalAuth],
  }, async (request, reply) => {
    const { agentId } = request.params;
    const { tokenName, tokenSymbol, totalSupply, logoUrl, description, agentDescription } = request.body || {};
    const bodyCreatorWallet = request.body?.creatorWallet;

    // Validate agent exists
    const agent = stmts.getAgent.get(agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    // Determine creatorWallet based on who is calling:
    // - Authenticated agent calling for itself → use DB wallet (can't be spoofed)
    // - Authenticated agent calling for a different agent → reject (agents can't tokenize each other)
    // - No auth (human flow) → use creatorWallet from body (human's wallet receives creator fees)
    let creatorWallet;
    if (request.agent) {
      // Agent-authenticated flow
      if (request.agent.id !== agentId) {
        return reply.code(403).send({ error: 'Agents can only tokenize themselves' });
      }
      creatorWallet = agent.wallet_address;
    } else {
      // Human flow — creatorWallet required in body
      if (!bodyCreatorWallet || bodyCreatorWallet.length < 32) {
        return reply.code(400).send({ error: 'creatorWallet required (your wallet address to receive creator fees)' });
      }
      creatorWallet = bodyCreatorWallet;
    }

    // Check not already tokenized
    const existing = stmts.getAgentTokenByAgent.get(agentId);
    if (existing) return reply.code(409).send({ error: 'Agent already tokenized', token: existing });

    // Validate inputs
    if (!tokenName || tokenName.length < 2 || tokenName.length > 32) {
      return reply.code(400).send({ error: 'Token name must be 2-32 characters' });
    }
    if (!tokenSymbol || tokenSymbol.length < 2 || tokenSymbol.length > 10) {
      return reply.code(400).send({ error: 'Token symbol must be 2-10 characters' });
    }

    const supply = totalSupply || '1000000000';
    const id = randomUUID();

    // 2% total trade fee: 70% to creator (140 bps), 30% to platform (60 bps)
    const creatorFeeBps = 140;
    const platformFeeBps = 60;

    stmts.insertAgentToken.run(
      id, agentId, tokenName, tokenSymbol.toUpperCase(),
      supply, creatorWallet, creatorFeeBps, platformFeeBps,
      logoUrl || null, description || null, agentDescription || null
    );

    // Update agent stats to link token
    const stats = stmts.getAgentStats.get(agentId);
    if (stats) {
      stmts.upsertAgentStats.run(
        agentId, stats.total_jobs, stats.completed_jobs, stats.rejected_jobs,
        stats.total_earned, stats.success_rate, id
      );
    } else {
      stmts.upsertAgentStats.run(agentId, 0, 0, 0, '0', 0, id);
    }

    // Create bonding curve pool
    const poolState = createPool(id);
    stmts.insertPool.run(
      id, poolState.virtual_sol_reserve, poolState.virtual_token_reserve,
      poolState.real_sol_reserve, poolState.real_token_reserve,
      poolState.k, poolState.total_supply, poolState.circulating_supply,
      poolState.current_price_lamports
    );

    return reply.code(201).send({
      id,
      agentId,
      tokenName,
      tokenSymbol: tokenSymbol.toUpperCase(),
      totalSupply: supply,
      creatorWallet,
      creatorFeeBps,
      platformFeeBps,
      status: 'pending',
      pool: {
        initial_price: `~${lamportsToSol(poolState.current_price_lamports)} SOL`,
        initial_fdv: '~30 SOL',
        virtual_sol_reserve: '30 SOL',
        bonding_curve: 'constant product (x * y = k)',
        liquidity: 'permanently locked',
      },
      message: 'Token created with bonding curve pool. Create SPL mint on-chain, revoke all authorities, then activate.',
      authorities: {
        freeze: 'MUST be revoked — no one can freeze holder accounts',
        mint: 'MUST be revoked — supply is fixed at 1B, no more can ever be minted',
        metadata: 'MUST be revoked — token name, symbol, and image are permanent',
      },
      next: {
        step: 'Create SPL token mint on Solana, revoke freeze/mint/metadata authorities',
        endpoint: `POST /api/tokens/${id}/activate`,
        required: ['mintAddress', 'launchTx', 'authoritiesRevoked'],
        authoritiesRevoked: '{ freeze: true, mint: true, metadata: true }',
      },
    });
  });

  // Activate token after on-chain creation.
  // REQUIRES: launchTx verified on-chain, all authorities revoked.
  // Token status is NOT changed to 'active' until the launchTx is confirmed on Solana.
  // This prevents the race condition where the DB shows 'active' before the on-chain
  // create_token tx has actually landed.
  fastify.post('/api/tokens/:id/activate', async (request, reply) => {
    const token = stmts.getAgentToken.get(request.params.id);
    if (!token) return reply.code(404).send({ error: 'Token not found' });
    if (token.status === 'active') return reply.code(409).send({ error: 'Token already active' });

    const { mintAddress, poolAddress, launchTx, authoritiesRevoked } = request.body || {};
    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });
    if (!launchTx) return reply.code(400).send({ error: 'launchTx required' });

    // Enforce authority revocation — all three must be confirmed
    if (!authoritiesRevoked || !authoritiesRevoked.freeze || !authoritiesRevoked.mint || !authoritiesRevoked.metadata) {
      return reply.code(400).send({
        error: 'All authorities must be revoked before activation',
        required: {
          freeze: 'Freeze authority must be revoked (SetAuthority to null)',
          mint: 'Mint authority must be revoked (SetAuthority to null)',
          metadata: 'Metadata update authority must be revoked (set to null)',
        },
        hint: 'Pass authoritiesRevoked: { freeze: true, mint: true, metadata: true } after revoking on-chain',
      });
    }

    // Verify the on-chain create_token tx landed before marking active.
    // This prevents off-chain state from diverging from on-chain state.
    const confirmed = await verifyTx(launchTx);
    if (!confirmed) {
      return reply.code(400).send({
        error: 'launchTx not confirmed on-chain. Ensure the token creation transaction has landed before calling /activate.',
        launchTx,
        hint: 'Wait for the tx to reach "confirmed" commitment, then retry.',
      });
    }

    stmts.updateAgentTokenStatus.run('active', mintAddress, poolAddress || null, launchTx, token.id);

    // Insert initial price point
    stmts.insertTokenPrice.run(token.id, '0', '0', '0', '0', 0);

    return { success: true, status: 'active', mintAddress, poolAddress };
  });

  // Record a token trade (called by indexer or API)
  fastify.post('/api/tokens/:id/trade', async (request, reply) => {
    const token = stmts.getAgentToken.get(request.params.id);
    if (!token || token.status !== 'active') {
      return reply.code(404).send({ error: 'Active token not found' });
    }

    const { traderWallet, side, amountToken, amountSol, pricePerToken, txSignature } = request.body || {};
    if (!traderWallet || !side || !amountToken || !amountSol || !pricePerToken) {
      return reply.code(400).send({ error: 'Missing required fields: traderWallet, side, amountToken, amountSol, pricePerToken' });
    }
    if (!['buy', 'sell'].includes(side)) {
      return reply.code(400).send({ error: 'side must be buy or sell' });
    }

    const tradeId = randomUUID();
    stmts.insertTokenTrade.run(tradeId, token.id, traderWallet, side, amountToken, amountSol, pricePerToken, txSignature || null);

    // Calculate and accrue fees (2% of SOL amount)
    const solAmount = parseFloat(amountSol);
    const totalFeeLamports = Math.floor(solAmount * 1e9 * 0.02); // 2% fee
    const creatorFeeLamports = Math.floor(totalFeeLamports * 0.7); // 70% to creator
    const platformFeeLamports = totalFeeLamports - creatorFeeLamports; // 30% to platform

    // Accrue creator fee
    if (creatorFeeLamports > 0) {
      stmts.insertFeeAccrual.run(
        randomUUID(), token.agent_id, 'token_trade',
        creatorFeeLamports, amountToken, token.mint_address, tradeId
      );
    }

    // Update price snapshot
    stmts.insertTokenPrice.run(token.id, pricePerToken, null, amountSol, null, null);

    return { tradeId, fees: { creator: creatorFeeLamports, platform: platformFeeLamports } };
  });

  // === TOKEN METADATA (Metaplex-compatible JSON) ===

  // Serve token metadata JSON for Metaplex on-chain URI
  fastify.get('/api/tokens/:id/metadata.json', async (request, reply) => {
    const token = stmts.getAgentToken.get(request.params.id);
    if (!token) return reply.code(404).send({ error: 'Token not found' });

    const agent = stmts.getAgent.get(token.agent_id);
    const stats = stmts.getAgentStats.get(token.agent_id);

    // Metaplex Token Metadata Standard
    return {
      name: token.token_name,
      symbol: token.token_symbol,
      description: token.description || `${token.token_name} — an AI agent token on SolAgents. ${token.agent_description || ''}`.trim(),
      image: token.logo_url || 'https://solagents.dev/default-agent-logo.png',
      external_url: `https://solagents.dev/#agents/${token.agent_id}`,
      attributes: [
        { trait_type: 'Agent Name', value: agent?.name || 'Unknown' },
        { trait_type: 'Platform', value: 'SolAgents' },
        { trait_type: 'Total Supply', value: token.total_supply },
        { trait_type: 'Creator Fee', value: `${(token.creator_fee_bps / 100).toFixed(1)}%` },
        ...(stats ? [
          { trait_type: 'Jobs Completed', value: stats.completed_jobs.toString() },
          { trait_type: 'Success Rate', value: `${(stats.success_rate * 100).toFixed(0)}%` },
        ] : []),
        ...(agent?.capabilities ? JSON.parse(agent.capabilities).map(c => ({ trait_type: 'Capability', value: c })) : []),
      ],
      properties: {
        category: 'agent',
        creators: [{ address: token.creator_wallet, share: 100 }],
      },
    };
  });

  // === FEE MANAGEMENT ===

  // Get fee summary for an agent
  fastify.get('/api/agents/:agentId/fees', async (request, reply) => {
    const agent = stmts.getAgent.get(request.params.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const summary = stmts.getFeeSummary.get(request.params.agentId);
    const unclaimed = stmts.getUnclaimedFees.all(request.params.agentId);

    return {
      agentId: request.params.agentId,
      summary: {
        unclaimed_sol: summary?.unclaimed_lamports ? (summary.unclaimed_lamports / 1e9).toFixed(9) : '0',
        claimed_sol: summary?.claimed_lamports ? (summary.claimed_lamports / 1e9).toFixed(9) : '0',
        total_sol: summary?.total_lamports ? (summary.total_lamports / 1e9).toFixed(9) : '0',
        unclaimed_count: summary?.unclaimed_count || 0,
        claimed_count: summary?.claimed_count || 0,
      },
      unclaimed_fees: unclaimed.map(f => ({
        id: f.id,
        source: f.source,
        amount_sol: (f.amount_lamports / 1e9).toFixed(9),
        amount_lamports: f.amount_lamports,
        reference_id: f.reference_id,
        created_at: f.created_at,
      })),
    };
  });

  // Get fee history for an agent
  fastify.get('/api/agents/:agentId/fees/history', async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const fees = stmts.getFeeHistory.all(request.params.agentId, limit, offset);

    return {
      fees: fees.map(f => ({
        ...f,
        amount_sol: (f.amount_lamports / 1e9).toFixed(9),
      })),
      pagination: { limit, offset },
    };
  });

  // Fee claiming is handled by pool routes (POST /api/agents/:agentId/fees/claim)

  // === AGENT STATS & DASHBOARD ===

  // Get full agent dashboard (profile + stats + token + pool + devBuys + fees)
  fastify.get('/api/agents/:agentId/dashboard', async (request, reply) => {
    const agent = stmts.getAgent.get(request.params.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const stats = stmts.getAgentStats.get(request.params.agentId);
    const token = stmts.getAgentTokenByAgent.get(request.params.agentId);
    const feeSummary = stmts.getFeeSummary.get(request.params.agentId);
    const claimStats = stmts.getFeeClaimStats.get(request.params.agentId);

    let tokenData = null;
    let poolData = null;
    let devBuyData = { buys: [], totals: [] };

    if (token) {
      const price = stmts.getLatestTokenPrice.get(token.id);
      const recentTrades = stmts.getTokenTrades.all(token.id, 10, 0);
      const pool = stmts.getPool.get(token.id);
      const devBuys = stmts.getDevBuys.all(token.id);
      const devTotals = stmts.getDevBuyTotal.all(token.id);

      tokenData = {
        ...token,
        current_price: pool ? (Number(BigInt(pool.current_price_lamports)) / 1e9).toFixed(9) : (price?.price_sol || '0'),
        price_usd: price?.price_usd || '0',
        market_cap: pool ? (Number(BigInt(pool.current_price_lamports)) * Number(BigInt(pool.total_supply)) / 1e18 / 1e9).toFixed(4) : (price?.market_cap || '0'),
        volume_24h: price?.volume_24h || '0',
        holders: price?.holders || 0,
        circulating: pool ? (Number(BigInt(pool.circulating_supply)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0',
        total_supply: '1,000,000,000',
        recent_trades: recentTrades,
      };

      if (pool) {
        const vSol = Number(BigInt(pool.virtual_sol_reserve)) / 1e9;  // SOL
        const vToken = Number(BigInt(pool.virtual_token_reserve)) / 1e9; // display tokens
        const realSol = Number(BigInt(pool.real_sol_reserve)) / 1e9;
        const totalSupplyDisplay = Number(BigInt(pool.total_supply)) / 1e9;
        const priceSol = vToken > 0 ? vSol / vToken : 0;
        // FDV market cap: (real_sol + initial_virtual_30) * (total_supply / tokens_in_pool)
        const marketCapSol = vToken > 0 ? (realSol + 30) * (totalSupplyDisplay / vToken) : 0;

        poolData = {
          price_sol: priceSol.toFixed(12),
          pool_sol: (Number(BigInt(pool.real_sol_reserve)) / 1e9).toFixed(9),
          virtual_sol: vSol.toFixed(9),
          virtual_token: vToken.toFixed(2),
          total_supply: totalSupplyDisplay,
          market_cap_sol: marketCapSol.toFixed(4),
          circulating: (Number(BigInt(pool.circulating_supply)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 }),
          liquidity_locked: true,
        };
      }

      devBuyData = {
        buys: devBuys.map(d => ({
          wallet: d.dev_wallet,
          sol_spent: (Number(BigInt(d.amount_sol)) / 1e9).toFixed(9),
          tokens_received: (Number(BigInt(d.amount_token)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 }),
          timestamp: d.created_at,
        })),
        totals: devTotals.map(t => ({
          wallet: t.dev_wallet,
          total_sol: (t.total_sol / 1e9).toFixed(9),
          total_tokens: (t.total_tokens / 1e9).toFixed(2),
          pct_of_supply: pool ? ((t.total_tokens / Number(BigInt(pool.total_supply))) * 100).toFixed(4) : '0',
        })),
      };
    }

    // Fetch creator's current on-chain token balance
    let creatorHoldings = null;
    if (token?.mint_address && token?.creator_wallet) {
      try {
        const mintPk = new PublicKey(token.mint_address);
        const creatorPk = new PublicKey(token.creator_wallet);
        const ata = await getAssociatedTokenAddress(mintPk, creatorPk);
        const acct = await getAccount(connection, ata);
        const rawBalance = BigInt(acct.amount.toString());
        const displayBalance = Number(rawBalance) / 1e9; // 9 decimals
        const totalSupplyRaw = poolData ? poolData.total_supply * 1e9 : 1e18;
        creatorHoldings = {
          wallet: token.creator_wallet,
          balance_raw: rawBalance.toString(),
          balance: displayBalance.toLocaleString('en-US', { maximumFractionDigits: 2 }),
          pct_of_supply: totalSupplyRaw > 0 ? ((Number(rawBalance) / totalSupplyRaw) * 100).toFixed(2) : '0',
        };
      } catch {
        // ATA doesn't exist or creator sold everything
        creatorHoldings = {
          wallet: token.creator_wallet,
          balance_raw: '0',
          balance: '0',
          pct_of_supply: '0',
        };
      }
    }

    // Get recent jobs
    const recentJobs = stmts.listJobsByProvider.all(agent.wallet_address, 10, 0);

    return {
      agent: (() => {
        const meta = JSON.parse(agent.metadata || '{}');
        return {
          id: agent.id,
          name: agent.name,
          walletAddress: agent.wallet_address,
          capabilities: JSON.parse(agent.capabilities || '[]'),
          description: meta.description || null,
          github: meta.github || null,
          twitter: meta.twitter || null,
          registeredAt: agent.registered_at,
          lastSeen: agent.last_seen,
        };
      })(),
      stats: stats ? {
        totalJobs: stats.total_jobs,
        completedJobs: stats.completed_jobs,
        rejectedJobs: stats.rejected_jobs,
        successRate: stats.success_rate,
        totalEarned: stats.total_earned,
      } : { totalJobs: 0, completedJobs: 0, rejectedJobs: 0, successRate: 0, totalEarned: '0' },
      token: tokenData,
      tokenized: !!token,
      pool: poolData,
      devBuys: devBuyData,
      creatorHoldings,
      fees: {
        unclaimed_sol: feeSummary?.unclaimed_lamports ? (feeSummary.unclaimed_lamports / 1e9).toFixed(9) : '0',
        claimed_sol: claimStats?.total_claimed_lamports ? (claimStats.total_claimed_lamports / 1e9).toFixed(9) : '0',
        total_sol: ((feeSummary?.unclaimed_lamports || 0) + (claimStats?.total_claimed_lamports || 0)) > 0 
          ? (((feeSummary?.unclaimed_lamports || 0) + (claimStats?.total_claimed_lamports || 0)) / 1e9).toFixed(9) 
          : '0',
      },
      recentJobs: recentJobs.slice(0, 5),
    };
  });

  // === PLATFORM STATS ===

  fastify.get('/api/platform/stats', async () => {
    const stats = stmts.platformStats.get();
    const jobData = stmts.jobStats.get();
    // budget is stored in raw USDC (6 decimals) — convert to human-readable
    const rawPaid = jobData?.total_paid || 0;
    const paidUsd = rawPaid > 1000 ? rawPaid / 1e6 : rawPaid; // handle both raw and decimal formats
    return {
      agents: stats?.total_agents || 0,
      tokenized_agents: stats?.tokenized_agents || 0,
      total_jobs: stats?.total_jobs || 0,
      onchain_completed_jobs: stats?.onchain_completed_jobs || 0,
      active_onchain_jobs: stats?.active_onchain_jobs || 0,
      total_escrowed_usd: parseFloat(paidUsd.toFixed(2)),
      total_token_trades: stats?.total_token_trades || 0,
    };
  });
}
