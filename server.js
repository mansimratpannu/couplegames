const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { WYR, TOT, WKM } = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room

const GAME_CONFIG = {
  wyr: { count: 10 },
  tot: { count: 15 },
  wkm: { count: 10 }, // must be even so both partners are the subject equally
};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickQuestions(type) {
  const { count } = GAME_CONFIG[type];
  if (type === 'wkm') {
    return shuffle(WKM).slice(0, count);
  }
  const pool = type === 'wyr' ? WYR : TOT;
  return shuffle(pool).slice(0, count).map(([a, b]) => ({ options: [a, b] }));
}

function newGame(type) {
  return {
    type,
    questions: pickQuestions(type),
    qIndex: 0,
    answers: [null, null],
    revealed: false,
    finished: false,
    matches: 0,          // wyr + tot
    scores: [0, 0],      // wkm: points for each player as guesser
  };
}

// What each client is allowed to see. Answers stay hidden until reveal.
function publicState(room) {
  const g = room.game;
  return {
    code: room.code,
    phase: room.phase, // 'lobby' | 'menu' | 'playing'
    players: room.players.map((p) => (p ? { name: p.name, connected: p.connected } : null)),
    game: g
      ? {
          type: g.type,
          qIndex: g.qIndex,
          total: g.questions.length,
          question: g.finished ? null : g.questions[g.qIndex],
          answered: [g.answers[0] !== null, g.answers[1] !== null],
          revealed: g.revealed,
          answers: g.revealed ? g.answers : null,
          matches: g.matches,
          scores: g.scores,
          subject: g.type === 'wkm' ? g.qIndex % 2 : null,
          finished: g.finished,
        }
      : null,
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 20) || 'Player 1';
    const code = makeCode();
    const room = {
      code,
      phase: 'lobby',
      players: [{ id: socket.id, name, connected: true }, null],
      game: null,
      emptyTimer: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    socket.data.idx = 0;
    cb({ ok: true, code, idx: 0, state: publicState(room) });
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 20) || 'Player 2';
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Couldn't find that room code." });

    // Prefer reclaiming your own seat after a refresh (matched by name),
    // then an empty partner seat, then any disconnected seat.
    let idx = room.players.findIndex((p) => p && !p.connected && p.name === name);
    if (idx === -1 && room.players[1] === null) idx = 1;
    if (idx === -1) idx = room.players.findIndex((p) => p && !p.connected);
    if (idx === -1) return cb({ ok: false, error: 'That room is already full.' });

    room.players[idx] = { id: socket.id, name, connected: true };
    if (room.phase === 'lobby' && room.players[1] !== null) room.phase = 'menu';

    if (room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }
    socket.join(code);
    socket.data.code = code;
    socket.data.idx = idx;
    cb({ ok: true, code, idx, state: publicState(room) });
    broadcast(room);
  });

  function getRoom() {
    const room = rooms.get(socket.data.code);
    if (!room) return null;
    const player = room.players[socket.data.idx];
    if (!player || player.id !== socket.id) return null;
    return room;
  }

  socket.on('selectGame', ({ type }) => {
    const room = getRoom();
    if (!room || room.phase === 'lobby' || !GAME_CONFIG[type]) return;
    room.game = newGame(type);
    room.phase = 'playing';
    broadcast(room);
  });

  socket.on('answer', ({ choice }) => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || g.revealed || g.finished) return;
    const idx = socket.data.idx;
    if (g.answers[idx] !== null) return;
    const q = g.questions[g.qIndex];
    const optionCount = q.options.length;
    if (!Number.isInteger(choice) || choice < 0 || choice >= optionCount) return;

    g.answers[idx] = choice;
    if (g.answers[0] !== null && g.answers[1] !== null) {
      g.revealed = true;
      if (g.type === 'wkm') {
        const subject = g.qIndex % 2;
        const guesser = 1 - subject;
        if (g.answers[guesser] === g.answers[subject]) g.scores[guesser]++;
      } else if (g.answers[0] === g.answers[1]) {
        g.matches++;
      }
    }
    broadcast(room);
  });

  socket.on('next', () => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || !g.revealed || g.finished) return;
    g.qIndex++;
    g.answers = [null, null];
    g.revealed = false;
    if (g.qIndex >= g.questions.length) g.finished = true;
    broadcast(room);
  });

  socket.on('playAgain', () => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || !g.finished) return;
    room.game = newGame(g.type);
    broadcast(room);
  });

  socket.on('backToMenu', () => {
    const room = getRoom();
    if (!room || room.phase !== 'playing') return;
    room.game = null;
    room.phase = 'menu';
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const player = room.players[socket.data.idx];
    if (!player || player.id !== socket.id) return;
    player.connected = false;
    broadcast(room);
    if (room.players.every((p) => !p || !p.connected)) {
      // Keep the room around so players whose phones locked can rejoin.
      room.emptyTimer = setTimeout(() => rooms.delete(room.code), 15 * 60 * 1000);
    }
  });
});

// On free hosting (Render) the server is spun down after ~15 idle minutes,
// which wipes all in-memory rooms. While any room has a connected player,
// ping our own public URL so an active game is never interrupted.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    const anyActive = [...rooms.values()].some((r) => r.players.some((p) => p && p.connected));
    if (anyActive) fetch(SELF_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log(`Couple Games running at http://localhost:${PORT}`);
});
