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
  getCurveConfigPDA,
  getCurvePoolPDA,
  getSolVaultPDA,
  getTokenVaultPDA,
  getBondingCurveProgram,
  BONDING_CURVE_PROGRAM_ID,
  LAMPORTS_PER_SOL,
} from '../services/solana.js';
import { stmts } from '../services/db.js';
import db from '../services/db.js';
import { emitTrade } from '../services/ws-feed.js';
import { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

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

  // ═══════════════════════════════════════════════════════════
  // PLATFORM FEES — Query
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/admin/platform-fees
   * Returns all pools with their platform fee status.
   * Requires: admin
   */
  fastify.get('/api/admin/platform-fees', { preHandler: adminAuthHook }, async (request, reply) => {
    try {
      const rows = db.prepare(`
        SELECT
          at.id, at.mint_address, at.token_name, at.token_symbol, at.status,
          tp.platform_fees_earned, tp.platform_fees_claimed,
          tp.graduated_at, tp.raydium_pool_address
        FROM agent_tokens at
        JOIN token_pools tp ON tp.token_id = at.id
        WHERE at.status IN ('active', 'graduated')
          AND CAST(tp.platform_fees_earned AS REAL) > CAST(tp.platform_fees_claimed AS REAL)
        ORDER BY (CAST(tp.platform_fees_earned AS REAL) - CAST(tp.platform_fees_claimed AS REAL)) DESC
      `).all();

      let totalUnclaimed = 0n;

      const pools = rows.map(row => {
        const earned = BigInt(row.platform_fees_earned || '0');
        const claimed = BigInt(row.platform_fees_claimed || '0');
        const unclaimed = earned > claimed ? earned - claimed : 0n;
        totalUnclaimed += unclaimed;

        return {
          mint: row.mint_address,
          name: row.token_name,
          symbol: row.token_symbol,
          status: row.status,
          platformFeesEarned: Number(earned),
          platformFeesClaimed: Number(claimed),
          unclaimed: Number(unclaimed),
          unclaimedSol: Number(unclaimed) / LAMPORTS_PER_SOL,
        };
      });

      return {
        pools,
        totalUnclaimed: Number(totalUnclaimed),
        totalUnclaimedSol: Number(totalUnclaimed) / LAMPORTS_PER_SOL,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CLOSEABLE POOLS — Query
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/admin/closeable-pools
   * Returns graduated pools where all fees are claimed.
   * Requires: admin
   */
  fastify.get('/api/admin/closeable-pools', { preHandler: adminAuthHook }, async (request, reply) => {
    try {
      const rows = db.prepare(`
        SELECT
          at.id, at.mint_address, at.token_name, at.token_symbol,
          tp.graduated_at, tp.raydium_pool_address,
          tp.platform_fees_earned, tp.platform_fees_claimed
        FROM agent_tokens at
        JOIN token_pools tp ON tp.token_id = at.id
        WHERE at.status = 'graduated'
          AND CAST(tp.platform_fees_earned AS REAL) <= CAST(tp.platform_fees_claimed AS REAL)
        ORDER BY tp.graduated_at ASC
      `).all();

      // Estimated rent per pool account (pool + vault accounts)
      // CurvePool ~600 bytes + SolVault ~128 bytes ≈ ~0.01 SOL in rent
      const ESTIMATED_RENT_PER_POOL = 10_000_000; // 0.01 SOL in lamports
      const totalRent = rows.length * ESTIMATED_RENT_PER_POOL;

      const pools = rows.map(row => ({
        mint: row.mint_address,
        name: row.token_name,
        symbol: row.token_symbol,
        graduatedAt: row.graduated_at,
        raydiumPool: row.raydium_pool_address,
        estimatedRent: ESTIMATED_RENT_PER_POOL,
      }));

      return {
        pools,
        totalRent,
        totalRentSol: totalRent / LAMPORTS_PER_SOL,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CLAIM ALL PLATFORM FEES
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/claim-all-fees
   * Build batch claim_all_platform_fees transaction(s) for admin to sign.
   * Uses real Anchor IDL — remaining_accounts = [pool, sol_vault] pairs.
   * Requires: admin
   */
  fastify.post('/api/admin/claim-all-fees', { preHandler: adminAuthHook }, async (request, reply) => {
    try {
      const conn = getConnection();
      const { adminPublicKey } = request.body || {};

      if (!adminPublicKey) {
        return reply.code(400).send({ error: 'adminPublicKey required (the wallet that will sign)' });
      }

      // Query DB for pools with unclaimed fees
      const rows = db.prepare(`
        SELECT at.mint_address, at.token_name, at.token_symbol,
               tp.platform_fees_earned, tp.platform_fees_claimed
        FROM agent_tokens at
        JOIN token_pools tp ON tp.token_id = at.id
        WHERE at.status IN ('active', 'graduated')
          AND CAST(tp.platform_fees_earned AS REAL) > CAST(tp.platform_fees_claimed AS REAL)
          AND at.mint_address IS NOT NULL
      `).all();

      if (rows.length === 0) {
        return { transactions: [], totalPools: 0, totalEstimatedSol: 0 };
      }

      const BATCH_SIZE = 14; // max remaining_accounts pairs per TX
      const batches = [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        batches.push(rows.slice(i, i + BATCH_SIZE));
      }

      const program = getBondingCurveProgram();
      const [configPDA] = getCurveConfigPDA();
      const config = await readCurveConfig();
      const treasuryPubkey = config.treasury;
      const { blockhash } = await conn.getLatestBlockhash();
      const adminPubkey = new PublicKey(adminPublicKey);

      const transactions = [];

      for (const batch of batches) {
        let batchEstimatedSol = 0n;

        const remainingAccounts = [];
        for (const row of batch) {
          const mint = new PublicKey(row.mint_address);
          const [poolPDA] = getCurvePoolPDA(mint);
          const [solVaultPDA] = getSolVaultPDA(poolPDA);

          remainingAccounts.push({ pubkey: poolPDA, isSigner: false, isWritable: true });
          remainingAccounts.push({ pubkey: solVaultPDA, isSigner: false, isWritable: true });

          const earned = BigInt(row.platform_fees_earned || '0');
          const claimed = BigInt(row.platform_fees_claimed || '0');
          batchEstimatedSol += earned > claimed ? earned - claimed : 0n;
        }

        const ix = await program.methods
          .claimAllPlatformFees()
          .accounts({
            treasury: treasuryPubkey,
            config: configPDA,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(remainingAccounts)
          .instruction();

        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: adminPubkey });
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
        tx.add(ix);

        const base64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
        transactions.push({
          base64,
          poolCount: batch.length,
          estimatedSol: Number(batchEstimatedSol) / LAMPORTS_PER_SOL,
          pools: batch.map(r => ({ mint: r.mint_address, name: r.token_name, symbol: r.token_symbol })),
        });
      }

      const totalEstimatedSol = transactions.reduce((acc, t) => acc + t.estimatedSol, 0);

      return {
        transactions,
        totalPools: rows.length,
        totalEstimatedSol,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CLOSE GRADUATED POOL
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/close-pool
   * Build close_graduated_pool transaction for admin to sign.
   * Closes CurvePool + sol_vault + token_vault, reclaims rent to treasury.
   * Requires: superAdmin
   */
  fastify.post('/api/admin/close-pool', { preHandler: superAdminHook }, async (request, reply) => {
    try {
      const { mint, adminPublicKey } = request.body || {};
      if (!mint) return reply.code(400).send({ error: 'mint required' });
      if (!adminPublicKey) return reply.code(400).send({ error: 'adminPublicKey required' });

      // Validate: must be graduated
      const token = stmts.getAgentTokenByMint?.get(mint);
      if (!token) return reply.code(404).send({ error: 'Token not found' });
      if (token.status !== 'graduated') return reply.code(400).send({ error: 'Pool must be graduated before closing' });

      // Validate: all fees must be claimed
      const pool = stmts.getPool?.get(token.id);
      if (!pool) return reply.code(404).send({ error: 'Pool record not found in DB' });

      const earned = BigInt(pool.platform_fees_earned || '0');
      const claimed = BigInt(pool.platform_fees_claimed || '0');
      if (earned > claimed) {
        return reply.code(400).send({
          error: 'Cannot close pool — unclaimed platform fees remain',
          unclaimedSol: Number(earned - claimed) / LAMPORTS_PER_SOL,
        });
      }

      const conn = getConnection();
      const program = getBondingCurveProgram();
      const config = await readCurveConfig();
      const mintPubkey = new PublicKey(mint);
      const adminPubkey = new PublicKey(adminPublicKey);
      const [configPDA] = getCurveConfigPDA();
      const [poolPDA] = getCurvePoolPDA(mintPubkey);
      const [solVaultPDA] = getSolVaultPDA(poolPDA);
      const [tokenVaultPDA] = getTokenVaultPDA(poolPDA);

      const ix = await program.methods
        .closeGraduatedPool()
        .accounts({
          caller: adminPubkey,
          config: configPDA,
          pool: poolPDA,
          solVault: solVaultPDA,
          tokenVault: tokenVaultPDA,
          mint: mintPubkey,
          treasury: config.treasury,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const { blockhash } = await conn.getLatestBlockhash();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: adminPubkey });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ix);

      const base64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');

      // Estimate rent from on-chain account sizes
      const poolInfo = await conn.getAccountInfo(poolPDA);
      const vaultInfo = await conn.getAccountInfo(solVaultPDA);
      const tokenVaultInfo = await conn.getAccountInfo(tokenVaultPDA);
      const rentReclaimed = (poolInfo?.lamports || 0) + (vaultInfo?.lamports || 0) + (tokenVaultInfo?.lamports || 0);

      return {
        transaction: base64,
        rentReclaimed,
        rentReclaimedSol: rentReclaimed / LAMPORTS_PER_SOL,
        mint,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TOGGLE TRADING PAUSE
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/toggle-trading-pause
   * Build update_config transaction with trading_paused param for admin to sign.
   * Requires: superAdmin
   */
  fastify.post('/api/admin/toggle-trading-pause', { preHandler: superAdminHook }, async (request, reply) => {
    try {
      const { paused, adminPublicKey } = request.body || {};
      if (typeof paused !== 'boolean') return reply.code(400).send({ error: 'paused (boolean) required' });
      if (!adminPublicKey) return reply.code(400).send({ error: 'adminPublicKey required' });

      const conn = getConnection();
      const program = getBondingCurveProgram();
      const adminPubkey = new PublicKey(adminPublicKey);
      const [configPDA] = getCurveConfigPDA();

      const ix = await program.methods
        .updateConfig(
          null,   // new_creator_fee_bps
          null,   // new_platform_fee_bps
          null,   // new_graduation_threshold
          null,   // new_treasury
          null,   // new_admin (pending_admin)
          null,   // paused (creation pause)
          null,   // raydium_permission_enabled
          paused, // trading_paused
        )
        .accounts({
          admin: adminPubkey,
          config: configPDA,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const { blockhash } = await conn.getLatestBlockhash();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: adminPubkey });
      tx.add(ix);

      const base64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');

      // Read current state to confirm
      const config = await readCurveConfig();

      return {
        transaction: base64,
        paused,
        currentTradingPaused: config?.tradingPaused ?? null,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PROPOSE NEW ADMIN (two-step admin transfer)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/admin/propose-admin
   * Build update_config transaction that sets pending_admin on-chain (two-step transfer).
   * The proposed admin must then call accept_admin to complete the transfer.
   * Requires: superAdmin
   */
  fastify.post('/api/admin/propose-admin', { preHandler: superAdminHook }, async (request, reply) => {
    try {
      const { newAdmin, adminPublicKey } = request.body || {};
      if (!newAdmin) return reply.code(400).send({ error: 'newAdmin pubkey required' });
      if (!adminPublicKey) return reply.code(400).send({ error: 'adminPublicKey required' });

      let newAdminPubkey;
      try {
        newAdminPubkey = new PublicKey(newAdmin);
      } catch {
        return reply.code(400).send({ error: 'Invalid newAdmin pubkey' });
      }

      const conn = getConnection();
      const program = getBondingCurveProgram();
      const adminPubkey = new PublicKey(adminPublicKey);
      const [configPDA] = getCurveConfigPDA();

      // update_config with pending_admin set via the admin param
      // In the new program, passing a pubkey to the "admin" param in update_config
      // sets pending_admin (not direct admin change).
      const ix = await program.methods
        .updateConfig(
          null,             // creator_fee_bps
          null,             // platform_fee_bps
          null,             // graduation_threshold
          null,             // treasury
          newAdminPubkey,   // new_admin → sets pending_admin
          null,             // paused
          null,             // raydium_permission_enabled
          null,             // trading_paused
        )
        .accounts({
          admin: adminPubkey,
          config: configPDA,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const { blockhash } = await conn.getLatestBlockhash();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: adminPubkey });
      tx.add(ix);

      const base64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');

      return {
        transaction: base64,
        newAdmin,
        note: 'Proposed admin must call accept_admin to complete transfer',
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
