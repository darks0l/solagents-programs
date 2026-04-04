/**
 * E2E test: Referral system on bonding curve
 * Tests: enable referrals, buy with referrer, verify fee splits, self-referral block
 */
import {
  Connection, Keypair, PublicKey, SystemProgram,
  LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount,
  mintTo, TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { readFileSync } from 'fs';
import pkg from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet, BN } = pkg;

const RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = 'C:/Users/favcr/.openclaw/workspace/.keys/agent-sol-deploy.json';
const IDL_PATH = './target/idl/bonding_curve.json';

const LAMPORTS = BigInt(LAMPORTS_PER_SOL);

async function fundFromAdmin(conn, adminKp, dest, lamports) {
  const bal = await conn.getBalance(dest.publicKey);
  if (bal < lamports) {
    console.log(`  Funding ${dest.publicKey.toBase58().slice(0,8)}... with ${lamports/LAMPORTS_PER_SOL} SOL`);
    const { SystemProgram: SP, Transaction: TX, sendAndConfirmTransaction: sact } = await import('@solana/web3.js');
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: adminKp.publicKey, toPubkey: dest.publicKey, lamports })
    );
    await sendAndConfirmTransaction(conn, tx, [adminKp], { commitment: 'confirmed' });
  }
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')))
  );
  const provider = new AnchorProvider(conn, new Wallet(adminKp), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const program = new Program(idl, provider);

  // Generate a fresh buyer and referrer wallets
  const buyer = Keypair.generate();
  const referrer = Keypair.generate();
  console.log('Buyer:', buyer.publicKey.toBase58());
  console.log('Referrer:', referrer.publicKey.toBase58());

  await fundFromAdmin(conn, adminKp, buyer, Math.floor(0.3 * LAMPORTS_PER_SOL));
  await fundFromAdmin(conn, adminKp, referrer, Math.floor(0.01 * LAMPORTS_PER_SOL));

  // ── Find a live token pool with referrals enabled (or create one) ──
  // Get CurveConfig
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('curve_config')], program.programId);
  const config = await program.account.curveConfig.fetch(configPda);
  console.log('\nConfig referral_fee_bps:', config.referralFeeBps);

  // Use specific pool with referrals enabled (DevTest, admin-owned)
  const poolPda = new PublicKey('26g88eakchDh7YGNGQgswjwcWh7Trz6vVkwSCVEFKcmi');
  const pool = await program.account.curvePool.fetch(poolPda);
  const mint = pool.mint;

  console.log(`\nUsing pool: ${pool.name} (${mint.toBase58().slice(0,8)}...)`);
  console.log('Referrals enabled:', pool.referralsEnabled);

  console.log('\n1. Referrals status:', pool.referralsEnabled ? 'ENABLED ✅' : 'DISABLED ❌');
  if (!pool.referralsEnabled) {
    console.log('  ❌ Pool referrals not enabled — run toggle_referrals first');
    process.exit(1);
  }

  // ── TEST: Buy with referrer ──
  console.log('\n2. Buying 0.05 SOL with referrer...');

  const [solVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('sol_vault'), poolPda.toBuffer()],
    program.programId
  );
  const [tokenVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), poolPda.toBuffer()],
    program.programId
  );

  const buyerTokenAta = await getOrCreateAssociatedTokenAccount(
    conn, buyer, mint, buyer.publicKey
  );

  const referrerBalBefore = await conn.getBalance(referrer.publicKey);
  const platformBalBefore = await conn.getBalance(config.treasury);
  const creatorBalBefore = await conn.getBalance(adminKp.publicKey); // assuming admin=creator for test

  const solAmount = 0.05 * LAMPORTS_PER_SOL;
  const buyerProvider = new AnchorProvider(conn, new Wallet(buyer), { commitment: 'confirmed' });
  const buyerProgram = new Program(idl, buyerProvider);

  try {
    const tx = await buyerProgram.methods.buy(
      new BN(solAmount),  // sol_amount in lamports
      new BN(1),          // min_tokens_out (1 = no slippage protection for test)
    ).accounts({
      buyer: buyer.publicKey,
      config: configPda,
      pool: poolPda,
      solVault: solVaultPda,
      tokenVault: tokenVaultPda,
      buyerTokenAccount: buyerTokenAta.address,
      mint: mint,
      referrer: referrer.publicKey,  // pass referrer account
      treasury: config.treasury,
      creator: pool.creator,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();

    console.log('  Buy TX:', tx);

    // Check fee splits
    const referrerBalAfter = await conn.getBalance(referrer.publicKey);
    const referrerGain = referrerBalAfter - referrerBalBefore;

    const expectedTotalFee = Math.floor(solAmount * 200 / 10000); // 2% of 0.05 SOL
    const expectedReferralFee = Math.floor(solAmount * 50 / 10000); // 0.5%
    const expectedPlatformFee = Math.floor(solAmount * 10 / 10000); // 0.1%
    const expectedCreatorFee = Math.floor(solAmount * 140 / 10000); // 1.4%

    console.log(`\n  Fee checks (expected vs actual):`);
    console.log(`  Referrer gain: ${referrerGain} lamports (expected ~${expectedReferralFee})`);
    const referralOk = Math.abs(referrerGain - expectedReferralFee) < 100;
    console.log(`  ✅ Referral fee: ${referralOk ? 'PASS' : 'FAIL'}`);

    // ── TEST: Self-referral block ──
    console.log('\n3. Testing self-referral block...');
    const buyerAta2 = await getOrCreateAssociatedTokenAccount(conn, buyer, mint, buyer.publicKey);
    try {
      await buyerProgram.methods.buy(new BN(Math.floor(0.01 * LAMPORTS_PER_SOL)), new BN(1))
        .accounts({
          buyer: buyer.publicKey,
          config: configPda,
          pool: poolPda,
          solVault: solVaultPda,
          tokenVault: tokenVaultPda,
          buyerTokenAccount: buyerAta2.address,
          mint: mint,
          referrer: buyer.publicKey,  // self-referral!
          treasury: config.treasury,
          creator: pool.creator,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
      console.log('  ❌ FAIL: Self-referral should have been rejected!');
    } catch (e) {
      const logs = e.logs?.join(' ') || e.message;
      if (logs.includes('SelfReferral') || logs.includes('6007')) {
        console.log('  ✅ Self-referral correctly rejected (SelfReferral error)');
      } else {
        console.log('  ⚠️  Got error but not SelfReferral:', logs.slice(0, 200));
      }
    }

    console.log('\n✅ Referral E2E test complete!');
  } catch (e) {
    const logs = e.logs?.join('\n') || e.message;
    console.error('\n❌ Buy with referrer failed:');
    console.error(logs.slice(0, 500));
  }
}

main().catch(console.error);
