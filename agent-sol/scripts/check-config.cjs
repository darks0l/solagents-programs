const anchor = require("@coral-xyz/anchor");
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const prog = anchor.workspace.AgenticCommerce;
const [pda] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
prog.account.platformConfig.fetch(pda).then(c => {
  for (const [k,v] of Object.entries(c)) {
    console.log(k+":", v?.toBase58 ? v.toBase58() : v?.toString());
  }
}).catch(console.error);
