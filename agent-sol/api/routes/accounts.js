import { randomUUID } from 'crypto';
import { stmts } from '../services/db.js';

/**
 * Account Routes — wallet-based auth, profile management
 */
export default async function accountRoutes(fastify) {

  // Sign in / register with wallet (creates account if new)
  fastify.post('/api/accounts/auth', async (request, reply) => {
    const { walletAddress, signature, message } = request.body || {};
    if (!walletAddress || walletAddress.length < 32) {
      return reply.code(400).send({ error: 'Valid wallet address required' });
    }

    // Check if account exists
    let account = stmts.getAccountByWallet.get(walletAddress);

    if (account) {
      stmts.touchAccount.run(account.id);
      return {
        account: formatAccount(account),
        isNew: false,
      };
    }

    // Create new account
    const id = randomUUID();
    const agent = stmts.getAgentByWallet?.get(walletAddress);
    const accountType = agent ? 'agent' : 'human';

    stmts.insertAccount.run(
      id, walletAddress,
      agent?.name || null, // default display name from agent registration
      null, null,
      accountType,
      agent?.id || null
    );

    account = stmts.getAccount.get(id);
    return {
      account: formatAccount(account),
      isNew: true,
    };
  });

  // Get account by wallet
  fastify.get('/api/accounts/wallet/:address', async (request, reply) => {
    const account = stmts.getAccountByWallet.get(request.params.address);
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    return { account: formatAccount(account) };
  });

  // Get account by ID
  fastify.get('/api/accounts/:id', async (request, reply) => {
    const account = stmts.getAccount.get(request.params.id);
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    return { account: formatAccount(account) };
  });

  // Update profile
  fastify.put('/api/accounts/:id', async (request, reply) => {
    const account = stmts.getAccount.get(request.params.id);
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const { displayName, bio, avatarUrl, callerWallet } = request.body || {};

    // Verify caller owns the account
    if (!callerWallet || callerWallet !== account.wallet_address) {
      return reply.code(403).send({ error: 'Only the wallet owner can update this profile' });
    }

    if (displayName !== undefined && (displayName.length < 1 || displayName.length > 50)) {
      return reply.code(400).send({ error: 'Display name must be 1-50 characters' });
    }
    if (bio !== undefined && bio.length > 500) {
      return reply.code(400).send({ error: 'Bio must be under 500 characters' });
    }

    stmts.updateAccount.run(
      displayName !== undefined ? displayName : account.display_name,
      bio !== undefined ? bio : account.bio,
      avatarUrl !== undefined ? avatarUrl : account.avatar_url,
      account.id
    );

    const updated = stmts.getAccount.get(account.id);
    return { account: formatAccount(updated), updated: true };
  });

  // Get current user (by wallet in header)
  fastify.get('/api/accounts/me', async (request, reply) => {
    const wallet = request.headers['x-wallet-address'];
    if (!wallet) return reply.code(401).send({ error: 'X-Wallet-Address header required' });

    const account = stmts.getAccountByWallet.get(wallet);
    if (!account) return reply.code(404).send({ error: 'Not signed in' });

    return { account: formatAccount(account) };
  });
}

function formatAccount(a) {
  return {
    id: a.id,
    walletAddress: a.wallet_address,
    displayName: a.display_name,
    bio: a.bio,
    avatarUrl: a.avatar_url,
    accountType: a.account_type,
    agentId: a.agent_id,
    createdAt: a.created_at,
    lastActive: a.last_active,
  };
}
