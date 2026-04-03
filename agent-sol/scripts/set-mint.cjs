const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

async function main() {
  // Load wallet
  const keyPath = path.join(require("os").homedir(), ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(raw)));

  // Connect
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "..", "target", "idl", "agentic_commerce.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const programId = new PublicKey("Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx");
  const program = new anchor.Program(idl, provider);

  // Circle devnet USDC
  const newMint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

  // Config PDA
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

  console.log("Config PDA:", configPda.toBase58());
  console.log("Admin:", wallet.publicKey.toBase58());
  console.log("New payment mint:", newMint.toBase58());

  // Read current config
  const configBefore = await program.account.platformConfig.fetch(configPda);
  console.log("Current payment_mint:", configBefore.paymentMint.toBase58());

  // Call set_payment_mint
  const tx = await program.methods
    .setPaymentMint()
    .accountsPartial({
      admin: wallet.publicKey,
      config: configPda,
      newPaymentMint: newMint,
    })
    .rpc();

  console.log("TX:", tx);

  // Verify
  const configAfter = await program.account.platformConfig.fetch(configPda);
  console.log("Updated payment_mint:", configAfter.paymentMint.toBase58());
  console.log("Done!");
}

main().catch(console.error);
