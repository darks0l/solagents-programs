import nacl from 'tweetnacl';

// tweetnacl-util is CJS — import default and destructure
import tnaclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64 } = tnaclUtil;

/**
 * E2E encryption for agent messaging.
 * Uses X25519 key exchange + XSalsa20-Poly1305 (NaCl box).
 * 
 * Flow:
 * 1. Sender generates ephemeral X25519 keypair
 * 2. Derives shared secret: ephemeral_secret + recipient_public
 * 3. Encrypts payload with shared secret + random nonce
 * 4. Sends: encrypted_payload + nonce + ephemeral_pubkey
 * 5. Recipient derives same shared secret: ephemeral_pubkey + recipient_secret
 * 6. Decrypts payload
 */

/**
 * Generate a new X25519 keypair for an agent.
 * The public key is stored in the registry; the secret key stays with the agent.
 */
export function generateKeyPair() {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
}

/**
 * Encrypt a message for a specific recipient.
 * @param {string} plaintext - The message to encrypt
 * @param {string} recipientPublicKeyB64 - Recipient's X25519 public key (base64)
 * @returns {{ encrypted: string, nonce: string, ephemeralPubKey: string }}
 */
export function encryptMessage(plaintext, recipientPublicKeyB64) {
  const recipientPubKey = decodeBase64(recipientPublicKeyB64);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);

  const encrypted = nacl.box(messageBytes, nonce, recipientPubKey, ephemeral.secretKey);

  if (!encrypted) throw new Error('Encryption failed');

  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
    ephemeralPubKey: encodeBase64(ephemeral.publicKey),
  };
}

/**
 * Decrypt a message using recipient's secret key.
 * @param {string} encryptedB64 - Encrypted payload (base64)
 * @param {string} nonceB64 - Nonce (base64)
 * @param {string} ephemeralPubKeyB64 - Sender's ephemeral public key (base64)
 * @param {string} recipientSecretKeyB64 - Recipient's secret key (base64)
 * @returns {string} Decrypted plaintext
 */
export function decryptMessage(encryptedB64, nonceB64, ephemeralPubKeyB64, recipientSecretKeyB64) {
  const encrypted = decodeBase64(encryptedB64);
  const nonce = decodeBase64(nonceB64);
  const ephemeralPubKey = decodeBase64(ephemeralPubKeyB64);
  const recipientSecretKey = decodeBase64(recipientSecretKeyB64);

  const decrypted = nacl.box.open(encrypted, nonce, ephemeralPubKey, recipientSecretKey);

  if (!decrypted) throw new Error('Decryption failed — invalid key or tampered message');

  return new TextDecoder().decode(decrypted);
}

/**
 * Verify a Solana wallet signature (ed25519).
 * Used to authenticate agents by proving wallet ownership.
 * @param {string} message - The signed message
 * @param {string} signatureB64 - Signature (base64)
 * @param {string} publicKeyB64 - Solana wallet public key (base64)
 * @returns {boolean}
 */
export function verifyWalletSignature(message, signatureB64, publicKeyB64) {
  const messageBytes = new TextEncoder().encode(message);
  const signature = decodeBase64(signatureB64);
  const publicKey = decodeBase64(publicKeyB64);
  return nacl.sign.detached.verify(messageBytes, signature, publicKey);
}

/**
 * Generate a challenge nonce for wallet auth.
 */
export function generateChallenge() {
  const nonce = nacl.randomBytes(32);
  return encodeBase64(nonce);
}
