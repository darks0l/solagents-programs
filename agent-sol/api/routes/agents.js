import { stmts } from '../services/db.js';
import { optionalAuth, authHook } from '../middleware/auth.js';

/**
 * Agent Directory Routes
 * Public agent lookup + directory listing with token & stats data
 */
export default async function agentRoutes(fastify) {

  // List registered agents with stats + token info
  fastify.get('/api/agents', {
    preHandler: [optionalAuth],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;
    const filter = request.query.filter; // 'tokenized', 'all'

    const agents = stmts.listAgents.all('active', limit, offset);

    const enriched = agents.map(a => {
      const stats = stmts.getAgentStats.get(a.id);
      const token = stmts.getAgentTokenByAgent.get(a.id);
      let tokenData = null;

      if (token && token.status === 'active') {
        const price = stmts.getLatestTokenPrice.get(token.id);
        tokenData = {
          id: token.id,
          symbol: token.token_symbol,
          name: token.token_name,
          mintAddress: token.mint_address,
          currentPrice: price?.price_sol || '0',
          marketCap: price?.market_cap || '0',
          volume24h: price?.volume_24h || '0',
          holders: price?.holders || 0,
        };
      }

      const meta = JSON.parse(a.metadata || '{}');
      return {
        id: a.id,
        name: a.name,
        walletAddress: a.wallet_address,
        capabilities: JSON.parse(a.capabilities || '[]'),
        description: meta.description || null,
        github: meta.github || null,
        twitter: meta.twitter || null,
        registeredAt: a.registered_at,
        tokenized: !!token && token.status === 'active',
        token: tokenData,
        stats: stats ? {
          totalJobs: stats.total_jobs,
          completedJobs: stats.completed_jobs,
          successRate: stats.success_rate,
          totalEarned: stats.total_earned,
        } : null,
      };
    });

    // Apply filter
    let result = enriched;
    if (filter === 'tokenized') {
      result = enriched.filter(a => a.tokenized);
    }

    return { agents: result, pagination: { limit, offset } };
  });

  // Get specific agent profile with full details
  fastify.get('/api/agents/:id', {
    preHandler: [optionalAuth],
  }, async (request, reply) => {
    const agent = stmts.getAgent.get(request.params.id);
    if (!agent || agent.status !== 'active') {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    const stats = stmts.getAgentStats.get(agent.id);
    const token = stmts.getAgentTokenByAgent.get(agent.id);
    const feeSummary = stmts.getFeeSummary.get(agent.id);

    let tokenData = null;
    if (token) {
      const price = stmts.getLatestTokenPrice.get(token.id);
      tokenData = {
        ...token,
        currentPrice: price?.price_sol || '0',
        priceUsd: price?.price_usd || '0',
        marketCap: price?.market_cap || '0',
        volume24h: price?.volume_24h || '0',
        holders: price?.holders || 0,
      };
    }

    const meta = JSON.parse(agent.metadata || '{}');
    return {
      id: agent.id,
      name: agent.name,
      walletAddress: agent.wallet_address,
      publicKey: agent.public_key,
      capabilities: JSON.parse(agent.capabilities || '[]'),
      description: meta.description || null,
      github: meta.github || null,
      twitter: meta.twitter || null,
      metadata: meta,
      registeredAt: agent.registered_at,
      lastSeen: agent.last_seen,
      tokenized: !!token && token.status === 'active',
      token: tokenData,
      stats: stats ? {
        totalJobs: stats.total_jobs,
        completedJobs: stats.completed_jobs,
        rejectedJobs: stats.rejected_jobs,
        successRate: stats.success_rate,
        totalEarned: stats.total_earned,
      } : { totalJobs: 0, completedJobs: 0, rejectedJobs: 0, successRate: 0, totalEarned: '0' },
      fees: feeSummary ? {
        unclaimed: (feeSummary.unclaimed_lamports || 0) / 1e9,
        claimed: (feeSummary.claimed_lamports || 0) / 1e9,
        total: (feeSummary.total_lamports || 0) / 1e9,
      } : { unclaimed: 0, claimed: 0, total: 0 },
    };
  });

  // Lookup agent by wallet address
  fastify.get('/api/agents/wallet/:address', {
    preHandler: [optionalAuth],
  }, async (request, reply) => {
    const agent = stmts.getAgentByWallet.get(request.params.address);
    if (!agent || agent.status !== 'active') {
      return reply.code(404).send({ error: 'No agent found for this wallet' });
    }

    const stats = stmts.getAgentStats.get(agent.id);
    const token = stmts.getAgentTokenByAgent.get(agent.id);

    return {
      id: agent.id,
      name: agent.name,
      walletAddress: agent.wallet_address,
      publicKey: agent.public_key,
      capabilities: JSON.parse(agent.capabilities || '[]'),
      registeredAt: agent.registered_at,
      tokenized: !!token && token.status === 'active',
      token: token ? { id: token.id, symbol: token.token_symbol, mintAddress: token.mint_address } : null,
      stats: stats || null,
    };
  });

  // Update agent profile (self-management API for agents)
  // Requires auth: only the agent itself can update its own profile.
  fastify.put('/api/agents/:id', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const agent = stmts.getAgent.get(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    // Auth: only the agent itself can update itself
    if (request.agent.id !== request.params.id) {
      return reply.code(403).send({ error: 'An agent can only update its own profile' });
    }

    const { name, capabilities, metadata } = request.body || {};

    // Build update query dynamically
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (capabilities !== undefined) { updates.push('capabilities = ?'); params.push(JSON.stringify(capabilities)); }
    if (metadata !== undefined) { updates.push('metadata = ?'); params.push(JSON.stringify(metadata)); }
    updates.push('last_seen = unixepoch()');

    if (updates.length > 1) {
      const sql = `UPDATE agents SET ${updates.join(', ')} WHERE id = ?`;
      const stmt = (await import('../services/db.js')).default.prepare(sql);
      stmt.run(...params, request.params.id);
    }

    stmts.updateLastSeen.run(request.params.id);
    return { updated: true };
  });
}
