import { PinataSDK } from 'pinata-web3';

let pinata = null;

export function initPinata(jwt) {
  if (!jwt) throw new Error('PINATA_JWT required');
  pinata = new PinataSDK({ pinataJwt: jwt, pinataGateway: 'gateway.pinata.cloud' });
}

/**
 * Upload an image file buffer to IPFS
 * @param {Buffer} buffer - file data
 * @param {string} filename - original filename
 * @param {string} mimeType - e.g. 'image/png'
 * @returns {Promise<{cid: string, uri: string, gateway: string}>}
 */
export async function uploadImage(buffer, filename, mimeType) {
  const file = new File([buffer], filename, { type: mimeType });
  const result = await pinata.upload.file(file);
  return {
    cid: result.IpfsHash,
    uri: `ipfs://${result.IpfsHash}`,
    gateway: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
  };
}

/**
 * Upload token metadata JSON to IPFS (Metaplex standard)
 * @param {object} metadata - full metadata object
 * @param {string} name - pin name for Pinata dashboard
 * @returns {Promise<{cid: string, uri: string, gateway: string}>}
 */
export async function uploadMetadataJson(metadata, name) {
  const result = await pinata.upload.json(metadata).addMetadata({ name: `${name}-metadata` });
  return {
    cid: result.IpfsHash,
    uri: `ipfs://${result.IpfsHash}`,
    gateway: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
  };
}

export function getPinata() { return pinata; }
