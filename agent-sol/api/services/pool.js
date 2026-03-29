/**
 * Bonding Curve Pool Service
 * Constant product (x * y = k) virtual AMM for agent tokens
 *
 * All agent tokens launch with:
 * - 1,000,000,000 (1B) total supply (9 decimals = 1e18 raw units)
 * - 30 SOL virtual reserve (sets initial price)
 * - 100% of supply in pool (no pre-mine, no reserves)
 * - Optional dev buy at same curve price as everyone
 *
 * Price formula: price = virtual_sol_reserve / virtual_token_reserve
 * Trade formula: constant product x * y = k
 */

// === Constants ===
const LAMPORTS_PER_SOL = 1_000_000_000n;
const TOKEN_DECIMALS = 9;
const TOKEN_MULTIPLIER = 10n ** BigInt(TOKEN_DECIMALS);

// Launch parameters
export const POOL_CONFIG = {
  TOTAL_SUPPLY: 1_000_000_000n * TOKEN_MULTIPLIER,          // 1B tokens (with 9 decimals)
  VIRTUAL_SOL_RESERVE: 30n * LAMPORTS_PER_SOL,              // 30 SOL virtual reserve
  FEE_BPS: 200,                                              // 2% total fee
  CREATOR_FEE_SHARE: 70,                                     // 70% of fee to creator
  PLATFORM_FEE_SHARE: 30,                                    // 30% of fee to platform
};

// Graduation threshold: 85 SOL (net SOL = real_sol - unclaimed fees)
POOL_CONFIG.GRADUATION_THRESHOLD = 85n * LAMPORTS_PER_SOL;

// Derive initial price: 30 SOL / 1B tokens = 0.00000003 SOL per token
// Initial FDV: 30 SOL (~$4,500)
POOL_CONFIG.INITIAL_PRICE_LAMPORTS = (POOL_CONFIG.VIRTUAL_SOL_RESERVE * TOKEN_MULTIPLIER) / POOL_CONFIG.TOTAL_SUPPLY;
POOL_CONFIG.K = POOL_CONFIG.VIRTUAL_SOL_RESERVE * POOL_CONFIG.TOTAL_SUPPLY;

/**
 * Create initial pool state for a new token
 */
export function createPool(tokenId) {
  const { TOTAL_SUPPLY, VIRTUAL_SOL_RESERVE, K, INITIAL_PRICE_LAMPORTS } = POOL_CONFIG;

  return {
    token_id: tokenId,
    virtual_sol_reserve: VIRTUAL_SOL_RESERVE.toString(),
    virtual_token_reserve: TOTAL_SUPPLY.toString(),
    real_sol_reserve: '0',
    real_token_reserve: TOTAL_SUPPLY.toString(),
    k: K.toString(),
    total_supply: TOTAL_SUPPLY.toString(),
    circulating_supply: '0',
    current_price_lamports: INITIAL_PRICE_LAMPORTS.toString(),
  };
}

/**
 * Calculate tokens received for a given SOL input (buy)
 * Uses constant product: (sol + ds) * (tok - dt) = k
 * dt = tok - k / (sol + ds)
 *
 * Fee is taken from the SOL input before the swap
 */
export function calculateBuy(pool, solAmountLamports) {
  const solIn = BigInt(solAmountLamports);
  if (solIn <= 0n) throw new Error('SOL amount must be positive');

  // Take fee from input
  const feeAmount = (solIn * BigInt(POOL_CONFIG.FEE_BPS)) / 10000n;
  const solAfterFee = solIn - feeAmount;

  const solReserve = BigInt(pool.virtual_sol_reserve);
  const tokenReserve = BigInt(pool.virtual_token_reserve);
  const k = BigInt(pool.k);

  // New sol reserve after adding input
  const newSolReserve = solReserve + solAfterFee;

  // Calculate tokens out: dt = tokenReserve - k / newSolReserve
  const newTokenReserve = k / newSolReserve;
  const tokensOut = tokenReserve - newTokenReserve;

  if (tokensOut <= 0n) throw new Error('Trade too small');
  if (tokensOut > BigInt(pool.real_token_reserve)) throw new Error('Insufficient liquidity');

  // New price after trade
  const priceAfter = (newSolReserve * TOKEN_MULTIPLIER) / newTokenReserve;

  // Fee split
  const creatorFee = (feeAmount * BigInt(POOL_CONFIG.CREATOR_FEE_SHARE)) / 100n;
  const platformFee = feeAmount - creatorFee;

  return {
    tokensOut: tokensOut.toString(),
    solIn: solIn.toString(),
    solAfterFee: solAfterFee.toString(),
    feeTotal: feeAmount.toString(),
    creatorFee: creatorFee.toString(),
    platformFee: platformFee.toString(),
    pricePerToken: priceAfter.toString(),
    newPool: {
      virtual_sol_reserve: newSolReserve.toString(),
      virtual_token_reserve: newTokenReserve.toString(),
      real_sol_reserve: (BigInt(pool.real_sol_reserve) + solAfterFee).toString(),
      real_token_reserve: (BigInt(pool.real_token_reserve) - tokensOut).toString(),
      circulating_supply: (BigInt(pool.circulating_supply) + tokensOut).toString(),
      current_price_lamports: priceAfter.toString(),
    },
  };
}

/**
 * Calculate SOL received for a given token input (sell)
 * Uses constant product: (sol - ds) * (tok + dt) = k
 * ds = sol - k / (tok + dt)
 *
 * Fee is taken from the SOL output
 */
export function calculateSell(pool, tokenAmount) {
  const tokensIn = BigInt(tokenAmount);
  if (tokensIn <= 0n) throw new Error('Token amount must be positive');

  const solReserve = BigInt(pool.virtual_sol_reserve);
  const tokenReserve = BigInt(pool.virtual_token_reserve);
  const k = BigInt(pool.k);

  // New token reserve after adding input
  const newTokenReserve = tokenReserve + tokensIn;

  // Calculate SOL out: ds = solReserve - k / newTokenReserve
  const newSolReserve = k / newTokenReserve;
  const solOut = solReserve - newSolReserve;

  if (solOut <= 0n) throw new Error('Trade too small');
  if (solOut > BigInt(pool.real_sol_reserve)) throw new Error('Insufficient SOL liquidity');

  // Take fee from output
  const feeAmount = (solOut * BigInt(POOL_CONFIG.FEE_BPS)) / 10000n;
  const solAfterFee = solOut - feeAmount;

  // New price after trade
  const priceAfter = (newSolReserve * TOKEN_MULTIPLIER) / newTokenReserve;

  // Fee split
  const creatorFee = (feeAmount * BigInt(POOL_CONFIG.CREATOR_FEE_SHARE)) / 100n;
  const platformFee = feeAmount - creatorFee;

  return {
    solOut: solAfterFee.toString(),
    solBeforeFee: solOut.toString(),
    tokensIn: tokensIn.toString(),
    feeTotal: feeAmount.toString(),
    creatorFee: creatorFee.toString(),
    platformFee: platformFee.toString(),
    pricePerToken: priceAfter.toString(),
    newPool: {
      virtual_sol_reserve: newSolReserve.toString(),
      virtual_token_reserve: newTokenReserve.toString(),
      real_sol_reserve: (BigInt(pool.real_sol_reserve) - solOut + feeAmount).toString(),
      real_token_reserve: (BigInt(pool.real_token_reserve) + tokensIn).toString(),
      circulating_supply: (BigInt(pool.circulating_supply) - tokensIn).toString(),
      current_price_lamports: priceAfter.toString(),
    },
  };
}

/**
 * Get a price quote without executing (read-only)
 */
export function getQuote(pool, side, amount) {
  if (side === 'buy') return calculateBuy(pool, amount);
  if (side === 'sell') return calculateSell(pool, amount);
  throw new Error('side must be buy or sell');
}

/**
 * Format lamports to SOL string
 */
export function lamportsToSol(lamports) {
  const l = BigInt(lamports);
  const sol = Number(l) / Number(LAMPORTS_PER_SOL);
  return sol.toFixed(9);
}

/**
 * Format raw token amount to human-readable
 */
export function rawToTokens(raw) {
  const r = BigInt(raw);
  const tokens = Number(r) / Number(TOKEN_MULTIPLIER);
  return tokens.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Check if pool has reached graduation threshold
 * net_sol = real_sol - (creator_fees_earned - creator_fees_claimed) - (platform_fees_earned - platform_fees_claimed)
 */
export function checkGraduation(pool) {
  const realSol = BigInt(pool.real_sol_reserve);
  const creatorUnclaimed = BigInt(pool.creator_fees_earned || '0') - BigInt(pool.creator_fees_claimed || '0');
  const platformUnclaimed = BigInt(pool.platform_fees_earned || '0') - BigInt(pool.platform_fees_claimed || '0');
  const netSol = realSol - creatorUnclaimed - platformUnclaimed;
  return {
    netSol,
    threshold: POOL_CONFIG.GRADUATION_THRESHOLD,
    ready: netSol >= POOL_CONFIG.GRADUATION_THRESHOLD,
    progress: Number(netSol * 10000n / POOL_CONFIG.GRADUATION_THRESHOLD) / 100, // percentage
  };
}

/**
 * Get pool stats for display
 */
export function getPoolStats(pool) {
  const virtualSol = BigInt(pool.virtual_sol_reserve);
  const virtualToken = BigInt(pool.virtual_token_reserve);
  const realSol = BigInt(pool.real_sol_reserve);
  const totalSupply = BigInt(pool.total_supply);
  const circulating = BigInt(pool.circulating_supply);

  const pricePerToken = Number(virtualSol) / Number(virtualToken);
  const marketCap = pricePerToken * Number(totalSupply) / Number(TOKEN_MULTIPLIER);
  const fdv = Number(marketCap) / Number(LAMPORTS_PER_SOL);

  const graduation = checkGraduation(pool);

  return {
    price_sol: lamportsToSol(pool.current_price_lamports),
    price_lamports: pool.current_price_lamports,
    market_cap_sol: fdv.toFixed(4),
    total_supply: rawToTokens(pool.total_supply),
    circulating: rawToTokens(pool.circulating_supply),
    pool_sol: lamportsToSol(pool.real_sol_reserve),
    liquidity_locked: pool.status !== 'graduated',
    status: pool.status || 'active',
    graduation: {
      progress: graduation.progress,
      threshold_sol: lamportsToSol(POOL_CONFIG.GRADUATION_THRESHOLD.toString()),
      ready: graduation.ready,
    },
    total_volume_sol: lamportsToSol(pool.total_volume_sol || '0'),
    total_trades: pool.total_trades || 0,
    // Raydium post-graduation fee tracking (only populated after graduation)
    ...(pool.status === 'graduated' ? {
      raydium: {
        pool_address: pool.raydium_pool_address || null,
        lp_locked: true,
        fees_claimed_token_0: pool.raydium_fees_claimed_token_0 || '0',
        fees_claimed_token_1: pool.raydium_fees_claimed_token_1 || '0',
        graduated_at: pool.graduated_at || null,
        graduation_tx: pool.graduation_tx || null,
      }
    } : {}),
  };
}
