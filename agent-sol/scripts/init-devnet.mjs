/**
 * Initialize both programs on devnet.
 * Run once after deployment: node scripts/init-devnet.mjs
 */
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN } = anchor;
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Config ──────────────────────────────────────────────────
const RPC_URL = 'https://api.devnet.solana.com';
const BONDING_CURVE_PROGRAM_ID = new PublicKey('nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof');
const AGENTIC_COMMERCE_PROGRAM_ID = new PublicKey('Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx');
// Circle's devnet USDC mint
const DEVNET_USDC = new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');

// ── Setup ───────────────────────────────────────────────────
const conn = new Connection(RPC_URL, 'confirmed');

const deployerRaw = JSON.parse(readFileSync(join(ROOT, '.keys', 'deployer.json'), 'utf8'));
const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerRaw));
console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
console.log(`Balance: ${(await conn.getBalance(deployer.publicKey)) / 1e9} SOL\n`);

const provider = new AnchorProvider(
  conn,
  {
    publicKey: deployer.publicKey,
    signTransaction: async (tx) => { tx.sign(deployer); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign(deployer)); return txs; },
  },
  { commitment: 'confirmed' }
);

// ── Load IDLs ───────────────────────────────────────────────
const bondingIdl = JSON.parse(readFileSync(join(ROOT, 'target', 'idl', 'bonding_curve.json'), 'utf8'));
const commerceIdl = JSON.parse(readFileSync(join(ROOT, 'target', 'idl', 'agentic_commerce.json'), 'utf8'));

// Anchor 0.31 new IDL format: Program(idl, provider) — uses idl.address
const bondingProgram = new Program(bondingIdl, provider);
const commerceProgram = new Program(commerceIdl, provider);

// ── PDAs ────────────────────────────────────────────────────
const [curveConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from('curve_config')],
  BONDING_CURVE_PROGRAM_ID
);
const [platformConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from('config')],
  AGENTIC_COMMERCE_PROGRAM_ID
);

console.log(`Bonding Curve Config PDA: ${curveConfig.toBase58()}`);
console.log(`Agentic Commerce Config PDA: ${platformConfig.toBase58()}\n`);

// ── Initialize Bonding Curve ─────────────────────────────────
try {
  const existing = await bondingProgram.account.curveConfig.fetch(curveConfig);
  console.log('✅ Bonding Curve already initialized');
  console.log(`   Creator fee: ${existing.creatorFeeBps} bps`);
  console.log(`   Platform fee: ${existing.platformFeeBps} bps`);
  console.log(`   Graduation threshold: ${existing.graduationThreshold.toString()} lamports`);
  console.log(`   Treasury: ${existing.treasury.toBase58()}`);
} catch {
  console.log('Initializing Bonding Curve...');
  const tx = await bondingProgram.methods
    .initialize(
      140,                        // creator_fee_bps: 1.4%
      60,                         // platform_fee_bps: 0.6%
      new BN(85_000_000_000),     // graduation_threshold: 85 SOL
      new BN(1_000_000_000),      // total_supply: 1B tokens
      9,                          // decimals
      new BN(30_000_000_000),     // initial_virtual_sol: 30 SOL
      deployer.publicKey          // treasury (deployer for now)
    )
    .accountsPartial({
      admin: deployer.publicKey,
    })
    .rpc();
  console.log(`✅ Bonding Curve initialized! Tx: ${tx}`);
}

// ── Initialize Agentic Commerce ──────────────────────────────
try {
  const existing = await commerceProgram.account.platformConfig.fetch(platformConfig);
  console.log('\n✅ Agentic Commerce already initialized');
  console.log(`   Fee: ${existing.feeBps} bps`);
  console.log(`   Treasury: ${existing.treasury.toBase58()}`);
  console.log(`   Payment mint: ${existing.paymentMint.toBase58()}`);
} catch {
  console.log('\nInitializing Agentic Commerce...');
  const tx = await commerceProgram.methods
    .initialize(250)  // fee_bps: 2.5%
    .accountsPartial({
      admin: deployer.publicKey,
      paymentMint: DEVNET_USDC,
      treasury: deployer.publicKey,
    })
    .rpc();
  console.log(`✅ Agentic Commerce initialized! Tx: ${tx}`);
}

// ── Final Status ─────────────────────────────────────────────
const finalBalance = await conn.getBalance(deployer.publicKey);
console.log(`\n🌑 Done! Remaining balance: ${finalBalance / 1e9} SOL`);
console.log(`\nPrograms live on devnet:`);
console.log(`  bonding_curve:     https://explorer.solana.com/address/${BONDING_CURVE_PROGRAM_ID.toBase58()}?cluster=devnet`);
console.log(`  agentic_commerce:  https://explorer.solana.com/address/${AGENTIC_COMMERCE_PROGRAM_ID.toBase58()}?cluster=devnet`);
