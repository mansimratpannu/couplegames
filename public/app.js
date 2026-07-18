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
const screens = ['home', 'wait', 'menu', 'us', 'play', 'c4', 'results'];

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
};

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

let lastCelebration = null; // avoid re-firing on re-renders
function celebrateOnce(key) {
  if (lastCelebration === key) return;
  lastCelebration = key;
  confetti();
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
    const names = state.players.map((p) => (p ? p.name : '?')).join(' & ');
    $('menu-names').textContent = names;
    $('menu-room').textContent = 'Room ' + state.code;
    const days = daysTogether();
    $('us-card-sub').textContent = days === null
      ? 'Set your anniversary — count the days together'
      : `${days.toLocaleString()} days together · see your stats`;
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
  const g = state.game;
  if (!g) return show('menu');
  if (g.type === 'c4') {
    // Even when finished, keep the winning board on screen.
    renderC4(g);
    return show('c4');
  }
  if (g.finished) return renderResults(g);
  if (g.type === 'tod') renderTod(g);
  else if (g.type === 'q36') renderQ36(g);
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
  const c4Names = Object.keys(p.c4Wins || {});
  if (c4Names.length) {
    box.appendChild(statRow('Connect Four wins', c4Names.map((n) => `${n} ${p.c4Wins[n]}`).join(' · ')));
  }
  for (const [type, name] of Object.entries(GAME_NAMES)) {
    if (played[type]) box.appendChild(statRow(name, `played ${played[type]}×`));
  }
  show('us');
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
// Connect Four
// ---------------------------------------------------------------------------
function renderC4(g) {
  const myTurn = g.turn === myIdx && !g.finished;
  if (g.finished) {
    $('c4-status').textContent = g.winner === null
      ? "It's a draw!"
      : (g.winner === myIdx ? 'You win!' : `${nameOf(g.winner)} wins!`);
    if (g.winner === myIdx) celebrateOnce('c4-' + g.id);
  } else {
    $('c4-status').textContent = myTurn ? 'Your move' : `${nameOf(g.turn)} is thinking…`;
  }
  $('c4-legend').textContent = `${nameOf(0)} plays rose · ${nameOf(1)} plays gold`;

  const board = $('c4-board');
  board.innerHTML = '';
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

  const actions = $('c4-actions');
  actions.classList.toggle('hidden', !g.finished);
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
      if (correct) celebrateOnce(`rev-${g.id}-${g.qIndex}`);
    } else {
      const match = g.answers[0] === g.answers[1];
      verdict.textContent = match ? 'You matched!' : 'Opposites attract';
      verdict.className = 'verdict ' + (match ? 'match' : 'differ');
      rows.appendChild(revealRow(nameOf(0), options[g.answers[0]]));
      rows.appendChild(revealRow(nameOf(1), options[g.answers[1]]));
      if (match) celebrateOnce(`rev-${g.id}-${g.qIndex}`);
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
