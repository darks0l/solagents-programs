/**
 * Solana Program Client
 * Wires backend to the on-chain bonding_curve + agentic_commerce programs.
 *
 * Architecture:
 * - Server-side: admin ops (initialize, update_config, platform fee claims)
 * - Client-side: user ops (buy, sell, create_token, claim_creator_fees)
 *   → Server builds instruction + returns serialized tx for user wallet to sign
 *
 * This file handles:
 * 1. RPC connection management
 * 2. Program IDL loading + AnchorProvider setup
 * 3. Transaction building (instructions only, no signing for user ops)
 * 4. On-chain state reading (pool, config, job accounts)
 * 5. Event parsing from transaction logs
 */

import { Connection, PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN, web3 } = anchor;
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── RPC Configuration ───────────────────────────────────────
const RPC_URLS = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
  localnet: 'http://localhost:8899',
};

const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';
const RPC_URL = process.env.SOLANA_RPC_URL || RPC_URLS[CLUSTER];

// ── Program IDs ─────────────────────────────────────────────
export const BONDING_CURVE_PROGRAM_ID = new PublicKey(
  'nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof'
);
export const AGENTIC_COMMERCE_PROGRAM_ID = new PublicKey(
  'Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx'
);
export const METAPLEX_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

// ── PDAs ─────────────────────────────────────────────────────

export function getCurveConfigPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('curve_config')],
    BONDING_CURVE_PROGRAM_ID
  );
}

export function getCurvePoolPDA(mintPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('curve_pool'), mintPubkey.toBuffer()],
    BONDING_CURVE_PROGRAM_ID
  );
}

export function getSolVaultPDA(poolPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('sol_vault'), poolPubkey.toBuffer()],
    BONDING_CURVE_PROGRAM_ID
  );
}

export function getTokenVaultPDA(poolPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), poolPubkey.toBuffer()],
    BONDING_CURVE_PROGRAM_ID
  );
}

export function getMetadataPDA(mintPubkey) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METAPLEX_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METAPLEX_PROGRAM_ID
  );
}

export function getPlatformConfigPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    AGENTIC_COMMERCE_PROGRAM_ID
  );
}

// ── Connection Singleton ─────────────────────────────────────

let _connection = null;

export function getConnection() {
  if (!_connection) {
    _connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return _connection;
}

// ── Deployer Wallet (server-side, admin ops only) ───────────

let _deployer = null;

export function getDeployer() {
  if (_deployer) return _deployer;

  // Support Railway/cloud: DEPLOYER_KEY_BASE64 env var (base64-encoded JSON array)
  if (process.env.DEPLOYER_KEY_BASE64) {
    const raw = JSON.parse(Buffer.from(process.env.DEPLOYER_KEY_BASE64, 'base64').toString('utf8'));
    _deployer = Keypair.fromSecretKey(Uint8Array.from(raw));
    return _deployer;
  }

  // Fallback: local file
  const keyPath = join(ROOT, '.keys', 'deployer.json');
  if (!existsSync(keyPath)) {
    throw new Error(`Deployer keypair not found. Set DEPLOYER_KEY_BASE64 env var or place key at ${keyPath}`);
  }

  const raw = JSON.parse(readFileSync(keyPath, 'utf8'));
  _deployer = Keypair.fromSecretKey(Uint8Array.from(raw));
  return _deployer;
}

// ── IDL Loading ──────────────────────────────────────────────

let _bondingCurveIdl = null;
let _agenticCommerceIdl = null;

export function getBondingCurveIdl() {
  if (_bondingCurveIdl) return _bondingCurveIdl;
  // api/idl/ is the production copy (committed); target/idl/ is the build output (dev only)
  const candidates = [
    join(__dirname, '..', 'idl', 'bonding_curve.json'),
    join(ROOT, 'target', 'idl', 'bonding_curve.json'),
  ];
  const idlPath = candidates.find(existsSync);
  if (!idlPath) throw new Error(`Bonding curve IDL not found. Run: anchor build`);
  _bondingCurveIdl = JSON.parse(readFileSync(idlPath, 'utf8'));
  return _bondingCurveIdl;
}

export function getAgenticCommerceIdl() {
  if (_agenticCommerceIdl) return _agenticCommerceIdl;
  const candidates = [
    join(__dirname, '..', 'idl', 'agentic_commerce.json'),
    join(ROOT, 'target', 'idl', 'agentic_commerce.json'),
  ];
  const idlPath = candidates.find(existsSync);
  if (!idlPath) throw new Error(`Agentic commerce IDL not found. Run: anchor build`);
  _agenticCommerceIdl = JSON.parse(readFileSync(idlPath, 'utf8'));
  return _agenticCommerceIdl;
}

// ── Program Clients ──────────────────────────────────────────

/**
 * Build a read-only AnchorProvider (no signing)
 */
function getReadOnlyProvider() {
  const conn = getConnection();
  return new AnchorProvider(
    conn,
    { publicKey: PublicKey.default, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs },
    { commitment: 'confirmed', skipPreflight: false }
  );
}

/**
 * Get bonding curve program (read-only)
 */
let _bcProgram = null;
export function getBondingCurveProgram() {
  if (_bcProgram) return _bcProgram;
  try {
    const idl = getBondingCurveIdl();
    const provider = getReadOnlyProvider();
    _bcProgram = new Program(idl, provider);
    return _bcProgram;
  } catch (err) {
    console.error('getBondingCurveProgram error:', err.message, err.stack);
    throw err;
  }
}

/**
 * Get agentic commerce program (read-only)
 */
export function getAgenticCommerceProgram() {
  const idl = getAgenticCommerceIdl();
  const provider = getReadOnlyProvider();
  return new Program(idl, provider);
}

// ── On-Chain State Reads ─────────────────────────────────────

/**
 * Read the global curve config from chain
 */
export async function readCurveConfig() {
  const program = getBondingCurveProgram();
  const [configPDA] = getCurveConfigPDA();
  try {
    return await program.account.curveConfig.fetch(configPDA);
  } catch {
    return null; // Config not initialized yet
  }
}

/**
 * Read a pool account from chain by mint address
 */
/**
 * Manually decode CurvePool from raw account data.
 * Avoids Anchor coder issues on Railway with variable-length string fields.
 */
function decodeCurvePoolRaw(data) {
  // Skip 8-byte discriminator
  let offset = 8;

  const readPubkey = () => { const pk = new PublicKey(data.subarray(offset, offset + 32)); offset += 32; return pk; };
  const readU64 = () => { const v = data.readBigUInt64LE(offset); offset += 8; return v; };
  const readI64 = () => { const v = data.readBigInt64LE(offset); offset += 8; return v; };
  const readU8 = () => { const v = data[offset]; offset += 1; return v; };
  const readString = () => { const len = data.readUInt32LE(offset); offset += 4; const s = data.subarray(offset, offset + len).toString('utf8'); offset += len; return s; };

  const mint = readPubkey();
  const creator = readPubkey();
  const virtualSolReserve = readU64();
  const virtualTokenReserve = readU64();
  const realSolBalance = readU64();
  const realTokenBalance = readU64();
  const totalSupply = readU64();
  const statusByte = readU8();
  const statusMap = { 0: 'Active', 1: 'Graduated' };
  const status = { [statusMap[statusByte] || 'Unknown']: {} };
  const creatorFeesEarned = readU64();
  const creatorFeesClaimed = readU64();
  const platformFeesEarned = readU64();
  const platformFeesClaimed = readU64();
  const devBuySol = readU64();
  const devBuyTokens = readU64();
  const createdAt = readI64();
  const graduatedAt = readI64();
  const raydiumPool = readPubkey();
  const raydiumLpMint = readPubkey();
  const lpTokensLocked = readU64();
  const raydiumFeesClaimedToken0 = readU64();
  const raydiumFeesClaimedToken1 = readU64();
  const totalVolumeSol = readU64();
  const totalTrades = readU64();
  const name = readString();
  const symbol = readString();
  const uri = readString();
  const bump = readU8();
  const vaultBump = readU8();

  // Convert BigInts to BN-like objects with toNumber()
  const bn = (v) => ({ toNumber: () => Number(v), toString: () => v.toString() });

  return {
    mint, creator, status, name, symbol, uri, bump, vaultBump,
    virtualSolReserve: bn(virtualSolReserve),
    virtualTokenReserve: bn(virtualTokenReserve),
    realSolBalance: bn(realSolBalance),
    realTokenBalance: bn(realTokenBalance),
    totalSupply: bn(totalSupply),
    creatorFeesEarned: bn(creatorFeesEarned),
    creatorFeesClaimed: bn(creatorFeesClaimed),
    platformFeesEarned: bn(platformFeesEarned),
    platformFeesClaimed: bn(platformFeesClaimed),
    devBuySol: bn(devBuySol),
    devBuyTokens: bn(devBuyTokens),
    createdAt: bn(createdAt),
    graduatedAt: bn(graduatedAt),
    raydiumPool, raydiumLpMint,
    lpTokensLocked: bn(lpTokensLocked),
    raydiumFeesClaimedToken0: bn(raydiumFeesClaimedToken0),
    raydiumFeesClaimedToken1: bn(raydiumFeesClaimedToken1),
    totalVolumeSol: bn(totalVolumeSol),
    totalTrades: bn(totalTrades),
  };
}

export async function readPool(mintAddress) {
  const conn = getConnection();
  const mintPubkey = typeof mintAddress === 'string' ? new PublicKey(mintAddress) : mintAddress;
  const [poolPDA] = getCurvePoolPDA(mintPubkey);
  try {
    const info = await conn.getAccountInfo(poolPDA);
    if (!info) return null;
    return decodeCurvePoolRaw(info.data);
  } catch (err) {
    console.error('readPool error:', err.message, err.stack);
    return null;
  }
}

/**
 * Read all active pools (uses getProgramAccounts — use sparingly)
 */
export async function readAllPools() {
  const conn = getConnection();
  try {
    // Filter by owner program only — CurvePool has variable-length strings so no dataSize filter
    const accounts = await conn.getProgramAccounts(BONDING_CURVE_PROGRAM_ID);
    // CurvePool discriminator: first 8 bytes
    const configDiscrim = Buffer.from([56, 144, 146, 88, 225, 200, 37, 218]); // CurveConfig discrim (skip these)
    return accounts
      .filter(a => a.account.data.length > 200) // CurvePool is ~500+ bytes, CurveConfig is small
      .map(a => {
        try {
          return { publicKey: a.pubkey, account: decodeCurvePoolRaw(a.account.data) };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('readAllPools error:', err.message);
    return [];
  }
}

/**
 * Read a job account from agentic_commerce by job PDA
 */
export async function readJob(jobPDA) {
  const program = getAgenticCommerceProgram();
  const pubkey = typeof jobPDA === 'string' ? new PublicKey(jobPDA) : jobPDA;
  try {
    return await program.account.job.fetch(pubkey);
  } catch {
    return null;
  }
}

// ── Transaction Builders (for client-side signing) ───────────
// These build the transaction but DON'T sign it.
// The serialized transaction is returned to the frontend,
// where the user's wallet (Phantom etc.) signs and submits.

/**
 * Build a "buy" transaction for the user to sign
 * Returns base64-encoded transaction bytes
 */
export async function buildBuyTransaction({
  buyerPublicKey,
  mintAddress,
  solAmountLamports,
  minTokensOut,
  createATA = false,
}) {
  const program = getBondingCurveProgram();
  const conn = getConnection();
  const buyer = new PublicKey(buyerPublicKey);
  const mint = new PublicKey(mintAddress);

  const [pool] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(pool);
  const [tokenVault] = getTokenVaultPDA(pool);
  const buyerATA = await getAssociatedTokenAddress(mint, buyer);

  const [configPDA] = getCurveConfigPDA();

  const ix = await program.methods
    .buy(new BN(solAmountLamports.toString()), new BN(minTokensOut.toString()))
    .accounts({
      buyer,
      config: configPDA,
      pool,
      solVault,
      tokenVault,
      buyerTokenAccount: buyerATA,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: buyer });

  // Create ATA if buyer doesn't have one yet
  if (createATA) {
    tx.add(createAssociatedTokenAccountInstruction(buyer, buyerATA, buyer, mint));
  }

  tx.add(ix);

  return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
}

/**
 * Build a "sell" transaction for the user to sign
 * Returns base64-encoded transaction bytes
 */
export async function buildSellTransaction({
  sellerPublicKey,
  mintAddress,
  tokenAmount,
  minSolOut,
}) {
  const program = getBondingCurveProgram();
  const conn = getConnection();
  const seller = new PublicKey(sellerPublicKey);
  const mint = new PublicKey(mintAddress);

  const [pool] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(pool);
  const [tokenVault] = getTokenVaultPDA(pool);
  const sellerATA = await getAssociatedTokenAddress(mint, seller);

  const [configPDA] = getCurveConfigPDA();

  const ix = await program.methods
    .sell(new BN(tokenAmount.toString()), new BN(minSolOut.toString()))
    .accounts({
      seller,
      config: configPDA,
      pool,
      solVault,
      tokenVault,
      sellerTokenAccount: sellerATA,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: seller });

  tx.add(ix);

  return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
}

/**
 * Build a "create_token" transaction for the creator to sign.
 * Note: The mint keypair is generated server-side and returned
 * alongside the transaction. Creator must sign both the transaction
 * AND we need the mint's signature — so we return both.
 */
export async function buildCreateTokenTransaction({
  creatorPublicKey,
  name,
  symbol,
  uri,
  devBuySol = null,
}) {
  const program = getBondingCurveProgram();
  const conn = getConnection();
  const creator = new PublicKey(creatorPublicKey);

  // Generate a new mint keypair — fresh every call, so reuse isn't the issue
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  const [configPDA] = getCurveConfigPDA();
  const [pool] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(pool);
  const [tokenVault] = getTokenVaultPDA(pool);
  const [metadata] = getMetadataPDA(mint);
  const creatorATA = await getAssociatedTokenAddress(mint, creator);

  // Pre-flight: check if metadata PDA already exists (deterministic from mint).
  // A stale failed tx can leave residual account state that causes InvalidAccountData on retry.
  const metadataInfo = await conn.getAccountInfo(metadata);
  if (metadataInfo !== null) {
    const err = new Error(
      'InvalidAccountData: Metaplex metadata account already exists for this mint. ' +
      'This can happen if a previous create_token transaction partially landed. ' +
      'A new mint keypair will be generated on your next call — please retry the request.'
    );
    err.code = 'METADATA_ACCOUNT_EXISTS';
    throw err;
  }

  const config = await program.account.curveConfig.fetch(configPDA);

  const devBuyArg = devBuySol
    ? new BN(Math.round(devBuySol * 1e9))
    : null;

  try {
    const ix = await program.methods
      .createToken(name, symbol, uri, devBuyArg)
      .accounts({
        creator,
        config: configPDA,
        mint,
        pool,
        solVault,
        tokenVault,
        metadata,
        metadataProgram: METAPLEX_PROGRAM_ID,
        creatorTokenAccount: creatorATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: creator });
    tx.add(ix);

    // Partially sign with mint keypair (mint account must be a signer)
    tx.partialSign(mintKp);

    return {
      transaction: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64'),
      mintPublicKey: mint.toBase58(),
      poolAddress: pool.toBase58(),
    };
  } catch (err) {
    if (err.message?.includes('InvalidAccountData') || err.code === 'InvalidAccountData') {
      const enhanced = new Error(
        'InvalidAccountData building create_token instruction. ' +
        'A Metaplex metadata or ATA account may already exist from a prior failed attempt. ' +
        'Please retry — a fresh mint keypair will be generated. ' +
        'If the issue persists, try a different token name/symbol combination or contact support.'
      );
      enhanced.code = 'INVALID_ACCOUNT_DATA';
      throw enhanced;
    }
    throw err;
  }
}

/**
 * Build a "claim_creator_fees" transaction
 */
export async function buildClaimCreatorFeesTransaction({
  creatorPublicKey,
  mintAddress,
}) {
  const program = getBondingCurveProgram();
  const conn = getConnection();
  const creator = new PublicKey(creatorPublicKey);
  const mint = new PublicKey(mintAddress);

  const [configPDA] = getCurveConfigPDA();
  const [pool] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(pool);

  const ix = await program.methods
    .claimCreatorFees()
    .accounts({
      creator,
      config: configPDA,
      pool,
      solVault,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: creator });
  tx.add(ix);

  return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
}

// ── Server-Side Admin Operations ─────────────────────────────
// These sign and submit directly using the deployer key.

/**
 * Initialize the bonding curve config on-chain.
 * Called once after deployment.
 */
export async function initializeBondingCurve({
  creatorFeeBps = 140,    // 1.4%
  platformFeeBps = 60,    // 0.6%
  graduationThreshold = 85_000_000_000, // 85 SOL in lamports
  totalSupply = 1_000_000_000,          // 1B tokens
  decimals = 9,
  initialVirtualSol = 30_000_000_000,  // 30 SOL in lamports
  treasury,
} = {}) {
  const program = getBondingCurveProgram();
  const conn = getConnection();
  const deployer = getDeployer();
  const [configPDA] = getCurveConfigPDA();

  const treasuryPubkey = treasury
    ? new PublicKey(treasury)
    : deployer.publicKey;

  const provider = new AnchorProvider(
    conn,
    { publicKey: deployer.publicKey, signTransaction: async (tx) => { tx.sign(deployer); return tx; }, signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign(deployer)); return txs; } },
    { commitment: 'confirmed' }
  );

  const adminProgram = new Program(getBondingCurveIdl(), provider);

  const tx = await adminProgram.methods
    .initialize(
      creatorFeeBps,
      platformFeeBps,
      new BN(graduationThreshold),
      new BN(totalSupply),
      decimals,
      new BN(initialVirtualSol),
      treasuryPubkey
    )
    .accountsPartial({
      admin: deployer.publicKey,
    })
    .rpc();

  return { tx, configPDA: configPDA.toBase58() };
}

/**
 * Claim platform fees (treasury operation)
 */
export async function claimPlatformFees(mintAddress) {
  const program = getBondingCurveProgram();
  const conn = getConnection();
  const deployer = getDeployer();
  const mint = new PublicKey(mintAddress);

  const [configPDA] = getCurveConfigPDA();
  const [pool] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(pool);

  const provider = new AnchorProvider(
    conn,
    { publicKey: deployer.publicKey, signTransaction: async (tx) => { tx.sign(deployer); return tx; }, signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign(deployer)); return txs; } },
    { commitment: 'confirmed' }
  );

  const adminProgram = new Program(getBondingCurveIdl(), provider);

  const tx = await adminProgram.methods
    .claimPlatformFees()
    .accountsPartial({
      treasury: deployer.publicKey,
      pool,
      solVault,
    })
    .rpc();

  return { tx };
}

// ── Graduation ──────────────────────────────────────────────

/**
 * Build a graduation transaction.
 * Permissionless — anyone can trigger once threshold is met.
 *
 * Payer (caller) acts as Raydium creator:
 * - Pre-transfer: tokens/SOL moved from pool vaults → payer ATAs
 * - Raydium CPI with payer as creator (plain invoke, payer already signed)
 * - LP tokens burned immediately from payer's LP ATA
 */
export async function buildGraduateTransaction({ mintAddress, payer }) {
  const conn = getConnection();
  const mint = new PublicKey(mintAddress);
  const payerPk = new PublicKey(payer);

  const [configPDA] = getCurveConfigPDA();
  const [poolPDA] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(poolPDA);
  const [tokenVault] = getTokenVaultPDA(poolPDA);

  // ── Raydium CPMM accounts ─────────────────────────────────
  const {
    RAYDIUM_CPMM_PROGRAM_ID,
    RAYDIUM_AMM_CONFIG,
    RAYDIUM_CREATE_POOL_FEE,
    getRaydiumAuthPDA,
    getRaydiumPoolPDA,
    getRaydiumLpMintPDA,
    getRaydiumVaultPDA,
    getRaydiumObservationPDA,
  } = await import('./raydium.js');

  const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

  // Raydium requires token_0 < token_1
  const agentIsToken0 = mint.toBuffer().compare(WSOL_MINT.toBuffer()) < 0;
  const [token0Mint, token1Mint] = agentIsToken0 ? [mint, WSOL_MINT] : [WSOL_MINT, mint];

  const [raydiumAuth] = getRaydiumAuthPDA();
  const [raydiumPoolState] = getRaydiumPoolPDA(RAYDIUM_AMM_CONFIG, token0Mint, token1Mint);
  const [raydiumLpMint] = getRaydiumLpMintPDA(raydiumPoolState);
  const [vault0] = getRaydiumVaultPDA(raydiumPoolState, token0Mint);
  const [vault1] = getRaydiumVaultPDA(raydiumPoolState, token1Mint);
  const [raydiumObservation] = getRaydiumObservationPDA(raydiumPoolState);

  // Payer ATAs
  const payerAgentAta = await getAssociatedTokenAddress(mint, payerPk);
  const payerWsolAta = await getAssociatedTokenAddress(WSOL_MINT, payerPk);
  const lpTokenAccount = await getAssociatedTokenAddress(raydiumLpMint, payerPk);

  // Vault ordering: program uses swap internally, so pass:
  //   raydium_token_0_vault = agent vault (vault1 when !agentIsToken0)
  //   raydium_token_1_vault = wsol vault (vault0 when !agentIsToken0)
  const [structVault0, structVault1] = agentIsToken0 ? [vault0, vault1] : [vault1, vault0];

  const program = getBondingCurveProgram();
  const tx = await program.methods
    .graduate()
    .accounts({
      payer: payerPk,
      config: configPDA,
      pool: poolPDA,
      solVault,
      tokenVault,
      mint,
      payerAgentAta,
      payerWsolAta,
      raydiumProgram: RAYDIUM_CPMM_PROGRAM_ID,
      raydiumAmmConfig: RAYDIUM_AMM_CONFIG,
      raydiumPoolState,
      raydiumAuthority: raydiumAuth,
      raydiumToken0Vault: structVault0,
      raydiumToken1Vault: structVault1,
      raydiumLpMint,
      lpTokenAccount,
      raydiumObservation,
      createPoolFee: RAYDIUM_CREATE_POOL_FEE,
      wsolMint: WSOL_MINT,
      raydiumPermission: SystemProgram.programId,  // dummy for Path B
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .transaction();

  tx.feePayer = payerPk;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));

  return {
    tx,
    poolPDA: poolPDA.toBase58(),
    raydiumPoolState: raydiumPoolState.toBase58(),
    raydiumLpMint: raydiumLpMint.toBase58(),
  };
}

// ── Event Parsing ────────────────────────────────────────────

/**
 * Parse bonding curve events from a transaction's log messages.
 * Used to sync DB state after a transaction confirms.
 */
export function parseBondingCurveEvents(logs) {
  const program = getBondingCurveProgram();
  const events = [];

  for (const log of logs) {
    try {
      const event = program.coder.events.decode(log);
      if (event) events.push(event);
    } catch {
      // Not an event log
    }
  }

  return events;
}

/**
 * Parse events from a confirmed transaction signature
 */
export async function getTransactionEvents(signature) {
  const conn = getConnection();
  const tx = await conn.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });

  if (!tx?.meta?.logMessages) return [];

  return parseBondingCurveEvents(tx.meta.logMessages);
}

// ── Utility ──────────────────────────────────────────────────

/**
 * Convert on-chain pool account → DB-friendly format
 */
export function poolAccountToDb(poolAccount, mintAddress) {
  return {
    mint_address: mintAddress,
    virtual_sol_reserve: poolAccount.virtualSolReserve.toString(),
    virtual_token_reserve: poolAccount.virtualTokenReserve.toString(),
    real_sol_balance: poolAccount.realSolBalance.toString(),
    real_token_balance: poolAccount.realTokenBalance.toString(),
    total_supply: poolAccount.totalSupply.toString(),
    creator_fees_earned: poolAccount.creatorFeesEarned.toString(),
    creator_fees_claimed: poolAccount.creatorFeesClaimed.toString(),
    platform_fees_earned: poolAccount.platformFeesEarned.toString(),
    platform_fees_claimed: poolAccount.platformFeesClaimed.toString(),
    dev_buy_sol: poolAccount.devBuySol.toString(),
    dev_buy_tokens: poolAccount.devBuyTokens.toString(),
    status: poolAccount.status,
    graduated_at: poolAccount.graduatedAt.toNumber(),
    total_volume_sol: poolAccount.totalVolumeSol.toString(),
    total_trades: poolAccount.totalTrades.toNumber(),
  };
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
