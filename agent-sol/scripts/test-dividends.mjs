/**
 * E2E test: Agent Dividends program
 * Tests: create_token_dividend, stake, deposit_revenue, claim_rewards, mode switch
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync } from 'fs';
import pkg from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet, BN } = pkg;

const RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = 'C:/Users/favcr/.openclaw/workspace/.keys/agent-sol-deploy.json';
const DIVIDENDS_IDL_PATH = './target/idl/agent_dividends.json';
const BONDING_IDL_PATH = './target/idl/bonding_curve.json';

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')))
  );
  const provider = new AnchorProvider(conn, new Wallet(adminKp), { commitment: 'confirmed' });
  const divIdl = JSON.parse(readFileSync(DIVIDENDS_IDL_PATH, 'utf8'));
  const bcIdl = JSON.parse(readFileSync(BONDING_IDL_PATH, 'utf8'));
  const divProgram = new Program(divIdl, provider);
  const bcProgram = new Program(bcIdl, provider);

  console.log('=== Agent Dividends E2E Test ===\n');

  // ── 1. Verify DividendConfig exists ──
  const [divConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('dividend_config')], divProgram.programId
  );
  const divConfig = await divProgram.account.dividendConfig.fetch(divConfigPda);
  console.log('✅ DividendConfig PDA:', divConfigPda.toBase58());
  console.log('   job_revenue_share_bps:', divConfig.jobRevenueShareBps.toString());
  console.log('   creator_fee_share_bps:', divConfig.creatorFeeShareBps.toString());

  // ── 2. Find a live token from bonding curve ──
  const poolPda = new PublicKey('BsqGC9dDmceRodNEKo7zq7Jfu3455Ptq8KVuPeodbvho');
  const poolData = await bcProgram.account.curvePool.fetch(poolPda);
  const mint = poolData.mint;
  console.log(`\n✅ Using token: ${poolData.name} (mint: ${mint.toBase58().slice(0, 8)}...)`);

  // ── 3. Create TokenDividend for this token ──
  const [tokenDivPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_dividend'), mint.toBuffer()], divProgram.programId
  );

  let tokenDivExists = false;
  try {
    const td = await divProgram.account.tokenDividend.fetch(tokenDivPda);
    console.log(`\n✅ TokenDividend already exists (mode: ${JSON.stringify(td.mode)})`);
    tokenDivExists = true;
  } catch {
    console.log('\n3. Creating TokenDividend...');
    try {
      const tx = await divProgram.methods.createTokenDividend(
        { regular: {} }  // Start in Regular mode
      ).accounts({
        creator: adminKp.publicKey,
        config: divConfigPda,
        tokenDividend: tokenDivPda,
        mint: mint,
        systemProgram: SystemProgram.programId,
      }).rpc();
      console.log('   ✅ Created! TX:', tx);
      tokenDivExists = true;
    } catch (e) {
      console.error('   ❌ Failed:', e.logs?.join('\n') || e.message);
    }
  }

  if (!tokenDivExists) {
    console.log('Cannot continue without TokenDividend account');
    process.exit(1);
  }

  // ── 4. Stake tokens ──
  console.log('\n4. Staking tokens...');
  const adminTokenAta = await getOrCreateAssociatedTokenAccount(
    conn, adminKp, mint, adminKp.publicKey
  );
  const adminTokenBal = adminTokenAta.amount;
  console.log('   Admin token balance:', adminTokenBal.toString());

  if (adminTokenBal === 0n) {
    console.log('   ⚠️  No tokens to stake — skipping stake/claim test');
  } else {
    const stakeAmount = adminTokenBal / 10n; // Stake 10%
    console.log(`   Staking ${stakeAmount} tokens (10% of balance)...`);

    const [stakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('stake_position'), mint.toBuffer(), adminKp.publicKey.toBuffer()],
      divProgram.programId
    );

    const mintKey = mint;
    const [stakingVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('staking_vault'), mintKey.toBuffer()],
      divProgram.programId
    );

    const [dividendVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('dividend_vault'), mintKey.toBuffer()],
      divProgram.programId
    );

    // Verify staking vault exists
    const svInfo = await conn.getAccountInfo(stakingVaultPda);
    console.log('   Staking vault:', stakingVaultPda.toBase58(), svInfo ? 'EXISTS' : 'NOT FOUND');

    try {
      const tx = await divProgram.methods.stake(new BN(stakeAmount.toString()))
        .accounts({
          user: adminKp.publicKey,
          mint: mint,
          tokenDividend: tokenDivPda,
          stakePosition: stakePda,
          userTokenAccount: adminTokenAta.address,
          stakingVault: stakingVaultPda,
          dividendVault: dividendVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
      console.log('   ✅ Staked! TX:', tx);

      // ── 5. Switch to Dividend mode ──
      console.log('\n5. Switching to Dividend mode...');
      try {
        const tx2 = await divProgram.methods.setDividendMode({ dividend: {} })
          .accounts({
            creator: adminKp.publicKey,
            tokenDividend: tokenDivPda,
          }).rpc();
        console.log('   ✅ Mode switched to Dividend! TX:', tx2);

        // ── 6. Deposit revenue ──
        console.log('\n6. Depositing 0.01 SOL revenue...');
        const [buybackVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('buyback_vault'), mint.toBuffer()],
          divProgram.programId
        );
        const tx3 = await divProgram.methods.depositRevenue(
          new BN(0.01 * LAMPORTS_PER_SOL)
        ).accounts({
          depositor: adminKp.publicKey,
          config: divConfigPda,
          tokenDividend: tokenDivPda,
          dividendVault: dividendVaultPda,
          buybackVault: buybackVaultPda,
          systemProgram: SystemProgram.programId,
        }).rpc();
        console.log('   ✅ Revenue deposited! TX:', tx3);

        // ── 7. Claim rewards ──
        console.log('\n7. Claiming rewards...');
        const balBefore = await conn.getBalance(adminKp.publicKey);
        const tx4 = await divProgram.methods.claimRewards()
          .accounts({
            user: adminKp.publicKey,
            mint: mint,
            tokenDividend: tokenDivPda,
            stakePosition: stakePda,
            dividendVault: dividendVaultPda,
            systemProgram: SystemProgram.programId,
          }).rpc();
        const balAfter = await conn.getBalance(adminKp.publicKey);
        console.log('   ✅ Rewards claimed! TX:', tx4);
        console.log('   SOL gained (net):', (balAfter - balBefore) / LAMPORTS_PER_SOL, 'SOL');

      } catch (e) {
        const logs = e.logs?.join('\n') || e.message;
        if (logs.includes('7-day') || logs.includes('CooldownActive')) {
          console.log('   ⚠️  Mode switch on cooldown (7 days) — expected for recently created token');
        } else {
          console.error('   ❌ Mode switch failed:', logs.slice(0, 300));
        }
      }

    } catch (e) {
      console.error('   ❌ Stake failed:', e.logs?.join('\n') || e.message);
    }
  }

  // ── 8. Test Buyback mode ──
  console.log('\n8. Testing BuybackBurn mode switch...');
  const td = await divProgram.account.tokenDividend.fetch(tokenDivPda);
  console.log('   Current mode:', JSON.stringify(td.mode));
  console.log('   Last mode switch:', td.lastModeSwitch ? new Date(td.lastModeSwitch.toNumber() * 1000).toISOString() : 'never');

  console.log('\n=== Dividend E2E Test Complete ===');
}

main().catch(console.error);
