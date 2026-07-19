/* global io */
// If the Socket.IO client script failed to load (flaky mobile network, edge
// hiccup), every button would silently do nothing. Surface it and retry.
if (typeof io === 'undefined') {
  const el = document.getElementById('home-error');
  if (el) {
    el.textContent = "Couldn't reach the game server — retrying automatically…";
    el.classList.remove('hidden');
  }
  setTimeout(() => location.reload(), 5000);
  throw new Error('socket.io client failed to load');
}
const socket = io();

let myIdx = null;
let state = null;

const $ = (id) => document.getElementById(id);
const screens = ['home', 'wait', 'menu', 'us', 'list', 'play', 'c4', 'bs', 'draw', 'results'];

// Installable app: register the (network-passthrough) service worker.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function show(name) {
  screens.forEach((s) => $('screen-' + s).classList.toggle('hidden', s !== name));
}

function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

const GAME_NAMES = {
  wyr: 'Would You Rather',
  tot: 'This or That',
  wkm: 'Who Knows Me Better?',
  tod: 'Truth or Dare',
  q36: '36 Questions',
  c4: 'Connect Four',
  ttt: 'Tic-Tac-Toe',
  mem: 'Memory Match',
  rps: 'Rock Paper Scissors',
  bs: 'Battleship',
  draw: 'Drawing & Guessing',
};

const BOARD_GAMES = ['c4', 'ttt', 'mem'];
const RPS_MOVES = ['Rock', 'Paper', 'Scissors'];
const MEM_TOKENS = [
  { ch: 'A', color: '#e11d48' }, { ch: 'B', color: '#2563eb' },
  { ch: 'C', color: '#059669' }, { ch: 'D', color: '#d97706' },
  { ch: 'E', color: '#7c3aed' }, { ch: 'F', color: '#0891b2' },
  { ch: 'G', color: '#db2777' }, { ch: 'H', color: '#65a30d' },
  { ch: 'J', color: '#dc2626' }, { ch: 'K', color: '#4f46e5' },
];

// ---------------------------------------------------------------------------
// Couple profile (anniversary + lifetime stats), mirrored in localStorage
// ---------------------------------------------------------------------------
let profile = null;
try { profile = JSON.parse(localStorage.getItem('cg-profile')); } catch (e) { /* ignore */ }

function saveProfile(p) {
  profile = p;
  try { localStorage.setItem('cg-profile', JSON.stringify(p)); } catch (e) { /* ignore */ }
}

function shareProfile() {
  socket.emit('shareProfile', { profile });
}

function daysTogether() {
  if (!profile || !profile.anniversary) return null;
  const start = new Date(profile.anniversary + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
}

// ---------------------------------------------------------------------------
// Confetti (small, dependency-free)
// ---------------------------------------------------------------------------
function confetti() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:50';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#e11d48', '#fda4af', '#fbbf24', '#34d399', '#818cf8'];
  const parts = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    vx: (Math.random() - 0.5) * 2.5,
    vy: 2 + Math.random() * 3.5,
    size: 5 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - t / 2200);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (t < 2200) requestAnimationFrame(frame);
    else canvas.remove();
  })(start);
}

// ---------------------------------------------------------------------------
// Subtle sounds + haptics (Web Audio, no files; created after first tap)
// ---------------------------------------------------------------------------
let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
});

function beep(freq, delay, dur, vol = 0.1) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ }
}

function soundMatch() { beep(660, 0, 0.15); beep(880, 0.12, 0.22); vibrate(30); }
function soundWin() { beep(523, 0, 0.15); beep(659, 0.13, 0.15); beep(784, 0.26, 0.3); vibrate([40, 60, 40]); }

let lastCelebration = null; // avoid re-firing on re-renders
function celebrateOnce(key, kind = 'win') {
  if (lastCelebration === key) return;
  lastCelebration = key;
  confetti();
  if (kind === 'match') soundMatch();
  else soundWin();
}

// ---------------------------------------------------------------------------
// Home: create / join
// ---------------------------------------------------------------------------
function myName() {
  return $('name-input').value.trim();
}

function showError(msg) {
  const el = $('home-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// Remember the session so a page reload (phone screen lock, in-app browser
// restart) can rejoin. localStorage, not sessionStorage: mobile in-app
// browsers routinely recreate the tab, which wipes sessionStorage.
const SESSION_TTL = 6 * 60 * 60 * 1000; // stop trying to rejoin after 6h

function saveSession(code) {
  try {
    localStorage.setItem('cg-session', JSON.stringify({ code, name: myName(), at: Date.now() }));
    localStorage.setItem('cg-name', myName());
  } catch (e) { /* storage unavailable — rejoin just won't be automatic */ }
}

function savedSession() {
  try {
    const s = JSON.parse(localStorage.getItem('cg-session'));
    if (!s || !s.code || Date.now() - (s.at || 0) > SESSION_TTL) return null;
    return s;
  } catch (e) { return null; }
}

function clearSession() {
  try { localStorage.removeItem('cg-session'); } catch (e) { /* ignore */ }
}

// The free-tier server can take ~30s to wake up; don't let buttons fail silently.
function ensureConnected() {
  if (socket.connected) return true;
  showError('Connecting to the server — this can take up to 30 seconds if it was asleep. Try again in a moment.');
  return false;
}

try {
  const savedName = localStorage.getItem('cg-name');
  if (savedName) $('name-input').value = savedName;
} catch (e) { /* ignore */ }

$('btn-create').addEventListener('click', () => {
  if (!myName()) return showError('Enter your name first.');
  if (!ensureConnected()) return;
  socket.emit('createRoom', { name: myName() }, (res) => {
    if (!res.ok) return showError(res.error);
    myIdx = res.idx;
    state = res.state;
    saveSession(res.code);
    shareProfile();
    render();
  });
});

$('btn-join').addEventListener('click', () => {
  if (!myName()) return showError('Enter your name first.');
  const code = $('code-input').value.trim().toUpperCase();
  if (code.length !== 4) return showError('Room codes are 4 letters.');
  if (!ensureConnected()) return;
  socket.emit('joinRoom', { code, name: myName() }, (res) => {
    if (!res.ok) return showError(res.error);
    myIdx = res.idx;
    state = res.state;
    saveSession(res.code);
    shareProfile();
    render();
  });
});

// ---------------------------------------------------------------------------
// Menu + game actions
// ---------------------------------------------------------------------------
document.querySelectorAll('.game-card').forEach((btn) => {
  btn.addEventListener('click', () => socket.emit('selectGame', { type: btn.dataset.game }));
});

$('btn-quit').addEventListener('click', () => socket.emit('backToMenu'));
$('btn-menu').addEventListener('click', () => socket.emit('backToMenu'));
$('btn-again').addEventListener('click', () => socket.emit('playAgain'));
$('btn-next').addEventListener('click', () => socket.emit('next'));

// ---------------------------------------------------------------------------
// State updates from server
// ---------------------------------------------------------------------------
socket.on('state', (s) => {
  const prev = state;
  state = s;
  if (prev && myIdx !== null) {
    const partner = s.players[1 - myIdx];
    const prevPartner = prev.players[1 - myIdx];
    if (partner && prevPartner && prevPartner.connected && !partner.connected) {
      toast(`${partner.name} disconnected — waiting for them to rejoin…`, 4000);
    }
    if (partner && prevPartner && !prevPartner.connected && partner.connected) {
      toast(`${partner.name} is back!`);
    }
    if (!prevPartner && partner) {
      toast(`${partner.name} joined!`);
    }
  }
  render();
});

// A newer tab took over our seat — stand down instead of fighting it for
// the seat in a reconnect loop.
socket.on('replaced', () => {
  clearSession();
  state = null;
  myIdx = null;
  render();
  toast('This room was opened in a newer tab.', 4000);
});

socket.on('disconnect', (reason) => {
  // A server-initiated disconnect (seat takeover) stops auto-reconnect;
  // reconnect manually so the home screen still works afterwards.
  if (reason === 'io server disconnect') socket.connect();
  if (state) toast('Connection lost — trying to reconnect…', 4000);
});
socket.on('connect', () => {
  // Rejoin after a reconnect (stale seat) or a fresh page load (saved session,
  // e.g. the phone reloaded the tab after a screen lock).
  let target = null;
  if (state && myIdx !== null) {
    target = { code: state.code, name: myName() || 'Player' };
  } else {
    const saved = savedSession();
    if (saved && saved.code) target = { code: saved.code, name: saved.name || myName() || 'Player' };
  }
  if (!target) return;

  const wasInRoom = state !== null;
  socket.emit('joinRoom', { code: target.code, name: target.name, rejoin: true }, (res) => {
    if (res.ok) {
      myIdx = res.idx;
      state = res.state;
      shareProfile();
      render();
    } else {
      // The server restarted and the room is gone — reset instead of leaving
      // a dead lobby on screen.
      clearSession();
      state = null;
      myIdx = null;
      render();
      if (wasInRoom) toast('Your room expired — please create a new one.', 5000);
    }
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  if (!state || myIdx === null) return show('home');

  if (state.phase === 'lobby') {
    $('room-code-big').textContent = state.code;
    return show('wait');
  }

  if (state.phase === 'menu') {
    if (showingUs) return renderUs();
    if (showingList) return renderList();
    const names = state.players.map((p) => (p ? p.name : '?')).join(' & ');
    $('menu-names').textContent = names;
    $('menu-room').textContent = 'Room ' + state.code;
    const days = daysTogether();
    $('us-card-sub').textContent = days === null
      ? 'Set your anniversary — count the days together'
      : `${days.toLocaleString()} days together · see your stats`;
    const bucket = ((profile && profile.bucket) || []).filter((i) => !i.deleted);
    const bucketDone = bucket.filter((i) => i.done).length;
    $('list-card-sub').textContent = bucket.length
      ? `${bucketDone}/${bucket.length} done · spin the date wheel`
      : 'Things to do together & the date wheel';
    const partner = state.players[1 - myIdx];
    const statusEl = $('partner-status');
    if (partner && !partner.connected) {
      statusEl.textContent = `${partner.name} is disconnected — games will wait for them.`;
      statusEl.classList.remove('hidden');
    } else {
      statusEl.classList.add('hidden');
    }
    return show('menu');
  }

  // phase === 'playing'
  showingUs = false;
  showingList = false;
  const g = state.game;
  if (!g) return show('menu');
  if (BOARD_GAMES.includes(g.type)) {
    // Even when finished, keep the final board on screen.
    renderBoard(g);
    return show('c4');
  }
  if (g.type === 'bs') {
    renderBs(g);
    return show('bs');
  }
  if (g.finished) return renderResults(g);
  if (g.type === 'draw') {
    renderDraw(g);
    return show('draw');
  }
  if (g.type === 'tod') renderTod(g);
  else if (g.type === 'q36') renderQ36(g);
  else if (g.type === 'rps') renderRps(g);
  else renderQuestion(g);
  show('play');
}

// ---------------------------------------------------------------------------
// Us screen (days together + stats)
// ---------------------------------------------------------------------------
let showingUs = false;

$('us-card').addEventListener('click', () => { showingUs = true; render(); });
$('btn-us-back').addEventListener('click', () => { showingUs = false; render(); });
$('btn-c4-quit').addEventListener('click', () => socket.emit('backToMenu'));
$('btn-c4-again').addEventListener('click', () => socket.emit('playAgain'));
$('btn-c4-menu').addEventListener('click', () => socket.emit('backToMenu'));

$('btn-set-anniversary').addEventListener('click', () => {
  const date = $('anniversary-input').value;
  if (!date) return toast('Pick a date first.');
  if (new Date(date + 'T00:00:00').getTime() > Date.now()) return toast("That's in the future — lucky you, but pick a past date.");
  socket.emit('setAnniversary', { date });
});

$('btn-edit-anniversary').addEventListener('click', () => {
  $('us-set-box').classList.remove('hidden');
  $('btn-edit-anniversary').classList.add('hidden');
});

socket.on('profile', (p) => {
  saveProfile(p);
  render();
});

function statRow(label, value) {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'stat-value';
  v.textContent = value;
  row.append(l, v);
  return row;
}

function renderUs() {
  $('us-room').textContent = 'Room ' + state.code;
  const days = daysTogether();
  if (days !== null) {
    $('us-days').textContent = days.toLocaleString();
    const d = new Date(profile.anniversary + 'T00:00:00');
    $('us-since').textContent = `days — since ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    $('us-set-box').classList.add('hidden');
    $('btn-edit-anniversary').classList.remove('hidden');
  } else {
    $('us-days').textContent = '—';
    $('us-since').textContent = 'Tell us when it all began:';
    $('us-set-box').classList.remove('hidden');
    $('btn-edit-anniversary').classList.add('hidden');
  }

  const box = $('us-stats');
  box.innerHTML = '';
  const p = profile || {};
  const played = p.played || {};
  const totalGames = Object.values(played).reduce((a, b) => a + b, 0);
  box.appendChild(statRow('Games played together', totalGames));
  if (p.questions > 0) {
    box.appendChild(statRow('Compatibility (all time)', Math.round((p.matches / p.questions) * 100) + '%'));
  }
  const wkmNames = Object.keys(p.wkmWins || {});
  if (wkmNames.length || p.wkmTies) {
    const tally = wkmNames.map((n) => `${n} ${p.wkmWins[n]}`).join(' · ') || '—';
    box.appendChild(statRow('Who Knows Me Better wins', tally + (p.wkmTies ? ` · ${p.wkmTies} tied` : '')));
  }
  const winMaps = [
    ['Connect Four wins', p.c4Wins],
    ['Tic-Tac-Toe wins', p.tttWins],
    ['Memory Match wins', p.memWins],
    ['Rock Paper Scissors wins', p.rpsWins],
    ['Battleship wins', p.bsWins],
  ];
  for (const [label, map] of winMaps) {
    const names = Object.keys(map || {});
    if (names.length) {
      box.appendChild(statRow(label, names.map((n) => `${n} ${map[n]}`).join(' · ')));
    }
  }
  if (p.drawBest > 0) {
    box.appendChild(statRow('Drawing best team score', `${p.drawBest}/6`));
  }
  const bucketItems = (p.bucket || []).filter((i) => !i.deleted);
  if (bucketItems.length) {
    box.appendChild(statRow('Bucket list', `${bucketItems.filter((i) => i.done).length}/${bucketItems.length} done`));
  }
  for (const [type, name] of Object.entries(GAME_NAMES)) {
    if (played[type]) box.appendChild(statRow(name, `played ${played[type]}×`));
  }
  show('us');
}

// ---------------------------------------------------------------------------
// Bucket list & date wheel
// ---------------------------------------------------------------------------
let showingList = false;
let wheelSpinning = false;

$('list-card').addEventListener('click', () => { showingList = true; render(); });
$('btn-list-back').addEventListener('click', () => { showingList = false; render(); });

function addBucketItem() {
  const text = $('list-input').value.trim();
  if (!text) return;
  socket.emit('bucketAdd', { text });
  $('list-input').value = '';
}
$('btn-list-add').addEventListener('click', addBucketItem);
$('list-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addBucketItem(); });

$('btn-spin').addEventListener('click', () => socket.emit('spinWheel'));

socket.on('wheelResult', ({ id }) => {
  const items = ((profile && profile.bucket) || []).filter((i) => !i.deleted && !i.done);
  const winner = items.find((i) => i.id === id);
  if (!winner || wheelSpinning) return;
  showingList = true;
  render();
  const display = $('wheel-display');
  display.classList.remove('hidden', 'landed');
  wheelSpinning = true;
  // Slot-machine style: cycle through options, slowing down, land on winner.
  const pool = items.map((i) => i.text);
  let step = 0;
  const totalSteps = Math.min(18, 8 + pool.length * 2);
  (function tick() {
    if (step < totalSteps) {
      display.textContent = pool[step % pool.length];
      step++;
      setTimeout(tick, 60 + step * 18);
    } else {
      display.textContent = winner.text;
      display.classList.add('landed');
      wheelSpinning = false;
      confetti();
      soundWin();
    }
  })();
});

function renderList() {
  $('list-room').textContent = 'Room ' + state.code;
  const items = ((profile && profile.bucket) || []).filter((i) => !i.deleted);
  const box = $('list-items');
  box.innerHTML = '';
  $('list-empty').classList.toggle('hidden', items.length > 0);

  const sorted = [...items].sort((x, y) => (x.done === y.done ? 0 : x.done ? 1 : -1));
  for (const item of sorted) {
    const row = document.createElement('div');
    row.className = 'list-item' + (item.done ? ' done' : '');

    const checkBtn = document.createElement('button');
    checkBtn.className = 'list-check';
    checkBtn.setAttribute('aria-label', item.done ? 'Mark as not done' : 'Mark as done');
    checkBtn.addEventListener('click', () => socket.emit('bucketToggle', { id: item.id }));

    const label = document.createElement('span');
    label.className = 'list-text';
    label.textContent = item.text;

    const delBtn = document.createElement('button');
    delBtn.className = 'list-del';
    delBtn.textContent = '×';
    delBtn.setAttribute('aria-label', 'Remove item');
    delBtn.addEventListener('click', () => socket.emit('bucketDelete', { id: item.id }));

    row.append(checkBtn, label, delBtn);
    box.appendChild(row);
  }

  const spinnable = items.filter((i) => !i.done).length >= 2;
  $('btn-spin').disabled = !spinnable;
  $('btn-spin').textContent = spinnable ? 'Spin the wheel' : 'Add at least 2 unchecked items';
  show('list');
}

// ---------------------------------------------------------------------------
// Truth or Dare + 36 Questions (reuse the play screen)
// ---------------------------------------------------------------------------
function renderTod(g) {
  $('play-progress').textContent = `${GAME_NAMES.tod} · ${g.round + 1}/${g.total}`;
  $('reveal-box').classList.add('hidden');
  const iAmActor = g.actor === myIdx;
  const box = $('play-options');
  box.innerHTML = '';

  if (g.phase === 'choose') {
    $('play-kicker').textContent = iAmActor ? 'Your turn!' : `${nameOf(g.actor)}'s turn`;
    $('play-question').textContent = iAmActor ? 'Truth… or dare?' : '';
    $('play-status').textContent = iAmActor ? '' : `${nameOf(g.actor)} is choosing…`;
    if (iAmActor) {
      for (const kind of ['truth', 'dare']) {
        const b = document.createElement('button');
        b.className = 'option';
        b.textContent = kind === 'truth' ? 'Truth' : 'Dare';
        b.addEventListener('click', () => socket.emit('todChoose', { kind }));
        box.appendChild(b);
      }
    }
  } else {
    $('play-kicker').textContent = `${g.choice === 'truth' ? 'Truth' : 'Dare'} for ${iAmActor ? 'you' : nameOf(g.actor)}`;
    $('play-question').textContent = g.prompt;
    $('play-status').textContent = iAmActor ? 'Go on then…' : `Make sure ${nameOf(g.actor)} actually does it.`;
    const b = document.createElement('button');
    b.className = 'option';
    b.textContent = g.round + 1 >= g.total ? 'Done — finish' : 'Done — next round';
    b.addEventListener('click', () => socket.emit('next'));
    box.appendChild(b);
  }
}

function renderQ36(g) {
  const set = Math.floor(g.qIndex / 12) + 1;
  $('play-progress').textContent = `${GAME_NAMES.q36} · ${g.qIndex + 1}/${g.total}`;
  $('reveal-box').classList.add('hidden');
  $('play-kicker').textContent = `Set ${set} of 3`;
  $('play-question').textContent = g.question;
  const iReady = g.ready[myIdx];
  const partnerReady = g.ready[1 - myIdx];
  $('play-status').textContent = iReady
    ? `Waiting for ${nameOf(1 - myIdx)}…`
    : (partnerReady ? `${nameOf(1 - myIdx)} is ready to move on.` : 'Talk it through, then both tap continue.');
  const box = $('play-options');
  box.innerHTML = '';
  const b = document.createElement('button');
  b.className = 'option' + (iReady ? ' picked' : '');
  b.textContent = iReady ? 'Ready' : "We've both answered — continue";
  b.disabled = iReady;
  b.addEventListener('click', () => socket.emit('ready'));
  box.appendChild(b);
}

// ---------------------------------------------------------------------------
// Board games (Connect Four, Tic-Tac-Toe, Memory Match) share one screen
// ---------------------------------------------------------------------------
function renderBoard(g) {
  $('c4-chip').textContent = GAME_NAMES[g.type];
  const myTurn = g.turn === myIdx && !g.finished;

  if (g.finished) {
    $('c4-status').textContent = g.winner === null || g.winner === undefined
      ? "It's a draw!"
      : (g.winner === myIdx ? 'You win!' : `${nameOf(g.winner)} wins!`);
    if (g.winner === myIdx) celebrateOnce('board-' + g.id);
  } else if (g.type === 'mem' && g.lock) {
    $('c4-status').textContent = 'No match…';
  } else {
    $('c4-status').textContent = myTurn
      ? (g.type === 'mem' ? 'Your turn — flip two cards' : 'Your move')
      : `${nameOf(g.turn)} is thinking…`;
  }

  const board = $('c4-board');
  board.innerHTML = '';
  board.className = 'c4-board grid-' + g.type;

  if (g.type === 'c4') {
    $('c4-legend').textContent = `${nameOf(0)} plays rose · ${nameOf(1)} plays gold`;
    const winSet = new Set((g.winLine || []).map(([r, c]) => r + ',' + c));
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        const cell = document.createElement('button');
        cell.className = 'c4-cell';
        const v = g.board[r][c];
        if (v !== null) cell.classList.add(v === 0 ? 'p0' : 'p1');
        if (winSet.has(r + ',' + c)) cell.classList.add('win');
        cell.disabled = !myTurn || g.board[0][c] !== null;
        cell.addEventListener('click', () => socket.emit('c4move', { col: c }));
        board.appendChild(cell);
      }
    }
  } else if (g.type === 'ttt') {
    $('c4-legend').textContent = `${nameOf(0)} is X · ${nameOf(1)} is O`;
    const winSet = new Set(g.winLine || []);
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('button');
      cell.className = 'ttt-cell';
      const v = g.board[i];
      if (v !== null) {
        cell.textContent = v === 0 ? 'X' : 'O';
        cell.classList.add(v === 0 ? 'p0' : 'p1');
      }
      if (winSet.has(i)) cell.classList.add('win');
      cell.disabled = !myTurn || v !== null;
      cell.addEventListener('click', () => socket.emit('tttMove', { cell: i }));
      board.appendChild(cell);
    }
  } else if (g.type === 'mem') {
    $('c4-legend').textContent = `Pairs — ${nameOf(0)} ${g.scores[0]} · ${nameOf(1)} ${g.scores[1]}`;
    for (let i = 0; i < g.cards.length; i++) {
      const cell = document.createElement('button');
      cell.className = 'mem-card';
      const token = g.cards[i];
      if (token !== null) {
        const t = MEM_TOKENS[token];
        cell.textContent = t.ch;
        cell.style.color = t.color;
        cell.classList.add('face-up');
        if (g.matched[i]) cell.classList.add('matched');
      }
      cell.disabled = !myTurn || g.lock || token !== null;
      cell.addEventListener('click', () => socket.emit('memFlip', { idx: i }));
      board.appendChild(cell);
    }
  }

  $('c4-actions').classList.toggle('hidden', !g.finished);
}

// ---------------------------------------------------------------------------
// Battleship
// ---------------------------------------------------------------------------
let bsShips = null; // { gameId, ships: [[cells]] } — our own secret fleet

socket.on('bsLayout', (p) => {
  bsShips = p;
  render();
});

$('btn-bs-quit').addEventListener('click', () => socket.emit('backToMenu'));
$('btn-bs-menu').addEventListener('click', () => socket.emit('backToMenu'));
$('btn-bs-again').addEventListener('click', () => socket.emit('playAgain'));
$('btn-bs-shuffle').addEventListener('click', () => socket.emit('bsShuffle'));
$('btn-bs-ready').addEventListener('click', () => socket.emit('bsReady'));

function bsGrid(el, cellFn) {
  el.innerHTML = '';
  for (let i = 0; i < 64; i++) el.appendChild(cellFn(i));
}

function renderBs(g) {
  const myShipCells = new Set(
    bsShips && bsShips.gameId === g.id ? bsShips.ships.flat() : []
  );
  const placing = g.phase === 'place';
  const myTurn = g.turn === myIdx && g.phase === 'battle' && !g.finished;

  if (g.finished) {
    $('bs-status').textContent = g.winner === myIdx ? 'You sank their whole fleet!' : `${nameOf(g.winner)} sank your fleet!`;
    if (g.winner === myIdx) celebrateOnce('bs-' + g.id);
  } else if (placing) {
    $('bs-status').textContent = g.ready[myIdx]
      ? `Waiting for ${nameOf(1 - myIdx)} to place their ships…`
      : 'Place your fleet — shuffle until you like it';
  } else {
    $('bs-status').textContent = myTurn ? 'Your shot — a hit earns another!' : `${nameOf(g.turn)} is aiming…`;
  }

  $('bs-enemy-wrap').classList.toggle('hidden', placing);
  $('bs-place-actions').classList.toggle('hidden', !placing || g.ready[myIdx]);
  $('bs-actions').classList.toggle('hidden', !g.finished);

  // Enemy waters: our shots + their sunk ships.
  if (!placing) {
    const myShots = g.shots[myIdx];
    const enemySunk = new Set((g.sunk[1 - myIdx] || []).flat());
    bsGrid($('bs-enemy'), (i) => {
      const cell = document.createElement('button');
      cell.className = 'bs-cell';
      const shot = myShots[i];
      if (shot === 'hit') cell.classList.add(enemySunk.has(i) ? 'sunk' : 'hit');
      else if (shot === 'miss') cell.classList.add('miss');
      cell.disabled = !myTurn || !!shot;
      cell.addEventListener('click', () => socket.emit('bsFire', { cell: i }));
      return cell;
    });
  }

  // Our fleet: ships + incoming shots.
  const theirShots = g.shots[1 - myIdx];
  bsGrid($('bs-own'), (i) => {
    const cell = document.createElement('span');
    cell.className = 'bs-cell own';
    if (myShipCells.has(i)) cell.classList.add('ship');
    const shot = theirShots[i];
    if (shot === 'hit') cell.classList.add('hit');
    else if (shot === 'miss') cell.classList.add('miss');
    return cell;
  });
}

// ---------------------------------------------------------------------------
// Drawing & Guessing
// ---------------------------------------------------------------------------
let drawPrivate = { gameId: null, options: null, word: null };
let drawColor = '#18181b';
let drawCountdownTimer = null;

const canvas = $('draw-canvas');
const dctx = canvas.getContext('2d');
dctx.lineCap = 'round';
dctx.lineJoin = 'round';

function paintSeg(s) {
  dctx.strokeStyle = s.c;
  dctx.lineWidth = 7;
  dctx.beginPath();
  dctx.moveTo(s.x0 * canvas.width, s.y0 * canvas.height);
  dctx.lineTo(s.x1 * canvas.width, s.y1 * canvas.height);
  dctx.stroke();
}

socket.on('seg', paintSeg);
socket.on('clearCanvas', () => dctx.clearRect(0, 0, canvas.width, canvas.height));
socket.on('drawStrokes', (p) => {
  dctx.clearRect(0, 0, canvas.width, canvas.height);
  (p.strokes || []).forEach(paintSeg);
});
socket.on('drawOptions', (p) => {
  drawPrivate = { gameId: p.gameId, options: p.options, word: null };
  render();
});
socket.on('drawWord', (p) => {
  drawPrivate = { gameId: p.gameId, options: null, word: p.word };
  render();
});
socket.on('guessShown', ({ name, guess }) => {
  $('draw-feed').textContent = `${name} guessed: “${guess}”`;
});

// Drawer input: pointer events emit normalized segments.
let drawing = false;
let lastPt = null;

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

function iAmDrawer() {
  const g = state && state.game;
  return g && g.type === 'draw' && g.phase === 'draw' && g.drawer === myIdx;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!iAmDrawer()) return;
  drawing = true;
  lastPt = canvasPoint(e);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drawing || !iAmDrawer()) return;
  const pt = canvasPoint(e);
  const seg = { x0: lastPt.x, y0: lastPt.y, x1: pt.x, y1: pt.y, c: drawColor };
  paintSeg(seg);
  socket.emit('drawSeg', seg);
  lastPt = pt;
});
['pointerup', 'pointercancel'].forEach((ev) =>
  canvas.addEventListener(ev, () => { drawing = false; lastPt = null; }));

document.querySelectorAll('.draw-color').forEach((btn) => {
  btn.addEventListener('click', () => {
    drawColor = btn.dataset.color;
    document.querySelectorAll('.draw-color').forEach((b) => b.classList.toggle('selected', b === btn));
  });
});
$('btn-draw-clear').addEventListener('click', () => socket.emit('drawClear'));
$('btn-draw-skip').addEventListener('click', () => socket.emit('drawSkip'));
$('btn-draw-quit').addEventListener('click', () => socket.emit('backToMenu'));
$('btn-draw-next').addEventListener('click', () => socket.emit('next'));

function sendGuess() {
  const text = $('draw-guess-input').value.trim();
  if (!text) return;
  socket.emit('drawGuess', { text });
  $('draw-guess-input').value = '';
}
$('btn-draw-guess').addEventListener('click', sendGuess);
$('draw-guess-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendGuess(); });

function renderDraw(g) {
  $('draw-chip').textContent = `Round ${g.round + 1}/${g.total} · Score ${g.score}`;
  const drawer = g.drawer;
  const iDraw = drawer === myIdx;

  const pickBox = $('draw-pick');
  pickBox.classList.add('hidden');
  $('draw-tools').classList.toggle('hidden', !(iDraw && g.phase === 'draw'));
  $('draw-guess-box').classList.toggle('hidden', !(!iDraw && g.phase === 'draw'));
  $('draw-reveal-actions').classList.toggle('hidden', g.phase !== 'reveal');
  canvas.classList.toggle('draw-active', iDraw && g.phase === 'draw');

  clearInterval(drawCountdownTimer);
  drawCountdownTimer = null;

  if (g.phase === 'pick') {
    $('draw-feed').textContent = '';
    $('draw-word-hint').textContent = '';
    if (iDraw) {
      $('draw-status').textContent = 'Pick a word to draw';
      if (drawPrivate.gameId === g.id && drawPrivate.options) {
        pickBox.classList.remove('hidden');
        pickBox.innerHTML = '';
        drawPrivate.options.forEach((w, i) => {
          const b = document.createElement('button');
          b.className = 'option';
          b.textContent = w;
          b.addEventListener('click', () => socket.emit('drawPick', { i }));
          pickBox.appendChild(b);
        });
      }
    } else {
      $('draw-status').textContent = `${nameOf(drawer)} is picking a word…`;
    }
  } else if (g.phase === 'draw') {
    const tick = () => {
      const left = Math.max(0, Math.ceil((g.deadline - Date.now()) / 1000));
      $('draw-status').textContent = (iDraw ? 'Draw!' : `${nameOf(drawer)} is drawing…`) + ` · ${left}s`;
    };
    tick();
    drawCountdownTimer = setInterval(tick, 1000);
    $('draw-word-hint').textContent = iDraw
      ? (drawPrivate.gameId === g.id && drawPrivate.word ? `Your word: ${drawPrivate.word}` : '')
      : Array(g.wordLen || 0).fill('_').join(' ');
  } else if (g.phase === 'reveal') {
    const messages = {
      guessed: `${nameOf(1 - drawer)} guessed it!`,
      timeout: "Time's up!",
      skipped: `${nameOf(drawer)} skipped it`,
    };
    $('draw-status').textContent = messages[g.lastResult] || 'Round over';
    $('draw-word-hint').textContent = `The word was: ${g.lastWord}`;
    $('draw-feed').textContent = '';
    $('btn-draw-next').textContent = g.round + 1 >= g.total ? 'See results' : 'Next round →';
    if (g.lastResult === 'guessed') celebrateOnce(`rev-${g.id}-${g.round}`, 'match');
  }
}

// ---------------------------------------------------------------------------
// Rock Paper Scissors (reuses the play screen)
// ---------------------------------------------------------------------------
function renderRps(g) {
  $('play-progress').textContent = `${GAME_NAMES.rps} · first to ${g.target}`;
  $('play-kicker').textContent = `Round ${g.round}`;
  $('play-question').textContent = `${nameOf(0)} ${g.scores[0]} – ${g.scores[1]} ${nameOf(1)}`;

  const iAnswered = g.answered[myIdx];
  const partnerAnswered = g.answered[1 - myIdx];
  const box = $('play-options');
  box.innerHTML = '';
  RPS_MOVES.forEach((move, i) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.textContent = move;
    b.disabled = iAnswered || g.revealed;
    if (g.revealed && g.answers[myIdx] === i) b.classList.add('picked');
    b.addEventListener('click', () => socket.emit('answer', { choice: i }));
    box.appendChild(b);
  });

  const status = $('play-status');
  if (g.revealed) {
    status.textContent = '';
  } else if (iAnswered && !partnerAnswered) {
    status.textContent = `Locked in — waiting for ${nameOf(1 - myIdx)}…`;
  } else if (!iAnswered && partnerAnswered) {
    status.textContent = `${nameOf(1 - myIdx)} has thrown — your turn!`;
  } else {
    status.textContent = 'Pick your throw in secret.';
  }

  const revealBox = $('reveal-box');
  if (g.revealed) {
    revealBox.classList.remove('hidden');
    const verdict = $('reveal-verdict');
    const rows = $('reveal-answers');
    rows.innerHTML = '';
    const [a, b] = g.answers;
    if (a === b) {
      verdict.textContent = 'Tie — go again!';
      verdict.className = 'verdict differ';
    } else {
      const w = (a - b + 3) % 3 === 1 ? 0 : 1;
      verdict.textContent = `${RPS_MOVES[g.answers[w]]} beats ${RPS_MOVES[g.answers[1 - w]]} — ${nameOf(w)} takes the round!`;
      verdict.className = 'verdict ' + (w === myIdx ? 'match' : 'differ');
      if (w === myIdx) celebrateOnce(`rev-${g.id}-${g.round}`, 'match');
    }
    rows.appendChild(revealRow(nameOf(0), RPS_MOVES[a]));
    rows.appendChild(revealRow(nameOf(1), RPS_MOVES[b]));
    $('btn-next').textContent = 'Next round →';
  } else {
    revealBox.classList.add('hidden');
  }
}

function nameOf(idx) {
  const p = state.players[idx];
  return p ? p.name : '?';
}

function renderQuestion(g) {
  $('play-progress').textContent = `${GAME_NAMES[g.type]} · ${g.qIndex + 1}/${g.total}`;

  const q = g.question;
  const iAnswered = g.answered[myIdx];
  const partnerAnswered = g.answered[1 - myIdx];

  // Kicker + question text
  let kicker = '';
  let questionText = '';
  let options = q.options;

  if (g.type === 'wyr') {
    kicker = 'Would you rather…';
    questionText = '';
  } else if (g.type === 'tot') {
    kicker = 'Quick! Pick one';
    questionText = '';
  } else {
    const iAmSubject = g.subject === myIdx;
    kicker = iAmSubject ? 'Your turn — answer honestly!' : `Guess ${nameOf(g.subject)}'s answer!`;
    questionText = (iAmSubject ? q.you : q.them).replaceAll('{name}', nameOf(g.subject));
  }
  $('play-kicker').textContent = kicker;
  $('play-question').textContent = questionText;

  // Options
  const box = $('play-options');
  box.innerHTML = '';
  options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.textContent = opt;
    b.disabled = iAnswered || g.revealed;
    if (g.revealed ? g.answers[myIdx] === i : false) b.classList.add('picked');
    if (!g.revealed && iAnswered && myPick === i) b.classList.add('picked');
    b.addEventListener('click', () => {
      myPick = i;
      socket.emit('answer', { choice: i });
      renderQuestion({ ...g, answered: g.answered.map((a, idx2) => (idx2 === myIdx ? true : a)) });
    });
    box.appendChild(b);
  });

  // Status line
  const status = $('play-status');
  if (g.revealed) {
    status.textContent = '';
  } else if (iAnswered && !partnerAnswered) {
    status.textContent = `Locked in — waiting for ${nameOf(1 - myIdx)}…`;
  } else if (!iAnswered && partnerAnswered) {
    status.textContent = `${nameOf(1 - myIdx)} has answered — your turn!`;
  } else {
    status.textContent = 'Both of you answer secretly, then we reveal.';
  }

  // Reveal
  const revealBox = $('reveal-box');
  if (g.revealed) {
    revealBox.classList.remove('hidden');
    const verdict = $('reveal-verdict');
    const rows = $('reveal-answers');
    rows.innerHTML = '';

    if (g.type === 'wkm') {
      const subject = g.subject;
      const guesser = 1 - subject;
      const correct = g.answers[guesser] === g.answers[subject];
      verdict.textContent = correct ? `${nameOf(guesser)} nailed it!` : `Nope — ${nameOf(guesser)} guessed wrong`;
      verdict.className = 'verdict ' + (correct ? 'match' : 'differ');
      rows.appendChild(revealRow(`${nameOf(subject)}'s answer`, options[g.answers[subject]]));
      rows.appendChild(revealRow(`${nameOf(guesser)}'s guess`, options[g.answers[guesser]]));
      if (correct) celebrateOnce(`rev-${g.id}-${g.qIndex}`, 'match');
    } else {
      const match = g.answers[0] === g.answers[1];
      verdict.textContent = match ? 'You matched!' : 'Opposites attract';
      verdict.className = 'verdict ' + (match ? 'match' : 'differ');
      rows.appendChild(revealRow(nameOf(0), options[g.answers[0]]));
      rows.appendChild(revealRow(nameOf(1), options[g.answers[1]]));
      if (match) celebrateOnce(`rev-${g.id}-${g.qIndex}`, 'match');
    }
    $('btn-next').textContent = g.qIndex + 1 >= g.total ? 'See results' : 'Next →';
  } else {
    revealBox.classList.add('hidden');
  }
}

let myPick = null;

function revealRow(who, answer) {
  const row = document.createElement('div');
  row.className = 'reveal-row';
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  const a = document.createElement('span');
  a.textContent = answer;
  row.append(w, a);
  return row;
}

function renderResults(g) {
  const title = $('results-title');
  const big = $('results-big');
  const detail = $('results-detail');

  if (g.type === 'draw') {
    title.textContent = 'Drawing & Guessing';
    big.textContent = `${g.score}/${g.total}`;
    const flavor =
      g.score === g.total ? 'A perfect team. Museum-worthy communication.' :
      g.score >= 4 ? 'You two are seriously on the same wavelength.' :
      g.score >= 2 ? 'Some masterpieces just need more time.' :
      'Abstract art is still art.';
    detail.textContent = `You guessed ${g.score} of ${g.total} as a team — ${flavor}`;
    if (g.score >= 4) celebrateOnce('res-' + g.id);
    return show('results');
  }
  if (g.type === 'rps') {
    title.textContent = 'Rock Paper Scissors';
    big.textContent = `${g.scores[0]} – ${g.scores[1]}`;
    const finalMove = g.answers
      ? ` (${RPS_MOVES[g.answers[g.winner]]} beats ${RPS_MOVES[g.answers[1 - g.winner]]})`
      : '';
    detail.textContent = `${nameOf(g.winner)} wins the match${finalMove}!`;
    if (g.winner === myIdx) celebrateOnce('res-' + g.id);
    return show('results');
  }
  if (g.type === 'tod') {
    title.textContent = 'Truth or Dare';
    big.textContent = `${g.total}/${g.total}`;
    detail.textContent = 'All rounds survived. Whatever was said in this game stays in this game.';
    celebrateOnce('res-' + g.id);
    return show('results');
  }
  if (g.type === 'q36') {
    title.textContent = '36 Questions';
    big.textContent = '36';
    detail.textContent = 'You made it through all three sets. Tradition says you now stare into each other\'s eyes for four minutes — good luck.';
    celebrateOnce('res-' + g.id);
    return show('results');
  }

  if (g.type === 'wkm') {
    const [s0, s1] = g.scores;
    const perPlayer = g.total / 2;
    title.textContent = 'Who Knows Who Better?';
    big.textContent = `${s0} – ${s1}`;
    if (s0 === s1) {
      detail.textContent = `It's a tie! You know each other equally well (${s0}/${perPlayer} correct guesses each).`;
    } else {
      const winner = s0 > s1 ? 0 : 1;
      detail.textContent = `${nameOf(winner)} knows ${nameOf(1 - winner)} better — ${Math.max(s0, s1)}/${perPlayer} correct guesses!`;
    }
  } else {
    const pct = Math.round((g.matches / g.total) * 100);
    title.textContent = g.type === 'tot' ? 'Compatibility score' : 'Match score';
    big.textContent = pct + '%';
    const flavor =
      pct >= 90 ? 'Soulmates. Actual soulmates.' :
      pct >= 70 ? 'Seriously in sync — impressive!' :
      pct >= 40 ? 'A lovely mix of same and different.' :
      'Total opposites… and clearly still into each other.';
    detail.textContent = `You matched on ${g.matches} of ${g.total} — ${flavor}`;
    if (pct >= 70) celebrateOnce('res-' + g.id);
  }
  show('results');
}
