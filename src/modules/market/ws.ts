import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { env } from '../../config/env.js';
import { feed, snapshot } from './feed.js';

export function attachWs(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const allowed = env.CORS_ORIGIN.split(',');
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const okPath = new URL(req.url ?? '/', 'http://x').pathname === '/ws';
    const okOrigin = !req.headers.origin || allowed.includes(req.headers.origin);
    if (!okPath || !okOrigin || wss.clients.size >= 1000) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => ws.terminate());
    ws.send(JSON.stringify({ t: 'snapshot', p: snapshot() }));
  });

  feed.on('tick', (prices) => {
    const message = JSON.stringify({ t: 'tick', p: prices });
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.get(client)) { client.terminate(); continue; }
      alive.set(client, false);
      client.ping();
    }
  }, 30_000);
  server.on('close', () => clearInterval(heartbeat));
}