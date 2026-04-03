import { PublicKey } from '@solana/web3.js';
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from('config')],
  new PublicKey('Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx')
);
console.log(pda.toBase58());
