/**
 * Create a real on-chain token via the bonding curve program on devnet.
 * Uses raw transaction building to avoid Anchor CJS/ESM issues.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  Connection, Keypair, PublicKey, SystemProgram, 
  SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, Transaction, TransactionInstruction
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require('@solana/spl-token');
const borsh = require('borsh');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load deployer key
const keyPath = path.join(process.cwd(), '.keys', 'deployer.json');
const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
const deployer = Keypair.fromSecretKey(Uint8Array.from(keyData));

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const PROGRAM_ID = new PublicKey('nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof');
const MPL = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Anchor instruction discriminator = sha256("global:create_token")[0..8]
function getDiscriminator(name) {
  const hash = crypto.createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

// Borsh serialize create_token args: name (string), symbol (string), uri (string), dev_buy_sol (Option<u64>)
function serializeCreateTokenArgs(name, symbol, uri, devBuySol = null) {
  const disc = getDiscriminator('create_token');
  
  // Manual serialization: discriminator + borsh string + string + string + option<u64>
  const nameBytes = Buffer.from(name, 'utf-8');
  const symbolBytes = Buffer.from(symbol, 'utf-8');
  const uriBytes = Buffer.from(uri, 'utf-8');
  
  // Calculate total size
  let size = 8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 1;
  if (devBuySol !== null) size += 8;
  
  const buf = Buffer.alloc(size);
  let offset = 0;
  
  // Discriminator
  disc.copy(buf, offset); offset += 8;
  
  // String: 4-byte length + bytes
  buf.writeUInt32LE(nameBytes.length, offset); offset += 4;
  nameBytes.copy(buf, offset); offset += nameBytes.length;
  
  buf.writeUInt32LE(symbolBytes.length, offset); offset += 4;
  symbolBytes.copy(buf, offset); offset += symbolBytes.length;
  
  buf.writeUInt32LE(uriBytes.length, offset); offset += 4;
  uriBytes.copy(buf, offset); offset += uriBytes.length;
  
  // Option<u64>: 0 = None, 1 + u64 = Some
  if (devBuySol === null) {
    buf.writeUInt8(0, offset); offset += 1;
  } else {
    buf.writeUInt8(1, offset); offset += 1;
    buf.writeBigUInt64LE(BigInt(devBuySol), offset); offset += 8;
  }
  
  return buf;
}

async function main() {
  console.log('Deployer:', deployer.publicKey.toBase58());
  const bal = await conn.getBalance(deployer.publicKey);
  console.log('Balance:', bal / LAMPORTS_PER_SOL, 'SOL');

  const mintKp = Keypair.generate();
  console.log('Mint:', mintKp.publicKey.toBase58());

  // Derive PDAs
  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('curve_config')], PROGRAM_ID);
  const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from('curve_pool'), mintKp.publicKey.toBuffer()], PROGRAM_ID);
  const [solVaultPDA] = PublicKey.findProgramAddressSync([Buffer.from('sol_vault'), poolPDA.toBuffer()], PROGRAM_ID);
  const [tokenVaultPDA] = PublicKey.findProgramAddressSync([Buffer.from('token_vault'), poolPDA.toBuffer()], PROGRAM_ID);
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL.toBuffer(), mintKp.publicKey.toBuffer()],
    MPL
  );
  const creatorATA = await getAssociatedTokenAddress(mintKp.publicKey, deployer.publicKey);

  console.log('Config PDA:', configPDA.toBase58());
  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Creating token: Darksol ($DARK)...');

  // Build instruction data
  const data = serializeCreateTokenArgs('Darksol', 'DARK', 'https://solagents.dev', null);

  // Account metas — must match the Anchor CreateToken accounts struct order
  const keys = [
    { pubkey: deployer.publicKey, isSigner: true, isWritable: true },    // creator
    { pubkey: configPDA, isSigner: false, isWritable: true },              // config (mut)
    { pubkey: mintKp.publicKey, isSigner: true, isWritable: true },       // mint
    { pubkey: poolPDA, isSigner: false, isWritable: true },               // pool
    { pubkey: solVaultPDA, isSigner: false, isWritable: true },           // sol_vault
    { pubkey: tokenVaultPDA, isSigner: false, isWritable: true },         // token_vault
    { pubkey: metadataPDA, isSigner: false, isWritable: true },           // metadata
    { pubkey: MPL, isSigner: false, isWritable: false },                  // metadata_program
    { pubkey: creatorATA, isSigner: false, isWritable: true },            // creator_token_account
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },   // rent
  ];

  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: deployer.publicKey });
  tx.add(ix);
  tx.sign(deployer, mintKp);

  try {
    const sig = await conn.sendRawTransaction(tx.serialize());
    console.log('\nTX sent:', sig);
    
    const latestBh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({
      signature: sig,
      blockhash: latestBh.blockhash,
      lastValidBlockHeight: latestBh.lastValidBlockHeight,
    }, 'confirmed');

    console.log('\n✅ Token created on-chain!');
    console.log('Explorer:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    console.log('Mint:', mintKp.publicKey.toBase58());
    console.log('Pool:', poolPDA.toBase58());

    // Output sync data
    console.log('\n--- SYNC DATA ---');
    console.log(JSON.stringify({
      mintAddress: mintKp.publicKey.toBase58(),
      txSignature: sig,
      poolAddress: poolPDA.toBase58(),
      name: 'Darksol',
      symbol: 'DARK',
    }));
  } catch (err) {
    console.error('Failed:', err.message);
    if (err.logs) console.error('Logs:', err.logs.join('\n'));
    
    // Try to get more details
    if (err.message?.includes('Transaction simulation failed')) {
      console.error('Full error:', JSON.stringify(err, null, 2));
    }
  }
}

main();
