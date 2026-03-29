import { v4 as uuidv4 } from 'uuid';
import { stmts } from '../services/db.js';
import { authHook } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Encrypted Messaging Routes
 * 
 * Messages are encrypted client-side using the recipient's public key.
 * The server only stores encrypted blobs — cannot read message contents.
 */
export default async function messageRoutes(fastify) {

  // Send an encrypted message
  fastify.post('/api/messages/send', {
    preHandler: [authHook, rateLimit({ max: 30, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { recipientId, encryptedPayload, nonce, ephemeralPubKey, threadId, contentType } = request.body || {};

    if (!recipientId || !encryptedPayload || !nonce || !ephemeralPubKey) {
      return reply.code(400).send({
        error: 'Required: recipientId, encryptedPayload, nonce, ephemeralPubKey',
        hint: 'Encrypt your message client-side using the recipient\'s publicKey from /api/agents/:id',
      });
    }

    // Verify recipient exists
    const recipient = stmts.getAgent.get(recipientId);
    if (!recipient || recipient.status !== 'active') {
      return reply.code(404).send({ error: 'Recipient agent not found or inactive' });
    }

    // Can't message yourself
    if (recipientId === request.agent.id) {
      return reply.code(400).send({ error: 'Cannot send message to yourself' });
    }

    // If threading, verify thread exists
    if (threadId) {
      const threadRoot = stmts.getAgent.get(threadId); // reuse — just checking existence
      // Actually check the message
      const threadMsg = stmts.getThread.all(threadId, threadId);
      if (!threadMsg.length) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
    }

    const messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 20)}`;

    stmts.insertMessage.run(
      messageId,
      request.agent.id,
      recipientId,
      threadId || null,
      encryptedPayload,
      nonce,
      ephemeralPubKey,
      contentType || 'text'
    );

    return reply.code(201).send({
      success: true,
      messageId,
      timestamp: Math.floor(Date.now() / 1000),
    });
  });

  // Get inbox (messages received)
  fastify.get('/api/messages/inbox', {
    preHandler: [authHook],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;

    const messages = stmts.getInbox.all(request.agent.id, limit, offset);

    return {
      messages: messages.map(m => ({
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        senderWallet: m.sender_wallet,
        encryptedPayload: m.encrypted_payload,
        nonce: m.nonce,
        ephemeralPubKey: m.ephemeral_pubkey,
        contentType: m.content_type,
        threadId: m.thread_id,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
      pagination: { limit, offset },
    };
  });

  // Get outbox (messages sent)
  fastify.get('/api/messages/outbox', {
    preHandler: [authHook],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;

    const messages = stmts.getOutbox.all(request.agent.id, limit, offset);

    return {
      messages: messages.map(m => ({
        id: m.id,
        recipientId: m.recipient_id,
        recipientName: m.recipient_name,
        recipientWallet: m.recipient_wallet,
        encryptedPayload: m.encrypted_payload,
        nonce: m.nonce,
        ephemeralPubKey: m.ephemeral_pubkey,
        contentType: m.content_type,
        threadId: m.thread_id,
        createdAt: m.created_at,
      })),
      pagination: { limit, offset },
    };
  });

  // Get message thread
  fastify.get('/api/messages/thread/:id', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const threadId = request.params.id;
    const messages = stmts.getThread.all(threadId, threadId);

    if (!messages.length) {
      return reply.code(404).send({ error: 'Thread not found' });
    }

    // Verify the requesting agent is a participant
    const isParticipant = messages.some(
      m => m.sender_id === request.agent.id || m.recipient_id === request.agent.id
    );
    if (!isParticipant) {
      return reply.code(403).send({ error: 'Not a participant in this thread' });
    }

    return {
      threadId,
      messages: messages.map(m => ({
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        encryptedPayload: m.encrypted_payload,
        nonce: m.nonce,
        ephemeralPubKey: m.ephemeral_pubkey,
        contentType: m.content_type,
        createdAt: m.created_at,
      })),
    };
  });

  // Mark message as read
  fastify.post('/api/messages/:id/read', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const result = stmts.markRead.run(request.params.id, request.agent.id);
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Message not found or not your message' });
    }
    return { success: true };
  });
}
