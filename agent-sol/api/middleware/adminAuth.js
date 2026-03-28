/**
 * Admin Authentication Middleware
 * Wallet-based admin auth using Phantom ed25519 signature verification.
 *
 * Auth header format: X-Admin-Auth: <walletAddress>:<signatureB64>:<timestamp>
 * Signed message:    SolAgentsAdmin:<wallet>:<timestamp>
 *
 * Roles:
 *   superAdmin — full access + admin management
 *   admin      — dashboard + trigger operations
 *   token_manager — reset tokens, update mints
 *   pool_manager  — trigger graduation
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { verifyWalletSignature } from '../services/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMINS_PATH = join(__dirname, '..', 'config', 'admins.json');
const AUTH_WINDOW = 300; // 5 minutes

// ── Admin config helpers ────────────────────────────────────

function loadAdmins() {
  try {
    return JSON.parse(readFileSync(ADMINS_PATH, 'utf-8'));
  } catch {
    return { superAdmins: [], admins: [], roles: { token_manager: [], pool_manager: [] } };
  }
}

function saveAdmins(data) {
  writeFileSync(ADMINS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Check if a wallet has a specific admin level.
 * @param {string} wallet
 * @param {'superAdmin'|'admin'|string} level — 'superAdmin', 'admin', or a role name
 * @returns {boolean}
 */
function hasAccess(wallet, level) {
  const cfg = loadAdmins();

  // superAdmins can do everything
  if (cfg.superAdmins.includes(wallet)) return true;

  if (level === 'superAdmin') return false; // only explicit superAdmins

  // admins can do admin-level things
  if (cfg.admins.includes(wallet)) {
    if (level === 'admin') return true;
    // admins also have all roles
    return true;
  }

  // role-specific check
  if (level !== 'admin' && level !== 'superAdmin') {
    return cfg.roles?.[level]?.includes(wallet) ?? false;
  }

  return false;
}

// ── Signature verification ──────────────────────────────────

async function verifyAdminHeader(request) {
  const header = request.headers['x-admin-auth'];
  if (!header) return { valid: false, error: 'Missing X-Admin-Auth header' };

  const parts = header.split(':');
  if (parts.length < 3) {
    return { valid: false, error: 'Invalid X-Admin-Auth format. Expected: <wallet>:<signatureB64>:<timestamp>' };
  }

  // Wallet address may contain colons? No — base58. Last part is timestamp, second-to-last is sig, first is wallet.
  // But base64 can contain chars... safer: timestamp is last, sig is second-to-last, wallet is everything before.
  const timestamp = parts[parts.length - 1];
  const signatureB64 = parts[parts.length - 2];
  const wallet = parts.slice(0, parts.length - 2).join(':');

  if (!wallet || !signatureB64 || !timestamp) {
    return { valid: false, error: 'Invalid X-Admin-Auth format' };
  }

  const ts = parseInt(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > AUTH_WINDOW) {
    return { valid: false, error: 'Admin auth token expired (>5 min drift)' };
  }

  // Verify ed25519 signature
  const message = `SolAgentsAdmin:${wallet}:${timestamp}`;
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const pubkeyBytes = new PublicKey(wallet).toBytes();
    const pubkeyB64 = Buffer.from(pubkeyBytes).toString('base64');

    const valid = verifyWalletSignature(message, signatureB64, pubkeyB64);
    if (!valid) return { valid: false, error: 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: `Auth error: ${err.message}` };
  }

  return { valid: true, wallet };
}

// ── Fastify hooks ───────────────────────────────────────────

/**
 * Requires any admin level (superAdmin, admin, or any role holder).
 */
export async function adminAuthHook(request, reply) {
  const result = await verifyAdminHeader(request);
  if (!result.valid) {
    return reply.code(401).send({ error: result.error });
  }

  // Must be at least admin-level or have any role
  if (!hasAccess(result.wallet, 'admin')) {
    // Check if they have any role at all
    const cfg = loadAdmins();
    const hasAnyRole = Object.values(cfg.roles || {}).some(arr => arr.includes(result.wallet));
    if (!hasAnyRole) {
      return reply.code(403).send({ error: 'Not an admin' });
    }
  }

  request.adminWallet = result.wallet;
  request.isSuperAdmin = loadAdmins().superAdmins.includes(result.wallet);
}

/**
 * Requires superAdmin level.
 */
export async function superAdminHook(request, reply) {
  const result = await verifyAdminHeader(request);
  if (!result.valid) {
    return reply.code(401).send({ error: result.error });
  }

  if (!hasAccess(result.wallet, 'superAdmin')) {
    return reply.code(403).send({ error: 'Super admin access required' });
  }

  request.adminWallet = result.wallet;
  request.isSuperAdmin = true;
}

/**
 * Requires admin level OR a specific role.
 * Usage: { preHandler: roleCheck('pool_manager') }
 */
export function roleCheck(role) {
  return async function roleCheckHook(request, reply) {
    const result = await verifyAdminHeader(request);
    if (!result.valid) {
      return reply.code(401).send({ error: result.error });
    }

    if (!hasAccess(result.wallet, role)) {
      return reply.code(403).send({ error: `Access denied. Requires admin or ${role} role.` });
    }

    request.adminWallet = result.wallet;
    request.isSuperAdmin = loadAdmins().superAdmins.includes(result.wallet);
  };
}

// Export helpers for admin routes to manage the whitelist
export { loadAdmins, saveAdmins };
