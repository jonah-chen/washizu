'use strict';
/* Washizu Mahjong client. The server is authoritative; this file only draws what it is sent. */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const W = ['East', 'South', 'West', 'North'], WK = '東南西北';
const SUIT = ['characters', 'circles', 'bamboo'], HON = ['East wind', 'South wind', 'West wind', 'North wind', 'White dragon', 'Green dragon', 'Red dragon'];
// The four fixed roles, in play order (seat 0 deals first). Akagi and Washizu lead the two
// teams, with Yasuoka and Suzuki at their sides. Akagi's team wins if Akagi outpoints Washizu.
const ROLE = ['Akagi', 'Yasuoka', 'Washizu', 'Suzuki'];
const TEAM = ['Akagi', 'Washizu'];
const LEN = { east: 'East round only', south: 'East and South', hanchan2: '2 hanchan', hanchan4: '4 hanchan', hanchan6: '6 hanchan' };
// The story's bet: Washizu's 20 million yen for 2,000cc of Akagi's blood, worth the table's
// whole stake in points. Low stakes spread the blood over 200,000 points, high over 20,000.
const STAKE = {
  none: { label: 'No stake', pts: 0, yen: 0 },
  low: { label: 'Low stake', pts: 200000, yen: 20000000 },
  high: { label: 'High stake', pts: 20000, yen: 20000000 },
};
const fmtYen = n => '¥' + Math.abs(n).toLocaleString();
// In team games the fixed role is a player's identity, shown at full size, with the account
// name as a smaller label after it. Free-for-all has no roles, so the account name stands alone.
const who = (p, s, mode) => mode === 'ffa' ? esc(p.name) : `${ROLE[s]} <span class="un">${esc(p.name)}</span>`;

const S = {
  me: null, lobby: { tables: [], online: 0 }, table: null, game: null, board: [],
  screen: null, authMode: 'login', sel: null, riichiMode: false, flash: null, evN: 0,
  offset: 0, timer: null, closed: false, payN: 0, payFlash: null,
};
let ws = null, retry = 0;

/* ---------- plumbing ---------- */
async function api(op, body) {
  const r = await fetch('/api/server?op=' + op, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'The server did not respond. Try again.');
  return j;
}
// The server may drop the socket every few minutes (Vercel caps connection length), so anything
// sent during the brief reconnect is held and delivered as soon as the new socket opens.
const outbox = [];
function sendMsg(m) {
  if (ws && ws.readyState === 1) return ws.send(JSON.stringify(m));
  if (outbox.length < 5) outbox.push(m);
  if (retry > 1) toast('Reconnecting to the server.');
}
let toastTimer;
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function connect() {
  if (!S.me || S.closed) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/server');
  ws.onopen = () => { retry = 0; while (outbox.length) ws.send(JSON.stringify(outbox.shift())); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') { S.me = m.me; render(); }
    else if (m.t === 'lobby') { S.lobby = m.lobby; if (S.screen === 'lobby') drawLobby(); }
    else if (m.t === 'table') onTable(m);
    else if (m.t === 'err') toast(m.msg);
  };
  ws.onclose = async e => {
    ws = null;
    if (e.code === 4001) { S.closed = true; S.table = S.game = null; render(); return; }
    if (!S.me) return;
    if (++retry > 2) {
      try { const r = await api('me'); if (!r.user) { S.me = null; S.table = S.game = null; return render(); } } catch { /* offline: keep trying */ }
    }
    setTimeout(connect, retry === 1 ? 150 : Math.min(8000, 400 * 2 ** retry));
  };
}

function onTable(m) {
  const wasLobby = !S.table;
  S.table = m.table; S.game = m.game;
  if (m.now) S.offset = m.now - Date.now();
  const g = S.game;
  if (g) {
    if (!g.options) { S.sel = null; S.riichiMode = false; }
    else if (S.sel != null && !g.players[g.seat].tiles.includes(S.sel)) S.sel = null;
    if (g.ev && g.ev.n !== S.evN) {
      S.evN = g.ev.n; S.flash = { seat: g.ev.seat, text: g.ev.text, until: Date.now() + 1300 };
      setTimeout(() => { if (S.screen === 'game') drawGame(); }, 1350);
    }
    if (g.deadline) {
      if (!S.timer || S.timer.deadline !== g.deadline) S.timer = { deadline: g.deadline, total: Math.max(1, g.deadline - (Date.now() + S.offset)) };
    } else S.timer = null;
    // a fresh payment under the stakes: a banner for a few seconds (joiners see past payments quietly)
    if (g.lastPayment) {
      if (!S.payN) S.payN = g.lastPayment.n;
      else if (g.lastPayment.n > S.payN) {
        S.payN = g.lastPayment.n; S.payFlash = { pay: g.lastPayment, until: Date.now() + 5200 };
        setTimeout(() => { if (S.screen === 'game') drawGame(); }, 5300);
      }
    }
  } else { S.evN = 0; S.timer = null; S.payN = 0; S.payFlash = null; }
  if (!S.table && !wasLobby) refreshMe();
  render();
}
async function refreshMe() {
  try {
    const [me, lb] = await Promise.all([api('me'), api('leaderboard')]);
    if (me.user) S.me = me.user;
    S.board = lb.top;
    if (S.screen === 'lobby') drawLobby();
  } catch { /* the lobby still works without the leaderboard */ }
}

/* ---------- tiles ---------- */
function tileName(k) { return k < 27 ? `${k % 9 + 1} of ${SUIT[Math.floor(k / 9)]}` : HON[k - 27]; }
// One face per kind, in kind order 0..33 (see public/tiles/). The tile body — opaque for solid
// tiles, transparent for glass ones — is drawn by CSS; the face art on top is always fully opaque.
const FACE = ['Man1', 'Man2', 'Man3', 'Man4', 'Man5', 'Man6', 'Man7', 'Man8', 'Man9',
  'Pin1', 'Pin2', 'Pin3', 'Pin4', 'Pin5', 'Pin6', 'Pin7', 'Pin8', 'Pin9',
  'Sou1', 'Sou2', 'Sou3', 'Sou4', 'Sou5', 'Sou6', 'Sou7', 'Sou8', 'Sou9',
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun'];
function tile(id, o = {}) {
  const k = id >> 2, glass = (id & 3) !== 0;
  const name = `${tileName(k)}, ${glass ? 'glass' : 'solid'}`;
  const face = `<img class="face" src="/tiles/${FACE[k]}.svg" alt="${esc(name)}" draggable="false">`;
  const cls = `tile ${glass ? 'glass' : 'solid'} ${o.cls || ''}`;
  if (o.btn) return `<button class="${cls}" data-id="${id}" title="${esc(name)}"${o.disabled ? ' disabled' : ''}>${face}</button>`;
  return `<span class="${cls}" title="${esc(name)}">${face}</span>`;
}
const back = () => '<span class="tile back" title="Solid tile, face hidden"><img class="face" src="/tiles/Back.svg" alt="" aria-hidden="true" draggable="false"></span>';
function meld(m) {
  return `<span class="meld">${m.tiles.map(t => tile(t, { cls: m.called === t ? 'side' : '' })).join('')}</span>`;
}
function pond(p, last) {
  return p.map(d => tile(d.id, { cls: (d.riichi ? 'side ' : '') + (d.called ? 'gone ' : '') + (last === d.id ? 'last' : '') })).join('');
}

/* ---------- screens ---------- */
function render() {
  const screen = S.closed ? 'closed' : !S.me ? 'auth' : S.game ? 'game' : S.table ? 'room' : 'lobby';
  if (screen !== S.screen) {
    S.screen = screen;
    $('#app').innerHTML = shells[screen]();
    if (screen === 'lobby') { refreshMe(); syncCreateForm(); }
  }
  ({ auth: drawAuth, lobby: drawLobby, room: drawRoom, game: drawGame, closed: () => {} })[screen]();
}

const chatShell = () => `<aside class="chat" aria-label="Table chat"><div class="log" id="chatlog"></div>
  <form id="chatform"><input type="text" id="chatin" maxlength="200" placeholder="Message the table" autocomplete="off" aria-label="Message"><button class="btn small">Send</button></form></aside>`;
function drawChat() {
  const log = $('#chatlog'); if (!log || !S.table) return;
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = S.table.chat.length ? S.table.chat.map(c => `<p><b>${esc(c.name)}</b>${esc(c.text)}</p>`).join('') : '<p class="muted">No messages yet.</p>';
  if (stick) log.scrollTop = log.scrollHeight;
}

const shells = {
  closed: () => `<main class="auth"><div><h1>Washizu Mahjong</h1><p class="lede">This account is now open in another window. Close that one, then reload this page to play here.</p></div></main>`,
  auth: () => `<main class="auth">
    <div>
      <img class="banner" src="/assets/homepage2.png" alt="The story's table: the blood pump beside the crystal tiles, Washizu across the felt" draggable="false">
      <h1>Washizu Mahjong</h1>
      <p class="lede">The crystal-tile mahjong Washizu Iwao invented in <i>Akagi</i> — Akagi, backed by Yasuoka, against Washizu, backed by Suzuki. On a two-against-two table you can play the story's own stakes: 20 million yen against 2,000cc of Akagi's blood, where more than 2,000cc lost ends him — or keep the table for points alone.</p>
      <div class="quad" aria-hidden="true">${tile(13 * 4 + 1)}${tile(13 * 4 + 2)}${tile(13 * 4 + 3)}${tile(13 * 4)}</div>
      <p class="quadnote">Three of every four tiles are glass. The whole table can read them, in your hand and in everyone else's. Only the fourth stays private.</p>
    </div>
    <form class="card" id="authform" novalidate>
      <h2 id="authtitle"></h2>
      <label>Player name<input type="text" id="au" autocomplete="username" maxlength="16" required></label>
      <label>Password<input type="password" id="ap" required></label>
      <p class="err" id="autherr" role="alert"></p>
      <button class="btn primary" id="authgo"></button>
      <p class="switch" id="authswitch"></p>
    </form></main>`,
  lobby: () => `<header class="top"><span class="brand">Washizu Mahjong</span><span class="muted" id="online"></span><span id="whoami"></span><button class="btn small" data-act="logout">Log out</button></header>
    <main class="lobby"><div>
      <section><h2>Open tables</h2><div id="tables"></div></section>
      <section><h2>Start a table</h2>
        <form id="createform" class="card">
          <label>Table name<input type="text" id="tn" maxlength="30" placeholder="Optional"></label>
          <label>Mode<select id="tm"><option value="team" selected>Two against two</option><option value="ffa">Free-for-all</option></select></label>
          <label>Length<select id="tl"><option value="east" class="ffaonly">East round only (about 20 minutes)</option><option value="south">East and South (about 45 minutes)</option><option value="hanchan2">2 hanchan (about 90 minutes)</option><option value="hanchan4">4 hanchan (about 3 hours)</option><option value="hanchan6">6 hanchan (about 4½ hours)</option></select></label>
          <label>Time per turn<select id="tt"><option value="15">15 seconds</option><option value="30" selected>30 seconds</option><option value="60">60 seconds</option></select></label>
          <label id="stakelabel">The stakes<select id="ts" title="A team game only: every point that passes directly between Akagi and Washizu is paid out in blood and money.">
            <option value="none" selected>None — points only</option>
            <option value="low">Low — 20 million yen for 2,000cc of blood, over 200,000 points</option>
            <option value="high">High — 20 million yen for 2,000cc of blood, over 20,000 points</option>
          </select></label>
          <p class="muted" id="stakenote" style="font-size:.85rem;margin:-.4rem 0 1rem">Akagi's blood is drawn as the direct exchanges against Washizu are paid. More than 2,000cc lost and he dies, the game over at once; surviving it wins his team the match. Free-for-all tables always play for points only.</p>
          <button class="btn primary">Create table</button>
        </form></section>
    </div><div>
      <section><h2>Your record</h2><div id="record"></div></section>
      <section><h2>Leaderboard</h2><div id="board"></div></section>
      <section class="rules"><h2>The story and the rules</h2>
        <p class="muted">Washizu Mahjong (와시즈 마작) is the special riichi game Washizu Iwao invented in Nobuyuki Fukumoto's <i>Akagi</i>. Washizu is the "king of the gambling world," whose left hand is said to be godlike and never to lose — and this game is the one he set, on his own house rules, for the greatest gambler in the country. <b>Washizu</b>, backed by <b>Suzuki</b>, plays against <b>Akagi</b>, backed by <b>Yasuoka</b>, over crystal tiles.</p>
        <p class="muted">Washizu stakes 20 million yen; Akagi stakes his own blood — 2,000cc, the "vampire rules" — so the more he loses, the more he bleeds, and playing it safe is no shelter. On a two-against-two table you can set the story's stakes on the table — low, where 2,000cc is worth 200,000 points, or high, where it is worth 20,000, the ratio of the story itself. Then every point that passes directly between Akagi and Washizu is paid out in blood and money the moment the hand ends; if at any moment more than 2,000cc has been lost, Akagi dies and the game is over at once, and otherwise his team wins the match by surviving. Free-for-all tables play for points only. The story's match is said to have lasted 21 years. <a href="https://en.namu.wiki/w/%EC%99%80%EC%8B%9C%EC%A6%88%20%EB%A7%88%EC%9E%91" target="_blank" rel="noopener">The story and its rules</a>.</p>
        <details open><summary>The rules, in eight lines</summary><ul>
          <li><strong>Crystal tiles.</strong> Each tile has four copies: three are transparent crystal — visible to the whole table, in your hand and in everyone else's — and the fourth is solid, showing only its back in a hand. Washizu ground the crystal set himself: every tile can be read, and that is exactly what binds you.</li>
          <li><strong>The hole.</strong> There is no wall to track. The 136 tiles are machine-shuffled and drawn at random, one at a time, from a bag standing in for the hole in the middle of the story's table. A hand ends in a draw after 70 draws.</li>
          <li><strong>Everything else is riichi mahjong.</strong> You need a yaku to win. Riichi, ippatsu, dora, ura dora, kan dora and furiten all apply. Open tanyao is allowed.</li>
          <li><strong>The seats.</strong> Four fixed roles, played in the order Akagi → Yasuoka → Washizu → Suzuki, and you pick your role by taking its seat. In two-against-two games Akagi and Washizu lead the teams, backed by Yasuoka and Suzuki; you cannot see your partner's solid tiles, and you may win off your partner's discard.</li>
          <li><strong>The modes.</strong> When starting a table you choose two-against-two — the story's match — or free-for-all, where everyone plays for themselves. In free-for-all there are no hanchan settlements and the game ends after its last hand; the highest total wins, a tie going to the lower seat, so there are no drawn games.</li>
          <li><strong>Winning.</strong> Everyone scores as usual from 25,000 and nobody is out for going negative. In two-against-two, when the game ends the match belongs to whichever of Akagi and Washizu has more points — the duel between the two geniuses decides it (a tie goes to Washizu's side). On a staked table the stakes decide instead: if Akagi has lost more than 2,000cc at any moment he is dead and Washizu's team wins at once; otherwise Akagi's team wins by surviving. If several players can ron the same discard, only the one nearest the discarder in turn order wins; the others get nothing.</li>
          <li><strong>Lengths and hanchan scoring.</strong> Free-for-all plays East round only or East and South; two-against-two plays East and South or 2, 4 or 6 hanchan — a hanchan is an East round followed by a South round, and there are no West or North rounds. The longest game here is about 4½ hours. In two-against-two, at the end of each hanchan the places are paid as in the story: +30,000, +10,000, −10,000, −30,000 for 1st to 4th.</li>
          <li><strong>Clock.</strong> If your time runs out, the tile you drew is discarded and calls are passed.</li>
        </ul></details></section>
    </div></main>`,
  room: () => `<header class="top"><span class="brand">Washizu Mahjong</span><button class="btn small" data-act="leave">Leave table</button></header>
    <main class="room"><div><h2 id="rname"></h2><p class="muted" id="rmeta"></p><div class="seats" id="seats"></div>
      <div class="rowbtns"><button class="btn primary" id="readybtn" data-act="ready"></button></div><p class="status" id="rstatus"></p></div>${chatShell()}</main>`,
  // The chat is drawn inside the game's bottom row (drawGame), next to the hand.
  game: () => `<div class="gamewrap"><div id="game"></div></div>`,
};

function drawAuth() {
  const reg = S.authMode === 'register';
  $('#authtitle').textContent = reg ? 'Create an account' : 'Log in';
  $('#authgo').textContent = reg ? 'Create account' : 'Log in';
  $('#ap').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authswitch').innerHTML = reg ? 'Already have an account? <button type="button" class="link" data-act="authmode">Log in</button>'
    : 'New here? <button type="button" class="link" data-act="authmode">Create an account</button>';
}

// The two names on one side of a lobby table, e.g. "Mei and an open seat". Teammates sit side by side.
function side(t, team) {
  const n = [t.seats[team * 2], t.seats[team * 2 + 1]].filter(Boolean).map(esc);
  return n.length === 2 ? n.join(' and ') : n.length === 1 ? `${n[0]} and an open seat` : 'two open seats';
}

// The top two players by score, e.g. "Mei 34,000 vs Ryo 25,000". Ties go to the lower seat,
// so this always names exactly two players.
function leaders(P) {
  const o = [0, 1, 2, 3].sort((a, b) => P[b].score - P[a].score || a - b);
  return `${esc(P[o[0]].name)} ${P[o[0]].score.toLocaleString()} vs ${esc(P[o[1]].name)} ${P[o[1]].score.toLocaleString()}`;
}

function drawLobby() {
  const L = S.lobby, st = S.me.stats;
  $('#online').textContent = `${L.online} online`;
  $('#whoami').textContent = S.me.name;
  $('#tables').innerHTML = L.tables.length ? L.tables.map(t => `<div class="trow">
      <div class="pips" aria-label="${t.seats.filter(Boolean).length} of 4 seats taken">${[0, 1, 2, 3].map(i => `<span class="pip ${t.seats[i] ? 'full' : ''} ${i === 1 ? 'gap' : ''}" title="${ROLE[i]}"></span>`).join('')}</div>
      <div class="grow"><div class="tname">${esc(t.name)}</div><div class="who">${LEN[t.length] || LEN.east}, ${t.turnSec}s turns. ${t.mode === 'ffa' ? 'Free-for-all: each player for themselves' : `${esc(TEAM[0])} (${side(t, 0)}) against ${esc(TEAM[1])} (${side(t, 1)})`}</div></div>
      ${t.mode === 'ffa' ? '<span class="tag">Free-for-all</span>' : (t.stake && t.stake !== 'none') ? `<span class="tag bet" title="20 million yen for 2,000cc of Akagi's blood — ${STAKE[t.stake].pts.toLocaleString()} points">${STAKE[t.stake].label}</span>` : ''}${t.playing ? '<span class="tag">In play</span>' : t.seats.every(Boolean) ? '<span class="tag">Full</span>' : `<button class="btn small" data-act="join" data-table="${t.id}">Take a seat</button>`}
    </div>`).join('') : '<p class="empty">No tables are open. Start one below and three more players can join it.</p>';
  $('#record').innerHTML = st.games ? `<dl class="facts"><dt>Rating</dt><dd>${st.rating}</dd><dt>Games</dt><dd>${st.games}</dd>
      <dt>Wins</dt><dd>${st.wins}</dd></dl>` : `<p class="muted">Rating ${st.rating}. Finish a game to start your record.</p>`;
  $('#board').innerHTML = S.board.length ? `<table class="board"><thead><tr><th>Player</th><th class="num">Rating</th><th class="num">Games</th><th class="num">Wins</th></tr></thead><tbody>${
    S.board.map(u => `<tr><td>${esc(u.name)}</td><td class="num">${u.stats.rating}</td><td class="num">${u.stats.games}</td><td class="num">${u.stats.wins}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nobody has finished a game yet.</p>';
}

function drawRoom() {
  const t = S.table, mine = t.seats.find(s => s && s.name === S.me.name);
  const n = t.seats.filter(Boolean).length;
  $('#rname').textContent = t.name;
  const ffa = t.mode === 'ffa';
  const bet = !ffa && t.stake && t.stake !== 'none' ? ` The stakes are on: 20 million yen for 2,000cc of Akagi's blood, worth ${STAKE[t.stake].pts.toLocaleString()} points. More than 2,000cc lost ends Akagi — and the game — at once.` : '';
  $('#rmeta').textContent = `${LEN[t.length] || LEN.east}, ${t.turnSec} seconds per turn. ${ffa ? 'Free-for-all: everyone plays for themselves, and the highest total at the end wins.' : `Each seat is a fixed role: ${TEAM[0]} and ${TEAM[1]} lead the teams, with Yasuoka and Suzuki at their sides.`} Turns go Akagi, Yasuoka, Washizu, Suzuki; Akagi deals first.${bet}`;
  const seat = i => { const s = t.seats[i], part = s ? t.seats[i ^ 1] : null; return s
    ? `<div class="seat ${s.ready ? 'rdy' : ''}"><div class="sn">${esc(s.name)}${s.name === S.me.name ? ' (you)' : ''}</div><div class="ss">${!s.online ? 'Disconnected' : s.ready ? 'Ready' : 'Not ready'} · ${ROLE[i]}${part && !ffa ? `, partner ${esc(part.name)}` : ''}</div></div>`
    : `<div class="seat open"><div class="sn">${ROLE[i]}</div><button class="btn small" data-act="seat" data-i="${i}">Play as ${ROLE[i]}</button></div>`; };
  $('#seats').innerHTML = ffa ? `<div class="team">${[0, 1, 2, 3].map(seat).join('')}</div>`
    : [0, 1].map(team => `<div class="team"><h3>${esc(TEAM[team])}</h3>${seat(team * 2)}${seat(team * 2 + 1)}</div>`).join('');
  const b = $('#readybtn');
  b.textContent = mine && mine.ready ? 'Cancel ready' : 'Ready';
  b.classList.toggle('primary', !(mine && mine.ready));
  $('#rstatus').textContent = n < 4 ? `${4 - n} more ${4 - n === 1 ? 'player is' : 'players are'} needed. The game starts when all four are ready.` : 'The game starts when all four players are ready.';
  drawChat();
}

/* ---------- the stakes ---------- */
// The stakes as they stand: eight tubes of 250cc hold the 2,000cc of the story, and the
// money Akagi's side has taken. g.stake is null on tables without the stakes.
function stakeBox(g) {
  if (!g.stake) return '';
  const { pts, blood, money, dead } = g.stake;
  const full = STAKE[g.stake.level].yen;
  const pct = full ? Math.max(0, Math.min(100, (money / full) * 100)) : 0;
  const tubes = [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
    const f = Math.max(0, Math.min(1, (blood - i * 250) / 250));
    return `<span class="tube" title="${(i * 250).toLocaleString()}–${((i + 1) * 250).toLocaleString()}cc"><i style="height:${(f * 100).toFixed(1)}%"></i></span>`;
  }).join('');
  // The ? holds everything that does not fit: what the stake is worth, and what the blood means.
  const tip = `${STAKE[g.stake.level].label} — 20,000,000 yen for 2,000cc of Akagi's blood, worth ${pts.toLocaleString()} points. Blood is drawn as Akagi's side loses points directly to Washizu's side; more than 2,000cc lost and Akagi dies, the game over at once.`;
  return `<div class="stakebox">
    <div class="sbhead">The stakes<span class="stakeinfo" tabindex="0" aria-label="About the stakes">?<span class="staketip" role="tooltip">${tip}</span></span></div>
    <div class="tubes" title="The blood lost so far">${tubes}</div>
    <div class="sbstat"><b class="${dead ? 'dead' : ''}">${dead ? 'Akagi is dead' : blood.toLocaleString() + 'cc'}</b><span class="muted">${dead ? 'more than 2,000cc lost — Washizu’s team wins the match' : 'lost of the 2,000cc'}</span></div>
    <div class="moneybar" title="The money taken so far, out of the 20,000,000 yen at stake"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="sbstat"><b>${fmtYen(money)}</b><span class="muted">taken so far</span></div>
  </div>`;
}
// The words on the payment banner. lastPayment: { dir, cc, choice, transfused, money, blood }.
function payFlashText(p, dead) {
  if (p.dir < 0) return dead
    ? `Blood drawn — ${p.cc.toLocaleString()}cc. That is more than 2,000cc: Akagi is dead, and the game is over.`
    : `Blood drawn — ${p.cc.toLocaleString()}cc for ${p.points.toLocaleString()} points. ${p.blood.toLocaleString()}cc is now lost.`;
  if (p.choice === 'transfuse') return `Transfused — ${p.transfused.toLocaleString()}cc of the lost blood comes back${p.transfused < p.cc ? `, the other ${(p.cc - p.transfused).toLocaleString()}cc becomes ${fmtYen(p.money)}` : ''}. ${p.blood.toLocaleString()}cc is still lost.`;
  return `Money taken — ${fmtYen(p.money)} for ${p.points.toLocaleString()} points.`;
}

/* ---------- the table ---------- */
function drawGame() {
  const g = S.game, me = g.seat, P = g.players, el = $('#game');
  if (!el) return;
  const last = g.lastDiscard ? g.lastDiscard.id : null;
  const flash = s => (S.flash && S.flash.seat === s && S.flash.until > Date.now() ? `<div class="flash">${esc(S.flash.text)}</div>` : '');
  const head = (p, s) => `<div class="phead"><span class="wind ${s === g.dealer ? 'dealer' : ''}" title="${W[p.wind]} seat${s === g.dealer ? ', dealer' : ''}">${WK[p.wind]}</span>
      ${g.mode === 'ffa' ? `<span class="tag role ${s >> 1 ? 'r1' : 'r0'}" title="${ROLE[s]}">${ROLE[s][0]}</span><span class="pname">${esc(p.name)}</span>` : `<span class="pname">${who(p, s, g.mode)}</span>`}${g.mode !== 'ffa' && s === (me ^ 1) ? '<span class="tag partner">Partner</span>' : ''}${p.riichi ? '<span class="tag riichi">Riichi</span>' : ''}${p.online ? '' : '<span class="tag warn">Away</span>'}
      <span class="score">${p.score.toLocaleString()}</span></div>`;
  const myTurn = g.phase === 'action' && g.turn === me;
  const opp = s => {
    const p = P[s];
    return `<section class="opp ${g.mode !== 'ffa' && Math.floor(s / 2) === Math.floor(me / 2) ? 'ally' : ''} ${g.phase === 'action' && g.turn === s ? 'turn' : ''}">${head(p, s)}
      <div class="tiles ohand">${p.glass.map(t => tile(t)).join('')}${back().repeat(p.hidden)}${p.melds.map(meld).join('')}</div>
      <div class="pond">${pond(p.pond, last)}</div>${flash(s)}</section>`;
  };

  // actions
  const o = g.options, c = g.claim, acts = [];
  if (myTurn && o) {
    if (o.tsumo) acts.push('<button class="btn primary" data-act="tsumo">Tsumo</button>');
    if (o.riichi.length) acts.push(`<button class="btn ${S.riichiMode ? 'on' : ''}" data-act="riichimode">${S.riichiMode ? 'Cancel riichi' : 'Riichi'}</button>`);
    for (const k of o.ankan) acts.push(`<button class="btn" data-act="ankan" data-kind="${k}">Kan ${tile(k * 4 + 1)}</button>`);
    for (const k of o.kakan) acts.push(`<button class="btn" data-act="kakan" data-kind="${k}">Kan ${tile(k * 4 + 1)}</button>`);
  } else if (c) {
    if (c.ron) acts.push('<button class="btn primary" data-act="claim" data-c="ron">Ron</button>');
    if (c.pon) acts.push('<button class="btn" data-act="claim" data-c="pon">Pon</button>');
    if (c.kan) acts.push('<button class="btn" data-act="claim" data-c="kan">Kan</button>');
    (c.chi || []).forEach((pair, i) => acts.push(`<button class="btn" data-act="claim" data-c="chi" data-i="${i}">Chi ${pair.map(t => tile(t)).join('')}</button>`));
    acts.push('<button class="btn" data-act="claim" data-c="pass">Pass</button>');
  }
  let status = '';
  if (g.phase === 'action') {
    status = !myTurn ? `${g.mode === 'ffa' ? P[g.turn].name : ROLE[g.turn]} is choosing a discard.`
      : P[me].riichi && !o.tsumo && !o.ankan.length ? 'You are in riichi. Your draw is discarded for you.'
        : S.riichiMode ? 'Choose the tile to discard with your riichi.'
          : S.sel != null ? 'Select the raised tile again to discard it.' : 'Your turn. Select a tile to discard.';
  } else if (g.phase === 'claim') status = 'Waiting for potential calls.';

  // my hand
  const mine = P[me], allowed = myTurn && o ? (S.riichiMode ? o.riichi : o.discard) : [];
  const handTiles = mine.tiles.filter(t => t !== g.drawn);
  const btn = (t, extra) => tile(t, { btn: true, disabled: !allowed.includes(t), cls: (myTurn && !allowed.includes(t) ? 'dim ' : '') + (S.sel === t ? 'sel ' : '') + (extra || '') });
  const hand = handTiles.map(t => btn(t)).join('') + (g.drawn != null ? btn(g.drawn, 'drawn') : '') + mine.melds.map(meld).join('');

  const pf = g.stake && S.payFlash && S.payFlash.until > Date.now() ? payFlashText(S.payFlash.pay, g.stake.dead) : '';
  // The chat lives in the bottom row, so every redraw replaces it: keep its draft, focus and scroll.
  const ci0 = $('#chatin'), cl0 = $('#chatlog');
  const draft = ci0 ? ci0.value : '';
  const chatFocused = ci0 === document.activeElement;
  const stick = cl0 ? cl0.scrollHeight - cl0.scrollTop - cl0.clientHeight < 40 : true;
  const oldScroll = cl0 ? cl0.scrollTop : 0;
  el.innerHTML = `
    ${pf ? `<div class="payflash ${S.payFlash.pay.dir < 0 ? 'blood' : 'money'}" role="status">${pf}</div>` : ''}
    <div class="opps">${opp((me + 3) % 4)}${opp((me + 2) % 4)}${opp((me + 1) % 4)}</div>
    <div class="mid">
      <div class="info"><h3>${W[g.roundWind]} ${g.kyoku + 1}</h3>
        <dl class="facts">${g.mode === 'ffa' ? `<dt>Leaders</dt><dd>${leaders(P)}</dd>` : `<dt>Akagi vs Washizu</dt><dd>${P[0].score.toLocaleString()} · ${P[2].score.toLocaleString()}</dd>`}<dt>Hanchan</dt><dd>${g.hanchan} of ${g.hanchans}</dd><dt>Draws left</dt><dd>${g.drawsLeft}</dd><dt>Repeat counters</dt><dd>${g.honba}</dd><dt>Riichi sticks on table</dt><dd>${g.sticks}</dd></dl>
        <div class="muted" style="font-size:.85rem;margin-bottom:4px">Dora indicators</div><div class="tiles">${g.dora.map(t => tile(t)).join('')}</div>
        <div class="timer"><span id="tbar"></span></div><p class="status">${esc(status)}</p></div>
      <div class="mine"><div class="muted" style="font-size:.85rem;margin-bottom:6px">Your discards</div><div class="pond">${pond(mine.pond, last)}</div></div>
      ${stakeBox(g)}
    </div>
    <div class="bottom">
      <section class="me ${myTurn ? 'turn' : ''}">${head(mine, me)}
        <div class="actions">${acts.join('')}${g.furiten ? '<span class="tag warn" title="One of your winning tiles is in your discards or you let one pass, so you cannot win by ron.">Furiten</span>' : ''}</div>
        <div class="myhand">${hand}</div>
        <p class="hint">Glass tiles in your hand are visible to the whole table. Your solid tiles are the only ones your opponents cannot read.</p>${flash(me)}
      </section>
      ${chatShell()}
    </div>${overlay(g)}`;
  tick();
  drawChat();
  const ci = $('#chatin'), cl = $('#chatlog');
  if (ci) { if (draft) ci.value = draft; if (chatFocused) ci.focus(); }
  if (cl) { if (stick) cl.scrollTop = cl.scrollHeight; else cl.scrollTop = oldScroll; }
}

function overlay(g) {
  const P = g.players, r = g.result;
  if (g.phase === 'over') {
    const t = S.table, mine = t.seats.find(s => s && s.name === S.me.name);
    const f = g.final, myTeam = g.seat >> 1;
    const head = f.standings
      ? `<h2>${f.winner === g.seat ? 'You win the game' : `${esc(f.standings[0].name)} wins the game`}</h2>
        <div class="rank" style="margin-top:14px">${f.standings.map(m => `<span${m.won ? ' class="pl"' : ''}>${['1st', '2nd', '3rd', '4th'][m.rank - 1]} · ${esc(m.name)}${m.seat === g.seat ? ' (you)' : ''}</span><span>${m.score.toLocaleString()}</span>`).join('')}</div>
        <p class="muted" style="margin-top:14px">${esc(f.standings[0].name)} ${f.standings[0].score.toLocaleString()} against ${esc(f.standings[1].name)} ${f.standings[1].score.toLocaleString()} — the highest total takes the game.</p>`
      : `<h2>${f.winner === myTeam ? 'Your team wins' : 'Your team loses'}</h2>
        ${f.teams.map(tm => `<div class="win"><div class="teamline"><b>${esc(TEAM[tm.team])}${tm.team === myTeam ? ' (your team)' : ''}</b><span class="total">${tm.total.toLocaleString()}</span></div>
          <div class="rank">${tm.members.map(m => `<span><b>${who(m, m.seat, 'team')}</b></span><span>${m.score.toLocaleString()}</span>`).join('')}</div></div>`).join('')}
        ${f.stake ? `<div style="margin-top:14px">${stakeBox(g)}</div>
        <p class="muted" style="margin-top:10px">${f.stake.dead ? `Akagi lost ${f.stake.blood.toLocaleString()}cc — more than the 2,000cc the stakes allow — so he is dead, and the ${esc(TEAM[1])} team takes the game. ${fmtYen(f.stake.money)} had changed hands before the end.` : `Akagi survived the match with ${f.stake.blood.toLocaleString()}cc of the 2,000cc lost, so his team takes the game. The money stands at ${fmtYen(f.stake.money)}.`}</p>`
        : `<p class="muted" style="margin-top:14px">Akagi ${f.decider[0].toLocaleString()} against Washizu ${f.decider[1].toLocaleString()} — ${f.winner === 0 ? 'Akagi leads, so' : 'Washizu is not behind, so'} the ${esc(TEAM[f.winner])} team takes the game.</p>`}`;
    return `<div class="overlay"><div class="sheet">${head}
      <p class="muted" style="margin-top:8px">${t.seats.filter(s => s && s.ready).length} of 4 ready for another game with the same roles.</p>
      <div class="rowbtns" style="margin-top:14px"><button class="btn ${mine && mine.ready ? '' : 'primary'}" data-act="ready">${mine && mine.ready ? 'Cancel ready' : 'Play again'}</button><button class="btn" data-act="regroup">Change roles</button><button class="btn" data-act="leave">Leave table</button></div>
    </div></div>`;
  }
  if (g.phase === 'settle') {
    const st = g.settle, iAmAkagi = g.seat === 0;
    return `<div class="overlay"><div class="sheet">
      <h2>The stakes are settled</h2>
      <p>${st.points.toLocaleString()} points are being settled between Akagi and Washizu — as ${fmtYen(st.yen)}, or as ${st.cc.toLocaleString()}cc of blood.</p>
      ${stakeBox(g)}
      ${iAmAkagi ? `<div class="rowbtns" style="margin-top:14px">
        <button class="btn primary" data-act="settle" data-c="money">Take ${fmtYen(st.yen)}</button>
        <button class="btn" data-act="settle" data-c="transfuse" title="The lost blood comes back as far as it can, down to 0cc; anything beyond comes back as yen.">Transfuse ${st.cc.toLocaleString()}cc <span class="muted">(${st.transfused.toLocaleString()}cc back · ${fmtYen(st.restYen)} the rest)</span></button>
      </div>
      <p class="muted" style="margin-top:10px;font-size:.85rem">If the clock runs out, the yen are taken.</p>`
      : `<p class="muted" style="margin-top:10px">Waiting for <b>${esc(P[0].name)}</b> — the one who plays Akagi — to choose.</p>`}
    </div></div>`;
  }
  if (g.phase !== 'ended' || !r) return '';
  let body = '', title;
  if (r.type === 'draw') {
    title = 'Exhaustive draw';
    const tp = r.hands.map((h, s) => (h ? `<div class="win"><p><b>${who(P[s], s, g.mode)}</b> is tenpai.</p><div class="tiles">${h.hand.map(t => tile(t)).join('')}${h.melds.map(meld).join('')}</div></div>` : '')).join('');
    body = tp || '<p class="muted">Nobody was one tile from winning.</p>';
  } else {
    title = r.type === 'tsumo' ? 'Tsumo' : 'Ron';
    body = r.winners.map(w => `<div class="win">
      <p><b>${who(P[w.seat], w.seat, g.mode)}</b> ${r.type === 'tsumo' ? 'wins by self-draw.' : `wins off ${who(P[r.from], r.from, g.mode)}'s discard.`}</p>
      <div class="tiles" style="margin-top:8px">${w.hand.map(t => tile(t)).join('')}<span style="width:10px"></span>${tile(w.winTile, { cls: 'last' })}${w.melds.map(meld).join('')}</div>
      <div class="yaku">${w.yaku.map(y => `<span>${esc(y[0])}</span><span>${w.yakuman ? 'yakuman' : y[1] + ' han'}</span>`).join('')}</div>
      <p class="total">${w.limit ? esc(w.limit) + ', ' : ''}${w.yakuman ? '' : `${w.han} han ${w.fu} fu, `}${w.total.toLocaleString()} points</p></div>`).join('');
    body += `<div class="win"><div class="muted" style="font-size:.85rem">Dora indicators</div><div class="tiles">${r.dora.map(t => tile(t)).join('')}</div>
      ${r.ura ? `<div class="muted" style="font-size:.85rem;margin-top:8px">Ura dora indicators</div><div class="tiles">${r.ura.map(t => tile(t)).join('')}</div>` : ''}</div>`;
  }
  const ready = g.nextReady.includes(g.seat);
  // me, my partner, then the two opponents - (g.seat + 3) % 4 is the partner again on odd seats,
  // so the last two seats are the ones that are neither me nor my partner
  const order = [g.seat, g.seat ^ 1, ...[0, 1, 2, 3].filter(s => s !== g.seat && s !== (g.seat ^ 1))];
  return `<div class="overlay"><div class="sheet"><h2>${title}</h2>${body}
    <div class="deltas">${order.map(s => { const p = P[s]; return `<div class="${g.mode !== 'ffa' && Math.floor(s / 2) === Math.floor(g.seat / 2) ? 'ours' : ''}"><b>${who(p, s, g.mode)}</b><span class="${r.deltas[s] > 0 ? 'plus' : r.deltas[s] < 0 ? 'minus' : ''}">${r.deltas[s] > 0 ? '+' : ''}${r.deltas[s].toLocaleString()}</span><br>${p.score.toLocaleString()}</div>`; }).join('')}</div>
    <p class="muted" style="margin-bottom:14px">${g.mode === 'ffa' ? leaders(P) + '.' : `Akagi ${P[0].score.toLocaleString()} vs Washizu ${P[2].score.toLocaleString()}.${g.stake ? ` The stakes so far: ${g.stake.blood.toLocaleString()}cc lost, ${fmtYen(g.stake.money)} taken.` : ''}`}</p>
    <button class="btn primary" data-act="next" ${ready ? 'disabled' : ''}>${ready ? 'Waiting for the others' : 'Continue'}</button>
  </div></div>`;
}

function tick() {
  const bar = $('#tbar'); if (!bar) return;
  if (!S.timer) { bar.style.width = '0'; return; }
  const left = S.timer.deadline - (Date.now() + S.offset);
  bar.style.width = Math.max(0, Math.min(100, (left / S.timer.total) * 100)) + '%';
}
setInterval(tick, 100);

/* ---------- input ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-id]');
  if (!t) return;
  const a = t.dataset.act;
  if (t.dataset.id != null && !a) {
    const id = +t.dataset.id;
    if (S.riichiMode) { sendMsg({ t: 'act', a: 'riichi', id }); S.riichiMode = false; }
    else if (S.sel === id) { sendMsg({ t: 'act', a: 'discard', id }); S.sel = null; }
    else { S.sel = id; drawGame(); }
    return;
  }
  if (a === 'authmode') { S.authMode = S.authMode === 'login' ? 'register' : 'login'; $('#autherr').textContent = ''; drawAuth(); }
  else if (a === 'logout') { try { await api('logout', {}); } catch { /* log out locally anyway */ } S.me = null; S.table = S.game = null; if (ws) ws.close(); render(); }
  else if (a === 'join') sendMsg({ t: 'join', id: t.dataset.table });
  else if (a === 'leave') sendMsg({ t: 'leave' });
  else if (a === 'seat') sendMsg({ t: 'seat', i: +t.dataset.i });
  else if (a === 'regroup') sendMsg({ t: 'regroup' });
  else if (a === 'ready') { const mine = S.table.seats.find(s => s && s.name === S.me.name); sendMsg({ t: 'ready', v: !(mine && mine.ready) }); }
  else if (a === 'riichimode') { S.riichiMode = !S.riichiMode; S.sel = null; drawGame(); }
  else if (a === 'tsumo') sendMsg({ t: 'act', a: 'tsumo' });
  else if (a === 'ankan' || a === 'kakan') sendMsg({ t: 'act', a, kind: +t.dataset.kind });
  else if (a === 'claim') sendMsg({ t: 'act', a: 'claim', c: t.dataset.c, i: t.dataset.i != null ? +t.dataset.i : undefined });
  else if (a === 'settle') sendMsg({ t: 'act', a: 'settle', c: t.dataset.c });
  else if (a === 'next') sendMsg({ t: 'act', a: 'next' });
});

// A free-for-all table always plays for points, and East-only is its length: the create form
// follows the mode it is given. Runs whenever the lobby is drawn and whenever the mode moves.
function syncCreateForm() {
  const tm = $('#tm');
  if (!tm) return;
  const team = tm.value === 'team';
  const east = $('#tl option.ffaonly');
  if (east) east.hidden = team;
  if (team && $('#tl').value === 'east') $('#tl').value = 'south';
  $('#stakelabel').hidden = !team;
  $('#stakenote').hidden = !team;
  const ts = $('#ts');
  ts.disabled = !team;
  if (!team) ts.value = 'none';     // free-for-all never carries the stakes
}
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'tm') syncCreateForm();
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'authform') {
    const err = $('#autherr'), go = $('#authgo');
    err.textContent = ''; go.disabled = true;
    try {
      const r = await api(S.authMode === 'register' ? 'register' : 'login', { username: $('#au').value, password: $('#ap').value });
      S.me = r.user; S.closed = false; render(); connect();
    } catch (x) { err.textContent = x.message; }
    go.disabled = false;
  } else if (f.id === 'createform') {
    sendMsg({ t: 'create', name: $('#tn').value, mode: $('#tm').value, length: $('#tl').value, turnSec: +$('#tt').value, stake: $('#tm').value === 'team' ? $('#ts').value : 'none' });
  } else if (f.id === 'chatform') {
    const i = $('#chatin');
    if (i.value.trim()) sendMsg({ t: 'chat', text: i.value });
    i.value = '';
  }
});

(async function boot() {
  try { const r = await api('me'); S.me = r.user; } catch { /* show the login form */ }
  render();
  connect();
})();
