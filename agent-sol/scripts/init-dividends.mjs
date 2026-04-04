import { Connection, Keypair, SystemProgram, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import pkg from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet, BN } = pkg;

const RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = 'C:/Users/favcr/.openclaw/workspace/.keys/agent-sol-deploy.json';
const IDL_PATH = './target/idl/agent_dividends.json';

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))));
  console.log('Admin wallet:', kp.publicKey.toBase58());

  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const program = new Program(idl, provider);

  // Derive DividendConfig PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('dividend_config')],
    program.programId
  );
  console.log('DividendConfig PDA:', configPda.toBase58());

  // Check if already initialized
  try {
    const existing = await program.account.dividendConfig.fetch(configPda);
    console.log('DividendConfig already initialized:', existing);
    return;
  } catch (e) {
    console.log('DividendConfig not found, initializing...');
  }

  // Initialize with reasonable defaults
  // job_revenue_share_bps: 500 (5% of job revenue goes to token dividends)
  // creator_fee_share_bps: 10000 (100% of creator fee goes to selected mode)
  const tx = await program.methods.initializeDividendConfig(
    new BN(500),    // job_revenue_share_bps
    new BN(10000),  // creator_fee_share_bps
  ).accounts({
    admin: kp.publicKey,
    config: configPda,
    systemProgram: SystemProgram.programId,
  }).rpc();

  console.log('DividendConfig initialized! TX:', tx);

  // Verify
  const config = await program.account.dividendConfig.fetch(configPda);
  console.log('Config:', {
    admin: config.admin.toBase58(),
    jobRevenueShareBps: config.jobRevenueShareBps.toString(),
    creatorFeeShareBps: config.creatorFeeShareBps.toString(),
  });
}

main().catch(console.error);
