const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

async function main() {
  // Load provider from Anchor.toml (devnet)
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "..", "target", "idl", "bonding_curve.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  
  const PROGRAM_ID = new PublicKey("nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof");
  const program = new anchor.Program(idl, provider);

  // Derive config PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("curve_config")],
    PROGRAM_ID
  );
  console.log("Config PDA:", configPda.toBase58());
  console.log("Admin/Treasury:", provider.wallet.publicKey.toBase58());

  // Check if already initialized
  try {
    const existing = await program.account.curveConfig.fetch(configPda);
    console.log("Config already initialized:", existing);
    return;
  } catch (e) {
    console.log("Config not initialized yet, proceeding...");
  }

  // Parameters matching MetaCaptain's spec
  const creatorFeeBps = 140;       // 1.4%
  const platformFeeBps = 60;       // 0.6%
  const graduationThreshold = new anchor.BN("85000000000");  // 85 SOL in lamports
  const totalSupply = new anchor.BN("1000000000000000000");  // 1B with 9 decimals
  const decimals = 9;
  const initialVirtualSol = new anchor.BN("30000000000");    // 30 SOL in lamports
  const treasury = provider.wallet.publicKey;

  console.log("\nInitializing bonding curve config:");
  console.log("  Creator fee:", creatorFeeBps, "bps (1.4%)");
  console.log("  Platform fee:", platformFeeBps, "bps (0.6%)");
  console.log("  Total fee:", creatorFeeBps + platformFeeBps, "bps (2%)");
  console.log("  Graduation threshold: 85 SOL");
  console.log("  Total supply: 1,000,000,000 tokens (9 decimals)");
  console.log("  Initial virtual SOL: 30 SOL");
  console.log("  Treasury:", treasury.toBase58());

  const tx = await program.methods
    .initialize(
      creatorFeeBps,
      platformFeeBps,
      graduationThreshold,
      totalSupply,
      decimals,
      initialVirtualSol,
      treasury
    )
    .accountsPartial({
      admin: provider.wallet.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\n✅ Bonding curve initialized!");
  console.log("TX:", tx);

  // Verify
  const config = await program.account.curveConfig.fetch(configPda);
  console.log("\nVerified config:");
  console.log("  Admin:", config.admin.toBase58());
  console.log("  Treasury:", config.treasury.toBase58());
  console.log("  Creator fee:", config.creatorFeeBps, "bps");
  console.log("  Platform fee:", config.platformFeeBps, "bps");
  console.log("  Graduation threshold:", config.graduationThreshold.toString(), "lamports");
  console.log("  Total supply:", config.totalSupply.toString());
  console.log("  Decimals:", config.decimals);
  console.log("  Initial virtual SOL:", config.initialVirtualSol.toString(), "lamports");
  console.log("  Paused:", config.paused);
  console.log("  Tokens created:", config.tokensCreated);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
