'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 200; // messages kept per room
const MAX_TEXT = 500; // characters per message
const MAX_NAME = 20; // characters per nickname
const MAX_ROOMS = 5000;
const MAX_PEOPLE = 30; // per room
const ROOM_ID = /^[A-Za-z0-9_-]{8,32}$/;
const SECRET = crypto.randomBytes(16).toString('hex');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10000 });

// rooms live in memory only: id -> { messages, members, lastActive }
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = { messages: [], members: new Map(), lastActive: Date.now() };
    rooms.set(id, room);
  }
  return room;
}

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function peopleOf(room) {
  const seen = new Map();
  for (const p of room.members.values()) {
    if (!seen.has(p.pid)) seen.set(p.pid, { id: p.pid, name: p.name });
  }
  return [...seen.values()];
}

// ---------- web ----------
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// The one link: opening the site drops you straight into a brand-new private room.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.redirect(302, '/r/' + crypto.randomBytes(9).toString('base64url'));
});

app.get('/r/:id', (req, res) => {
  if (!ROOM_ID.test(req.params.id)) return res.redirect(302, '/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- real time ----------
io.on('connection', (socket) => {
  let roomId = null;
  let name = 'Guest';
  const sent = []; // timestamps of recent messages, for rate limiting

  socket.on('join', (payload) => {
    if (roomId || !payload || typeof payload.room !== 'string') return;
    if (!ROOM_ID.test(payload.room)) return;

    const room = getRoom(payload.room);
    if (!room || room.members.size >= MAX_PEOPLE) {
      socket.emit('full');
      return;
    }

    const cid = typeof payload.cid === 'string' ? payload.cid.slice(0, 64) : socket.id;
    const pid = crypto
      .createHmac('sha256', SECRET)
      .update(payload.room + '|' + cid)
      .digest('hex')
      .slice(0, 16);

    roomId = payload.room;
    name = clean(payload.name, MAX_NAME) || 'Guest';
    room.members.set(socket.id, { pid, name });
    room.lastActive = Date.now();
    socket.join(roomId);

    socket.emit('joined', { you: pid });
    socket.emit('history', room.messages);
    io.to(roomId).emit('system', { text: name + ' joined' });
    io.to(roomId).emit('people', peopleOf(room));
  });

  socket.on('message', (text) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const now = Date.now();
    while (sent.length && now - sent[0] > 5000) sent.shift();
    if (sent.length >= 5) {
      socket.emit('slow');
      return;
    }

    const body = clean(text, MAX_TEXT);
    if (!body) return;
    sent.push(now);

    const msg = {
      id: crypto.randomUUID(),
      from: room.members.get(socket.id).pid,
      name,
      text: body,
      ts: now,
    };
    room.messages.push(msg);
    if (room.messages.length > MAX_HISTORY) room.messages.shift();
    room.lastActive = now;
    io.to(roomId).emit('message', msg);
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.members.delete(socket.id);
    room.lastActive = Date.now();
    io.to(roomId).emit('system', { text: name + ' left' });
    io.to(roomId).emit('people', peopleOf(room));
  });
});

// Auto-delete: drop messages older than 24h, and empty rooms after 24h of quiet.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    room.messages = room.messages.filter((m) => now - m.ts < DAY);
    if (room.members.size === 0 && now - room.lastActive > DAY) rooms.delete(id);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log('forthelovedone is running on port ' + PORT);
});
