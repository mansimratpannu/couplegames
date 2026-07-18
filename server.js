const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { WYR, TOT, WKM, TOD_TRUTHS, TOD_DARES, Q36 } = require('./questions');

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
  tod: { count: 10 },
  q36: { count: Q36.length },
  c4: { count: 0 },
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

function newGame(type, starter = 0) {
  const id = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  if (type === 'tod') {
    return {
      type,
      id,
      round: 0,
      total: GAME_CONFIG.tod.count,
      phase: 'choose', // 'choose' (actor picks truth/dare) | 'doing'
      choice: null,
      prompt: null,
      truths: shuffle(TOD_TRUTHS),
      dares: shuffle(TOD_DARES),
      finished: false,
    };
  }
  if (type === 'q36') {
    return { type, id, qIndex: 0, total: Q36.length, ready: [false, false], finished: false };
  }
  if (type === 'c4') {
    return {
      type,
      id,
      board: Array.from({ length: 6 }, () => Array(7).fill(null)), // [row][col], row 0 = top
      turn: starter,
      starter,
      winner: null,
      winLine: null,
      finished: false,
    };
  }
  return {
    type,
    id,
    questions: pickQuestions(type),
    qIndex: 0,
    answers: [null, null],
    revealed: false,
    finished: false,
    matches: 0,          // wyr + tot
    scores: [0, 0],      // wkm: points for each player as guesser
  };
}

// Returns the winning line of 4+ through (r, c), or null.
function c4WinLine(board, r, c) {
  const who = board[r][c];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [[r, c]];
    for (const s of [1, -1]) {
      let rr = r + dr * s;
      let cc = c + dc * s;
      while (rr >= 0 && rr < 6 && cc >= 0 && cc < 7 && board[rr][cc] === who) {
        line.push([rr, cc]);
        rr += dr * s;
        cc += dc * s;
      }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Couple profile: anniversary + lifetime stats. The server room copy is a
// relay/merge point — the durable copies live in each partner's localStorage,
// so nothing is lost when this process restarts.
// ---------------------------------------------------------------------------
function emptyProfile() {
  return {
    anniversary: null,
    anniversaryAt: 0,
    played: {},
    matches: 0,
    questions: 0,
    wkmWins: {},
    wkmTies: 0,
    c4Wins: {},
    updatedAt: 0,
  };
}

function mergeCounts(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[String(k).slice(0, 20)] = Math.max(a[k] || 0, b[k] || 0);
  }
  return out;
}

function num(x) { return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0; }

function mergeProfiles(a, b) {
  if (!b || typeof b !== 'object') return a;
  const out = { ...a };
  if (typeof b.anniversary === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.anniversary)
      && num(b.anniversaryAt) > a.anniversaryAt) {
    out.anniversary = b.anniversary;
    out.anniversaryAt = num(b.anniversaryAt);
  }
  out.played = mergeCounts(a.played, b.played);
  out.matches = Math.max(a.matches, num(b.matches));
  out.questions = Math.max(a.questions, num(b.questions));
  out.wkmWins = mergeCounts(a.wkmWins, b.wkmWins);
  out.wkmTies = Math.max(a.wkmTies, num(b.wkmTies));
  out.c4Wins = mergeCounts(a.c4Wins, b.c4Wins);
  out.updatedAt = Date.now();
  return out;
}

// Record a finished game into the room profile and push it to both players.
function recordFinish(room, g) {
  const p = room.profile;
  p.played[g.type] = (p.played[g.type] || 0) + 1;
  if (g.type === 'wyr' || g.type === 'tot') {
    p.matches += g.matches;
    p.questions += g.questions.length;
  }
  if (g.type === 'wkm') {
    const [s0, s1] = g.scores;
    if (s0 === s1) {
      p.wkmTies++;
    } else {
      const winner = room.players[s0 > s1 ? 0 : 1];
      if (winner) p.wkmWins[winner.name] = (p.wkmWins[winner.name] || 0) + 1;
    }
  }
  if (g.type === 'c4' && g.winner !== null) {
    const winner = room.players[g.winner];
    if (winner) p.c4Wins[winner.name] = (p.c4Wins[winner.name] || 0) + 1;
  }
  p.updatedAt = Date.now();
  io.to(room.code).emit('profile', p);
}

// What each client is allowed to see. Answers stay hidden until reveal.
function publicGame(g) {
  if (!g) return null;
  if (g.type === 'tod') {
    return {
      type: g.type, id: g.id, round: g.round, total: g.total, phase: g.phase,
      choice: g.choice, prompt: g.prompt, actor: g.round % 2, finished: g.finished,
    };
  }
  if (g.type === 'q36') {
    return {
      type: g.type, id: g.id, qIndex: g.qIndex, total: g.total,
      question: g.finished ? null : Q36[g.qIndex],
      ready: g.ready, finished: g.finished,
    };
  }
  if (g.type === 'c4') {
    return {
      type: g.type, id: g.id, board: g.board, turn: g.turn, starter: g.starter,
      winner: g.winner, winLine: g.winLine, finished: g.finished,
    };
  }
  return {
    type: g.type,
    id: g.id,
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
  };
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase, // 'lobby' | 'menu' | 'playing'
    players: room.players.map((p) => (p ? { name: p.name, connected: p.connected } : null)),
    game: publicGame(room.game),
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
      profile: emptyProfile(),
      emptyTimer: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    socket.data.idx = 0;
    cb({ ok: true, code, idx: 0, state: publicState(room) });
  });

  socket.on('joinRoom', ({ code, name, rejoin }, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 20) || 'Player 2';
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Couldn't find that room code." });

    let idx = -1;
    if (rejoin) {
      // Automatic rejoin may ONLY resume this player's own seat (matched by
      // name) — never grab the partner's empty seat as a duplicate. If the
      // seat still has a live socket (an older tab), boot it: newest tab wins.
      idx = room.players.findIndex((p) => p && p.name === name);
      if (idx === -1) return cb({ ok: false, error: 'Your seat is gone.' });
      const old = room.players[idx];
      if (old.connected && old.id !== socket.id) {
        const oldSock = io.sockets.sockets.get(old.id);
        if (oldSock) {
          oldSock.emit('replaced');
          oldSock.disconnect(true);
        }
      }
    } else {
      // Manual join: reclaim your own disconnected seat first (refresh after
      // typing the code again), then the empty partner seat, then any
      // disconnected seat.
      idx = room.players.findIndex((p) => p && !p.connected && p.name === name);
      if (idx === -1 && room.players[1] === null) idx = 1;
      if (idx === -1) idx = room.players.findIndex((p) => p && !p.connected);
      if (idx === -1) return cb({ ok: false, error: 'That room is already full.' });
    }

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
    if (!g || !g.answers || g.revealed || g.finished) return;
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
    if (!g || g.finished) return;

    if (g.type === 'tod') {
      if (g.phase !== 'doing') return;
      g.round++;
      g.phase = 'choose';
      g.choice = null;
      g.prompt = null;
      if (g.round >= g.total) {
        g.finished = true;
        recordFinish(room, g);
      }
      broadcast(room);
      return;
    }

    if (!g.revealed) return;
    g.qIndex++;
    g.answers = [null, null];
    g.revealed = false;
    if (g.qIndex >= g.questions.length) {
      g.finished = true;
      recordFinish(room, g);
    }
    broadcast(room);
  });

  // Truth or Dare: the actor picks truth or dare, the server draws a prompt.
  socket.on('todChoose', ({ kind }) => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || g.type !== 'tod' || g.finished || g.phase !== 'choose') return;
    if (socket.data.idx !== g.round % 2) return;
    if (kind !== 'truth' && kind !== 'dare') return;
    const pool = kind === 'truth' ? g.truths : g.dares;
    if (pool.length === 0) pool.push(...shuffle(kind === 'truth' ? TOD_TRUTHS : TOD_DARES));
    g.choice = kind;
    g.prompt = pool.pop();
    g.phase = 'doing';
    broadcast(room);
  });

  // 36 Questions: advance when both players say they've answered out loud.
  socket.on('ready', () => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || g.type !== 'q36' || g.finished) return;
    g.ready[socket.data.idx] = true;
    if (g.ready[0] && g.ready[1]) {
      g.qIndex++;
      g.ready = [false, false];
      if (g.qIndex >= g.total) {
        g.finished = true;
        recordFinish(room, g);
      }
    }
    broadcast(room);
  });

  // Connect Four: drop a disc in a column.
  socket.on('c4move', ({ col }) => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || g.type !== 'c4' || g.finished) return;
    const idx = socket.data.idx;
    if (idx !== g.turn) return;
    if (!Number.isInteger(col) || col < 0 || col > 6) return;
    let row = -1;
    for (let r = 5; r >= 0; r--) {
      if (g.board[r][col] === null) { row = r; break; }
    }
    if (row === -1) return; // column full

    g.board[row][col] = idx;
    const line = c4WinLine(g.board, row, col);
    if (line) {
      g.winner = idx;
      g.winLine = line;
      g.finished = true;
      recordFinish(room, g);
    } else if (g.board[0].every((_, c) => g.board[0][c] !== null)) {
      g.finished = true; // draw
      recordFinish(room, g);
    } else {
      g.turn = 1 - g.turn;
    }
    broadcast(room);
  });

  socket.on('playAgain', () => {
    const room = getRoom();
    const g = room && room.game;
    if (!g || !g.finished) return;
    // In Connect Four, alternate who starts each rematch.
    room.game = newGame(g.type, g.type === 'c4' ? 1 - g.starter : 0);
    broadcast(room);
  });

  // Either partner sets the day they started dating; both devices store it.
  socket.on('setAnniversary', ({ date }) => {
    const room = getRoom();
    if (!room) return;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const d = new Date(date + 'T00:00:00');
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) return;
    room.profile.anniversary = date;
    room.profile.anniversaryAt = Date.now();
    room.profile.updatedAt = Date.now();
    io.to(room.code).emit('profile', room.profile);
  });

  // Clients share their locally saved profile after joining; the room keeps
  // the merged view and pushes it back to both.
  socket.on('shareProfile', ({ profile }) => {
    const room = getRoom();
    if (!room) return;
    room.profile = mergeProfiles(room.profile, profile);
    io.to(room.code).emit('profile', room.profile);
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
