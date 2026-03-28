/**
 * Update bonding curve config on devnet.
 * Usage: node scripts/update-config.mjs [graduation_threshold_sol]
 * Example: node scripts/update-config.mjs 5   (sets threshold to 5 SOL)
 */
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN } = anchor;
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const keyPath = join(ROOT, '..', '.keys', 'agent-sol-deploy.json');
const deployer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf-8'))));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const idl = JSON.parse(readFileSync(join(ROOT, 'api', 'idl', 'bonding_curve.json'), 'utf-8'));
const PROGRAM_ID = new PublicKey('nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof');

const wallet = { publicKey: deployer.publicKey, signTransaction: async (tx) => { tx.sign(deployer); return tx; }, signAllTransactions: async (txs) => { txs.forEach(t => t.sign(deployer)); return txs; } };
const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });
const program = new Program(idl, provider);

const thresholdSol = parseFloat(process.argv[2] || '5');
const thresholdLamports = new BN(Math.round(thresholdSol * 1e9));

console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
console.log(`Setting graduation threshold to ${thresholdSol} SOL (${thresholdLamports.toString()} lamports)`);

const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('curve_config')], PROGRAM_ID);

const ix = await program.methods
  .updateConfig(
    null,                    // creator_fee_bps
    null,                    // platform_fee_bps  
    thresholdLamports,       // graduation_threshold
    null,                    // treasury
    null,                    // admin
    null,                    // paused
    null,                    // raydium_permission_enabled
  )
  .accounts({
    admin: deployer.publicKey,
    config: configPDA,
  })
  .instruction();

const { blockhash } = await conn.getLatestBlockhash();
const tx = new Transaction({ recentBlockhash: blockhash, feePayer: deployer.publicKey });
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
tx.add(ix);
tx.sign(deployer);

const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, 'confirmed');
console.log(`✅ Config updated! TX: ${sig}`);

// Verify
const config = await program.account.curveConfig.fetch(configPDA);
console.log(`Verified threshold: ${config.graduationThreshold.toString()} lamports (${config.graduationThreshold.toNumber() / 1e9} SOL)`);
