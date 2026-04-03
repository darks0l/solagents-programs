import { Connection, Keypair, SystemProgram, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import pkg from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet, BN } = pkg;

const RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = 'C:/Users/favcr/.openclaw/workspace/.keys/agent-sol-deploy.json';
const IDL_PATH = './target/idl/bonding_curve.json';

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))));
  console.log('Admin wallet:', kp.publicKey.toBase58());

  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const program = new Program(idl, provider);

  // Step 1: migrate_config (realloc to fit new referral_fee_bps field)
  console.log('\n1. Calling migrate_config...');
  try {
    const tx = await program.methods.migrateConfig()
      .accounts({
        admin: kp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('   Migration TX:', tx);
  } catch (e) {
    const msg = e.logs?.join(' ') || e.message || String(e);
    if (msg.includes('already at target size')) {
      console.log('   Config already migrated');
    } else {
      console.error('   Migration error:', msg);
    }
  }

  // Step 2: update_config to set referral_fee_bps = 50
  console.log('\n2. Setting referral_fee_bps = 50...');
  try {
    const tx = await program.methods.updateConfig(
      null,  // new_creator_fee_bps
      null,  // new_platform_fee_bps
      null,  // new_graduation_threshold
      null,  // new_treasury
      null,  // new_admin
      null,  // paused
      null,  // raydium_permission_enabled
      null,  // trading_paused
      50,    // referral_fee_bps
    ).accounts({
      admin: kp.publicKey,
    }).rpc();
    console.log('   Update TX:', tx);
  } catch (e) {
    console.error('   Update error:', e.logs?.join('\n') || e.message || e);
  }

  // Verify
  console.log('\n3. Verifying config...');
  try {
    const resp = await fetch('https://agent-sol-api-production.up.railway.app/api/chain/config');
    const data = await resp.json();
    console.log('   Config:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('   (API may still be deploying, check manually)');
  }
}

main().catch(console.error);
