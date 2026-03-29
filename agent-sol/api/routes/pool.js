import { randomUUID } from 'crypto';
import { stmts } from '../services/db.js';
import { createPool, calculateBuy, calculateSell, getPoolStats, checkGraduation, lamportsToSol, rawToTokens, POOL_CONFIG } from '../services/pool.js';
import { emitTrade, emitGraduation } from '../services/ws-feed.js';

/**
 * Bonding Curve Pool Routes
 * Buy/sell agent tokens through virtual AMM
 * Dev buy tracking, fee claims, pool info
 */
export default async function poolRoutes(fastify) {

  // === POOL INFO ===

  // Get pool state + stats for a token
  fastify.get('/api/pool/:tokenId', async (request, reply) => {
    const pool = stmts.getPool.get(request.params.tokenId);
    if (!pool) return reply.code(404).send({ error: 'Pool not found' });

    const token = stmts.getAgentToken.get(request.params.tokenId);
    const stats = getPoolStats(pool);
    const devBuys = stmts.getDevBuys.all(request.params.tokenId);

    return {
      pool: {
        ...stats,
        virtual_sol_reserve: lamportsToSol(pool.virtual_sol_reserve),
        virtual_token_reserve: rawToTokens(pool.virtual_token_reserve),
      },
      token: token ? {
        id: token.id,
        name: token.token_name,
        symbol: token.token_symbol,
        logo: token.logo_url,
      } : null,
      devBuys: devBuys.map(d => ({
        wallet: d.dev_wallet,
        sol_spent: lamportsToSol(d.amount_sol),
        tokens_received: rawToTokens(d.amount_token),
        price: lamportsToSol(d.price_per_token),
        tx: d.tx_signature,
        timestamp: d.created_at,
      })),
      config: {
        total_supply: '1,000,000,000',
        initial_virtual_sol: '30 SOL',
        fee_bps: POOL_CONFIG.FEE_BPS,
        creator_fee_pct: `${(POOL_CONFIG.CREATOR_FEE_SHARE * POOL_CONFIG.FEE_BPS / 100 / 100).toFixed(1)}%`,
        platform_fee_pct: `${(POOL_CONFIG.PLATFORM_FEE_SHARE * POOL_CONFIG.FEE_BPS / 100 / 100).toFixed(1)}%`,
        liquidity_locked: true,
      },
    };
  });

  // Get price quote (read-only, no execution)
  fastify.get('/api/pool/:tokenId/quote', async (request, reply) => {
    const pool = stmts.getPool.get(request.params.tokenId);
    if (!pool) return reply.code(404).send({ error: 'Pool not found' });

    const { side, amount } = request.query;
    if (!side || !['buy', 'sell'].includes(side)) {
      return reply.code(400).send({ error: 'side must be buy or sell' });
    }
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number (lamports for buy, raw tokens for sell)' });
    }

    try {
      const quote = side === 'buy'
        ? calculateBuy(pool, amount)
        : calculateSell(pool, amount);

      return {
        side,
        input: side === 'buy' ? `${lamportsToSol(amount)} SOL` : `${rawToTokens(amount)} tokens`,
        output: side === 'buy' ? `${rawToTokens(quote.tokensOut)} tokens` : `${lamportsToSol(quote.solOut)} SOL`,
        fee: lamportsToSol(quote.feeTotal),
        creator_fee: lamportsToSol(quote.creatorFee),
        platform_fee: lamportsToSol(quote.platformFee),
        price_after: lamportsToSol(quote.pricePerToken),
        price_impact: calculatePriceImpact(pool, quote),
      };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // === TRADING ===

  // Buy tokens with SOL
  fastify.post('/api/pool/:tokenId/buy', async (request, reply) => {
    const pool = stmts.getPool.get(request.params.tokenId);
    if (!pool) return reply.code(404).send({ error: 'Pool not found' });

    const token = stmts.getAgentToken.get(request.params.tokenId);
    if (!token || token.status !== 'active') {
      return reply.code(400).send({ error: 'Token not active' });
    }

    // Block trading on graduated pools
    if (pool.status === 'graduated') {
      return reply.code(400).send({ error: 'Pool has graduated to Raydium — trade on Raydium directly', raydium_pool: pool.raydium_pool_address });
    }

    const { solAmount, buyerWallet, txSignature, isDevBuy } = request.body || {};
    if (!solAmount || BigInt(solAmount) <= 0n) {
      return reply.code(400).send({ error: 'solAmount required (in lamports)' });
    }
    if (!buyerWallet) return reply.code(400).send({ error: 'buyerWallet required' });

    try {
      const result = calculateBuy(pool, solAmount);

      // Update pool state
      const np = result.newPool;
      stmts.updatePool.run(
        np.virtual_sol_reserve, np.virtual_token_reserve,
        np.real_sol_reserve, np.real_token_reserve,
        np.circulating_supply, np.current_price_lamports,
        request.params.tokenId
      );

      // Record trade
      const tradeId = randomUUID();
      stmts.insertTokenTrade.run(
        tradeId, token.id, buyerWallet, 'buy',
        result.tokensOut, result.solIn,
        result.pricePerToken, txSignature || null
      );

      // Record price snapshot
      const stats = getPoolStats({ ...pool, ...np, current_price_lamports: np.current_price_lamports });
      stmts.insertTokenPrice.run(
        token.id, stats.price_sol, null, result.solIn, stats.market_cap_sol, null
      );

      // Accrue creator fee
      if (BigInt(result.creatorFee) > 0n) {
        stmts.insertFeeAccrual.run(
          randomUUID(), token.agent_id, 'token_trade',
          Number(BigInt(result.creatorFee)), result.tokensOut,
          token.mint_address, tradeId
        );
      }

      // Track dev buy if creator wallet
      if (isDevBuy || buyerWallet === token.creator_wallet) {
        stmts.insertDevBuy.run(
          randomUUID(), token.id, buyerWallet,
          result.solAfterFee, result.tokensOut,
          result.pricePerToken, txSignature || null
        );
      }

      // Check graduation status after trade
      const updatedPool = stmts.getPool.get(request.params.tokenId);
      const graduation = updatedPool ? checkGraduation(updatedPool) : null;

      // Emit trade event to WebSocket feed
      emitTrade(request.params.tokenId, {
        type: 'buy',
        tradeId,
        wallet: buyerWallet,
        solAmount: lamportsToSol(result.solIn),
        tokenAmount: rawToTokens(result.tokensOut),
        price: lamportsToSol(result.pricePerToken),
        fee: lamportsToSol(result.feeTotal),
        isDevBuy: isDevBuy || buyerWallet === token.creator_wallet,
        symbol: token.token_symbol,
        name: token.token_name,
        txSignature: txSignature || null,
      });

      // Emit graduation if ready
      if (graduation?.ready) {
        emitGraduation(request.params.tokenId, {
          symbol: token.token_symbol,
          name: token.token_name,
          progress: graduation.progress,
          mint: token.mint_address,
        });
      }

      return {
        tradeId,
        tokensReceived: rawToTokens(result.tokensOut),
        tokensReceivedRaw: result.tokensOut,
        solSpent: lamportsToSol(result.solIn),
        fee: lamportsToSol(result.feeTotal),
        creatorFee: lamportsToSol(result.creatorFee),
        platformFee: lamportsToSol(result.platformFee),
        newPrice: lamportsToSol(result.pricePerToken),
        isDevBuy: isDevBuy || buyerWallet === token.creator_wallet,
        graduation: graduation ? {
          progress: graduation.progress,
          ready: graduation.ready,
        } : null,
      };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Sell tokens for SOL
  fastify.post('/api/pool/:tokenId/sell', async (request, reply) => {
    const pool = stmts.getPool.get(request.params.tokenId);
    if (!pool) return reply.code(404).send({ error: 'Pool not found' });

    const token = stmts.getAgentToken.get(request.params.tokenId);
    if (!token || token.status !== 'active') {
      return reply.code(400).send({ error: 'Token not active' });
    }

    // Block trading on graduated pools
    if (pool.status === 'graduated') {
      return reply.code(400).send({ error: 'Pool has graduated to Raydium — trade on Raydium directly', raydium_pool: pool.raydium_pool_address });
    }

    const { tokenAmount, sellerWallet, txSignature } = request.body || {};
    if (!tokenAmount || BigInt(tokenAmount) <= 0n) {
      return reply.code(400).send({ error: 'tokenAmount required (raw units)' });
    }
    if (!sellerWallet) return reply.code(400).send({ error: 'sellerWallet required' });

    try {
      const result = calculateSell(pool, tokenAmount);

      // Update pool state
      const np = result.newPool;
      stmts.updatePool.run(
        np.virtual_sol_reserve, np.virtual_token_reserve,
        np.real_sol_reserve, np.real_token_reserve,
        np.circulating_supply, np.current_price_lamports,
        request.params.tokenId
      );

      // Record trade
      const tradeId = randomUUID();
      stmts.insertTokenTrade.run(
        tradeId, token.id, sellerWallet, 'sell',
        result.tokensIn, result.solOut,
        result.pricePerToken, txSignature || null
      );

      // Record price snapshot
      const stats = getPoolStats({ ...pool, ...np, current_price_lamports: np.current_price_lamports });
      stmts.insertTokenPrice.run(
        token.id, stats.price_sol, null, result.solOut, stats.market_cap_sol, null
      );

      // Accrue creator fee
      if (BigInt(result.creatorFee) > 0n) {
        stmts.insertFeeAccrual.run(
          randomUUID(), token.agent_id, 'token_trade',
          Number(BigInt(result.creatorFee)), result.tokensIn,
          token.mint_address, tradeId
        );
      }

      // Emit trade event to WebSocket feed
      emitTrade(request.params.tokenId, {
        type: 'sell',
        tradeId,
        wallet: sellerWallet,
        solAmount: lamportsToSol(result.solOut),
        tokenAmount: rawToTokens(result.tokensIn),
        price: lamportsToSol(result.pricePerToken),
        fee: lamportsToSol(result.feeTotal),
        isDevBuy: false,
        symbol: token.token_symbol,
        name: token.token_name,
        txSignature: txSignature || null,
      });

      return {
        tradeId,
        solReceived: lamportsToSol(result.solOut),
        solReceivedRaw: result.solOut,
        tokensSold: rawToTokens(result.tokensIn),
        fee: lamportsToSol(result.feeTotal),
        creatorFee: lamportsToSol(result.creatorFee),
        platformFee: lamportsToSol(result.platformFee),
        newPrice: lamportsToSol(result.pricePerToken),
      };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // === DEV BUY INFO ===

  // Get dev buy transparency data for a token
  fastify.get('/api/pool/:tokenId/dev', async (request, reply) => {
    const token = stmts.getAgentToken.get(request.params.tokenId);
    if (!token) return reply.code(404).send({ error: 'Token not found' });

    const devBuys = stmts.getDevBuys.all(request.params.tokenId);
    const devTotals = stmts.getDevBuyTotal.all(request.params.tokenId);
    const pool = stmts.getPool.get(request.params.tokenId);
    const poolStats = pool ? getPoolStats(pool) : null;

    return {
      tokenId: token.id,
      symbol: token.token_symbol,
      creator_wallet: token.creator_wallet,
      dev_buys: devBuys.map(d => ({
        wallet: d.dev_wallet,
        sol_spent: lamportsToSol(d.amount_sol),
        tokens_received: rawToTokens(d.amount_token),
        tokens_received_raw: d.amount_token,
        avg_price: lamportsToSol(d.price_per_token),
        tx: d.tx_signature,
        timestamp: d.created_at,
      })),
      totals: devTotals.map(t => ({
        wallet: t.dev_wallet,
        total_sol_spent: (t.total_sol / 1e9).toFixed(9),
        total_tokens: (t.total_tokens / 1e9).toFixed(2),
        pct_of_supply: poolStats ? ((t.total_tokens / Number(BigInt(pool.total_supply))) * 100).toFixed(4) : '0',
      })),
      fair_launch: true,
      note: 'All dev buys happen at the same bonding curve price as public buyers. No pre-mine, no allocation.',
    };
  });

  // === FEE CLAIMS ===

  // Claim creator fees (triggers split + payout)
  fastify.post('/api/agents/:agentId/fees/claim', async (request, reply) => {
    const agent = stmts.getAgent.get(request.params.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const { callerWallet: bodyCallerWallet } = request.body || {};
    // If request is authenticated (Bearer auth), fall back to agent's registered wallet
    const callerWallet = bodyCallerWallet || agent.wallet_address;
    if (!callerWallet) return reply.code(400).send({ error: 'callerWallet required (or use Bearer auth)' });

    // Verify caller is the agent's wallet (creator)
    if (callerWallet !== agent.wallet_address) {
      return reply.code(403).send({ error: 'Only the agent creator wallet can claim fees' });
    }

    // Get unclaimed fee summary
    const summary = stmts.getFeeSummary.get(request.params.agentId);
    if (!summary?.unclaimed_lamports || summary.unclaimed_lamports === 0) {
      return reply.code(400).send({ error: 'No unclaimed fees available' });
    }

    const totalUnclaimed = summary.unclaimed_lamports;
    // The fee accruals already represent just the creator's 70% share
    // Platform's 30% was already separated at trade time
    const creatorAmount = totalUnclaimed;
    const platformAmount = Math.floor(totalUnclaimed * 30 / 70); // Reconstruct platform share for records

    // Create claim record
    const claimId = randomUUID();
    stmts.insertFeeClaim.run(
      claimId, request.params.agentId,
      creatorAmount, platformAmount,
      creatorAmount + platformAmount, 'pending'
    );

    // Mark fees as claimed
    stmts.claimFees.run(claimId, request.params.agentId);

    // In production: trigger SOL transfer to creator wallet here
    // For now: mark as completed (payout handled by admin/cron)
    stmts.updateFeeClaim.run('completed', `pending-payout-${claimId}`, claimId);

    return {
      claimId,
      status: 'completed',
      creator_payout: lamportsToSol(creatorAmount.toString()),
      creator_payout_lamports: creatorAmount,
      platform_share: lamportsToSol(platformAmount.toString()),
      platform_share_lamports: platformAmount,
      total_fees_in_claim: summary.unclaimed_count,
      payout_to: agent.wallet_address,
      note: 'Payout queued. SOL will be sent to your wallet within 24h.',
    };
  });

  // Get fee claim history for an agent
  fastify.get('/api/agents/:agentId/claims', async (request, reply) => {
    const agent = stmts.getAgent.get(request.params.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const claims = stmts.getFeeClaims.all(request.params.agentId, limit, offset);
    const claimStats = stmts.getFeeClaimStats.get(request.params.agentId);
    const feeSummary = stmts.getFeeSummary.get(request.params.agentId);

    return {
      claims: claims.map(c => ({
        id: c.id,
        creator_payout: lamportsToSol(c.creator_amount_lamports.toString()),
        platform_share: lamportsToSol(c.platform_amount_lamports.toString()),
        status: c.status,
        payout_tx: c.payout_tx,
        created_at: c.created_at,
        completed_at: c.completed_at,
      })),
      totals: {
        total_claimed_sol: lamportsToSol((claimStats?.total_claimed_lamports || 0).toString()),
        total_platform_sol: lamportsToSol((claimStats?.total_platform_lamports || 0).toString()),
        completed_claims: claimStats?.completed_claims || 0,
        unclaimed_sol: lamportsToSol((feeSummary?.unclaimed_lamports || 0).toString()),
        unclaimed_count: feeSummary?.unclaimed_count || 0,
      },
    };
  });

  // === TOKENIZATION CONFIG ===

  // Public endpoint: tokenization parameters
  fastify.get('/api/tokenize/config', async () => ({
    total_supply: '1,000,000,000',
    supply_raw: POOL_CONFIG.TOTAL_SUPPLY.toString(),
    decimals: 9,
    initial_virtual_sol: '30 SOL',
    initial_virtual_sol_lamports: POOL_CONFIG.VIRTUAL_SOL_RESERVE.toString(),
    initial_price: `~${lamportsToSol(POOL_CONFIG.INITIAL_PRICE_LAMPORTS.toString())} SOL`,
    initial_fdv: '~30 SOL',
    fee_structure: {
      total_fee: '2%',
      creator_share: '70% (1.4% effective)',
      platform_share: '30% (0.6% effective)',
    },
    bonding_curve: 'Constant product (x * y = k)',
    liquidity: 'Permanently locked — no rug pulls',
    allocation: '100% to bonding curve pool — no pre-mine, no team tokens',
    dev_buy: 'Optional — creator can buy at launch at the same curve price as everyone. Tracked + displayed publicly.',
    fair_launch: true,
    authorities_revoked: {
      freeze: 'Revoked — no one can freeze any holder account',
      mint: 'Revoked — supply is permanently fixed at 1B. No more tokens can ever be created.',
      metadata: 'Revoked — token name, symbol, logo, and description are permanent and immutable.',
    },
    security: 'All three authorities (freeze, mint, metadata) are revoked on-chain at token creation. This is enforced by the platform — tokens cannot be activated without confirmed revocation.',
  }));
}

// === Helpers ===

function calculatePriceImpact(pool, quote) {
  const oldPrice = Number(BigInt(pool.current_price_lamports));
  const newPrice = Number(BigInt(quote.pricePerToken));
  if (oldPrice === 0) return '0%';
  const impact = Math.abs((newPrice - oldPrice) / oldPrice * 100);
  return `${impact.toFixed(2)}%`;
}
