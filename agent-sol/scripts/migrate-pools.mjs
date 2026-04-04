/**
 * Fix CurvePool migration: resize to correct 546 bytes and zero-fill referral fields.
 * Handles: 537 (unmigrated), 554 (bad migration), 546 (already correct but may need zero-fill)
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, sendAndConfirmTransaction
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import pkg from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet } = pkg;

const RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = 'C:/Users/favcr/.openclaw/workspace/.keys/agent-sol-deploy.json';
const IDL_PATH = './target/idl/bonding_curve.json';

const OLD_SIZE = 537;
const BAD_SIZE = 554;
const TARGET_SIZE = 546; // 8 + CurvePool::INIT_SPACE (538)

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')))
  );
  const provider = new AnchorProvider(conn, new Wallet(adminKp), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const program = new Program(idl, provider);

  console.log('=== CurvePool Fix Migration ===');
  console.log('Admin:', adminKp.publicKey.toBase58());
  console.log('Target size:', TARGET_SIZE, 'bytes\n');

  // Get all CurvePool accounts at any of the expected sizes
  const [old, bad, target] = await Promise.all([
    conn.getProgramAccounts(program.programId, { filters: [{ dataSize: OLD_SIZE }] }),
    conn.getProgramAccounts(program.programId, { filters: [{ dataSize: BAD_SIZE }] }),
    conn.getProgramAccounts(program.programId, { filters: [{ dataSize: TARGET_SIZE }] }),
  ]);

  console.log(`Found ${old.length} at ${OLD_SIZE} bytes (unmigrated)`);
  console.log(`Found ${bad.length} at ${BAD_SIZE} bytes (bad migration)`);
  console.log(`Found ${target.length} at ${TARGET_SIZE} bytes (target size)\n`);

  const allPools = [
    ...old.map(a => ({ ...a, status: 'unmigrated' })),
    ...bad.map(a => ({ ...a, status: 'bad' })),
    ...target.map(a => ({ ...a, status: 'needs-zero' })),
  ];

  if (allPools.length === 0) {
    console.log('No pools found!');
    return;
  }

  let fixed = 0, skipped = 0, failed = 0;

  for (const { pubkey, status } of allPools) {
    process.stdout.write(`${status.padEnd(12)} ${pubkey.toBase58().slice(0, 12)}... `);

    try {
      const tx = await program.methods.migratePool()
        .accounts({
          payer: adminKp.publicKey,
          pool: pubkey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`✅ ${tx.slice(0, 16)}...`);
      fixed++;
    } catch (e) {
      const msg = e.logs?.join(' ') || e.message;
      if (msg.includes('already at target size')) {
        console.log('⏭ already correct');
        skipped++;
      } else {
        console.log(`❌ ${msg.slice(0, 120)}`);
        failed++;
      }
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${skipped} skipped, ${failed} failed`);

  // Verify by trying to deserialize one pool
  if (allPools.length > 0) {
    console.log('\nVerification: fetching first pool...');
    try {
      const pool = await program.account.curvePool.fetch(allPools[0].pubkey);
      console.log(`  Name: ${pool.name}, Symbol: ${pool.symbol}`);
      console.log(`  Referrals enabled: ${pool.referralsEnabled}`);
      console.log(`  Referral fees paid: ${pool.referralFeesPaid.toString()}`);
      console.log(`  Bump: ${pool.bump}, Vault bump: ${pool.vaultBump}`);
      console.log('  ✅ Deserialization works!');
    } catch (e) {
      console.error('  ❌ Still broken:', e.message);
    }
  }
}

main().catch(console.error);
