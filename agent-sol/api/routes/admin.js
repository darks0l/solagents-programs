/**
 * Admin Routes
 * Protected endpoints for platform administration, deployer operations,
 * graduation triggers, and admin management.
 */

import {
  adminAuthHook,
  superAdminHook,
  roleCheck,
  loadAdmins,
  saveAdmins,
} from '../middleware/adminAuth.js';
import {
  getConnection,
  buildGraduateTransaction,
  getDeployer,
  readPool,
  readCurveConfig,
  initializeBondingCurve,
  LAMPORTS_PER_SOL,
} from '../services/solana.js';
import { stmts } from '../services/db.js';
import { emitTrade } from '../services/ws-feed.js';

export default async function adminRoutes(fastify) {

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/admin/dashboard
   * Platform stats — agent count, token count, total volume, active pools.
   * Requires: admin or any role
   */
  fastify.get('/api/admin/dashboard', { preHandler: adminAuthHook }, async (request, reply) => {
    try {
      const agentCount = stmts.listAgents?.all('active', 99999, 0)?.length ?? 0;

      // Count tokens
      let tokenCount = 0;
      let activePoolCount = 0;
      let graduatedCount = 0;
      let totalVolumeSol = 0;
      try {
        const tokens = stmts.listActiveTokens?.all(99999, 0) ?? [];
        tokenCount = tokens.length;
        for (const t of tokens) {
          if (t.status === 'active') activePoolCount++;
          if (t.status === 'graduated') graduatedCount++;
        }
        // Sum volume from pools
        for (const t of tokens) {
          const pool = stmts.getPool?.get(t.id);
          if (pool) {
            totalVolumeSol += Number(pool.total_volume_sol || 0) / LAMPORTS_PER_SOL;
          }
        }
      } catch { /* tables may not exist yet */ }

      // Job stats
      const jobStats = stmts.jobStats?.get() ?? {};

      return {
        agents: agentCount,
        tokens: tokenCount,
        active_pools: activePoolCount,
        graduated_pools: graduatedCount,
        total_volume_sol: totalVolumeSol.toFixed(4),
        jobs: {
          total: jobStats.total || 0,
          open: jobStats.open || 0,
          completed: jobStats.completed || 0,
          total_paid: jobStats.total_paid || 0,
        },
        admin: request.adminWallet,
        is_super: request.isSuperAdmin,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ADMIN MANAGEMENT (superAdmin only)
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/admin/admins
   * List all admins and roles.
   */
  fastify.get('/api/admin/admins', { preHandler: superAdminHook }, async (request, reply) => {
    const cfg = loadAdmins();
    return {
      superAdmins: cfg.superAdmins,
      admins: cfg.admins,
      roles: cfg.roles,
    };
  });

  /**
   * POST /api/admin/admins
   * Add an admin with optional role.
   * Body: { wallet, role? }
   *   - If role is provided, adds wallet to that role only
   *   - If no role, adds as general admin
   */
  fastify.post('/api/admin/admins', { preHandler: superAdminHook }, async (request, reply) => {
    const { wallet, role } = request.body || {};
    if (!wallet) return reply.code(400).send({ error: 'wallet required' });

    const cfg = loadAdmins();

    if (role) {
      // Add to specific role
      if (!cfg.roles[role]) cfg.roles[role] = [];
      if (cfg.roles[role].includes(wallet)) {
        return reply.code(409).send({ error: `Wallet already has role: ${role}` });
      }
      cfg.roles[role].push(wallet);
    } else {
      // Add as general admin
      if (cfg.admins.includes(wallet) || cfg.superAdmins.includes(wallet)) {
        return reply.code(409).send({ error: 'Wallet is already an admin' });
      }
      cfg.admins.push(wallet);
    }

    saveAdmins(cfg);
    return { added: true, wallet, role: role || 'admin' };
  });

  /**
   * DELETE /api/admin/admins/:wallet
   * Remove an admin or role holder.
   * Query: ?role=<roleName> to remove from specific role only
   */
  fastify.delete('/api/admin/admins/:wallet', { preHandler: superAdminHook }, async (request, reply) => {
    const { wallet } = request.params;
    const { role } = request.query || {};

    const cfg = loadAdmins();

    // Prevent removing yourself from superAdmins
    if (cfg.superAdmins.includes(wallet) && wallet === request.adminWallet) {
      return reply.code(400).send({ error: 'Cannot remove yourself from superAdmins' });
    }

    // Prevent removing superAdmins entirely (they must be manually edited)
    if (cfg.superAdmins.includes(wallet) && !role) {
      return reply.code(400).send({ error: 'Cannot remove superAdmin via API. Edit admins.json directly.' });
    }

    let removed = false;

    if (role) {
      // Remove from specific role
      if (cfg.roles[role]) {
        const idx = cfg.roles[role].indexOf(wallet);
        if (idx >= 0) {
          cfg.roles[role].splice(idx, 1);
          removed = true;
        }
      }
    } else {
      // Remove from admins list
      const idx = cfg.admins.indexOf(wallet);
      if (idx >= 0) {
        cfg.admins.splice(idx, 1);
        removed = true;
      }
      // Also remove from all roles
      for (const r of Object.keys(cfg.roles)) {
        const rIdx = cfg.roles[r].indexOf(wallet);
        if (rIdx >= 0) {
          cfg.roles[r].splice(rIdx, 1);
          removed = true;
        }
      }
    }

    if (!removed) {
      return reply.code(404).send({ error: 'Wallet not found in admin list' });
    }

    saveAdmins(cfg);
    return { removed: true, wallet, role: role || 'all' };
  });

  // ═══════════════════════════════════════════════════════════
  // DEPLOYER INFO (was /chain/admin/wallet)
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/admin/deployer
   * Returns deployer pubkey + balance.
   */
  fastify.get('/api/admin/deployer', { preHandler: adminAuthHook }, async (request, reply) => {
    try {
      const deployer = getDeployer();
      const conn = getConnection();
      const balance = await conn.getBalance(deployer.publicKey);
      return {
        publicKey: deployer.publicKey.toBase58(),
        balance: balance / LAMPORTS_PER_SOL,
        cluster: process.env.SOLANA_CLUSTER || 'devnet',
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GRADUATION TRIGGER (was /chain/graduate/trigger)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/graduate/:mintAddress
   * Trigger graduation — creates Raydium CPMM pool.
   * Requires: admin or pool_manager role.
   */
  fastify.post('/api/admin/graduate/:mintAddress', { preHandler: roleCheck('pool_manager') }, async (request, reply) => {
    const { mintAddress } = request.params;
    const { solAmount, slippageBps = 50 } = request.body || {};

    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });

    try {
      const conn = getConnection();

      // Verify token exists in DB
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (!dbToken) return reply.code(404).send({ error: 'Token not found in DB' });
      if (dbToken.status === 'graduated') {
        const dbPool = stmts.getPool?.get(dbToken.id);
        return reply.code(409).send({
          error: 'Token already graduated',
          raydiumPool: dbPool?.raydium_pool_address || null,
        });
      }

      // Read on-chain pool state
      const pool = await readPool(mintAddress);
      if (!pool) return reply.code(404).send({ error: 'Bonding curve pool not found on-chain' });

      // Check graduation threshold (85 SOL)
      const GRADUATION_THRESHOLD = 85n * BigInt(LAMPORTS_PER_SOL);
      const realSol = BigInt(pool.realSolBalance.toString());
      if (realSol < GRADUATION_THRESHOLD) {
        return reply.code(400).send({
          error: 'Pool has not reached graduation threshold',
          realSol: (Number(realSol) / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
          required: '85 SOL',
          progress: ((Number(realSol) / Number(GRADUATION_THRESHOLD)) * 100).toFixed(2) + '%',
        });
      }

      // Calculate SOL and tokens to seed Raydium pool
      const vSol = BigInt(pool.virtualSolReserve.toString());
      const vToken = BigInt(pool.virtualTokenReserve.toString());
      const realTok = BigInt(pool.realTokenBalance.toString());

      const seedSolLamports = solAmount
        ? BigInt(Math.round(solAmount * LAMPORTS_PER_SOL))
        : realSol;

      const seedTokenAmount = (seedSolLamports * vToken) / vSol;
      const actualTokenAmount = seedTokenAmount > realTok ? realTok : seedTokenAmount;

      // Graduate on-chain
      const deployer = getDeployer();
      let txSignature, graduateResult;
      try {
        graduateResult = await buildGraduateTransaction({
          mintAddress,
          payer: deployer.publicKey.toBase58(),
        });
        graduateResult.tx.sign(deployer);
        txSignature = await conn.sendRawTransaction(
          graduateResult.tx.serialize(),
          { skipPreflight: false }
        );
        await conn.confirmTransaction(txSignature, 'confirmed');
      } catch (gradErr) {
        return reply.code(500).send({
          error: `On-chain graduation failed: ${gradErr.message}`,
          hint: 'Check bonding curve pool state and Raydium config.',
          seedSol: (Number(seedSolLamports) / LAMPORTS_PER_SOL).toFixed(4),
          seedTokens: (Number(actualTokenAmount) / 1e9).toFixed(2),
        });
      }

      const raydiumPoolAddress = graduateResult.raydiumPoolState;
      const raydiumLpMint = graduateResult.raydiumLpMint;

      // Update DB
      stmts.graduatePool?.run(raydiumPoolAddress, dbToken.id);
      stmts.updateAgentTokenStatus?.run(
        'graduated',
        dbToken.mint_address || mintAddress,
        dbToken.pool_address || null,
        dbToken.launch_tx || null,
        dbToken.id
      );

      // Price snapshot
      const priceSol = Number(seedSolLamports) / Number(actualTokenAmount);
      if (stmts.insertTokenPrice) {
        stmts.insertTokenPrice.run(dbToken.id, priceSol.toFixed(12), null, '0', '0', null);
      }

      // WebSocket event
      const graduationPayload = {
        type: 'graduation',
        mintAddress,
        raydiumPool: raydiumPoolAddress,
        seedSol: (Number(seedSolLamports) / LAMPORTS_PER_SOL).toFixed(4),
        seedTokens: (Number(actualTokenAmount) / 1e9).toFixed(2),
        txSignature,
        symbol: dbToken.token_symbol,
        name: dbToken.token_name,
        triggeredBy: request.adminWallet,
      };
      emitTrade(dbToken.id, graduationPayload);
      emitTrade(mintAddress, graduationPayload);

      return {
        graduated: true,
        mintAddress,
        raydiumPool: raydiumPoolAddress,
        lpMint: raydiumLpMint,
        seedSolLamports: seedSolLamports.toString(),
        seedSol: (Number(seedSolLamports) / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
        seedTokens: (Number(actualTokenAmount) / 1e9).toFixed(2),
        txSignature,
        triggeredBy: request.adminWallet,
        explorer: `https://explorer.solana.com/tx/${txSignature}?cluster=${process.env.SOLANA_CLUSTER || 'devnet'}`,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Graduation failed: ${err.message}` });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TOKEN RESET (was /chain/admin/reset-token)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/reset-token
   * Wipe stale test data and resync token from chain.
   * Requires: admin or token_manager role.
   */
  fastify.post('/api/admin/reset-token', { preHandler: roleCheck('token_manager') }, async (request, reply) => {
    const { tokenId } = request.body || {};
    if (!tokenId) return reply.code(400).send({ error: 'tokenId required' });

    try {
      const token = stmts.getAgentToken?.get(tokenId);
      if (!token) return reply.code(404).send({ error: 'Token not found' });

      // Delete stale trades
      stmts.deleteTokenTrades?.run(tokenId);
      stmts.deleteDevBuys?.run(tokenId);

      // Read on-chain pool state if mint exists
      let chainState = null;
      if (token.mint_address && token.mint_address !== 'TestMint111111111111111111111111111111111111') {
        const pool = await readPool(token.mint_address);
        if (pool) {
          chainState = pool;
          const vSol = Number(pool.virtualSolReserve);
          const vToken = Number(pool.virtualTokenReserve);
          const price = vToken > 0 ? (vSol / vToken).toFixed(12) : '0';
          const volume = Number(pool.totalVolumeSol || 0);

          stmts.updateAgentTokenPrice?.run(
            price,
            volume.toString(),
            0,
            (Number(pool.totalSupply) - Number(pool.realTokenBalance)).toString(),
            tokenId
          );
        }
      }

      return {
        reset: true,
        tokenId,
        trades_deleted: true,
        dev_buys_deleted: true,
        chain_synced: !!chainState,
        triggeredBy: request.adminWallet,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // INITIALIZE BONDING CURVE (was /chain/admin/initialize)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/initialize
   * Initialize bonding curve config on-chain (one-time setup).
   * Requires: superAdmin only.
   */
  fastify.post('/api/admin/initialize', { preHandler: superAdminHook }, async (request, reply) => {
    try {
      const existing = await readCurveConfig();
      if (existing) {
        return {
          status: 'already_initialized',
          config: {
            admin: existing.admin.toBase58(),
            treasury: existing.treasury.toBase58(),
            creatorFeeBps: existing.creatorFeeBps,
            platformFeeBps: existing.platformFeeBps,
          },
        };
      }

      const result = await initializeBondingCurve(request.body || {});
      return {
        status: 'initialized',
        tx: result.tx,
        configPDA: result.configPDA,
        triggeredBy: request.adminWallet,
        explorer: `https://explorer.solana.com/tx/${result.tx}?cluster=devnet`,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Initialize failed: ${err.message}` });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // UPDATE TOKEN MINT (was /chain/admin/update-token-mint)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/update-token-mint
   * Update token mint address in DB.
   * Requires: admin or token_manager role.
   */
  fastify.post('/api/admin/update-token-mint', { preHandler: roleCheck('token_manager') }, async (request, reply) => {
    const { tokenId, mintAddress, poolAddress, launchTx } = request.body || {};
    if (!tokenId || !mintAddress) return reply.code(400).send({ error: 'tokenId and mintAddress required' });

    try {
      stmts.updateAgentTokenStatus.run('active', mintAddress, poolAddress || null, launchTx || null, tokenId);
      return { updated: true, tokenId, mintAddress, triggeredBy: request.adminWallet };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
