/**
 * Raydium CPMM Service
 * Post-graduation trading via Raydium CPMM pools.
 *
 * Architecture:
 * - Pre-graduation: trades go through our on-chain bonding curve program
 * - Post-graduation: this service builds atomic txs that bundle fee transfers + Raydium swap
 *
 * Manual instruction building — no heavy SDK dependency.
 * Raydium CPMM: https://github.com/raydium-io/raydium-cpmm
 */

import { createHash } from 'crypto';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from '@solana/spl-token';
import { getConnection, getDeployer, LAMPORTS_PER_SOL } from './solana.js';

// ── Cluster + Program IDs ─────────────────────────────────────

const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';

/**
 * Raydium CPMM program IDs.
 * Mainnet: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 * Devnet:  DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb
 */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey(
  process.env.RAYDIUM_CPMM_PROGRAM_ID ||
    (CLUSTER === 'mainnet'
      ? 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
      : 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb')
);

/**
 * Raydium AMM config address (fee tier selection).
 * On mainnet, common configs:
 *   0.01% fee: D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2 (index 0)
 *   0.05% fee: FcUFWTVIRPWJmCMjpkknLzXXaFVKfxcSJPQ5DmKMHJzU (index 1)
 *   0.25% fee: CQYbhr6amxUER4p5SC44C63R4eLGPecf3jhMCBifeTNU (index 2)
 * Set RAYDIUM_AMM_CONFIG env var to override.
 */
export const RAYDIUM_AMM_CONFIG = new PublicKey(
  process.env.RAYDIUM_AMM_CONFIG ||
    (CLUSTER === 'mainnet'
      ? 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2'
      : 'CQYbhr6amxUER4p5SC44C63R4eLGPecf3jhMCBifeTNU') // devnet default
);

/**
 * Raydium pool creation fee receiver.
 * Set RAYDIUM_CREATE_POOL_FEE env var to override.
 */
export const RAYDIUM_CREATE_POOL_FEE = process.env.RAYDIUM_CREATE_POOL_FEE
  ? new PublicKey(process.env.RAYDIUM_CREATE_POOL_FEE)
  : null; // set at runtime for mainnet

// ── Discriminators ────────────────────────────────────────────

/** sha256("global:swap_base_input")[..8] */
const SWAP_BASE_INPUT_DISCRIMINATOR = createHash('sha256')
  .update('global:swap_base_input')
  .digest()
  .slice(0, 8);

/** sha256("global:initialize")[..8] */
const INITIALIZE_DISCRIMINATOR = createHash('sha256')
  .update('global:initialize')
  .digest()
  .slice(0, 8);

// ── Seeds ─────────────────────────────────────────────────────

const POOL_SEED         = Buffer.from('pool');
const POOL_LP_MINT_SEED = Buffer.from('pool_lp_mint');
const OBSERVATION_SEED  = Buffer.from('observation');
const POOL_VAULT_SEED   = Buffer.from('pool_vault');
const AUTH_SEED         = Buffer.from('vault_and_lp_mint_auth_seed');

// ── PDAs ─────────────────────────────────────────────────────

/** Raydium authority PDA (signs vault operations) */
export function getRaydiumAuthPDA() {
  return PublicKey.findProgramAddressSync([AUTH_SEED], RAYDIUM_CPMM_PROGRAM_ID);
}

/**
 * Deterministic pool state PDA.
 * Seeds: ["pool", ammConfig, token0Mint, token1Mint]
 * NOTE: token0 < token1 by address sort order (Raydium enforces this).
 */
export function getRaydiumPoolPDA(ammConfig, token0Mint, token1Mint) {
  const c = typeof ammConfig === 'string'  ? new PublicKey(ammConfig)  : ammConfig;
  const m0 = typeof token0Mint === 'string' ? new PublicKey(token0Mint) : token0Mint;
  const m1 = typeof token1Mint === 'string' ? new PublicKey(token1Mint) : token1Mint;
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, c.toBuffer(), m0.toBuffer(), m1.toBuffer()],
    RAYDIUM_CPMM_PROGRAM_ID
  );
}

/** LP mint PDA for a given pool state address */
export function getRaydiumLpMintPDA(poolStatePk) {
  const pk = typeof poolStatePk === 'string' ? new PublicKey(poolStatePk) : poolStatePk;
  return PublicKey.findProgramAddressSync([POOL_LP_MINT_SEED, pk.toBuffer()], RAYDIUM_CPMM_PROGRAM_ID);
}

/** Observation state PDA */
export function getRaydiumObservationPDA(poolStatePk) {
  const pk = typeof poolStatePk === 'string' ? new PublicKey(poolStatePk) : poolStatePk;
  return PublicKey.findProgramAddressSync([OBSERVATION_SEED, pk.toBuffer()], RAYDIUM_CPMM_PROGRAM_ID);
}

/** Token vault PDA for pool + mint */
export function getRaydiumVaultPDA(poolStatePk, tokenMint) {
  const pk = typeof poolStatePk === 'string' ? new PublicKey(poolStatePk) : poolStatePk;
  const m  = typeof tokenMint === 'string'   ? new PublicKey(tokenMint)   : tokenMint;
  return PublicKey.findProgramAddressSync([POOL_VAULT_SEED, pk.toBuffer(), m.toBuffer()], RAYDIUM_CPMM_PROGRAM_ID);
}

// ── Pool State Parsing ────────────────────────────────────────

/**
 * Parse Raydium CPMM PoolState from raw account buffer (borsh, no alignment padding).
 *
 * Struct layout (from raydium-cpmm program):
 *   [8]  discriminator
 *   [32] amm_config
 *   [32] pool_creator
 *   [32] token_0_vault
 *   [32] token_1_vault
 *   [32] lp_mint
 *   [32] token_0_mint
 *   [32] token_1_mint
 *   [32] token_0_program
 *   [32] token_1_program
 *   [32] observation_key
 *   [1]  auth_bump
 *   [1]  status
 *   [1]  lp_mint_decimals
 *   [1]  mint_0_decimals
 *   [1]  mint_1_decimals
 *   [8]  lp_supply (u64 LE)
 *   [8]  protocol_fees_token_0
 *   [8]  protocol_fees_token_1
 *   [8]  fund_fees_token_0
 *   [8]  fund_fees_token_1
 *   [8]  open_time
 *   [8]  recent_epoch
 *   [248] padding [u64; 31]
 */
export function parseRaydiumPoolState(data) {
  if (data.length < 340) {
    throw new Error(`Pool data too short: ${data.length} bytes (expected ≥340)`);
  }
  let offset = 8; // skip discriminator

  const readPubkey = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const readU8 = () => {
    const v = data[offset];
    offset += 1;
    return v;
  };

  return {
    ammConfig:          readPubkey(),
    poolCreator:        readPubkey(),
    token0Vault:        readPubkey(),
    token1Vault:        readPubkey(),
    lpMint:             readPubkey(),
    token0Mint:         readPubkey(),
    token1Mint:         readPubkey(),
    token0Program:      readPubkey(),
    token1Program:      readPubkey(),
    observationKey:     readPubkey(),
    authBump:           readU8(),
    status:             readU8(),
    lpMintDecimals:     readU8(),
    mint0Decimals:      readU8(),
    mint1Decimals:      readU8(),
    lpSupply:           readU64(),
    protocolFeesToken0: readU64(),
    protocolFeesToken1: readU64(),
    fundFeesToken0:     readU64(),
    fundFeesToken1:     readU64(),
    openTime:           readU64(),
  };
}

/**
 * Read Raydium CPMM pool state + live vault balances.
 *
 * @param {string|PublicKey} poolAddress
 * @returns {Promise<object>} pool state with token0Balance, token1Balance (BigInt)
 */
export async function getRaydiumPoolState(poolAddress) {
  const conn = getConnection();
  const poolPk = typeof poolAddress === 'string' ? new PublicKey(poolAddress) : poolAddress;

  const info = await conn.getAccountInfo(poolPk);
  if (!info) throw new Error(`Raydium pool not found: ${poolAddress}`);

  const state = parseRaydiumPoolState(info.data);

  // Fetch live vault balances for accurate quote
  const [v0, v1] = await Promise.all([
    conn.getTokenAccountBalance(state.token0Vault),
    conn.getTokenAccountBalance(state.token1Vault),
  ]);

  return {
    ...state,
    token0Balance:   BigInt(v0.value.amount),
    token1Balance:   BigInt(v1.value.amount),
    token0BalanceUi: v0.value.uiAmount ?? 0,
    token1BalanceUi: v1.value.uiAmount ?? 0,
  };
}

// ── Quote ─────────────────────────────────────────────────────

/**
 * Quote a Raydium CPMM swap using constant-product formula.
 * Approximates Raydium's protocol fee (~0.25%). Exact fee applied on-chain.
 *
 * @param {object}           poolState   - from getRaydiumPoolState()
 * @param {string|PublicKey} inputMint
 * @param {bigint}           inputAmount - raw units (lamports or token raw)
 * @returns {{ amountIn, amountOut, raydiumFee, priceImpact, isToken0Input }}
 */
export function quoteRaydiumSwap(poolState, inputMint, inputAmount) {
  const inputMintStr = inputMint.toString();
  const isToken0Input = inputMintStr === poolState.token0Mint.toString();

  const inputReserve  = isToken0Input ? poolState.token0Balance : poolState.token1Balance;
  const outputReserve = isToken0Input ? poolState.token1Balance : poolState.token0Balance;

  if (inputReserve === 0n || outputReserve === 0n) {
    throw new Error('Pool has no liquidity');
  }

  // Raydium CPMM applies a protocol fee set in amm_config (typically 0.25%)
  const RAYDIUM_FEE_BPS = 25n;
  const raydiumFee       = inputAmount * RAYDIUM_FEE_BPS / 10000n;
  const amountInAfterFee = inputAmount - raydiumFee;

  // amountOut = outputReserve * amountInAfterFee / (inputReserve + amountInAfterFee)
  const amountOut = (outputReserve * amountInAfterFee) / (inputReserve + amountInAfterFee);

  // Price impact ≈ what % of the pool's input reserve we're consuming
  const priceImpactBps = Number(amountInAfterFee * 10000n / inputReserve);
  const priceImpact = priceImpactBps / 100; // percentage

  return {
    amountIn: inputAmount,
    amountOut,
    raydiumFee,
    priceImpact,
    isToken0Input,
    inputReserve,
    outputReserve,
  };
}

// ── Instruction Builders ──────────────────────────────────────

/**
 * Build a Raydium CPMM `swap_base_input` instruction.
 * Data: discriminator(8) + amount_in(u64 LE) + minimum_amount_out(u64 LE)
 */
function buildSwapBaseInputInstruction({
  payer,
  authority,
  ammConfig,
  poolState,
  inputTokenAccount,
  outputTokenAccount,
  inputVault,
  outputVault,
  inputTokenProgram,
  outputTokenProgram,
  inputMint,
  outputMint,
  observationState,
  amountIn,
  minimumAmountOut,
}) {
  const data = Buffer.alloc(24);
  Buffer.from(SWAP_BASE_INPUT_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minimumAmountOut), 16);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer,              isSigner: true,  isWritable: true  },
      { pubkey: authority,          isSigner: false, isWritable: false },
      { pubkey: ammConfig,          isSigner: false, isWritable: false },
      { pubkey: poolState,          isSigner: false, isWritable: true  },
      { pubkey: inputTokenAccount,  isSigner: false, isWritable: true  },
      { pubkey: outputTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: inputVault,         isSigner: false, isWritable: true  },
      { pubkey: outputVault,        isSigner: false, isWritable: true  },
      { pubkey: inputTokenProgram,  isSigner: false, isWritable: false },
      { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: inputMint,          isSigner: false, isWritable: false },
      { pubkey: outputMint,         isSigner: false, isWritable: false },
      { pubkey: observationState,   isSigner: false, isWritable: true  },
    ],
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    data,
  });
}

/**
 * Build a Raydium CPMM `initialize` instruction (for pool creation at graduation).
 * Data: discriminator(8) + init_amount_0(u64) + init_amount_1(u64) + open_time(u64)
 */
function buildInitializeInstruction({
  creator,
  ammConfig,
  authority,
  poolState,
  token0Mint,
  token1Mint,
  lpMint,
  creatorToken0,
  creatorToken1,
  creatorLpToken,
  token0Vault,
  token1Vault,
  createPoolFee,
  observationState,
  initAmount0,
  initAmount1,
  openTime = 0n,
}) {
  const data = Buffer.alloc(32);
  Buffer.from(INITIALIZE_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(BigInt(initAmount0), 8);
  data.writeBigUInt64LE(BigInt(initAmount1), 16);
  data.writeBigUInt64LE(BigInt(openTime), 24);

  return new TransactionInstruction({
    keys: [
      { pubkey: creator,         isSigner: true,  isWritable: true  },
      { pubkey: ammConfig,       isSigner: false, isWritable: false },
      { pubkey: authority,       isSigner: false, isWritable: false },
      { pubkey: poolState,       isSigner: false, isWritable: true  },
      { pubkey: token0Mint,      isSigner: false, isWritable: false },
      { pubkey: token1Mint,      isSigner: false, isWritable: false },
      { pubkey: lpMint,          isSigner: false, isWritable: true  },
      { pubkey: creatorToken0,   isSigner: false, isWritable: true  },
      { pubkey: creatorToken1,   isSigner: false, isWritable: true  },
      { pubkey: creatorLpToken,  isSigner: false, isWritable: true  },
      { pubkey: token0Vault,     isSigner: false, isWritable: true  },
      { pubkey: token1Vault,     isSigner: false, isWritable: true  },
      { pubkey: createPoolFee,   isSigner: false, isWritable: true  },
      { pubkey: observationState,isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,isSigner: false, isWritable: false }, // token0Program
      { pubkey: TOKEN_PROGRAM_ID,isSigner: false, isWritable: false }, // token1Program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    data,
  });
}

// ── Buy Transaction ───────────────────────────────────────────

/**
 * Build a post-graduation BUY transaction for user wallet signing.
 *
 * Transaction flow (atomic):
 *   1. SOL transfer: buyer → creator wallet (creatorFeeBps %)
 *   2. SOL transfer: buyer → treasury wallet (platformFeeBps %)
 *   3. Create WSOL ATA if needed
 *   4. SOL transfer: buyer → WSOL ATA (net amount after fees = wrap)
 *   5. SyncNative (materialize WSOL balance)
 *   6. Create output token ATA if needed
 *   7. Raydium CPMM swap_base_input (WSOL → token)
 *   8. Close WSOL ATA (recover rent + any leftover)
 *
 * @param {object} params
 * @param {string} params.buyerWallet
 * @param {string} params.raydiumPoolAddress
 * @param {string} params.mintAddress          - the agent token mint
 * @param {number} params.solAmount            - SOL to spend (float, e.g. 0.1)
 * @param {number} [params.slippageBps=100]    - slippage tolerance in bps
 * @param {string} params.creatorWallet
 * @param {string} params.treasuryWallet
 * @param {number} [params.creatorFeeBps=140]  - 1.4%
 * @param {number} [params.platformFeeBps=60]  - 0.6%
 * @returns {Promise<{ transaction, expectedTokens, expectedTokensUi, fee, priceImpact, minOut }>}
 */
export async function buildPostGradBuyTransaction({
  buyerWallet,
  raydiumPoolAddress,
  mintAddress,
  solAmount,
  slippageBps = 100,
  creatorWallet,
  treasuryWallet,
  creatorFeeBps  = 140,
  platformFeeBps = 60,
}) {
  const conn = getConnection();
  const buyer      = new PublicKey(buyerWallet);
  const mint       = new PublicKey(mintAddress);
  const poolPk     = new PublicKey(raydiumPoolAddress);
  const creatorPk  = new PublicKey(creatorWallet);
  const treasuryPk = new PublicKey(treasuryWallet);

  // Read live pool state
  const pool = await getRaydiumPoolState(poolPk);
  const [authority] = getRaydiumAuthPDA();

  // Validate that one side of the pool is WSOL
  const isToken0Wsol = pool.token0Mint.equals(NATIVE_MINT);
  const isToken1Wsol = pool.token1Mint.equals(NATIVE_MINT);
  if (!isToken0Wsol && !isToken1Wsol) {
    throw new Error('Pool does not contain WSOL — cannot buy with native SOL');
  }

  // Fee + swap amount calculation (lamports, BigInt)
  const totalLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
  const creatorFee    = totalLamports * BigInt(creatorFeeBps) / 10000n;
  const platformFee   = totalLamports * BigInt(platformFeeBps) / 10000n;
  const swapLamports  = totalLamports - creatorFee - platformFee;

  // Quote (WSOL → token)
  const quote = quoteRaydiumSwap(pool, NATIVE_MINT, swapLamports);
  const minOut = quote.amountOut * BigInt(10000 - slippageBps) / 10000n;

  // Vault routing (which vault holds WSOL vs token)
  const wsolIsToken0 = isToken0Wsol;
  const inputVault   = wsolIsToken0 ? pool.token0Vault : pool.token1Vault;
  const outputVault  = wsolIsToken0 ? pool.token1Vault : pool.token0Vault;

  // ATAs
  const buyerWsolATA  = await getAssociatedTokenAddress(NATIVE_MINT, buyer);
  const buyerTokenATA = await getAssociatedTokenAddress(mint, buyer);

  // Build transaction
  const tx = new Transaction();
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = buyer;

  // 1 & 2. Fee transfers (SOL, before wrapping)
  if (creatorFee > 0n) {
    tx.add(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: creatorPk, lamports: creatorFee }));
  }
  if (platformFee > 0n) {
    tx.add(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: treasuryPk, lamports: platformFee }));
  }

  // 3. Create WSOL ATA if buyer doesn't have one
  let wsolExists = false;
  try { await getAccount(conn, buyerWsolATA); wsolExists = true; } catch (_) { /* no ATA */ }
  if (!wsolExists) {
    tx.add(createAssociatedTokenAccountInstruction(buyer, buyerWsolATA, buyer, NATIVE_MINT));
  }

  // 4. Transfer net SOL → WSOL ATA (wraps it)
  tx.add(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: buyerWsolATA, lamports: swapLamports }));

  // 5. SyncNative — required so the token program sees the updated WSOL balance
  tx.add(createSyncNativeInstruction(buyerWsolATA));

  // 6. Create output token ATA if needed
  let tokenAtaExists = false;
  try { await getAccount(conn, buyerTokenATA); tokenAtaExists = true; } catch (_) { /* no ATA */ }
  if (!tokenAtaExists) {
    tx.add(createAssociatedTokenAccountInstruction(buyer, buyerTokenATA, buyer, mint));
  }

  // 7. Raydium swap: WSOL → token
  tx.add(buildSwapBaseInputInstruction({
    payer:              buyer,
    authority,
    ammConfig:          pool.ammConfig,
    poolState:          poolPk,
    inputTokenAccount:  buyerWsolATA,
    outputTokenAccount: buyerTokenATA,
    inputVault,
    outputVault,
    inputTokenProgram:  TOKEN_PROGRAM_ID, // WSOL uses SPL Token
    outputTokenProgram: TOKEN_PROGRAM_ID, // our tokens use SPL Token
    inputMint:          NATIVE_MINT,
    outputMint:         mint,
    observationState:   pool.observationKey,
    amountIn:           swapLamports,
    minimumAmountOut:   minOut,
  }));

  // 8. Close WSOL ATA → recover rent + any dust
  tx.add(createCloseAccountInstruction(buyerWsolATA, buyer, buyer));

  return {
    transaction:       Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64'),
    expectedTokens:    quote.amountOut.toString(),
    expectedTokensUi:  Number(quote.amountOut) / 1e9,
    minOut:            minOut.toString(),
    fee: {
      creator:  Number(creatorFee)  / LAMPORTS_PER_SOL,
      platform: Number(platformFee) / LAMPORTS_PER_SOL,
      total:    Number(creatorFee + platformFee) / LAMPORTS_PER_SOL,
    },
    priceImpact: quote.priceImpact,
    swapLamports: swapLamports.toString(),
  };
}

// ── Sell Transaction ──────────────────────────────────────────

/**
 * Build a post-graduation SELL transaction for user wallet signing.
 *
 * Transaction flow (atomic):
 *   1. Create WSOL ATA for seller if needed (receives swap output)
 *   2. Raydium CPMM swap_base_input (token → WSOL)
 *   3. Close WSOL ATA → SOL lands in seller's wallet
 *   4. SOL transfer: seller → creator wallet (creatorFeeBps % of estimated output)
 *   5. SOL transfer: seller → treasury wallet (platformFeeBps % of estimated output)
 *
 * Note: Fee amounts are estimated from the quote. On-chain they're taken from the
 * seller's native SOL balance after step 3. Slippage protects the minimum received.
 *
 * @param {object} params
 * @param {string} params.sellerWallet
 * @param {string} params.raydiumPoolAddress
 * @param {string} params.mintAddress
 * @param {string|bigint} params.tokenAmount  - raw token units
 * @param {number} [params.slippageBps=100]
 * @param {string} params.creatorWallet
 * @param {string} params.treasuryWallet
 * @param {number} [params.creatorFeeBps=140]
 * @param {number} [params.platformFeeBps=60]
 * @returns {Promise<{ transaction, expectedSol, grossSol, fee, priceImpact }>}
 */
export async function buildPostGradSellTransaction({
  sellerWallet,
  raydiumPoolAddress,
  mintAddress,
  tokenAmount,
  slippageBps = 100,
  creatorWallet,
  treasuryWallet,
  creatorFeeBps  = 140,
  platformFeeBps = 60,
}) {
  const conn = getConnection();
  const seller     = new PublicKey(sellerWallet);
  const mint       = new PublicKey(mintAddress);
  const poolPk     = new PublicKey(raydiumPoolAddress);
  const creatorPk  = new PublicKey(creatorWallet);
  const treasuryPk = new PublicKey(treasuryWallet);

  const rawAmount = BigInt(tokenAmount.toString());

  // Read live pool state
  const pool = await getRaydiumPoolState(poolPk);
  const [authority] = getRaydiumAuthPDA();

  // Validate pool has WSOL
  const isToken0Wsol = pool.token0Mint.equals(NATIVE_MINT);
  const isToken1Wsol = pool.token1Mint.equals(NATIVE_MINT);
  if (!isToken0Wsol && !isToken1Wsol) {
    throw new Error('Pool does not contain WSOL — cannot receive native SOL from sell');
  }

  // Vault routing (token → WSOL)
  const wsolIsToken0 = isToken0Wsol;
  const inputVault   = wsolIsToken0 ? pool.token1Vault : pool.token0Vault;
  const outputVault  = wsolIsToken0 ? pool.token0Vault : pool.token1Vault;

  // Quote (token → WSOL)
  const quote = quoteRaydiumSwap(pool, mint, rawAmount);
  const expectedSolLamports = quote.amountOut;

  // Fee calculations on expected SOL output
  const creatorFee  = expectedSolLamports * BigInt(creatorFeeBps)  / 10000n;
  const platformFee = expectedSolLamports * BigInt(platformFeeBps) / 10000n;
  const totalFees   = creatorFee + platformFee;

  // minAmountOut for the Raydium swap (total WSOL out, slippage-protected)
  // The fees come out of this after unwrapping, so protect the gross amount
  const minWsolOut = expectedSolLamports * BigInt(10000 - slippageBps) / 10000n;

  // ATAs
  const sellerTokenATA = await getAssociatedTokenAddress(mint, seller);
  const sellerWsolATA  = await getAssociatedTokenAddress(NATIVE_MINT, seller);

  // Build transaction
  const tx = new Transaction();
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = seller;

  // 1. Create WSOL ATA if seller doesn't have one
  let wsolExists = false;
  try { await getAccount(conn, sellerWsolATA); wsolExists = true; } catch (_) { /* no ATA */ }
  if (!wsolExists) {
    tx.add(createAssociatedTokenAccountInstruction(seller, sellerWsolATA, seller, NATIVE_MINT));
  }

  // 2. Raydium swap: token → WSOL
  tx.add(buildSwapBaseInputInstruction({
    payer:              seller,
    authority,
    ammConfig:          pool.ammConfig,
    poolState:          poolPk,
    inputTokenAccount:  sellerTokenATA,
    outputTokenAccount: sellerWsolATA,
    inputVault,
    outputVault,
    inputTokenProgram:  TOKEN_PROGRAM_ID,
    outputTokenProgram: TOKEN_PROGRAM_ID,
    inputMint:          mint,
    outputMint:         NATIVE_MINT,
    observationState:   pool.observationKey,
    amountIn:           rawAmount,
    minimumAmountOut:   minWsolOut,
  }));

  // 3. Close WSOL ATA → SOL lands in seller's wallet
  tx.add(createCloseAccountInstruction(sellerWsolATA, seller, seller));

  // 4 & 5. Fee transfers from seller's (now enriched) SOL balance
  if (creatorFee > 0n) {
    tx.add(SystemProgram.transfer({ fromPubkey: seller, toPubkey: creatorPk, lamports: creatorFee }));
  }
  if (platformFee > 0n) {
    tx.add(SystemProgram.transfer({ fromPubkey: seller, toPubkey: treasuryPk, lamports: platformFee }));
  }

  const netSolLamports = expectedSolLamports - totalFees;

  return {
    transaction:         Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64'),
    expectedSol:         Number(netSolLamports)         / LAMPORTS_PER_SOL,
    expectedSolLamports: netSolLamports.toString(),
    grossSol:            Number(expectedSolLamports)     / LAMPORTS_PER_SOL,
    grossSolLamports:    expectedSolLamports.toString(),
    minWsolOut:          minWsolOut.toString(),
    fee: {
      creator:  Number(creatorFee)  / LAMPORTS_PER_SOL,
      platform: Number(platformFee) / LAMPORTS_PER_SOL,
      total:    Number(totalFees)   / LAMPORTS_PER_SOL,
    },
    priceImpact: quote.priceImpact,
  };
}

// ── Raydium Pool Creation (for graduation) ────────────────────

/**
 * Create a Raydium CPMM pool with initial SOL + token liquidity.
 * Called server-side by the graduate/trigger endpoint using the deployer key.
 *
 * The pool is created with:
 *   token0 = whichever of (WSOL, tokenMint) sorts lower by address
 *   token1 = the other one
 *
 * Price continuity formula:
 *   tokensForRaydium = solForRaydium / bondingCurvePriceAtGraduation
 *
 * @param {object} params
 * @param {string} params.mintAddress          - the agent token mint
 * @param {bigint} params.solLamports          - SOL to seed the pool (e.g. 85 SOL = 85e9)
 * @param {bigint} params.tokenAmount          - raw token units to seed
 * @param {PublicKey} [params.ammConfig]       - override amm_config PDA
 * @param {PublicKey} [params.createPoolFee]   - override fee receiver
 * @returns {Promise<{ tx, poolAddress, token0Mint, token1Mint, lpMint }>}
 */
export async function createRaydiumPool({
  mintAddress,
  solLamports,
  tokenAmount,
  ammConfig    = RAYDIUM_AMM_CONFIG,
  createPoolFee = RAYDIUM_CREATE_POOL_FEE,
}) {
  if (!createPoolFee) {
    throw new Error(
      'RAYDIUM_CREATE_POOL_FEE not configured. Set env var RAYDIUM_CREATE_POOL_FEE to the Raydium fee receiver address.'
    );
  }

  const conn = getConnection();
  const deployer = getDeployer();
  const mint = new PublicKey(mintAddress);

  // Raydium requires token0 < token1 by address (lexicographic sort)
  // Compare WSOL and the token mint
  const wsolStr  = NATIVE_MINT.toBase58();
  const tokenStr = mint.toBase58();
  const wsolIsToken0 = wsolStr < tokenStr;

  const token0Mint = wsolIsToken0 ? NATIVE_MINT : mint;
  const token1Mint = wsolIsToken0 ? mint : NATIVE_MINT;
  const amount0    = wsolIsToken0 ? solLamports  : tokenAmount;
  const amount1    = wsolIsToken0 ? tokenAmount  : solLamports;

  // Derive PDAs
  const [poolState]        = getRaydiumPoolPDA(ammConfig, token0Mint, token1Mint);
  const [lpMint]           = getRaydiumLpMintPDA(poolState);
  const [observationState] = getRaydiumObservationPDA(poolState);
  const [token0Vault]      = getRaydiumVaultPDA(poolState, token0Mint);
  const [token1Vault]      = getRaydiumVaultPDA(poolState, token1Mint);
  const [authority]        = getRaydiumAuthPDA();

  // Deployer's token accounts
  const deployerToken0ATA = await getAssociatedTokenAddress(token0Mint, deployer.publicKey);
  const deployerToken1ATA = await getAssociatedTokenAddress(token1Mint, deployer.publicKey);
  const deployerLpATA     = await getAssociatedTokenAddress(lpMint, deployer.publicKey);

  const tx = new Transaction();
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = deployer.publicKey;

  // Create deployer's LP token ATA if needed
  let lpAtaExists = false;
  try { await getAccount(conn, deployerLpATA); lpAtaExists = true; } catch (_) { /* no ATA */ }
  if (!lpAtaExists) {
    tx.add(createAssociatedTokenAccountInstruction(deployer.publicKey, deployerLpATA, deployer.publicKey, lpMint));
  }

  // For WSOL side: we need to wrap SOL first
  const wsolATA = wsolIsToken0 ? deployerToken0ATA : deployerToken1ATA;
  let wsolAtaExists = false;
  try { await getAccount(conn, wsolATA); wsolAtaExists = true; } catch (_) { /* no ATA */ }
  if (!wsolAtaExists) {
    tx.add(createAssociatedTokenAccountInstruction(deployer.publicKey, wsolATA, deployer.publicKey, NATIVE_MINT));
  }
  tx.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wsolATA, lamports: solLamports }));
  tx.add(createSyncNativeInstruction(wsolATA));

  // Initialize pool
  tx.add(buildInitializeInstruction({
    creator:         deployer.publicKey,
    ammConfig,
    authority,
    poolState,
    token0Mint,
    token1Mint,
    lpMint,
    creatorToken0:   deployerToken0ATA,
    creatorToken1:   deployerToken1ATA,
    creatorLpToken:  deployerLpATA,
    token0Vault,
    token1Vault,
    createPoolFee,
    observationState,
    initAmount0:     amount0,
    initAmount1:     amount1,
    openTime:        0n,
  }));

  tx.sign(deployer);
  const txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(txSig, 'confirmed');

  return {
    tx: txSig,
    poolAddress:  poolState.toBase58(),
    token0Mint:   token0Mint.toBase58(),
    token1Mint:   token1Mint.toBase58(),
    lpMint:       lpMint.toBase58(),
    token0Vault:  token0Vault.toBase58(),
    token1Vault:  token1Vault.toBase58(),
    observationState: observationState.toBase58(),
  };
}
