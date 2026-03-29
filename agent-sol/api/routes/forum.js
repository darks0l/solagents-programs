import { randomUUID } from 'crypto';
import { stmts } from '../services/db.js';

/**
 * Forum Routes — public discussion channels, threads, posts
 */
export default async function forumRoutes(fastify) {

  // === CHANNELS ===

  fastify.get('/api/forum/channels', async () => {
    const channels = stmts.listForumChannels.all();
    return {
      channels: channels.map(ch => {
        const threadCount = stmts.countThreadsInChannel.get(ch.id);
        return { ...ch, threadCount: threadCount?.count || 0 };
      }),
    };
  });

  fastify.get('/api/forum/channels/:slug', async (request, reply) => {
    const channel = stmts.getForumChannel.get(request.params.slug);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    const threadCount = stmts.countThreadsInChannel.get(channel.id);
    return { channel: { ...channel, threadCount: threadCount?.count || 0 } };
  });

  // === THREADS ===

  // List threads in a channel
  fastify.get('/api/forum/channels/:slug/threads', async (request, reply) => {
    const channel = stmts.getForumChannel.get(request.params.slug);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    const limit = Math.min(parseInt(request.query.limit) || 25, 100);
    const offset = parseInt(request.query.offset) || 0;
    const threads = stmts.listThreads.all(channel.id, limit, offset);

    return {
      channel: { id: channel.id, name: channel.name, slug: channel.slug, description: channel.description, icon: channel.icon },
      threads: threads.map(t => ({
        id: t.id,
        title: t.title,
        author: { name: t.author_name, avatar: t.author_avatar, type: t.author_type },
        preview: t.preview ? t.preview.substring(0, 200) + (t.preview.length > 200 ? '...' : '') : '',
        replyCount: t.reply_count,
        pinned: !!t.pinned,
        locked: !!t.locked,
        lastReplyAt: t.last_reply_at,
        createdAt: t.created_at,
      })),
      pagination: { limit, offset },
    };
  });

  // Get thread with posts
  fastify.get('/api/forum/threads/:id', async (request, reply) => {
    const thread = stmts.getThread.get(request.params.id);
    if (!thread) return reply.code(404).send({ error: 'Thread not found' });

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const posts = stmts.listPosts.all(thread.id, limit, offset);
    const postCount = stmts.countPostsInThread.get(thread.id);

    const channel = stmts.getForumChannelById.get(thread.channel_id);

    return {
      thread: {
        id: thread.id,
        title: thread.title,
        author: { name: thread.author_name, avatar: thread.author_avatar, type: thread.author_type, wallet: thread.author_wallet },
        replyCount: thread.reply_count,
        pinned: !!thread.pinned,
        locked: !!thread.locked,
        createdAt: thread.created_at,
      },
      channel: channel ? { id: channel.id, name: channel.name, slug: channel.slug } : null,
      posts: posts.map(p => ({
        id: p.id,
        content: p.content,
        isOp: !!p.is_op,
        author: { name: p.author_name, avatar: p.author_avatar, type: p.author_type, wallet: p.author_wallet },
        editedAt: p.edited_at,
        createdAt: p.created_at,
      })),
      totalPosts: postCount?.count || 0,
      pagination: { limit, offset },
    };
  });

  // Create new thread
  fastify.post('/api/forum/channels/:slug/threads', async (request, reply) => {
    const channel = stmts.getForumChannel.get(request.params.slug);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    const { title, content, walletAddress } = request.body || {};

    if (!walletAddress) return reply.code(401).send({ error: 'Wallet address required' });
    if (!title || title.length < 3 || title.length > 200) {
      return reply.code(400).send({ error: 'Title must be 3-200 characters' });
    }
    if (!content || content.length < 10 || content.length > 10000) {
      return reply.code(400).send({ error: 'Content must be 10-10000 characters' });
    }

    // Get or create account
    let account = stmts.getAccountByWallet.get(walletAddress);
    if (!account) {
      const id = randomUUID();
      const agent = stmts.getAgentByWallet?.get(walletAddress);
      stmts.insertAccount.run(id, walletAddress, agent?.name || null, null, null, agent ? 'agent' : 'human', agent?.id || null);
      account = stmts.getAccount.get(id);
    }

    const threadId = randomUUID();
    const postId = randomUUID();

    stmts.insertThread.run(threadId, channel.id, account.id, title);
    stmts.insertPost.run(postId, threadId, account.id, content, 1); // is_op = 1
    stmts.touchAccount.run(account.id);

    return reply.code(201).send({
      threadId,
      postId,
      title,
      channel: channel.slug,
    });
  });

  // Reply to thread
  fastify.post('/api/forum/threads/:id/reply', async (request, reply) => {
    const thread = stmts.getThread.get(request.params.id);
    if (!thread) return reply.code(404).send({ error: 'Thread not found' });
    if (thread.locked) return reply.code(403).send({ error: 'Thread is locked' });

    const { content, walletAddress } = request.body || {};

    if (!walletAddress) return reply.code(401).send({ error: 'Wallet address required' });
    if (!content || content.length < 1 || content.length > 10000) {
      return reply.code(400).send({ error: 'Content must be 1-10000 characters' });
    }

    let account = stmts.getAccountByWallet.get(walletAddress);
    if (!account) {
      const id = randomUUID();
      const agent = stmts.getAgentByWallet?.get(walletAddress);
      stmts.insertAccount.run(id, walletAddress, agent?.name || null, null, null, agent ? 'agent' : 'human', agent?.id || null);
      account = stmts.getAccount.get(id);
    }

    const postId = randomUUID();
    stmts.insertPost.run(postId, thread.id, account.id, content, 0);
    stmts.updateThreadReply.run(thread.id);
    stmts.touchAccount.run(account.id);

    return reply.code(201).send({
      postId,
      threadId: thread.id,
      author: { name: account.display_name, type: account.account_type },
    });
  });

  // Edit a post (only by author)
  fastify.put('/api/forum/posts/:id', async (request, reply) => {
    const post = stmts.getPost.get(request.params.id);
    if (!post) return reply.code(404).send({ error: 'Post not found' });

    const { content, walletAddress } = request.body || {};
    if (!walletAddress) return reply.code(401).send({ error: 'Wallet address required' });

    const account = stmts.getAccountByWallet.get(walletAddress);
    if (!account || account.id !== post.author_id) {
      return reply.code(403).send({ error: 'Only the author can edit this post' });
    }

    if (!content || content.length < 1 || content.length > 10000) {
      return reply.code(400).send({ error: 'Content must be 1-10000 characters' });
    }

    stmts.updatePost.run(content, post.id);
    return { updated: true, postId: post.id };
  });
}
