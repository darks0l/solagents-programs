const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

async function main() {
  const keyPath = path.join(require("os").homedir(), ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(raw)));
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "agentic_commerce.json"), "utf-8"));
  const programId = new PublicKey("Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx");
  const program = new anchor.Program(idl, provider);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const c = await program.account.platformConfig.fetch(configPda);
  console.log("admin:", c.admin.toBase58());
  console.log("treasury:", c.treasury.toBase58());
  console.log("paymentMint:", c.paymentMint.toBase58());
  console.log("feeBps:", c.feeBps);
  console.log("jobCounter:", c.jobCounter.toString());
}
main().catch(console.error);
