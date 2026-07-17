/* global io */
const socket = io();

let myIdx = null;
let state = null;

const $ = (id) => document.getElementById(id);
const screens = ['home', 'wait', 'menu', 'play', 'results'];

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

const GAME_NAMES = { wyr: 'Would You Rather', tot: 'This or That', wkm: 'Who Knows Me Better?' };

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

$('btn-create').addEventListener('click', () => {
  if (!myName()) return showError('Enter your name first.');
  socket.emit('createRoom', { name: myName() }, (res) => {
    if (!res.ok) return showError(res.error);
    myIdx = res.idx;
    state = res.state;
    render();
  });
});

$('btn-join').addEventListener('click', () => {
  if (!myName()) return showError('Enter your name first.');
  const code = $('code-input').value.trim().toUpperCase();
  if (code.length !== 4) return showError('Room codes are 4 letters.');
  socket.emit('joinRoom', { code, name: myName() }, (res) => {
    if (!res.ok) return showError(res.error);
    myIdx = res.idx;
    state = res.state;
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

socket.on('disconnect', () => toast('Connection lost — trying to reconnect…', 4000));
socket.on('connect', () => {
  // After a reconnect, our old seat is stale; rejoin with the same code.
  if (state && myIdx !== null) {
    socket.emit('joinRoom', { code: state.code, name: myName() || 'Player' }, (res) => {
      if (res.ok) {
        myIdx = res.idx;
        state = res.state;
        render();
      }
    });
  }
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
    const names = state.players.map((p) => (p ? p.name : '?')).join(' & ');
    $('menu-names').textContent = names;
    $('menu-room').textContent = 'Room ' + state.code;
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
  const g = state.game;
  if (!g) return show('menu');
  if (g.finished) return renderResults(g);
  renderQuestion(g);
  show('play');
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
    kicker = 'Quick! Pick one ⚡';
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
    } else {
      const match = g.answers[0] === g.answers[1];
      verdict.textContent = match ? 'You matched!' : 'Opposites attract';
      verdict.className = 'verdict ' + (match ? 'match' : 'differ');
      rows.appendChild(revealRow(nameOf(0), options[g.answers[0]]));
      rows.appendChild(revealRow(nameOf(1), options[g.answers[1]]));
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
  }
  show('results');
}
