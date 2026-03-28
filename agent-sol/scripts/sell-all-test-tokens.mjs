/**
 * Sell all test tokens back to bonding curve pools to recover devnet SOL.
 * Uses the deployer keypair to sign.
 */
import { Connection, PublicKey, Keypair, Transaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import anchor from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN } = anchor;
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load deployer
const keyPath = process.env.DEPLOYER_KEY || join(ROOT, '..', '.keys', 'agent-sol-deploy.json');
const deployer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf-8'))));
console.log(`Deployer: ${deployer.publicKey.toBase58()}`);

// RPC
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

// Load IDL
const idl = JSON.parse(readFileSync(join(ROOT, 'api', 'idl', 'bonding_curve.json'), 'utf-8'));
const PROGRAM_ID = new PublicKey('nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof');

const wallet = { publicKey: deployer.publicKey, signTransaction: async (tx) => { tx.sign(deployer); return tx; }, signAllTransactions: async (txs) => { txs.forEach(t => t.sign(deployer)); return txs; } };
const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });
const program = new Program(idl, provider);

// PDA helpers
function getCurvePoolPDA(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('curve_pool'), mint.toBuffer()], PROGRAM_ID);
}
function getSolVaultPDA(pool) {
  return PublicKey.findProgramAddressSync([Buffer.from('sol_vault'), pool.toBuffer()], PROGRAM_ID);
}
function getTokenVaultPDA(pool) {
  return PublicKey.findProgramAddressSync([Buffer.from('token_vault'), pool.toBuffer()], PROGRAM_ID);
}
function getCurveConfigPDA() {
  return PublicKey.findProgramAddressSync([Buffer.from('curve_config')], PROGRAM_ID);
}

// Tokens to sell (the 4 big GradTest pools + smaller test tokens, skip DARK)
const DARK_MINT = 'EGP6Htc7afo65XRJ3DTxSVzHiYp2RrgFysGCHVXXVKfG';

const tokensToSell = [
  { mint: 'G5XWj9YpLL2XwYiAnmKNL6v1w89YmnrroBcxdSAsS938', name: 'GradTest 1', balance: '89253187613843352' },
  { mint: '5CYUiTLQEdNhLb9d7YU3w8LobgscuowVEURRoAbzfLU6', name: 'GradTest 2', balance: '89253187613843352' },
  { mint: 'C6TehvhHwLJLhKQHe61DkejSJa8oVxmhZwjom6kuE5L4', name: 'GradTest 3', balance: '89253187613843352' },
  { mint: '2BNuCmcSC9iDt1iqDiUQFTj79Rdvb1imQWdAD4d3RFWL', name: 'GradTest 4', balance: '89253187613843352' },
  { mint: '3jfJKu5y58Ch3WFxK8FHFnXoFHv7SxqiKhafQxHMAyNs', name: 'GradTest 5', balance: '89253187613843352' },
  { mint: 'HkMW7ozCyvTGxxUTxbDBY4kRwtT2xf5rbtmzJjAnXBGK', name: 'test 1', balance: '1630669905820494' },
  { mint: 'APEe179HcUkJneUm5jabDFynuN4xqrJHsCzESViyAHJK', name: 'test 2', balance: '815334952910247' },
];

async function sellToken(mintStr, name, balanceStr) {
  const mint = new PublicKey(mintStr);
  const [pool] = getCurvePoolPDA(mint);
  const [solVault] = getSolVaultPDA(pool);
  const [tokenVault] = getTokenVaultPDA(pool);
  const [configPDA] = getCurveConfigPDA();
  const sellerATA = await getAssociatedTokenAddress(mint, deployer.publicKey);

  // Check actual token balance
  try {
    const tokenBalance = await conn.getTokenAccountBalance(sellerATA);
    const rawAmount = tokenBalance.value.amount;
    if (rawAmount === '0') {
      console.log(`  ${name}: balance is 0, skipping`);
      return 0;
    }
    console.log(`  ${name}: selling ${tokenBalance.value.uiAmountString} tokens...`);

    const ix = await program.methods
      .sell(new BN(rawAmount), new BN(0)) // minSolOut = 0 for devnet cleanup
      .accounts({
        seller: deployer.publicKey,
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
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: deployer.publicKey });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ix);
    tx.sign(deployer);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`  ✅ ${name} sold! TX: ${sig}`);
    return 1;
  } catch (err) {
    console.error(`  ❌ ${name} failed: ${err.message}`);
    return 0;
  }
}

async function main() {
  const balBefore = await conn.getBalance(deployer.publicKey);
  console.log(`\nSOL balance before: ${balBefore / 1e9}`);
  console.log(`\nSelling ${tokensToSell.length} test tokens...\n`);

  let sold = 0;
  for (const t of tokensToSell) {
    sold += await sellToken(t.mint, t.name, t.balance);
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  const balAfter = await conn.getBalance(deployer.publicKey);
  console.log(`\n═══════════════════════════════════════`);
  console.log(`Sold: ${sold}/${tokensToSell.length}`);
  console.log(`SOL before: ${balBefore / 1e9}`);
  console.log(`SOL after:  ${balAfter / 1e9}`);
  console.log(`SOL recovered: ${(balAfter - balBefore) / 1e9}`);
  console.log(`═══════════════════════════════════════`);
}

main().catch(console.error);
