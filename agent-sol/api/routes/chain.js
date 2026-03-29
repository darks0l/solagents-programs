/**
 * On-Chain Routes
 * Real Solana program interactions — build transactions for wallet signing,
 * read on-chain state, sync DB after confirmation.
 */

import { randomUUID } from 'crypto';
import {
  getConnection,
  readCurveConfig,
  readPool,
  readAllPools,
  buildBuyTransaction,
  buildSellTransaction,
  buildCreateTokenTransaction,
  buildClaimCreatorFeesTransaction,
  buildGraduateTransaction,
  getDeployer,
  getCurveConfigPDA,
  getCurvePoolPDA,
  getSolVaultPDA,
  getTokenVaultPDA,
  getTransactionEvents,
  poolAccountToDb,
  LAMPORTS_PER_SOL,
  BONDING_CURVE_PROGRAM_ID,
} from '../services/solana.js';
import {
  getRaydiumPoolState,
  quoteRaydiumSwap,
  buildPostGradBuyTransaction,
  buildPostGradSellTransaction,
} from '../services/raydium.js';
import { stmts } from '../services/db.js';
import { emitTrade } from '../services/ws-feed.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, getAccount, NATIVE_MINT } from '@solana/spl-token';

export default async function chainRoutes(fastify) {

  // Debug: show connection info
  fastify.get('/api/chain/debug', async (request, reply) => {
    const conn = getConnection();
    return {
      rpc_url: process.env.SOLANA_RPC_URL || process.env.SOLANA_CLUSTER || 'devnet-default',
      cluster: process.env.SOLANA_CLUSTER || 'devnet',
      env_rpc: process.env.SOLANA_RPC_URL,
    };
  });

  // ═══════════════════════════════════════════════════════════
  // STATE READS — direct from chain
  // ═══════════════════════════════════════════════════════════

  // Read bonding curve config
  fastify.get('/api/chain/config', async (request, reply) => {
    try {
      const config = await readCurveConfig();
      if (!config) return reply.code(404).send({ error: 'Config not initialized on-chain' });
      return {
        admin: config.admin.toBase58(),
        treasury: config.treasury.toBase58(),
        creatorFeeBps: config.creatorFeeBps,
        platformFeeBps: config.platformFeeBps,
        graduationThreshold: config.graduationThreshold.toString(),
        totalSupply: config.totalSupply.toString(),
        decimals: config.decimals,
        initialVirtualSol: config.initialVirtualSol.toString(),
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Read pool state from chain by mint address
  fastify.get('/api/chain/state/pool/:mintAddress', async (request, reply) => {
    try {
      const { mintAddress } = request.params;
      const pool = await readPool(mintAddress);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain' });

      // Read config for graduation threshold
      const config = await readCurveConfig();

      // Calculate price in SOL per human token
      // vSol is in lamports (raw), vToken is in raw token units (9 decimals)
      // Price per human token in SOL = (vSol / LAMPORTS_PER_SOL) / (vToken / 1e9)
      // Since both have 1e9 scaling, they cancel: priceSol = vSol / vToken
      const vSolBig = BigInt(pool.virtualSolReserve.toString());
      const vTokenBig = BigInt(pool.virtualTokenReserve.toString());
      const scaledPrice = vTokenBig > 0n ? (vSolBig * BigInt(1e18)) / vTokenBig : 0n;
      const priceSol = Number(scaledPrice) / 1e18; // SOL per human token
      const priceLamports = priceSol * LAMPORTS_PER_SOL; // lamports per human token
      const vSol = Number(vSolBig); // legacy numeric alias (display only, may lose precision)
      const vToken = Number(vTokenBig); // legacy numeric alias (display only)

      // Get token info from DB if available
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      const dbPool = dbToken ? stmts.getPool?.get(dbToken.id) : null;

      // Fetch creator's current on-chain token balance
      let creatorCurrentBalance = '0';
      let creatorCurrentPct = '0';
      try {
        const mintPk = new PublicKey(mintAddress);
        const creatorPk = pool.creator;
        const ata = await getAssociatedTokenAddress(mintPk, creatorPk);
        const _conn = getConnection();
        const acct = await getAccount(_conn, ata);
        const rawBal = BigInt(acct.amount.toString());
        creatorCurrentBalance = (Number(rawBal) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 });
        const totalRaw = BigInt(pool.totalSupply.toString());
        creatorCurrentPct = totalRaw > 0n ? ((Number(rawBal) / Number(totalRaw)) * 100).toFixed(2) : '0';
      } catch {
        // ATA doesn't exist
      }

      return {
        mint: mintAddress,
        name: dbToken?.token_name || pool.name || '',
        symbol: dbToken?.token_symbol || pool.symbol || '',
        creator: pool.creator.toBase58(),
        price_sol: priceSol.toFixed(12),
        virtual_sol_reserve: (vSol / LAMPORTS_PER_SOL).toFixed(9),
        virtual_token_reserve: (vToken / 1e9).toFixed(2),
        real_sol_balance: (Number(BigInt(pool.realSolBalance.toString())) / LAMPORTS_PER_SOL).toFixed(9),
        real_token_balance: (Number(BigInt(pool.realTokenBalance.toString()) / BigInt(1e6)) / 1e3).toFixed(2),
        total_supply: pool.totalSupply.toString(),
        creator_fees_earned: (pool.creatorFeesEarned.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
        creator_fees_claimed: (pool.creatorFeesClaimed.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
        platform_fees_earned: (pool.platformFeesEarned.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
        platform_fees_claimed: (pool.platformFeesClaimed.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
        dev_buy_sol: (pool.devBuySol.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
        dev_buy_tokens: (Number(BigInt(pool.devBuyTokens.toString()) / BigInt(1e6)) / 1e3).toFixed(2),
        creator_current_balance: creatorCurrentBalance,
        creator_current_pct: creatorCurrentPct,
        total_volume_sol: ((pool.totalVolumeSol?.toNumber() || 0) / LAMPORTS_PER_SOL).toFixed(9),
        total_trades: pool.totalTrades?.toNumber() || 0,
        total_buys: pool.totalBuys?.toNumber() || 0,
        total_sells: pool.totalSells?.toNumber() || 0,
        // Status: check on-chain enum OR graduated_at > 0 OR DB status as fallback
        status: (
          pool.status?.graduated !== undefined ||
          (pool.graduatedAt?.toNumber() || 0) > 0 ||
          dbToken?.status === 'graduated'
        ) ? 'graduated' : 'active',
        graduated_at: pool.graduatedAt?.toNumber() || 0,
        market_cap_sol: (vTokenBig > 0n
          ? (Number(BigInt(pool.realSolBalance.toString())) / LAMPORTS_PER_SOL + 30) * (Number(BigInt(pool.totalSupply.toString()) / BigInt(1e9)) / (vToken / 1e9))
          : 0).toFixed(4),
        graduation_progress: (() => {
          const realSolBig = BigInt(pool.realSolBalance?.toString() || '0');
          const unclaimedFees = (BigInt(pool.creatorFeesEarned?.toString() || '0') - BigInt(pool.creatorFeesClaimed?.toString() || '0'))
            + (BigInt(pool.platformFeesEarned?.toString() || '0') - BigInt(pool.platformFeesClaimed?.toString() || '0'));
          const netSol = realSolBig - unclaimedFees;
          return netSol > 0n
            ? ((Number(netSol) / Number(config?.graduationThreshold || 85_000_000_000n)) * 100).toFixed(2) + '%'
            : '0%';
        })(),
        graduation_threshold: Number(config?.graduationThreshold || 85_000_000_000n) / LAMPORTS_PER_SOL,
        raydium_pool_address: dbPool?.raydium_pool_address || null,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Sync on-chain pool state → DB (call this to fix stale data)
  fastify.post('/api/chain/sync/pool/:mintAddress', async (request, reply) => {
    try {
      const { mintAddress } = request.params;
      const pool = await readPool(mintAddress);
      if (!pool) return { skipped: true, reason: 'pool_not_onchain' };

      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (!dbToken) return { skipped: true, reason: 'token_not_in_db' };

      const tokenId = dbToken.id;
      const vSol = pool.virtualSolReserve.toString();
      const vToken = pool.virtualTokenReserve.toString();
      const realSol = pool.realSolBalance.toString();
      const realToken = pool.realTokenBalance.toString();
      const totalSupplyN = typeof pool.totalSupply === 'bigint' ? pool.totalSupply : BigInt(pool.totalSupply.toString());
      const realTokenN = typeof pool.realTokenBalance === 'bigint' ? pool.realTokenBalance : BigInt(pool.realTokenBalance.toString());
      const circulating = (totalSupplyN - realTokenN).toString();
      // Use BigInt to avoid overflow on virtualTokenReserve (>2^53)
      const vSolBig = BigInt(vSol);
      const vTokenBig = BigInt(vToken);
      const scaledPrice = vTokenBig > 0n ? (vSolBig * BigInt(1e18)) / vTokenBig : 0n;
      const priceSolPerToken = Number(scaledPrice) / 1e18; // SOL per human token
      const priceLamportsPerToken = priceSolPerToken * LAMPORTS_PER_SOL;

      // Update pool table
      stmts.updatePool?.run(vSol, vToken, realSol, realToken, circulating, Math.floor(priceLamportsPerToken).toString(), tokenId);

      // Update fees + volume + trade count
      const creatorFeesEarned = pool.creatorFeesEarned.toString();
      const creatorFeesClaimed = pool.creatorFeesClaimed.toString();
      const platformFeesEarned = pool.platformFeesEarned.toString();
      const platformFeesClaimed = pool.platformFeesClaimed.toString();
      const totalVolumeSol = (pool.totalVolumeSol?.toString() || '0');
      const totalTrades = pool.totalTrades?.toNumber() || 0;
      const totalBuys = pool.totalBuys?.toNumber() || 0;
      const totalSells = pool.totalSells?.toNumber() || 0;

      stmts.updatePoolFees?.run(
        creatorFeesEarned, creatorFeesClaimed,
        platformFeesEarned, platformFeesClaimed,
        totalVolumeSol, totalTrades,
        totalBuys, totalSells,
        tokenId
      );

      // Insert a fresh price snapshot so listActiveTokens query picks it up
      const marketCap = priceSolPerToken * Number(BigInt(pool.totalSupply.toString()) / BigInt(1e9));
      const volumeSol = (pool.totalVolumeSol?.toNumber() || 0) / LAMPORTS_PER_SOL;
      stmts.insertTokenPrice?.run(
        tokenId,
        priceSolPerToken.toFixed(12),
        null, // price_usd — no oracle yet
        volumeSol.toFixed(9),
        marketCap.toFixed(4),
        null  // holders — no on-chain count yet
      );

      return {
        synced: true,
        tokenId,
        price_lamports: priceLamportsPerToken,
        total_trades: totalTrades,
        circulating,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // List all pools from chain
  fastify.get('/api/chain/pools', async (request, reply) => {
    try {
      const pools = await readAllPools();
      return {
        pools: pools.map(p => {
          const pool = p.account;
          const _vSolBig = BigInt(pool.virtualSolReserve.toString());
          const _vTokenBig = BigInt(pool.virtualTokenReserve.toString());
          const _scaled = _vTokenBig > 0n ? (_vSolBig * BigInt(1e18)) / _vTokenBig : 0n;
          const priceSol = Number(_scaled) / 1e18; // SOL per human token (decimals cancel)
          return {
            address: p.publicKey.toBase58(),
            mint: pool.mint.toBase58(),
            creator: pool.creator.toBase58(),
            price_sol: priceSol.toFixed(12),
            real_sol_balance: (pool.realSolBalance.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
            total_trades: pool.totalTrades?.toNumber() || 0,
            status: (pool.status?.graduated !== undefined) ? 'graduated' : 'active',
          };
        }),
        count: pools.length,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // On-chain quote — reads pool state from chain and calculates expected output
  fastify.get('/api/chain/quote', async (request, reply) => {
    const { mint, side, amount } = request.query;
    if (!mint || !side || !amount) return reply.code(400).send({ error: 'mint, side, amount required' });

    try {
      const pool = await readPool(mint);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain' });

      const vSol = BigInt(pool.virtualSolReserve.toString());
      const vToken = BigInt(pool.virtualTokenReserve.toString());
      const k = vSol * vToken;
      const amountBig = BigInt(amount);

      // Read config for fees
      const config = await readCurveConfig();
      const totalFeeBps = BigInt((config?.creatorFeeBps || 140) + (config?.platformFeeBps || 60));

      if (side === 'buy') {
        // SOL in → tokens out
        const fee = amountBig * totalFeeBps / 10000n;
        const netSol = amountBig - fee;
        const newVSol = vSol + netSol;
        const newVToken = k / newVSol;
        const tokensOut = vToken - newVToken;
        const priceAfter = Number(newVSol) / Number(newVToken);
        const priceBefore = Number(vSol) / Number(vToken);
        const impact = priceBefore > 0 ? ((priceAfter - priceBefore) / priceBefore * 100).toFixed(2) : '0';

        const tokensOutNum = Number(tokensOut) / 1e9;
        const fmtTokens = tokensOutNum >= 1e6 ? (tokensOutNum / 1e6).toFixed(2) + 'M' : tokensOutNum.toLocaleString();
        return {
          side: 'buy',
          input_sol: (Number(amountBig) / 1e9).toFixed(9),
          output_tokens: tokensOutNum.toFixed(2),
          output: fmtTokens,
          fee: (Number(fee) / 1e9).toFixed(6),
          price_before: priceBefore.toFixed(12),
          price_after: priceAfter.toFixed(12),
          price_impact: `${impact}%`,
        };
      } else {
        // tokens in → SOL out
        const newVToken = vToken + amountBig;
        const newVSol = k / newVToken;
        const grossSol = vSol - newVSol;
        const fee = grossSol * totalFeeBps / 10000n;
        const netSol = grossSol - fee;
        const priceAfter = Number(newVSol) / Number(newVToken);
        const priceBefore = Number(vSol) / Number(vToken);
        const impact = priceBefore > 0 ? ((priceBefore - priceAfter) / priceBefore * 100).toFixed(2) : '0';

        return {
          side: 'sell',
          input_tokens: (Number(amountBig) / 1e9).toFixed(2),
          output_sol: (Number(netSol) / 1e9).toFixed(9),
          output: (Number(netSol) / 1e9).toFixed(6) + ' SOL',
          fee: (Number(fee) / 1e9).toFixed(6),
          price_before: priceBefore.toFixed(12),
          price_after: priceAfter.toFixed(12),
          price_impact: `${impact}%`,
        };
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TRANSACTION BUILDERS — return base64 tx for wallet signing
  // ═══════════════════════════════════════════════════════════

  // Build buy transaction
  fastify.post('/api/chain/build/buy', async (request, reply) => {
    const { mintAddress, buyerWallet, solAmount, slippageBps = 100 } = request.body || {};

    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });
    if (!buyerWallet) return reply.code(400).send({ error: 'buyerWallet required' });
    if (!solAmount || solAmount <= 0) return reply.code(400).send({ error: 'solAmount required (in SOL)' });

    try {
      // Guard: check if token is graduating or graduated
      const dbTokenCheck = stmts.getAgentTokenByMint?.get(mintAddress);
      if (dbTokenCheck?.status === 'graduating') {
        return reply.code(423).send({ error: 'Token is graduating to Raydium CPMM. Trading will resume shortly.', status: 'graduating' });
      }
      if (dbTokenCheck?.status === 'graduated') {
        const dbPoolCheck = stmts.getPool?.get(dbTokenCheck.id);
        return reply.code(400).send({ error: 'Token has graduated to Raydium. Use post-grad trading endpoints.', status: 'graduated', raydiumPool: dbPoolCheck?.raydium_pool_address });
      }

      const solAmountLamports = Math.round(solAmount * LAMPORTS_PER_SOL);

      // Read current pool state to calculate expected output + slippage
      let pool;
      try {
        pool = await readPool(mintAddress);
      } catch (poolErr) {
        return reply.code(500).send({
          error: `Failed to read pool from chain: ${poolErr.message}`,
          hint: 'The RPC may be unavailable or the mint address is invalid.',
          guide: 'GET /api/integration-guide for field layout and PDA derivation',
        });
      }

      if (!pool) {
        return reply.code(404).send({
          error: 'Pool not found on-chain. Token may not be created yet.',
          hint: 'Ensure the create_token transaction has been confirmed and POST /api/tokens/:id/activate has been called.',
          guide: 'GET /api/integration-guide → token_lifecycle for the full creation flow',
          mintAddress,
        });
      }

      // Sanity check pool fields
      let vSol, vToken;
      try {
        vSol = BigInt(pool.virtualSolReserve.toString());
        vToken = BigInt(pool.virtualTokenReserve.toString());
        if (vSol === 0n || vToken === 0n) throw new Error('zero reserves');
      } catch (parseErr) {
        return reply.code(500).send({
          error: 'Pool data appears malformed — reserves could not be read.',
          pool_fields: {
            virtualSolReserve: pool.virtualSolReserve?.toString() ?? 'undefined',
            virtualTokenReserve: pool.virtualTokenReserve?.toString() ?? 'undefined',
          },
          hint: 'Expected u64 values > 0. Pool may not be initialized correctly.',
          guide: 'GET /api/integration-guide → structs.CurvePool for field layout',
        });
      }

      // Calculate expected tokens out using constant product formula (BigInt for overflow safety)
      const solLamBig = BigInt(solAmountLamports);
      const config = await readCurveConfig();
      const totalFeeBps = BigInt(config.creatorFeeBps) + BigInt(config.platformFeeBps);
      const fee = solLamBig * totalFeeBps / 10000n;
      const solAfterFee = solLamBig - fee;
      const tokensOut = Number((vToken * solAfterFee) / (vSol + solAfterFee));

      // Apply slippage tolerance
      const minTokensOut = Math.floor(tokensOut * (10000 - slippageBps) / 10000);

      // Check if buyer has an ATA — if not, include createATA instruction
      const conn = getConnection();
      const buyerPk = new PublicKey(buyerWallet);
      const mintPk = new PublicKey(mintAddress);
      const buyerATA = await getAssociatedTokenAddress(mintPk, buyerPk);

      let needsATA = false;
      try {
        await getAccount(conn, buyerATA);
      } catch {
        needsATA = true;
      }

      let transaction;
      try {
        transaction = await buildBuyTransaction({
          buyerPublicKey: buyerWallet,
          mintAddress,
          solAmountLamports,
          minTokensOut,
          createATA: needsATA,
        });
      } catch (buildErr) {
        const msg = buildErr.message || '';
        let hint = `Failed to build buy tx: ${msg}`;
        if (msg.includes('MathOverflow') || msg.includes('overflow')) {
          hint = 'MathOverflow: trade size too large or pool reserves near zero. Reduce solAmount.';
        } else if (msg.includes('insufficient') || msg.includes('lamports')) {
          hint = 'Insufficient lamports: buyer wallet does not have enough SOL. Need solAmount + ~0.01 SOL for fees/rent.';
        } else if (msg.includes('SlippageExceeded') || msg.includes('slippage')) {
          hint = 'Slippage exceeded: price moved too much. Try a larger slippageBps (e.g. 300) or reduce trade size.';
        } else if (msg.includes('PoolNotActive') || msg.includes('not active')) {
          hint = 'Pool is not active. Token may have graduated to Raydium. Use POST /api/chain/build/post-grad/buy instead.';
        } else if (msg.includes('simulation')) {
          hint = `Transaction simulation failed: ${msg}. Check wallet SOL balance and token pool state.`;
        }
        return reply.code(400).send({
          error: hint,
          guide: 'GET /api/integration-guide → common_errors for troubleshooting',
        });
      }

      return {
        transaction,
        expectedTokens: tokensOut,
        expectedTokensFormatted: (tokensOut / 1e9).toFixed(2),
        minTokensOut,
        fee: Number(fee) / LAMPORTS_PER_SOL,
        priceImpact: (Number(solAfterFee * 10000n / (vSol + solAfterFee)) / 100).toFixed(2) + '%',
      };
    } catch (err) {
      return reply.code(500).send({
        error: `Failed to build buy tx: ${err.message}`,
        guide: 'GET /api/integration-guide → common_errors for troubleshooting',
      });
    }
  });

  // Build sell transaction
  fastify.post('/api/chain/build/sell', async (request, reply) => {
    const { mintAddress, sellerWallet, tokenAmount, slippageBps = 100 } = request.body || {};

    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });
    if (!sellerWallet) return reply.code(400).send({ error: 'sellerWallet required' });
    if (!tokenAmount) return reply.code(400).send({ error: 'tokenAmount required (raw units)' });

    try {
      // Guard: check if token is graduating or graduated
      const dbTokenCheck = stmts.getAgentTokenByMint?.get(mintAddress);
      if (dbTokenCheck?.status === 'graduating') {
        return reply.code(423).send({ error: 'Token is graduating to Raydium CPMM. Trading will resume shortly.', status: 'graduating' });
      }
      if (dbTokenCheck?.status === 'graduated') {
        const dbPoolCheck = stmts.getPool?.get(dbTokenCheck.id);
        return reply.code(400).send({ error: 'Token has graduated to Raydium. Use post-grad trading endpoints.', status: 'graduated', raydiumPool: dbPoolCheck?.raydium_pool_address });
      }

      let pool;
      try {
        pool = await readPool(mintAddress);
      } catch (poolErr) {
        return reply.code(500).send({
          error: `Failed to read pool from chain: ${poolErr.message}`,
          hint: 'The RPC may be unavailable or the mint address is invalid.',
          guide: 'GET /api/integration-guide for field layout and PDA derivation',
        });
      }

      if (!pool) {
        return reply.code(404).send({
          error: 'Pool not found on-chain.',
          hint: 'Verify mintAddress is correct and the token has been activated via POST /api/tokens/:id/activate.',
          guide: 'GET /api/integration-guide → token_lifecycle',
          mintAddress,
        });
      }

      // Sanity check pool fields
      let vSol, vToken;
      try {
        vSol = BigInt(pool.virtualSolReserve.toString());
        vToken = BigInt(pool.virtualTokenReserve.toString());
        if (vSol === 0n || vToken === 0n) throw new Error('zero reserves');
      } catch (parseErr) {
        return reply.code(500).send({
          error: 'Pool data appears malformed — reserves could not be read.',
          pool_fields: {
            virtualSolReserve: pool.virtualSolReserve?.toString() ?? 'undefined',
            virtualTokenReserve: pool.virtualTokenReserve?.toString() ?? 'undefined',
          },
          hint: 'Expected u64 values > 0.',
          guide: 'GET /api/integration-guide → structs.CurvePool for field layout',
        });
      }

      const rawTokens = BigInt(tokenAmount);
      const solOut = Number((vSol * rawTokens) / (vToken + rawTokens));
      const config = await readCurveConfig();
      const totalFeeBps = Number(config.creatorFeeBps) + Number(config.platformFeeBps);
      const fee = Math.floor(solOut * totalFeeBps / 10000);
      const solAfterFee = solOut - fee;

      const minSolOut = Math.floor(solAfterFee * (10000 - slippageBps) / 10000);

      let transaction;
      try {
        transaction = await buildSellTransaction({
          sellerPublicKey: sellerWallet,
          mintAddress,
          tokenAmount: tokenAmount.toString(),
          minSolOut,
        });
      } catch (buildErr) {
        const msg = buildErr.message || '';
        let hint = `Failed to build sell tx: ${msg}`;
        if (msg.includes('MathOverflow') || msg.includes('overflow')) {
          hint = 'MathOverflow: token amount too large for current pool reserves. Reduce tokenAmount.';
        } else if (msg.includes('ExceedsRealSol') || msg.includes('real sol')) {
          hint = 'ExceedsRealSol: selling too many tokens would require more SOL than is in the pool. Reduce tokenAmount.';
        } else if (msg.includes('SlippageExceeded') || msg.includes('slippage')) {
          hint = 'Slippage exceeded: price moved too much. Increase slippageBps (e.g. 300) or reduce trade size.';
        } else if (msg.includes('PoolNotActive') || msg.includes('not active')) {
          hint = 'Pool is not active. Token may have graduated to Raydium. Use POST /api/chain/build/post-grad/sell instead.';
        } else if (msg.includes('insufficient') || msg.includes('balance')) {
          hint = 'Insufficient token balance: seller may not hold enough tokens. tokenAmount is in raw units (human_tokens * 10^9).';
        }
        return reply.code(400).send({
          error: hint,
          guide: 'GET /api/integration-guide → common_errors for troubleshooting',
        });
      }

      return {
        transaction,
        expectedSol: solAfterFee / LAMPORTS_PER_SOL,
        minSolOut: minSolOut / LAMPORTS_PER_SOL,
        fee: fee / LAMPORTS_PER_SOL,
      };
    } catch (err) {
      return reply.code(500).send({
        error: `Failed to build sell tx: ${err.message}`,
        guide: 'GET /api/integration-guide → common_errors for troubleshooting',
      });
    }
  });

  // Build create token transaction
  fastify.post('/api/chain/build/create-token', async (request, reply) => {
    const { creatorWallet, name, symbol, uri, devBuySol } = request.body || {};

    if (!creatorWallet) return reply.code(400).send({ error: 'creatorWallet required' });
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (!symbol) return reply.code(400).send({ error: 'symbol required' });

    try {
      // Check if config is initialized
      const config = await readCurveConfig();
      if (!config) return reply.code(500).send({ error: 'Bonding curve config not initialized on-chain. Contact admin.' });

      const result = await buildCreateTokenTransaction({
        creatorPublicKey: creatorWallet,
        name,
        symbol,
        uri: uri || '',
        devBuySol: devBuySol || null,
      });

      return {
        transaction: result.transaction,
        mintPublicKey: result.mintPublicKey,
        mintAddress: result.mintPublicKey, // alias for compatibility
        poolAddress: result.poolAddress,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to build create-token tx: ${err.message}` });
    }
  });

  // Build claim creator fees transaction
  fastify.post('/api/chain/build/claim-fees', async (request, reply) => {
    const { creatorWallet, mintAddress } = request.body || {};

    if (!creatorWallet) return reply.code(400).send({ error: 'creatorWallet required' });
    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });

    try {
      const transaction = await buildClaimCreatorFeesTransaction({
        creatorPublicKey: creatorWallet,
        mintAddress,
      });

      return { transaction };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to build claim-fees tx: ${err.message}` });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GRADUATE — trigger graduation for a pool that crossed threshold
  // ═══════════════════════════════════════════════════════════

  fastify.post('/api/chain/build/graduate', async (request, reply) => {
    const { mintAddress } = request.body || {};
    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });

    try {
      // Check DB status first
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (!dbToken) return reply.code(404).send({ error: 'Token not found in DB' });
      if (dbToken.status === 'graduated') {
        const dbPool = stmts.getPool?.get(dbToken.id);
        return reply.code(400).send({ error: 'Token already graduated', raydiumPool: dbPool?.raydium_pool_address });
      }
      if (dbToken.status === 'graduating') {
        return reply.code(423).send({ error: 'Graduation already in progress', status: 'graduating' });
      }

      // Read on-chain pool + config
      const pool = await readPool(mintAddress);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain' });

      const config = await readCurveConfig();
      if (!config) return reply.code(500).send({ error: 'Could not read curve config' });

      // Check threshold
      const realSol = BigInt(pool.realSolBalance.toString());
      const unclaimedFees = (BigInt(pool.creatorFeesEarned?.toString() || '0') - BigInt(pool.creatorFeesClaimed?.toString() || '0'))
        + (BigInt(pool.platformFeesEarned?.toString() || '0') - BigInt(pool.platformFeesClaimed?.toString() || '0'));
      const netSol = realSol - unclaimedFees;
      const threshold = BigInt(config.graduationThreshold.toString());

      if (netSol < threshold) {
        return reply.code(400).send({
          error: 'Pool has not reached graduation threshold',
          netSol: netSol.toString(),
          threshold: threshold.toString(),
          progress: ((Number(netSol) / Number(threshold)) * 100).toFixed(2) + '%',
        });
      }

      // Check if already graduated on-chain
      if (pool.status?.graduated !== undefined || pool.graduatedAt > 0) {
        return reply.code(400).send({ error: 'Pool already graduated on-chain' });
      }

      // Set DB status to graduating
      const tokenId = dbToken.id;
      stmts.updateAgentTokenStatus?.run('graduating', mintAddress, dbToken?.pool_address, dbToken?.launch_tx, tokenId);

      // Notify clients
      emitTrade(mintAddress, { type: 'graduating', mintAddress, message: 'Token is graduating to Raydium CPMM...', symbol: dbToken?.token_symbol });
      if (tokenId) emitTrade(tokenId, { type: 'graduating', mintAddress, message: 'Token is graduating to Raydium CPMM...', symbol: dbToken?.token_symbol });

      // Build, sign, send graduation TX with deployer
      const deployer = getDeployer();
      const graduateResult = await buildGraduateTransaction({ mintAddress, payer: deployer.publicKey.toBase58() });
      graduateResult.tx.sign(deployer);

      const conn = getConnection();
      const gradTxSig = await conn.sendRawTransaction(graduateResult.tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(gradTxSig, 'confirmed');

      // Update DB
      stmts.graduatePool?.run(graduateResult.raydiumPoolState, tokenId);
      stmts.updateAgentTokenStatus?.run('graduated', mintAddress, dbToken?.pool_address, dbToken?.launch_tx, tokenId);

      // Notify clients
      const gradPayload = { type: 'graduation', mintAddress, raydiumPool: graduateResult.raydiumPoolState, txSignature: gradTxSig, symbol: dbToken?.token_symbol };
      emitTrade(mintAddress, gradPayload);
      if (tokenId) emitTrade(tokenId, gradPayload);

      return {
        graduated: true,
        raydiumPool: graduateResult.raydiumPoolState,
        graduationTx: gradTxSig,
        mintAddress,
      };
    } catch (err) {
      // Revert status on failure
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (dbToken) stmts.updateAgentTokenStatus?.run('active', mintAddress, dbToken?.pool_address, dbToken?.launch_tx, dbToken.id);
      console.error(`[build/graduate] Failed for ${mintAddress}:`, err.message);
      return reply.code(500).send({ error: `Graduation failed: ${err.message}`, hint: 'Pool reverted to active, trading can continue' });
    }
  });

  // Check graduation eligibility without triggering it
  fastify.get('/api/chain/check-graduation/:mint', async (request, reply) => {
    const { mint } = request.params;
    try {
      const pool = await readPool(mint);
      if (!pool) return reply.code(404).send({ error: 'Pool not found' });

      const config = await readCurveConfig();
      const realSol = BigInt(pool.realSolBalance.toString());
      const unclaimedFees = (BigInt(pool.creatorFeesEarned?.toString() || '0') - BigInt(pool.creatorFeesClaimed?.toString() || '0'))
        + (BigInt(pool.platformFeesEarned?.toString() || '0') - BigInt(pool.platformFeesClaimed?.toString() || '0'));
      const netSol = realSol - unclaimedFees;
      const threshold = BigInt(config.graduationThreshold.toString());

      const dbToken = stmts.getAgentTokenByMint?.get(mint);
      return {
        eligible: netSol >= threshold,
        graduated: pool.status?.graduated !== undefined || pool.graduatedAt > 0,
        dbStatus: dbToken?.status || 'unknown',
        netSol: netSol.toString(),
        threshold: threshold.toString(),
        progress: ((Number(netSol) / Number(threshold)) * 100).toFixed(2) + '%',
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SYNC — update DB from on-chain state after tx confirmation
  // ═══════════════════════════════════════════════════════════

  // Sync a trade after it confirms on-chain
  fastify.post('/api/chain/sync/trade', async (request, reply) => {
    const { txSignature, mintAddress, traderWallet } = request.body || {};

    if (!txSignature) return reply.code(400).send({ error: 'txSignature required' });
    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });

    try {
      const conn = getConnection();

      // Check if TX already on-chain (handles both fresh and old TXes)
      const txCheck = await conn.getTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!txCheck) {
        // Fresh TX — wait for confirmation with timeout
        try {
          const latestBlockhash = await conn.getLatestBlockhash();
          await conn.confirmTransaction({
            signature: txSignature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          }, 'confirmed');
        } catch (confirmErr) {
          return reply.code(400).send({ error: 'Transaction not found on-chain', txSignature });
        }
      }
      // TX confirmed (either pre-existing or just confirmed above)

      // Read updated pool state from chain
      const pool = await readPool(mintAddress);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain after trade' });

      // Parse events from the transaction
      const tx = await conn.getTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      // Find TradeExecuted event in logs
      let tradeEvent = null;
      if (tx?.meta?.logMessages) {
        for (const log of tx.meta.logMessages) {
          if (log.includes('TradeExecuted')) {
            // Anchor emits events as base64 in "Program data:" logs
            // For now extract basic info from pool state diff
            break;
          }
        }
      }

      // Get token from DB
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      const tokenId = dbToken?.id;

      // Compute price from pool reserves (BigInt safe)
      const _vs = BigInt(pool.virtualSolReserve.toString());
      const _vt = BigInt(pool.virtualTokenReserve.toString());
      const _sc = _vt > 0n ? (_vs * BigInt(1e18)) / _vt : 0n;
      const priceLamports = Math.floor(Number(_sc) / 1e18 * LAMPORTS_PER_SOL);

      // Update pool in DB from on-chain state
      if (tokenId && stmts.updatePool) {
        const vSol = pool.virtualSolReserve.toString();
        const vToken = pool.virtualTokenReserve.toString();
        const realSol = pool.realSolBalance.toString();
        const realToken = pool.realTokenBalance.toString();
        const totalSupplyN = typeof pool.totalSupply === 'bigint' ? pool.totalSupply : BigInt(pool.totalSupply.toString());
        const realTokenN = typeof pool.realTokenBalance === 'bigint' ? pool.realTokenBalance : BigInt(pool.realTokenBalance.toString());
        const circulating = (totalSupplyN - realTokenN).toString();

        stmts.updatePool.run(vSol, vToken, realSol, realToken, circulating, priceLamports.toString(), tokenId);
      }

      // Extract SOL and token amounts from tx meta — needed for both DB insert and WebSocket payload
      let solAmount = '0';
      let tokenAmount = '0';
      if (tx?.meta) {
        const accountKeys = tx.transaction?.message?.staticAccountKeys
          || tx.transaction?.message?.accountKeys || [];
        const traderIdx = accountKeys.findIndex(k => k.toBase58() === (traderWallet || ''));
        if (traderIdx >= 0) {
          const pre = tx.meta.preBalances?.[traderIdx] || 0;
          const post = tx.meta.postBalances?.[traderIdx] || 0;
          solAmount = Math.abs(post - pre).toString();
        }
        // Token amounts from pre/postTokenBalances
        const preToken = tx.meta.preTokenBalances?.find(b => b.owner === (traderWallet || '') && b.mint === mintAddress);
        const postToken = tx.meta.postTokenBalances?.find(b => b.owner === (traderWallet || '') && b.mint === mintAddress);
        const preAmt = BigInt(preToken?.uiTokenAmount?.amount || '0');
        const postAmt = BigInt(postToken?.uiTokenAmount?.amount || '0');
        tokenAmount = (postAmt > preAmt ? postAmt - preAmt : preAmt - postAmt).toString();
      }

      // Record trade in DB
      if (tokenId && stmts.insertTokenTrade) {
        const isBuy = tx?.meta?.logMessages?.some(l => l.includes('buy') || l.includes('Buy')) ?? true;
        const tradeId = randomUUID();

        stmts.insertTokenTrade.run(
          tradeId, tokenId, traderWallet || '', isBuy ? 'buy' : 'sell',
          tokenAmount, solAmount, priceLamports.toString(), txSignature
        );
      }

      // Emit WebSocket event — broadcast to both tokenId and mintAddress
      // so clients subscribed by either key receive the update
      const tradePayload = {
        type: 'trade',
        side: tx?.meta?.logMessages?.some(l => l.includes('buy') || l.includes('Buy')) ? 'buy' : 'sell',
        wallet: traderWallet || '',
        price: (priceLamports / LAMPORTS_PER_SOL).toFixed(12),
        amount_token: tokenAmount || '0',
        amount_sol: solAmount || '0',
        txSignature,
        symbol: dbToken?.token_symbol || '',
        name: dbToken?.token_name || '',
        mintAddress: mintAddress || '',
        onChain: true,
      };
      if (tokenId) emitTrade(tokenId, tradePayload);
      if (mintAddress) emitTrade(mintAddress, tradePayload);

      // ── Auto-graduation check ──
      // After syncing the trade, check if pool has hit the graduation threshold.
      // The trade already succeeded on-chain — graduation is a bonus step.
      let graduationResult = null;
      try {
        const config = await readCurveConfig();
        if (config && tokenId) {
          const realSol = BigInt(pool.realSolBalance.toString());
          const unclaimedFees = (BigInt(pool.creatorFeesEarned?.toString() || '0') - BigInt(pool.creatorFeesClaimed?.toString() || '0'))
            + (BigInt(pool.platformFeesEarned?.toString() || '0') - BigInt(pool.platformFeesClaimed?.toString() || '0'));
          const netSol = realSol - unclaimedFees;
          const threshold = BigInt(config.graduationThreshold.toString());

          // pool.status: Anchor enum { active: {} } or { graduated: {} }
          // Also check graduatedAt > 0 (more reliable — DARK graduated with status still showing active)
          const alreadyGraduated = (pool.status?.graduated !== undefined) || (pool.graduatedAt > 0);
          const dbTokenStatus = dbToken?.status;

          if (netSol >= threshold && !alreadyGraduated && dbTokenStatus !== 'graduating' && dbTokenStatus !== 'graduated') {
            // Set status to 'graduating' to block new trades
            stmts.updateAgentTokenStatus?.run('graduating', mintAddress, dbToken?.pool_address, dbToken?.launch_tx, tokenId);

            // Notify clients
            emitTrade(mintAddress, {
              type: 'graduating',
              mintAddress,
              message: 'Token is graduating to Raydium CPMM...',
              symbol: dbToken?.token_symbol,
            });
            if (tokenId) {
              emitTrade(tokenId, {
                type: 'graduating',
                mintAddress,
                message: 'Token is graduating to Raydium CPMM...',
                symbol: dbToken?.token_symbol,
              });
            }

            // Execute graduation
            const deployer = getDeployer();
            const graduateResult = await buildGraduateTransaction({
              mintAddress,
              payer: deployer.publicKey.toBase58(),
            });
            graduateResult.tx.sign(deployer);

            const gradConn = getConnection();
            const gradTxSig = await gradConn.sendRawTransaction(graduateResult.tx.serialize(), { skipPreflight: false });
            await gradConn.confirmTransaction(gradTxSig, 'confirmed');

            // Update DB with graduation info
            stmts.graduatePool?.run(graduateResult.raydiumPoolState, tokenId);
            stmts.updateAgentTokenStatus?.run('graduated', mintAddress, dbToken?.pool_address, dbToken?.launch_tx, tokenId);

            // Notify clients of graduation
            const gradPayload = {
              type: 'graduation',
              mintAddress,
              raydiumPool: graduateResult.raydiumPoolState,
              txSignature: gradTxSig,
              symbol: dbToken?.token_symbol,
            };
            emitTrade(mintAddress, gradPayload);
            if (tokenId) emitTrade(tokenId, gradPayload);

            graduationResult = {
              graduatedTo: graduateResult.raydiumPoolState,
              graduationTx: gradTxSig,
            };
          }
        }
      } catch (gradErr) {
        // Graduation failed — revert status back to active so trading can continue
        if (tokenId && dbToken) {
          stmts.updateAgentTokenStatus?.run('active', mintAddress, dbToken?.pool_address, dbToken?.launch_tx, tokenId);
        }
        console.error(`[auto-graduation] Failed for ${mintAddress}:`, gradErr.message);
      }

      return {
        synced: true,
        txSignature,
        poolState: {
          virtualSolReserve: pool.virtualSolReserve.toString(),
          virtualTokenReserve: pool.virtualTokenReserve.toString(),
          realSolBalance: pool.realSolBalance.toString(),
          totalTrades: pool.totalTrades?.toNumber() || 0,
        },
        ...(graduationResult || {}),
      };
    } catch (err) {
      // Don't fail hard — trade went through on-chain even if sync fails
      return reply.code(200).send({
        synced: false,
        error: err.message,
        txSignature,
        note: 'Trade confirmed on-chain but DB sync failed. Pool will sync on next read.',
      });
    }
  });

  // Sync token creation after it confirms
  fastify.post('/api/chain/sync/token', async (request, reply) => {
    const { txSignature, mintAddress, mintPublicKey, creatorWallet, agentId, name, symbol } = request.body || {};

    if (!txSignature) return reply.code(400).send({ error: 'txSignature required' });
    if (!mintPublicKey && !mintAddress) return reply.code(400).send({ error: 'mintPublicKey or mintAddress required' });

    try {
      const mint = mintPublicKey || mintAddress;
      const conn = getConnection();

      // Verify tx exists on-chain (don't block on confirmTransaction for old txs)
      const txInfo = await conn.getTransaction(txSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!txInfo) {
        // Try confirming if fresh
        try {
          const latestBlockhash = await conn.getLatestBlockhash();
          await conn.confirmTransaction({
            signature: txSignature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          }, 'confirmed');
        } catch (confirmErr) {
          return reply.code(400).send({ error: 'Transaction not found on-chain', txSignature });
        }
      }

      // Read pool from chain
      const pool = await readPool(mint);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain after creation' });

      // Create/update token in DB
      if (agentId && stmts.insertAgentToken) {
        const tokenId = randomUUID();
        // Column order: id, agent_id, token_name, token_symbol, total_supply,
        //   creator_wallet, creator_fee_bps, platform_fee_bps, logo_url, description,
        //   agent_description, social_twitter, social_telegram, social_discord,
        //   social_website, ipfs_logo_cid, ipfs_metadata_cid
        stmts.insertAgentToken.run(
          tokenId,
          agentId,
          name || 'Agent Token',
          symbol || 'TOKEN',
          pool.totalSupply.toString(),
          creatorWallet || pool.creator.toBase58(),
          140,
          60,
          null, // logo_url
          null, // description
          null, // agent_description
          null, // social_twitter
          null, // social_telegram
          null, // social_discord
          null, // social_website
          null, // ipfs_logo_cid
          null  // ipfs_metadata_cid
        );
        // Set mint address, pool address, launch tx and mark active
        stmts.updateAgentTokenStatus?.run('active', mint, null, txSignature, tokenId);

        // Create pool record
        if (stmts.insertPool) {
          const [poolPDA] = getCurvePoolPDA(new PublicKey(mint));
          stmts.insertPool.run(
            tokenId,
            pool.virtualSolReserve.toString(),
            pool.virtualTokenReserve.toString(),
            pool.realSolBalance.toString(),
            pool.realTokenBalance.toString(),
            pool.totalSupply.toString(),
            (BigInt(pool.totalSupply.toString()) - BigInt(pool.realTokenBalance.toString())).toString(),
            (() => {
              const _vs = BigInt(pool.virtualSolReserve.toString());
              const _vt = BigInt(pool.virtualTokenReserve.toString());
              return _vt > 0n ? Number((_vs * BigInt(1e18)) / _vt / BigInt(1e18)).toString() : '0';
            })(),
            'active'
          );
        }

        return { synced: true, tokenId, mintAddress: mint };
      }

      return { synced: true, mintAddress: mint, note: 'No agentId provided — token not linked to DB agent' };
    } catch (err) {
      return reply.code(200).send({ synced: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ADMIN ROUTES MOVED → /api/admin/* (see api/routes/admin.js)
  // Routes removed: /api/chain/admin/wallet, /api/chain/admin/initialize,
  //   /api/chain/admin/reset-token, /api/chain/admin/update-token-mint,
  //   /api/chain/graduate/trigger
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // POST-GRADUATION — Raydium CPMM trading after graduation threshold
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/chain/quote/post-grad
   * Quote a post-graduation trade through Raydium CPMM.
   * Query: ?mint=<mintAddress>&side=buy|sell&amount=<rawUnits>
   *
   * Returns expected output and price impact.
   */
  fastify.get('/api/chain/quote/post-grad', async (request, reply) => {
    const { mint, side, amount } = request.query;
    if (!mint)   return reply.code(400).send({ error: 'mint required' });
    if (!side)   return reply.code(400).send({ error: 'side required (buy|sell)' });
    if (!amount) return reply.code(400).send({ error: 'amount required (raw units)' });
    if (side !== 'buy' && side !== 'sell') {
      return reply.code(400).send({ error: 'side must be buy or sell' });
    }

    try {
      // Look up Raydium pool address from DB
      const dbToken = stmts.getAgentTokenByMint?.get(mint);
      if (!dbToken) return reply.code(404).send({ error: 'Token not found in DB' });

      const dbPool = stmts.getPool?.get(dbToken.id);
      if (!dbPool?.raydium_pool_address) {
        return reply.code(404).send({ error: 'Token has not graduated to Raydium yet' });
      }

      // Read live pool state from chain
      const poolState = await getRaydiumPoolState(dbPool.raydium_pool_address);

      // Determine input mint by side
      const inputMint = side === 'buy' ? NATIVE_MINT : new PublicKey(mint);
      const amountBig = BigInt(amount);

      const quote = quoteRaydiumSwap(poolState, inputMint, amountBig);

      // Our platform fee on top of Raydium's
      const totalPlatformFeeBps = (dbToken.creator_fee_bps || 140) + (dbToken.platform_fee_bps || 60);
      const platformFeeOnInput  = amountBig * BigInt(totalPlatformFeeBps) / 10000n;

      if (side === 'buy') {
        // input: SOL (lamports), output: tokens (raw)
        const netInput   = amountBig - platformFeeOnInput;
        const buyQuote   = quoteRaydiumSwap(poolState, NATIVE_MINT, netInput);
        return {
          side: 'buy',
          input_lamports:   amount,
          input_sol:        (Number(amountBig) / LAMPORTS_PER_SOL).toFixed(9),
          output_tokens:    buyQuote.amountOut.toString(),
          output_tokens_ui: (Number(buyQuote.amountOut) / 1e9).toFixed(6),
          platform_fee_sol: (Number(platformFeeOnInput) / LAMPORTS_PER_SOL).toFixed(6),
          raydium_fee_sol:  (Number(buyQuote.raydiumFee) / LAMPORTS_PER_SOL).toFixed(6),
          price_impact:     buyQuote.priceImpact.toFixed(2) + '%',
          pool:             dbPool.raydium_pool_address,
        };
      } else {
        // input: tokens (raw), output: SOL (lamports)
        const sellQuote       = quoteRaydiumSwap(poolState, new PublicKey(mint), amountBig);
        const platformFeeOnOut = sellQuote.amountOut * BigInt(totalPlatformFeeBps) / 10000n;
        const netOutput        = sellQuote.amountOut - platformFeeOnOut;
        return {
          side: 'sell',
          input_tokens:     amount,
          input_tokens_ui:  (Number(amountBig) / 1e9).toFixed(6),
          output_lamports:  netOutput.toString(),
          output_sol:       (Number(netOutput) / LAMPORTS_PER_SOL).toFixed(9),
          platform_fee_sol: (Number(platformFeeOnOut) / LAMPORTS_PER_SOL).toFixed(6),
          raydium_fee_sol:  (Number(sellQuote.raydiumFee) / LAMPORTS_PER_SOL).toFixed(6),
          price_impact:     sellQuote.priceImpact.toFixed(2) + '%',
          pool:             dbPool.raydium_pool_address,
        };
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/chain/build/post-grad/buy
   * Build a post-graduation BUY transaction (Raydium CPMM).
   *
   * Body: { mintAddress, buyerWallet, solAmount, slippageBps? }
   * Returns: { transaction, expectedTokens, expectedTokensUi, fee, priceImpact }
   */
  fastify.post('/api/chain/build/post-grad/buy', async (request, reply) => {
    const { mintAddress, buyerWallet, solAmount, slippageBps = 100 } = request.body || {};

    if (!mintAddress)  return reply.code(400).send({ error: 'mintAddress required' });
    if (!buyerWallet)  return reply.code(400).send({ error: 'buyerWallet required' });
    if (!solAmount || solAmount <= 0) return reply.code(400).send({ error: 'solAmount required (in SOL)' });

    try {
      // Validate buyer wallet
      let buyerPk;
      try { buyerPk = new PublicKey(buyerWallet); } catch {
        return reply.code(400).send({ error: 'Invalid buyerWallet address' });
      }

      // Look up token + pool in DB
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (!dbToken) return reply.code(404).send({ error: 'Token not found' });
      if (dbToken.status !== 'graduated') {
        return reply.code(400).send({ error: 'Token has not graduated yet. Use /api/chain/build/buy instead.' });
      }

      const dbPool = stmts.getPool?.get(dbToken.id);
      if (!dbPool?.raydium_pool_address) {
        return reply.code(404).send({ error: 'Raydium pool address not found in DB. Run /api/admin/graduate/:mintAddress first.' });
      }

      // Get creator wallet from token record
      const creatorWallet = dbToken.creator_wallet;
      if (!creatorWallet) return reply.code(500).send({ error: 'Creator wallet not set on token' });

      // Treasury = deployer wallet
      const { getDeployer } = await import('../services/solana.js');
      const deployer = getDeployer();
      const treasuryWallet = deployer.publicKey.toBase58();

      // Fee rates (from DB, with sensible defaults)
      const creatorFeeBps  = dbToken.creator_fee_bps  ?? 140;
      const platformFeeBps = dbToken.platform_fee_bps ?? 60;

      const result = await buildPostGradBuyTransaction({
        buyerWallet,
        raydiumPoolAddress: dbPool.raydium_pool_address,
        mintAddress,
        solAmount,
        slippageBps,
        creatorWallet,
        treasuryWallet,
        creatorFeeBps,
        platformFeeBps,
      });

      return {
        transaction:       result.transaction,
        expectedTokens:    result.expectedTokens,
        expectedTokensUi:  result.expectedTokensUi,
        minOut:            result.minOut,
        fee:               result.fee,
        priceImpact:       result.priceImpact.toFixed(2) + '%',
        raydiumPool:       dbPool.raydium_pool_address,
        tokenName:         dbToken.token_name,
        tokenSymbol:       dbToken.token_symbol,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to build post-grad buy tx: ${err.message}` });
    }
  });

  /**
   * POST /api/chain/build/post-grad/sell
   * Build a post-graduation SELL transaction (Raydium CPMM).
   *
   * Body: { mintAddress, sellerWallet, tokenAmount, slippageBps? }
   * Returns: { transaction, expectedSol, grossSol, fee, priceImpact }
   */
  fastify.post('/api/chain/build/post-grad/sell', async (request, reply) => {
    const { mintAddress, sellerWallet, tokenAmount, slippageBps = 100 } = request.body || {};

    if (!mintAddress)  return reply.code(400).send({ error: 'mintAddress required' });
    if (!sellerWallet) return reply.code(400).send({ error: 'sellerWallet required' });
    if (!tokenAmount)  return reply.code(400).send({ error: 'tokenAmount required (raw units)' });

    try {
      // Validate seller wallet
      try { new PublicKey(sellerWallet); } catch {
        return reply.code(400).send({ error: 'Invalid sellerWallet address' });
      }

      // Look up token + pool in DB
      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (!dbToken) return reply.code(404).send({ error: 'Token not found' });
      if (dbToken.status !== 'graduated') {
        return reply.code(400).send({ error: 'Token has not graduated yet. Use /api/chain/build/sell instead.' });
      }

      const dbPool = stmts.getPool?.get(dbToken.id);
      if (!dbPool?.raydium_pool_address) {
        return reply.code(404).send({ error: 'Raydium pool address not found in DB' });
      }

      const creatorWallet = dbToken.creator_wallet;
      if (!creatorWallet) return reply.code(500).send({ error: 'Creator wallet not set on token' });

      const { getDeployer } = await import('../services/solana.js');
      const deployer = getDeployer();
      const treasuryWallet = deployer.publicKey.toBase58();

      const creatorFeeBps  = dbToken.creator_fee_bps  ?? 140;
      const platformFeeBps = dbToken.platform_fee_bps ?? 60;

      const result = await buildPostGradSellTransaction({
        sellerWallet,
        raydiumPoolAddress: dbPool.raydium_pool_address,
        mintAddress,
        tokenAmount,
        slippageBps,
        creatorWallet,
        treasuryWallet,
        creatorFeeBps,
        platformFeeBps,
      });

      return {
        transaction:      result.transaction,
        expectedSol:      result.expectedSol,
        grossSol:         result.grossSol,
        minWsolOut:       result.minWsolOut,
        fee:              result.fee,
        priceImpact:      result.priceImpact.toFixed(2) + '%',
        raydiumPool:      dbPool.raydium_pool_address,
        tokenName:        dbToken.token_name,
        tokenSymbol:      dbToken.token_symbol,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to build post-grad sell tx: ${err.message}` });
    }
  });

  /**
   * POST /api/chain/sync/trade/post-grad
   * Sync a post-graduation Raydium trade to DB after tx confirms.
   *
   * Body: { txSignature, mintAddress, traderWallet, side? }
   * Returns: { synced, txSignature }
   */
  fastify.post('/api/chain/sync/trade/post-grad', async (request, reply) => {
    const { txSignature, mintAddress, traderWallet, side } = request.body || {};

    if (!txSignature) return reply.code(400).send({ error: 'txSignature required' });
    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });

    try {
      const conn = getConnection();

      // Confirm or find existing tx
      const txCheck = await conn.getTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!txCheck) {
        try {
          const latestBlockhash = await conn.getLatestBlockhash();
          await conn.confirmTransaction({
            signature: txSignature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          }, 'confirmed');
        } catch {
          return reply.code(400).send({ error: 'Transaction not found on-chain', txSignature });
        }
      }

      const tx = await conn.getTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      const tokenId = dbToken?.id;

      if (!tokenId) {
        return reply.code(404).send({ error: 'Token not found in DB' });
      }

      // Read Raydium pool for current price
      const dbPool = stmts.getPool?.get(tokenId);
      let priceLamports = 0;
      if (dbPool?.raydium_pool_address) {
        try {
          const poolState = await getRaydiumPoolState(dbPool.raydium_pool_address);
          // Price = SOL reserve / token reserve (in raw units)
          const isToken0Wsol = poolState.token0Mint.equals(NATIVE_MINT);
          const solReserve   = isToken0Wsol ? poolState.token0Balance : poolState.token1Balance;
          const tokReserve   = isToken0Wsol ? poolState.token1Balance : poolState.token0Balance;
          if (tokReserve > 0n) {
            // price in lamports per raw token unit, scaled for human tokens (1e9 decimals)
            priceLamports = Number((solReserve * BigInt(1e9)) / tokReserve);
          }
        } catch (_) { /* price read failed, use 0 */ }
      }

      // Determine trade side from tx logs or body parameter
      let tradeSide = side || 'buy';
      if (!side && tx?.meta?.logMessages) {
        const logs = tx.meta.logMessages.join(' ').toLowerCase();
        if (logs.includes('sell') || logs.includes('swap_base_input')) {
          // For Raydium, we check token balance changes to determine side
          const preToken  = tx.meta.preTokenBalances?.find(b => b.owner === traderWallet && b.mint === mintAddress);
          const postToken = tx.meta.postTokenBalances?.find(b => b.owner === traderWallet && b.mint === mintAddress);
          const preAmt    = BigInt(preToken?.uiTokenAmount?.amount  || '0');
          const postAmt   = BigInt(postToken?.uiTokenAmount?.amount || '0');
          tradeSide = postAmt > preAmt ? 'buy' : 'sell';
        }
      }

      // Extract amounts from balance changes
      let solAmount   = '0';
      let tokenAmount = '0';
      if (tx?.meta) {
        const accountKeys = tx.transaction?.message?.staticAccountKeys
          || tx.transaction?.message?.accountKeys || [];
        const traderIdx = accountKeys.findIndex(k => k.toBase58() === (traderWallet || ''));
        if (traderIdx >= 0) {
          const pre  = tx.meta.preBalances?.[traderIdx]  || 0;
          const post = tx.meta.postBalances?.[traderIdx] || 0;
          solAmount  = Math.abs(post - pre).toString();
        }
        const preToken  = tx.meta.preTokenBalances?.find(b => b.owner === (traderWallet || '') && b.mint === mintAddress);
        const postToken = tx.meta.postTokenBalances?.find(b => b.owner === (traderWallet || '') && b.mint === mintAddress);
        const preAmt    = BigInt(preToken?.uiTokenAmount?.amount  || '0');
        const postAmt   = BigInt(postToken?.uiTokenAmount?.amount || '0');
        tokenAmount     = (postAmt > preAmt ? postAmt - preAmt : preAmt - postAmt).toString();
      }

      // Record trade in DB
      if (stmts.insertTokenTrade) {
        const tradeId = randomUUID();
        stmts.insertTokenTrade.run(
          tradeId, tokenId, traderWallet || '', tradeSide,
          tokenAmount, solAmount, priceLamports.toString(), txSignature
        );
      }

      // Insert price snapshot for charts
      if (priceLamports > 0 && stmts.insertTokenPrice) {
        const priceSol = priceLamports / LAMPORTS_PER_SOL;
        stmts.insertTokenPrice.run(tokenId, priceSol.toFixed(12), null, '0', '0', null);
      }

      // Emit WebSocket event
      const tradePayload = {
        type:         'trade',
        side:         tradeSide,
        wallet:       traderWallet || '',
        price:        (priceLamports / LAMPORTS_PER_SOL).toFixed(12),
        amount_token: tokenAmount,
        amount_sol:   solAmount,
        txSignature,
        symbol:       dbToken?.token_symbol || '',
        name:         dbToken?.token_name   || '',
        mintAddress,
        postGrad:     true,
        raydium:      true,
      };
      if (tokenId)    emitTrade(tokenId, tradePayload);
      if (mintAddress) emitTrade(mintAddress, tradePayload);

      return { synced: true, txSignature, side: tradeSide, solAmount, tokenAmount, priceLamports };
    } catch (err) {
      return reply.code(200).send({
        synced:    false,
        error:     err.message,
        txSignature,
        note: 'Trade confirmed on-chain but DB sync failed.',
      });
    }
  });

}
