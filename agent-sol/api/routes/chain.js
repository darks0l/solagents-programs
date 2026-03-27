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
  initializeBondingCurve,
  getCurveConfigPDA,
  getCurvePoolPDA,
  getSolVaultPDA,
  getTokenVaultPDA,
  getTransactionEvents,
  poolAccountToDb,
  LAMPORTS_PER_SOL,
  BONDING_CURVE_PROGRAM_ID,
} from '../services/solana.js';
import { stmts } from '../services/db.js';
import { emitTrade } from '../services/ws-feed.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token';

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
        total_volume_sol: ((pool.totalVolumeSol?.toNumber() || 0) / LAMPORTS_PER_SOL).toFixed(9),
        total_trades: pool.totalTrades?.toNumber() || 0,
        total_buys: pool.totalBuys?.toNumber() || 0,
        total_sells: pool.totalSells?.toNumber() || 0,
        status: pool.graduated ? 'graduated' : 'active',
        graduated_at: pool.graduatedAt?.toNumber() || 0,
        market_cap_sol: (vTokenBig > 0n
          ? (Number(BigInt(pool.realSolBalance.toString())) / LAMPORTS_PER_SOL + 30) * (Number(BigInt(pool.totalSupply.toString()) / BigInt(1e9)) / (vToken / 1e9))
          : 0).toFixed(4),
        graduation_progress: pool.realSolBalance
          ? ((Number(BigInt(pool.realSolBalance.toString())) / 85_000_000_000) * 100).toFixed(2) + '%'
          : '0%',
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
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain' });

      const dbToken = stmts.getAgentTokenByMint?.get(mintAddress);
      if (!dbToken) return reply.code(404).send({ error: 'Token not in DB' });

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
            real_sol: (pool.realSolBalance.toNumber() / LAMPORTS_PER_SOL).toFixed(9),
            total_trades: pool.totalTrades?.toNumber() || 0,
            status: pool.graduated ? 'graduated' : 'active',
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
      const solAmountLamports = Math.round(solAmount * LAMPORTS_PER_SOL);

      // Read current pool state to calculate expected output + slippage
      const pool = await readPool(mintAddress);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain. Token may not be created yet.' });

      // Calculate expected tokens out using constant product formula (BigInt for overflow safety)
      const vSol = BigInt(pool.virtualSolReserve.toString());
      const vToken = BigInt(pool.virtualTokenReserve.toString());
      const solLamBig = BigInt(solAmountLamports);
      const fee = solLamBig * 200n / 10000n; // 2% fee
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

      const transaction = await buildBuyTransaction({
        buyerPublicKey: buyerWallet,
        mintAddress,
        solAmountLamports,
        minTokensOut,
        createATA: needsATA,
      });

      return {
        transaction,
        expectedTokens: tokensOut,
        expectedTokensFormatted: (tokensOut / 1e9).toFixed(2),
        minTokensOut,
        fee: Number(fee) / LAMPORTS_PER_SOL,
        priceImpact: (Number(solAfterFee * 10000n / (vSol + solAfterFee)) / 100).toFixed(2) + '%',
      };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to build buy tx: ${err.message}` });
    }
  });

  // Build sell transaction
  fastify.post('/api/chain/build/sell', async (request, reply) => {
    const { mintAddress, sellerWallet, tokenAmount, slippageBps = 100 } = request.body || {};

    if (!mintAddress) return reply.code(400).send({ error: 'mintAddress required' });
    if (!sellerWallet) return reply.code(400).send({ error: 'sellerWallet required' });
    if (!tokenAmount) return reply.code(400).send({ error: 'tokenAmount required (raw units)' });

    try {
      const pool = await readPool(mintAddress);
      if (!pool) return reply.code(404).send({ error: 'Pool not found on-chain' });

      const vSol = BigInt(pool.virtualSolReserve.toString());
      const vToken = BigInt(pool.virtualTokenReserve.toString());
      const rawTokens = BigInt(tokenAmount);
      const solOut = Number((vSol * rawTokens) / (vToken + rawTokens));
      const fee = Math.floor(solOut * 200 / 10000);
      const solAfterFee = solOut - fee;

      const minSolOut = Math.floor(solAfterFee * (10000 - slippageBps) / 10000);

      const transaction = await buildSellTransaction({
        sellerPublicKey: sellerWallet,
        mintAddress,
        tokenAmount: tokenAmount.toString(),
        minSolOut,
      });

      return {
        transaction,
        expectedSol: solAfterFee / LAMPORTS_PER_SOL,
        minSolOut: minSolOut / LAMPORTS_PER_SOL,
        fee: fee / LAMPORTS_PER_SOL,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to build sell tx: ${err.message}` });
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

      // Record trade in DB
      if (tokenId && stmts.insertTokenTrade) {
        const isBuy = tx?.meta?.logMessages?.some(l => l.includes('buy') || l.includes('Buy')) ?? true;
        const tradeId = randomUUID();

        // Extract SOL difference from pre/post balances for the trader
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

      return {
        synced: true,
        txSignature,
        poolState: {
          virtualSolReserve: pool.virtualSolReserve.toString(),
          virtualTokenReserve: pool.virtualTokenReserve.toString(),
          realSolBalance: pool.realSolBalance.toString(),
          totalTrades: pool.totalTrades?.toNumber() || 0,
        },
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
        stmts.insertAgentToken.run(
          tokenId, agentId, name || 'Agent Token', symbol || 'TOKEN',
          mint, null, pool.totalSupply.toString(),
          creatorWallet || pool.creator.toBase58(),
          140, 60, null, null, null, null,
          1, 'active', txSignature
        );

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

  // Admin: update token mint address in DB
  fastify.post('/api/chain/admin/update-token-mint', async (request, reply) => {
    const { tokenId, mintAddress, poolAddress, launchTx } = request.body || {};
    if (!tokenId || !mintAddress) return reply.code(400).send({ error: 'tokenId and mintAddress required' });
    try {
      stmts.updateAgentTokenStatus.run('active', mintAddress, poolAddress || null, launchTx || null, tokenId);
      return { updated: true, tokenId, mintAddress };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ADMIN — one-time setup operations
  // ═══════════════════════════════════════════════════════════

  // Initialize bonding curve config on-chain (admin only, requires deployer key)
  fastify.post('/api/chain/admin/initialize', async (request, reply) => {
    try {
      // Check if already initialized
      const existing = await readCurveConfig();
      if (existing) {
        return { status: 'already_initialized', config: {
          admin: existing.admin.toBase58(),
          treasury: existing.treasury.toBase58(),
          creatorFeeBps: existing.creatorFeeBps,
          platformFeeBps: existing.platformFeeBps,
        }};
      }

      const result = await initializeBondingCurve(request.body || {});
      return {
        status: 'initialized',
        tx: result.tx,
        configPDA: result.configPDA,
        explorer: `https://explorer.solana.com/tx/${result.tx}?cluster=devnet`,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Initialize failed: ${err.message}` });
    }
  });

  // Admin: wipe stale test data and resync token from on-chain state
  fastify.post('/api/chain/admin/reset-token', async (request, reply) => {
    const { tokenId } = request.body || {};
    if (!tokenId) return reply.code(400).send({ error: 'tokenId required' });

    try {
      // Get token info
      const token = stmts.getAgentToken?.get(tokenId);
      if (!token) return reply.code(404).send({ error: 'Token not found' });

      // Delete all stale trades for this token (direct SQL via stmts pattern)
      stmts.deleteTokenTrades?.run(tokenId);
      stmts.deleteDevBuys?.run(tokenId);

      // Read on-chain pool state if mint exists
      let chainState = null;
      if (token.mint_address && token.mint_address !== 'TestMint111111111111111111111111111111111111') {
        const pool = await readPool(token.mint_address);
        if (pool) {
          chainState = pool;
          // Update token with on-chain price
          const vSol = Number(pool.virtualSolReserve);
          const vToken = Number(pool.virtualTokenReserve);
          const price = vToken > 0 ? (vSol / vToken).toFixed(12) : '0';
          const volume = Number(pool.totalVolumeSol || 0);
          const totalTrades = Number(pool.totalBuys || 0) + Number(pool.totalSells || 0);

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
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Get deployer wallet info (for admin verification)
  fastify.get('/api/chain/admin/wallet', async (request, reply) => {
    try {
      const { getDeployer } = await import('../services/solana.js');
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
}
