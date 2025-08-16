/**
 * Banana Bonanza Alpha - server entry
 * - Express static hosting (/client)
 * - /healthz endpoint for Render
 * - WebSocket game server (same origin)
 */
const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const createGameServer = require('./game.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, '..', 'client')));

// Fallback to index for root (helps verify)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

createGameServer(wss); // attach game logic

server.listen(PORT, () => {
  console.log(`🍌 Banana Bonanza server listening on http://localhost:${PORT}`);
});
