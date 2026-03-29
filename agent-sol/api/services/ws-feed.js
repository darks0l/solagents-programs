import { WebSocketServer } from 'ws';

/**
 * Real-time WebSocket Trade Feed
 * 
 * Clients connect to ws://host/ws/trades and receive live trade events.
 * 
 * Subscribe to specific tokens:
 *   { "subscribe": "TOKEN_ID_OR_MINT" }
 *   { "subscribe": "*" }  // all trades
 * 
 * Unsubscribe:
 *   { "unsubscribe": "TOKEN_ID_OR_MINT" }
 * 
 * Events pushed to clients:
 *   { "event": "trade", "data": { ... } }
 *   { "event": "graduation", "data": { ... } }
 *   { "event": "token_created", "data": { ... } }
 */

let wss = null;

// Map<ws, Set<tokenId>> — what each client is subscribed to
const subscriptions = new Map();

// Stats
let totalConnections = 0;
let totalTradesEmitted = 0;

export function initWsFeed(server) {
  wss = new WebSocketServer({ server, path: '/ws/trades' });

  wss.on('connection', (ws, req) => {
    totalConnections++;
    const clientId = `ws_${totalConnections}`;
    subscriptions.set(ws, new Set(['*'])); // Subscribe to all by default

    // Send welcome
    ws.send(JSON.stringify({
      event: 'connected',
      data: {
        clientId,
        message: 'Connected to SolAgents trade feed',
        commands: {
          subscribe: '{ "subscribe": "TOKEN_ID" } or { "subscribe": "*" }',
          unsubscribe: '{ "unsubscribe": "TOKEN_ID" }',
          ping: '{ "ping": true }',
        },
      },
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.ping) {
          ws.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
          return;
        }

        if (msg.subscribe) {
          const subs = subscriptions.get(ws) || new Set();
          if (msg.subscribe === '*') {
            subs.clear();
            subs.add('*');
          } else {
            subs.delete('*'); // Remove wildcard when subscribing to specific
            subs.add(msg.subscribe);
          }
          subscriptions.set(ws, subs);
          ws.send(JSON.stringify({
            event: 'subscribed',
            data: { token: msg.subscribe, active: [...subs] },
          }));
          return;
        }

        if (msg.unsubscribe) {
          const subs = subscriptions.get(ws);
          if (subs) {
            subs.delete(msg.unsubscribe);
            if (subs.size === 0) subs.add('*'); // Fallback to all
          }
          ws.send(JSON.stringify({
            event: 'unsubscribed',
            data: { token: msg.unsubscribe, active: [...(subs || ['*'])] },
          }));
          return;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      subscriptions.delete(ws);
    });

    ws.on('error', () => {
      subscriptions.delete(ws);
    });
  });

  // Heartbeat to keep connections alive
  const interval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  console.log('📡 WebSocket trade feed initialized at /ws/trades');
}

/**
 * Emit a trade event to all subscribed clients
 */
export function emitTrade(tokenId, tradeData) {
  if (!wss) return;
  totalTradesEmitted++;

  const payload = JSON.stringify({
    event: 'trade',
    data: {
      tokenId,
      ...tradeData,
      ts: Date.now(),
    },
  });

  broadcast(tokenId, payload);
}

/**
 * Emit a new token creation event
 */
export function emitTokenCreated(tokenData) {
  if (!wss) return;

  const payload = JSON.stringify({
    event: 'token_created',
    data: {
      ...tokenData,
      ts: Date.now(),
    },
  });

  // Token creation goes to all wildcard subscribers
  broadcast('*', payload);
}

/**
 * Emit a graduation event (bonding curve → Raydium)
 */
export function emitGraduation(tokenId, graduationData) {
  if (!wss) return;

  const payload = JSON.stringify({
    event: 'graduation',
    data: {
      tokenId,
      ...graduationData,
      ts: Date.now(),
    },
  });

  broadcast(tokenId, payload);
}

/**
 * Get feed stats
 */
export function getFeedStats() {
  return {
    connected_clients: wss ? wss.clients.size : 0,
    total_connections: totalConnections,
    total_trades_emitted: totalTradesEmitted,
    subscriptions: wss ? [...subscriptions.entries()].map(([, subs]) => [...subs]) : [],
  };
}

// ── Internal ──

function broadcast(tokenId, payload) {
  if (!wss) return;

  wss.clients.forEach((ws) => {
    if (ws.readyState !== ws.OPEN) return;

    const subs = subscriptions.get(ws);
    if (!subs) return;

    // Send if subscribed to this token or to wildcard
    if (subs.has('*') || subs.has(tokenId)) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected mid-send
      }
    }
  });
}
