import { uploadImage, uploadMetadataJson } from '../services/ipfs.js';

export default async function uploadRoutes(fastify, { stmts }) {
  // Upload logo image — returns IPFS CID + gateway URL
  // Max 5MB, images only
  fastify.post('/api/upload/logo', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    // Validate image type
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowed.includes(data.mimetype)) {
      return reply.code(400).send({ error: `Invalid file type: ${data.mimetype}. Allowed: png, jpg, gif, webp, svg` });
    }

    // Read buffer
    const chunks = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // 5MB limit
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.code(400).send({ error: 'File too large. Max 5MB.' });
    }

    try {
      const result = await uploadImage(buffer, data.filename, data.mimetype);
      return {
        success: true,
        cid: result.cid,
        ipfsUri: result.uri,
        gatewayUrl: result.gateway,
      };
    } catch (err) {
      fastify.log.error(err, 'IPFS upload failed');
      return reply.code(500).send({ error: 'IPFS upload failed', details: err.message });
    }
  });

  // Pin complete metadata JSON to IPFS
  // Used during tokenization — after logo is uploaded, build full metadata and pin it
  fastify.post('/api/upload/metadata', async (request, reply) => {
    const { name, symbol, description, image, external_url, attributes, properties, socials } = request.body || {};

    if (!name || !symbol) return reply.code(400).send({ error: 'name and symbol required' });

    const metadata = {
      name,
      symbol,
      description: description || '',
      image: image || '',
      external_url: external_url || '',
      attributes: attributes || [],
      properties: {
        ...(properties || {}),
        category: 'agent',
      },
    };

    // Add social links if provided
    if (socials) {
      metadata.properties.socials = {};
      if (socials.twitter) metadata.properties.socials.twitter = socials.twitter;
      if (socials.telegram) metadata.properties.socials.telegram = socials.telegram;
      if (socials.discord) metadata.properties.socials.discord = socials.discord;
      if (socials.website) metadata.properties.socials.website = socials.website;
    }

    try {
      const result = await uploadMetadataJson(metadata, `${symbol}-${name}`);
      return {
        success: true,
        cid: result.cid,
        ipfsUri: result.uri,
        gatewayUrl: result.gateway,
        metadata,
      };
    } catch (err) {
      fastify.log.error(err, 'IPFS metadata upload failed');
      return reply.code(500).send({ error: 'Metadata IPFS upload failed', details: err.message });
    }
  });
}
