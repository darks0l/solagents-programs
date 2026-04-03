/**
 * Dividend Routes — 3-Mode System (Regular / Dividend / Buyback & Burn)
 *
 * Creator picks one mode per token:
 *   💰 Regular — creator keeps 100% of fees (default)
 *   🏦 Dividend — fees flow to staking rewards pool
 *   🔥 Buyback & Burn — fees buy tokens and burn them
 *
 * Public:
 *   GET /api/dividends/:tokenId         — dividend config + stats
 *   GET /api/dividends/:tokenId/stakers — staker list
 *   GET /api/dividends/:tokenId/revenue — revenue deposit history
 *   GET /api/dividends/:tokenId/buybacks — buyback event history
 *   GET /api/dividends/:tokenId/stats   — aggregated stats
 *   GET /api/dividends/wallet/:wallet   — all stakes for a wallet
 *   GET /api/dividends/leaderboard      — top tokens by revenue
 *
 * Creator-authenticated (Phantom ed25519):
 *   POST /api/dividends/:tokenId/enable — enable dividends for token
 *   POST /api/dividends/:tokenId/mode   — switch between 3 modes (7-day cooldown)
 *
 * Admin-only:
 *   POST /api/dividends/:tokenId/deposit  — record revenue deposit
 *   POST /api/dividends/:tokenId/buyback  — record buyback event
 */

import { randomUUID } from 'crypto';
import { stmts } from '../services/db.js';
import { verifyWalletSignature } from '../services/crypto.js';
import { adminAuthHook } from '../middleware/adminAuth.js';

const AUTH_WINDOW = 300; // 5 minutes
const MODE_SWITCH_COOLDOWN = 7 * 24 * 3600; // 7 days
const VALID_MODES = ['regular', 'dividend', 'buyback_burn'];

/**
 * Verify creator auth: X-Creator-Auth: wallet:signatureB64:timestamp
 * Message format: SolAgentsDividend:<wallet>:<timestamp>
 */
async function verifyCreatorAuth(request, tokenId) {
  const header = request.headers['x-creator-auth'];
  if (!header) return { valid: false, error: 'Missing X-Creator-Auth header' };

  const parts = header.split(':');
  if (parts.length < 3) return { valid: false, error: 'Invalid X-Creator-Auth format' };

  const timestamp = parts[parts.length - 1];
  const signatureB64 = parts[parts.length - 2];
  const wallet = parts.slice(0, parts.length - 2).join(':');

  const ts = parseInt(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > AUTH_WINDOW) {
    return { valid: false, error: 'Auth token expired (>5 min drift)' };
  }

  const message = `SolAgentsDividend:${wallet}:${timestamp}`;
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const pubkeyBytes = new PublicKey(wallet).toBytes();
    const pubkeyB64 = Buffer.from(pubkeyBytes).toString('base64');
    const valid = verifyWalletSignature(message, signatureB64, pubkeyB64);
    if (!valid) return { valid: false, error: 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: `Auth error: ${err.message}` };
  }

  const token = stmts.getAgentToken?.get(tokenId);
  if (!token) return { valid: false, error: 'Token not found' };
  if (token.creator_wallet !== wallet) {
    return { valid: false, error: 'Not the token creator' };
  }

  return { valid: true, wallet, token };
}

export default async function dividendRoutes(fastify) {

  // ── GET /api/dividends/leaderboard ────────────────────────
  fastify.get('/api/dividends/leaderboard', async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 20, 100);
    const rows = stmts.getDividendLeaderboard.all(limit);
    return {
      leaderboard: rows.map(r => ({
        token_id: r.token_id,
        mint_address: r.token_mint || r.mint_address,
        token_name: r.token_name,
        token_symbol: r.token_symbol,
        mode: r.mode,
        total_revenue: r.total_revenue_deposited,
        total_staked: r.total_staked,
        total_burned: r.total_burned,
      })),
    };
  });

  // ── GET /api/dividends/wallet/:wallet ─────────────────────
  fastify.get('/api/dividends/wallet/:wallet', async (request) => {
    const stakes = stmts.getWalletStakes.all(request.params.wallet);
    return {
      wallet: request.params.wallet,
      stakes: stakes.map(s => ({
        token_id: s.token_id,
        mint_address: s.mint_address,
        token_name: s.token_name,
        token_symbol: s.token_symbol,
        mode: s.mode,
        staked_amount: s.amount,
        total_claimed: s.total_claimed,
        staked_at: s.staked_at,
      })),
    };
  });

  // ── GET /api/dividends/:tokenId ───────────────────────────
  fastify.get('/api/dividends/:tokenId', async (request, reply) => {
    const div = stmts.getTokenDividend.get(request.params.tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled for this token' });

    const stakersCount = stmts.getStakersCount?.get(div.token_id)?.count || 0;

    return {
      token_id: div.token_id,
      mint_address: div.mint_address,
      enabled: !!div.enabled,
      mode: div.mode,
      staking: {
        total_staked: div.total_staked,
        total_revenue: div.total_staking_revenue,
        total_distributed: div.total_rewards_distributed,
        stakers_count: stakersCount,
      },
      buyback: {
        balance: div.buyback_balance,
        total_burned: div.total_burned,
        total_sol_spent: div.total_buyback_sol_spent,
        burn_count: div.burn_count,
      },
      total_revenue_deposited: div.total_revenue_deposited,
      last_mode_change: div.last_mode_change,
      created_at: div.created_at,
    };
  });

  // ── GET /api/dividends/:tokenId/stakers ───────────────────
  fastify.get('/api/dividends/:tokenId/stakers', async (request, reply) => {
    const div = stmts.getTokenDividend.get(request.params.tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    const stakers = stmts.getTokenStakers.all(request.params.tokenId);
    return {
      token_id: request.params.tokenId,
      mode: div.mode,
      total_staked: div.total_staked,
      stakers: stakers.map(s => ({
        wallet: s.wallet,
        amount: s.amount,
        total_claimed: s.total_claimed,
        staked_at: s.staked_at,
      })),
    };
  });

  // ── GET /api/dividends/:tokenId/revenue ───────────────────
  fastify.get('/api/dividends/:tokenId/revenue', async (request, reply) => {
    const div = stmts.getTokenDividend.get(request.params.tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const deposits = stmts.getRevenueHistory.all(request.params.tokenId, limit);
    const totalRow = stmts.getTotalRevenue.get(request.params.tokenId);

    return {
      token_id: request.params.tokenId,
      mode: div.mode,
      total_revenue: totalRow?.total?.toString() || '0',
      deposits: deposits.map(d => ({
        id: d.id,
        source: d.source,
        amount_lamports: d.amount_lamports,
        destination: d.destination,
        reference_id: d.reference_id,
        created_at: d.created_at,
      })),
    };
  });

  // ── GET /api/dividends/:tokenId/buybacks ──────────────────
  fastify.get('/api/dividends/:tokenId/buybacks', async (request, reply) => {
    const div = stmts.getTokenDividend.get(request.params.tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const events = stmts.getBuybackHistory.all(request.params.tokenId, limit);

    return {
      token_id: request.params.tokenId,
      buyback_balance: div.buyback_balance,
      total_burned: div.total_burned,
      total_sol_spent: div.total_buyback_sol_spent,
      burn_count: div.burn_count,
      events: events.map(e => ({
        id: e.id,
        sol_spent: e.sol_spent,
        tokens_burned: e.tokens_burned,
        burn_tx: e.burn_tx,
        price_per_token: e.price_per_token,
        created_at: e.created_at,
      })),
    };
  });

  // ── GET /api/dividends/:tokenId/stats ─────────────────────
  fastify.get('/api/dividends/:tokenId/stats', async (request, reply) => {
    const div = stmts.getTokenDividend.get(request.params.tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    const stakersCount = stmts.getStakersCount?.get(div.token_id)?.count || 0;
    const totalRevenue = stmts.getTotalRevenue.get(div.token_id)?.total || 0;

    return {
      token_id: div.token_id,
      mint_address: div.mint_address,
      mode: div.mode,
      enabled: !!div.enabled,
      staking: {
        total_staked: div.total_staked,
        stakers_count: stakersCount,
        total_revenue: div.total_staking_revenue,
        total_distributed: div.total_rewards_distributed,
        undistributed: (BigInt(div.total_staking_revenue || '0') - BigInt(div.total_rewards_distributed || '0')).toString(),
      },
      buyback: {
        balance: div.buyback_balance,
        total_sol_spent: div.total_buyback_sol_spent,
        total_burned: div.total_burned,
        burn_count: div.burn_count,
      },
      totals: {
        total_revenue: totalRevenue.toString(),
        created_at: div.created_at,
        last_mode_change: div.last_mode_change,
      },
    };
  });

  // ── POST /api/dividends/:tokenId/enable ───────────────────
  /** Enable dividends for a token. Starts in requested mode (default: regular). */
  fastify.post('/api/dividends/:tokenId/enable', async (request, reply) => {
    const { tokenId } = request.params;
    const auth = await verifyCreatorAuth(request, tokenId);
    if (!auth.valid) return reply.code(401).send({ error: auth.error });

    const existing = stmts.getTokenDividend.get(tokenId);
    if (existing) {
      return reply.code(409).send({ error: 'Dividends already enabled', dividend: existing });
    }

    const mode = request.body?.mode || 'regular';
    if (!VALID_MODES.includes(mode)) {
      return reply.code(400).send({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
    }

    const mintAddress = auth.token.mint_address;
    stmts.createTokenDividend.run(tokenId, mintAddress, mode);

    const modeLabels = { regular: '💰 Regular (keep fees)', dividend: '🏦 Dividend (staking rewards)', buyback_burn: '🔥 Buyback & Burn' };

    return {
      enabled: true,
      token_id: tokenId,
      mint_address: mintAddress,
      mode,
      message: `Dividends enabled in ${modeLabels[mode]} mode.`,
    };
  });

  // ── POST /api/dividends/:tokenId/mode ─────────────────────
  /** Switch dividend mode. 7-day cooldown between switches. */
  fastify.post('/api/dividends/:tokenId/mode', async (request, reply) => {
    const { tokenId } = request.params;
    const auth = await verifyCreatorAuth(request, tokenId);
    if (!auth.valid) return reply.code(401).send({ error: auth.error });

    const div = stmts.getTokenDividend.get(tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    const newMode = request.body?.mode;
    if (!newMode || !VALID_MODES.includes(newMode)) {
      return reply.code(400).send({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
    }

    if (newMode === div.mode) {
      return reply.code(200).send({ message: 'Already in this mode', mode: div.mode });
    }

    // 7-day cooldown
    if (div.last_mode_change) {
      const elapsed = Math.floor(Date.now() / 1000) - div.last_mode_change;
      if (elapsed < MODE_SWITCH_COOLDOWN) {
        const remaining = MODE_SWITCH_COOLDOWN - elapsed;
        const days = (remaining / 86400).toFixed(1);
        return reply.code(429).send({
          error: `Mode switch cooldown active. ${days} days remaining.`,
          current_mode: div.mode,
          next_change_at: div.last_mode_change + MODE_SWITCH_COOLDOWN,
        });
      }
    }

    // Can't switch away from dividend mode while tokens are staked
    if (div.mode === 'dividend' && BigInt(div.total_staked || '0') > 0n) {
      return reply.code(400).send({
        error: 'Cannot switch from Dividend mode while tokens are staked. All stakers must unstake first.',
        total_staked: div.total_staked,
      });
    }

    stmts.updateDividendMode.run(newMode, tokenId);

    const modeLabels = { regular: '💰 Regular', dividend: '🏦 Dividend', buyback_burn: '🔥 Buyback & Burn' };

    return {
      token_id: tokenId,
      previous_mode: div.mode,
      mode: newMode,
      next_change_at: Math.floor(Date.now() / 1000) + MODE_SWITCH_COOLDOWN,
      message: `Mode switched from ${modeLabels[div.mode]} to ${modeLabels[newMode]}.`,
    };
  });

  // ── POST /api/dividends/:tokenId/deposit (admin) ─────────
  /** Record a revenue deposit. Only accepted when mode != 'regular'. */
  fastify.post('/api/dividends/:tokenId/deposit', {
    preHandler: adminAuthHook,
  }, async (request, reply) => {
    const { tokenId } = request.params;
    const { source, amount_lamports, reference_id, tx_signature } = request.body || {};

    if (!source || !amount_lamports) {
      return reply.code(400).send({ error: 'source and amount_lamports required' });
    }

    const validSources = ['job_completion', 'creator_fee', 'manual'];
    if (!validSources.includes(source)) {
      return reply.code(400).send({ error: `source must be one of: ${validSources.join(', ')}` });
    }

    const div = stmts.getTokenDividend.get(tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    if (div.mode === 'regular') {
      return reply.code(400).send({
        error: 'Token is in Regular mode. Revenue deposits not accepted — creator keeps all fees.',
        mode: div.mode,
      });
    }

    const totalAmount = BigInt(amount_lamports);
    const destination = div.mode; // 'dividend' or 'buyback_burn'

    const depositId = randomUUID();
    stmts.insertRevenueDeposit.run(
      depositId, tokenId, source, amount_lamports,
      destination, reference_id || null, tx_signature || null
    );

    // Update aggregate stats based on mode
    const newTotalRevenue = (BigInt(div.total_revenue_deposited || '0') + totalAmount).toString();

    if (div.mode === 'dividend') {
      const newStakingRevenue = (BigInt(div.total_staking_revenue || '0') + totalAmount).toString();
      stmts.updateDividendStats.run(
        div.total_staked, newTotalRevenue, newStakingRevenue,
        div.total_rewards_distributed, div.buyback_balance,
        div.total_burned, div.total_buyback_sol_spent, div.burn_count, tokenId
      );
    } else if (div.mode === 'buyback_burn') {
      const newBuybackBalance = (BigInt(div.buyback_balance || '0') + totalAmount).toString();
      stmts.updateDividendStats.run(
        div.total_staked, newTotalRevenue, div.total_staking_revenue,
        div.total_rewards_distributed, newBuybackBalance,
        div.total_burned, div.total_buyback_sol_spent, div.burn_count, tokenId
      );
    }

    return {
      deposit_id: depositId,
      token_id: tokenId,
      source,
      amount: amount_lamports,
      destination,
      mode: div.mode,
    };
  });

  // ── POST /api/dividends/:tokenId/buyback (admin) ──────────
  /** Record a buyback & burn event. */
  fastify.post('/api/dividends/:tokenId/buyback', {
    preHandler: adminAuthHook,
  }, async (request, reply) => {
    const { tokenId } = request.params;
    const { sol_spent, tokens_burned, burn_tx, price_per_token } = request.body || {};

    if (!sol_spent || !tokens_burned) {
      return reply.code(400).send({ error: 'sol_spent and tokens_burned required' });
    }

    const div = stmts.getTokenDividend.get(tokenId);
    if (!div) return reply.code(404).send({ error: 'Dividends not enabled' });

    const eventId = randomUUID();
    stmts.insertBuybackEvent.run(
      eventId, tokenId, sol_spent, tokens_burned,
      burn_tx || null, price_per_token || null
    );

    // Update stats
    const newBuybackBalance = (BigInt(div.buyback_balance || '0') - BigInt(sol_spent)).toString();
    const newTotalBurned = (BigInt(div.total_burned || '0') + BigInt(tokens_burned)).toString();
    const newTotalSolSpent = (BigInt(div.total_buyback_sol_spent || '0') + BigInt(sol_spent)).toString();

    stmts.updateDividendStats.run(
      div.total_staked, div.total_revenue_deposited, div.total_staking_revenue,
      div.total_rewards_distributed, newBuybackBalance,
      newTotalBurned, newTotalSolSpent, div.burn_count + 1, tokenId
    );

    return {
      event_id: eventId,
      token_id: tokenId,
      sol_spent,
      tokens_burned,
      burn_tx,
      remaining_buyback_balance: newBuybackBalance,
      total_burns: div.burn_count + 1,
    };
  });
}
