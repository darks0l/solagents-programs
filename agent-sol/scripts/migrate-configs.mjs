/**
 * Migrate bonding-curve and commerce configs to new size (v2).
 * Calls migrate_config instruction on both programs using new IDLs from target/idl/.
 */
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { AnchorProvider, Program } = anchor;
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const keyPath = join(ROOT, '..', '.keys', 'agent-sol-deploy.json');
const deployer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf-8'))));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

const wallet = {
  publicKey: deployer.publicKey,
  signTransaction: async (tx) => { tx.sign(deployer); return tx; },
  signAllTransactions: async (txs) => { txs.forEach(t => t.sign(deployer)); return txs; },
};
const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });

// ── Bonding Curve ──────────────────────────────────
console.log('\n═══ Bonding Curve Config Migration ═══');
const bcIdl = JSON.parse(readFileSync(join(ROOT, 'target', 'idl', 'bonding_curve.json'), 'utf-8'));
const BC_PROGRAM_ID = new PublicKey('nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof');
const bcProgram = new Program(bcIdl, provider);

const [bcConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from('curve_config')], BC_PROGRAM_ID);
console.log(`Config PDA: ${bcConfigPDA.toBase58()}`);

const bcInfo = await conn.getAccountInfo(bcConfigPDA);
console.log(`Current size: ${bcInfo.data.length} bytes`);

try {
  const bcIx = await bcProgram.methods
    .migrateConfig()
    .accounts({
      admin: deployer.publicKey,
      config: bcConfigPDA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash } = await conn.getLatestBlockhash();
  const bcTx = new Transaction({ recentBlockhash: blockhash, feePayer: deployer.publicKey });
  bcTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  bcTx.add(bcIx);
  bcTx.sign(deployer);

  const bcSig = await conn.sendRawTransaction(bcTx.serialize());
  await conn.confirmTransaction(bcSig, 'confirmed');
  console.log(`✅ Bonding curve migrated! TX: ${bcSig}`);

  const bcInfoNew = await conn.getAccountInfo(bcConfigPDA);
  console.log(`New size: ${bcInfoNew.data.length} bytes`);
} catch (e) {
  console.error('❌ Migration failed:', e.message);
  if (e.logs) console.error(e.logs.join('\n'));
}

// ── Agentic Commerce ──────────────────────────────
console.log('\n═══ Agentic Commerce Config Migration ═══');
const acIdl = JSON.parse(readFileSync(join(ROOT, 'target', 'idl', 'agentic_commerce.json'), 'utf-8'));
const AC_PROGRAM_ID = new PublicKey('Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx');
const acProgram = new Program(acIdl, provider);

const [acConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], AC_PROGRAM_ID);
console.log(`Config PDA: ${acConfigPDA.toBase58()}`);

const acInfo = await conn.getAccountInfo(acConfigPDA);
console.log(`Current size: ${acInfo.data.length} bytes`);

try {
  const acIx = await acProgram.methods
    .migrateConfig()
    .accounts({
      admin: deployer.publicKey,
      config: acConfigPDA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash: bh2 } = await conn.getLatestBlockhash();
  const acTx = new Transaction({ recentBlockhash: bh2, feePayer: deployer.publicKey });
  acTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  acTx.add(acIx);
  acTx.sign(deployer);

  const acSig = await conn.sendRawTransaction(acTx.serialize());
  await conn.confirmTransaction(acSig, 'confirmed');
  console.log(`✅ Commerce migrated! TX: ${acSig}`);

  const acInfoNew = await conn.getAccountInfo(acConfigPDA);
  console.log(`New size: ${acInfoNew.data.length} bytes`);
} catch (e) {
  console.error('❌ Migration failed:', e.message);
  if (e.logs) console.error(e.logs.join('\n'));
}

console.log('\n✅ Done!');
const bal = await conn.getBalance(deployer.publicKey);
console.log(`Deployer balance: ${bal / 1e9} SOL`);
