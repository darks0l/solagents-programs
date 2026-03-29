import { v4 as uuidv4 } from 'uuid';
import { stmts } from '../services/db.js';
import { authHook } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Trading Routes
 * 
 * Spot swaps via Jupiter aggregator.
 * Perp markets via Drift Protocol.
 * 
 * NOTE: Actual trade execution happens client-side (agents sign their own txs).
 * This API provides quotes, records trades, and tracks portfolio.
 */

const JUPITER_API = 'https://quote-api.jup.ag/v6';

export default async function tradeRoutes(fastify) {

  // Get swap quote from Jupiter
  fastify.get('/api/trade/quote', {
    preHandler: [authHook, rateLimit({ max: 30, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { inputMint, outputMint, amount, slippageBps } = request.query;

    if (!inputMint || !outputMint || !amount) {
      return reply.code(400).send({
        error: 'Required query params: inputMint, outputMint, amount (in smallest unit)',
      });
    }

    try {
      const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps || 50}`;
      const res = await fetch(url);
      const quote = await res.json();

      if (quote.error) {
        return reply.code(400).send({ error: quote.error });
      }

      return {
        quote,
        hint: 'Use this quote in POST /api/trade/swap to record the trade after execution',
      };
    } catch (err) {
      return reply.code(502).send({ error: `Jupiter API error: ${err.message}` });
    }
  });

  // Get swap transaction from Jupiter
  fastify.post('/api/trade/swap/tx', {
    preHandler: [authHook, rateLimit({ max: 10, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { quoteResponse } = request.body || {};

    if (!quoteResponse) {
      return reply.code(400).send({ error: 'quoteResponse required (from /api/trade/quote)' });
    }

    try {
      const res = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: request.agent.wallet_address,
          wrapAndUnwrapSol: true,
        }),
      });
      const data = await res.json();
      return data;
    } catch (err) {
      return reply.code(502).send({ error: `Jupiter swap error: ${err.message}` });
    }
  });

  // Record a completed swap
  fastify.post('/api/trade/swap', {
    preHandler: [authHook, rateLimit({ max: 20, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { inputToken, outputToken, amount, txSignature, result } = request.body || {};

    if (!inputToken || !outputToken || !amount || !txSignature) {
      return reply.code(400).send({
        error: 'Required: inputToken, outputToken, amount, txSignature',
      });
    }

    const tradeId = `trade_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    stmts.insertTrade.run(tradeId, request.agent.id, 'swap', inputToken, outputToken, amount);
    stmts.updateTrade.run('confirmed', JSON.stringify(result || {}), txSignature, tradeId);

    return reply.code(201).send({
      success: true,
      tradeId,
      type: 'swap',
      txSignature,
    });
  });

  // Record a perp position open
  fastify.post('/api/trade/perp/open', {
    preHandler: [authHook, rateLimit({ max: 10, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { market, side, size, leverage, txSignature, result } = request.body || {};

    if (!market || !side || !size) {
      return reply.code(400).send({
        error: 'Required: market, side (long/short), size',
      });
    }

    const tradeId = `trade_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    stmts.insertTrade.run(
      tradeId, request.agent.id, 'perp_open',
      market, `${side}_${leverage || 1}x`, String(size)
    );

    if (txSignature) {
      stmts.updateTrade.run('confirmed', JSON.stringify(result || {}), txSignature, tradeId);
    }

    return reply.code(201).send({
      success: true,
      tradeId,
      type: 'perp_open',
      market,
      side,
      size,
      leverage: leverage || 1,
    });
  });

  // Record a perp position close
  fastify.post('/api/trade/perp/close', {
    preHandler: [authHook, rateLimit({ max: 10, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { tradeId, txSignature, pnl, result } = request.body || {};

    if (!tradeId) {
      return reply.code(400).send({ error: 'tradeId required (from perp/open)' });
    }

    const closeId = `trade_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    stmts.insertTrade.run(closeId, request.agent.id, 'perp_close', tradeId, null, String(pnl || 0));

    if (txSignature) {
      stmts.updateTrade.run('confirmed', JSON.stringify(result || {}), txSignature, closeId);
    }

    return reply.code(201).send({
      success: true,
      tradeId: closeId,
      type: 'perp_close',
      originalTradeId: tradeId,
      pnl,
    });
  });

  // Get agent's trade history
  fastify.get('/api/trade/history', {
    preHandler: [authHook],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;

    const trades = stmts.getAgentTrades.all(request.agent.id, limit, offset);

    return {
      trades: trades.map(t => ({
        id: t.id,
        type: t.type,
        inputToken: t.input_token,
        outputToken: t.output_token,
        amount: t.amount,
        result: t.result ? JSON.parse(t.result) : null,
        txSignature: t.tx_signature,
        status: t.status,
        createdAt: t.created_at,
        completedAt: t.completed_at,
      })),
      pagination: { limit, offset },
    };
  });

  // Portfolio overview (aggregated from trade history)
  fastify.get('/api/trade/portfolio', {
    preHandler: [authHook],
  }, async (request) => {
    // Get all confirmed trades for this agent
    const trades = stmts.getAgentTrades.all(request.agent.id, 1000, 0);
    
    const swapCount = trades.filter(t => t.type === 'swap').length;
    const perpCount = trades.filter(t => t.type.startsWith('perp_')).length;
    const openPerps = trades.filter(t => t.type === 'perp_open' && t.status === 'confirmed');

    return {
      agentId: request.agent.id,
      walletAddress: request.agent.wallet_address,
      stats: {
        totalTrades: trades.length,
        swaps: swapCount,
        perps: perpCount,
        openPositions: openPerps.length,
      },
      recentTrades: trades.slice(0, 10).map(t => ({
        id: t.id,
        type: t.type,
        inputToken: t.input_token,
        outputToken: t.output_token,
        amount: t.amount,
        status: t.status,
        createdAt: t.created_at,
      })),
    };
  });
}
