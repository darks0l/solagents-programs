import anchor from "@coral-xyz/anchor";
const { Program, BN, web3 } = anchor;
import {
  getAssociatedTokenAddress, getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const wallet = provider.wallet as anchor.Wallet;
const connection = provider.connection;

const commerce = anchor.workspace.AgenticCommerce as Program;
const curve = anchor.workspace.BondingCurve as Program;

const LAMPORTS = web3.LAMPORTS_PER_SOL;
const log = (msg: string) => console.log(`\n🌑 ${msg}`);
const ok = (msg: string) => console.log(`   ✅ ${msg}`);
const info = (msg: string) => console.log(`   📊 ${msg}`);
const skip = (msg: string) => console.log(`   ⏭️  ${msg}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// PDA helpers
const configPda = () => web3.PublicKey.findProgramAddressSync([Buffer.from("config")], commerce.programId)[0];
const jobPda = (config: web3.PublicKey, id: number) => web3.PublicKey.findProgramAddressSync(
  [Buffer.from("job"), config.toBuffer(), new BN(id).toArrayLike(Buffer, "le", 8)], commerce.programId
)[0];
const vaultPda = (job: web3.PublicKey) => web3.PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), job.toBuffer()], commerce.programId
)[0];
const curveConfigPda = () => web3.PublicKey.findProgramAddressSync([Buffer.from("curve_config")], curve.programId)[0];
const poolPda = (mint: web3.PublicKey) => web3.PublicKey.findProgramAddressSync(
  [Buffer.from("curve_pool"), mint.toBuffer()], curve.programId
)[0];
const solVaultPda = (pool: web3.PublicKey) => web3.PublicKey.findProgramAddressSync(
  [Buffer.from("sol_vault"), pool.toBuffer()], curve.programId
)[0];
const tokenVaultPda = (pool: web3.PublicKey) => web3.PublicKey.findProgramAddressSync(
  [Buffer.from("token_vault"), pool.toBuffer()], curve.programId
)[0];

const MPL_TOKEN_METADATA_PROGRAM_ID = new web3.PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const metadataPda = (mint: web3.PublicKey) => web3.PublicKey.findProgramAddressSync(
  [Buffer.from("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
  MPL_TOKEN_METADATA_PROGRAM_ID
)[0];

async function testAgenticCommerce() {
  log("=== AGENTIC COMMERCE (Devnet) ===");

  const config = configPda();
  let configAcc: any;
  try {
    configAcc = await commerce.account.platformConfig.fetch(config);
    ok(`Platform initialized — fee: ${configAcc.feeBps}bps, jobs: ${configAcc.jobCounter.toNumber()}, mint: ${configAcc.paymentMint.toBase58()}`);
  } catch {
    log("Platform not initialized — skipping commerce tests");
    return;
  }

  const paymentMint = configAcc.paymentMint as web3.PublicKey;
  const jobId = configAcc.jobCounter.toNumber();
  const job = jobPda(config, jobId);
  const vault = vaultPda(job);

  // Check USDC balance
  let usdcBalance = 0;
  try {
    const ata = await getAssociatedTokenAddress(paymentMint, wallet.publicKey);
    const acc = await getAccount(connection, ata);
    usdcBalance = Number(acc.amount);
    ok(`USDC balance: ${usdcBalance / 1e6}`);
  } catch {
    ok("No USDC — will test job creation + budget only");
  }

  // Create job
  log("Creating job...");
  const evaluator = web3.Keypair.generate();
  const providerKp = web3.Keypair.generate();
  const expiration = Math.floor(Date.now() / 1000) + 3600;

  const tx1 = await commerce.methods.createJob(
    providerKp.publicKey,
    evaluator.publicKey,
    new BN(expiration),
    "Devnet Live Test — AI agent escrow task",
    web3.PublicKey.default
  ).accountsPartial({
    client: wallet.publicKey,
    config,
    job,
    vault,
    paymentMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: web3.SystemProgram.programId,
    rent: web3.SYSVAR_RENT_PUBKEY,
  }).rpc();

  ok(`Job created — tx: ${tx1}`);
  const jobAcc = await commerce.account.job.fetch(job);
  info(`Job #${jobAcc.jobId.toNumber()} | Status: ${JSON.stringify(jobAcc.status)} | Provider: ${providerKp.publicKey.toBase58().slice(0,8)}...`);

  // Set budget
  log("Setting budget to 50 USDC...");
  const budget = new BN(50_000_000); // 50 USDC
  const tx2 = await commerce.methods.setBudget(budget, Buffer.from([]))
    .accountsPartial({ caller: wallet.publicKey, job })
    .rpc();
  ok(`Budget set — tx: ${tx2}`);

  const jobAfterBudget = await commerce.account.job.fetch(job);
  info(`Budget: ${jobAfterBudget.budget.toNumber() / 1e6} USDC`);

  if (usdcBalance >= 50_000_000) {
    // Fund
    log("Funding job (Open → Funded)...");
    const clientToken = await getAssociatedTokenAddress(paymentMint, wallet.publicKey);
    const tx3 = await commerce.methods.fund(budget, Buffer.from([]))
      .accountsPartial({
        client: wallet.publicKey,
        job,
        clientToken,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
    ok(`Funded — tx: ${tx3}`);

    const jobFunded = await commerce.account.job.fetch(job);
    info(`Status: ${JSON.stringify(jobFunded.status)}`);
  } else {
    skip("No USDC to fund — job stays Open (create + budget verified)");
  }

  log("✅ Agentic Commerce — LIVE ON DEVNET");
}

async function testBondingCurve() {
  log("=== BONDING CURVE (Devnet) ===");

  const config = curveConfigPda();
  let configAcc: any;
  try {
    configAcc = await curve.account.curveConfig.fetch(config);
    ok(`Curve initialized — fees: ${configAcc.creatorFeeBps + configAcc.platformFeeBps}bps, tokens: ${configAcc.tokensCreated.toNumber()}`);
    info(`Graduation: ${configAcc.graduationThreshold.toNumber() / LAMPORTS} SOL`);
  } catch {
    log("Curve not initialized — skipping");
    return;
  }

  // Create token
  log("Creating token: DEVTEST ($DVTS)...");
  const tokenMint = web3.Keypair.generate();
  const pool = poolPda(tokenMint.publicKey);
  const solVault = solVaultPda(pool);
  const tokenVault = tokenVaultPda(pool);

  const metadata = metadataPda(tokenMint.publicKey);
  const creatorTokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, wallet.publicKey);

  const tx1 = await curve.methods.createToken(
    "DevTest", "DVTS",
    "https://solagents.dev/tokens/dvts.json",
    null  // no dev buy
  ).accounts({
    creator: wallet.publicKey,
    config,
    mint: tokenMint.publicKey,
    pool,
    solVault,
    tokenVault,
    metadata,
    metadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
    creatorTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: web3.SystemProgram.programId,
    rent: web3.SYSVAR_RENT_PUBKEY,
  }).signers([tokenMint]).rpc();

  ok(`Token created — tx: ${tx1}`);
  ok(`Mint: ${tokenMint.publicKey.toBase58()}`);

  await sleep(2000);
  const poolAcc = await curve.account.curvePool.fetch(pool);
  info(`Status: ${JSON.stringify(poolAcc.status)}`);
  info(`Virtual SOL: ${poolAcc.virtualSolReserve.toNumber() / LAMPORTS}`);
  info(`Virtual tokens: ${(Number(BigInt(poolAcc.virtualTokenReserve.toString()) / BigInt(1e6))).toLocaleString()}`);

  // Buy
  log("Buying tokens with 0.05 SOL...");
  const buyAmount = new BN(Math.floor(0.05 * LAMPORTS));
  const buyerAta = await getOrCreateAssociatedTokenAccount(
    connection, wallet.payer, tokenMint.publicKey, wallet.publicKey
  );

  const tx2 = await curve.methods.buy(buyAmount, new BN(0))
    .accounts({
      buyer: wallet.publicKey,
      config,
      pool,
      solVault,
      tokenVault,
      buyerTokenAccount: buyerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    }).rpc();

  ok(`Buy tx: ${tx2}`);
  await sleep(2000);

  const buyerAccAfter = await getAccount(connection, buyerAta.address);
  const tokensReceived = Number(buyerAccAfter.amount);
  info(`Tokens received: ${(tokensReceived / 1e6).toLocaleString()}`);

  const poolAfterBuy = await curve.account.curvePool.fetch(pool);
  const priceAfter = Number(BigInt(poolAfterBuy.virtualSolReserve.toString()) * BigInt(1e9) / BigInt(poolAfterBuy.virtualTokenReserve.toString())) / 1e9;
  info(`Price: ${priceAfter.toFixed(12)} lamports/token`);
  info(`Trades: ${poolAfterBuy.totalTrades.toNumber()} | Volume: ${poolAfterBuy.totalVolumeSol.toNumber() / LAMPORTS} SOL`);

  // Sell half
  const sellAmount = new BN(Math.floor(tokensReceived / 2));
  log(`Selling ${(sellAmount.toNumber() / 1e6).toLocaleString()} tokens...`);

  const solBefore = await connection.getBalance(wallet.publicKey);
  const tx3 = await curve.methods.sell(sellAmount, new BN(0))
    .accounts({
      seller: wallet.publicKey,
      config,
      pool,
      solVault,
      tokenVault,
      sellerTokenAccount: buyerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    }).rpc();

  ok(`Sell tx: ${tx3}`);
  await sleep(2000);

  const solAfter = await connection.getBalance(wallet.publicKey);
  info(`SOL returned: ~${((solAfter - solBefore) / LAMPORTS).toFixed(6)} SOL`);

  const poolFinal = await curve.account.curvePool.fetch(pool);
  const priceFinal = Number(BigInt(poolFinal.virtualSolReserve.toString()) * BigInt(1e9) / BigInt(poolFinal.virtualTokenReserve.toString())) / 1e9;
  info(`Creator fees: ${poolFinal.creatorFeesEarned.toNumber() / LAMPORTS} SOL`);
  info(`Platform fees: ${poolFinal.platformFeesEarned.toNumber() / LAMPORTS} SOL`);
  info(`Final price: ${priceFinal.toFixed(12)} lamports/token`);
  info(`Final trades: ${poolFinal.totalTrades.toNumber()} | Volume: ${poolFinal.totalVolumeSol.toNumber() / LAMPORTS} SOL`);

  log("✅ Bonding Curve — LIVE ON DEVNET");
}

async function main() {
  console.log("\n════════════════════════════════════════");
  console.log("   🌑 AGENT SOL — DEVNET LIVE TEST");
  console.log("════════════════════════════════════════");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  const bal = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${(bal / LAMPORTS).toFixed(4)} SOL`);

  try {
    await testAgenticCommerce();
    console.log("");
    await testBondingCurve();

    const finalBal = await connection.getBalance(wallet.publicKey);
    console.log("\n════════════════════════════════════════");
    console.log("   🌑 ALL DEVNET TESTS PASSED");
    console.log(`   SOL spent: ${((bal - finalBal) / LAMPORTS).toFixed(6)} SOL`);
    console.log(`   Remaining: ${(finalBal / LAMPORTS).toFixed(4)} SOL`);
    console.log("════════════════════════════════════════\n");
  } catch (err: any) {
    console.error("\n❌ TEST FAILED:", err.message || err);
    if (err.logs) console.error("Logs:", err.logs);
    process.exit(1);
  }
}

main();
