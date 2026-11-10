'use strict';
// Plays a whole game over HTTP + WebSocket against TWO server instances that share one store,
// the way separate Vercel function instances would. Players are spread across both instances
// and one of them switches instance mid-game.
//   node test/e2e.js                      in-memory store shared by both instances
//   REDIS_URL=redis://... node test/e2e.js  real Redis, each instance with its own connections
const assert = require('assert');
const WebSocket = require('ws');
const { createApp } = require('../lib/app');
const { MemoryStore, createStore } = require('../lib/store');

const useRedis = !!process.env.REDIS_URL;
const shared = useRedis ? null : new MemoryStore();
const apps = [0, 1].map(() => createApp({ store: useRedis ? createStore() : shared }));
const ports = [];
const base = i => `http://localhost:${ports[i]}`;
const post = (i, op, body, cookie) => fetch(`${base(i)}/api/server?op=${op}`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { cookie } : {}), body: JSON.stringify(body) });
const get = async (i, op, cookie) => (await fetch(`${base(i)}/api/server?op=${op}`, { headers: cookie ? { cookie } : {} })).json();
// `prepare` attaches listeners before the socket opens, so the first messages are never missed
const wsOpen = (i, cookie, origin, prepare) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://localhost:${ports[i]}/api/server`, { headers: Object.assign({}, cookie ? { cookie } : {}, origin ? { origin } : {}) });
  if (prepare) prepare(ws);
  ws.on('open', () => res(ws)); ws.on('error', rej);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await wait(20); } };

(async () => {
  if (useRedis) { const r = apps[0].store.r; for (const k of await r.keys('gm:*')) await r.del(k.slice(3)); }
  for (const a of apps) { await new Promise(r => a.server.listen(0, r)); ports.push(a.server.address().port); }
  const tag = Math.random().toString(36).slice(2, 7);
  const N = ['Alice', 'Bob', 'Carol', 'Dave'].map(n => n + '_' + tag);

  // ---- accounts: registered on one instance, usable on the other ----
  assert.strictEqual((await post(0, 'register', { username: 'ab', password: 'longenough' })).status, 400);
  assert.strictEqual((await post(0, 'register', { username: N[0], password: 'short' })).status, 400);
  const cookies = [];
  for (let i = 0; i < 4; i++) {
    const r = await post(i % 2, 'register', { username: N[i], password: 'correct horse ' + i });
    assert.strictEqual(r.status, 200);
    const c = r.headers.get('set-cookie'); assert.ok(/HttpOnly/.test(c) && /SameSite=Lax/.test(c));
    cookies.push(c.split(';')[0]);
  }
  assert.strictEqual((await post(1, 'register', { username: N[0].toUpperCase(), password: 'whatever123' })).status, 409);
  assert.strictEqual((await post(1, 'login', { username: N[0], password: 'wrong password' })).status, 401);
  assert.strictEqual((await post(1, 'login', { username: N[0].toLowerCase(), password: 'correct horse 0' })).status, 200);
  assert.strictEqual((await get(0, 'me')).user, null);
  const me = await get(1, 'me', cookies[0]);                       // session made on instance 0, read on instance 1
  assert.strictEqual(me.user.name, N[0]); assert.ok(!JSON.stringify(me).includes('hash'));
  assert.strictEqual((await fetch(base(0) + '/%2e%2e/dev.js')).status, 404);
  await assert.rejects(wsOpen(0, null));
  await assert.rejects(wsOpen(0, cookies[0], 'https://evil.example'));

  // ---- sockets: Alice and Carol on instance 0, Bob and Dave on instance 1 ----
  const state = [0, 1, 2, 3].map(() => ({ errs: [] }));
  const socks = [];
  let finished, acted = 0, playing = true;
  const done = new Promise(r => { finished = r; });
  function wire(ws, i) {
    socks[i] = ws;
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'err') { state[i].errs.push(m.msg); return; }
      if (m.t === 'lobby') { state[i].lobby = m.lobby; return; }
      if (m.t !== 'table') return;
      state[i].table = m.table;
      const g = m.game; state[i].game = g;
      if (!g || !playing) return;
      const act = a => { acted++; setTimeout(() => { if (socks[i].readyState === 1) socks[i].send(JSON.stringify(Object.assign({ t: 'act' }, a))); else state[i].key = null; }, 15); };
      // a client must never be sent another player's solid tiles, partner included
      g.players.forEach((p, s) => { if (s !== g.seat) { assert.ok(!p.tiles); assert.ok(p.glass.every(t => t & 3)); } });
      assert.ok(!raw.toString().includes('"pool"'), 'the bag never leaves the server');
      const key = JSON.stringify([g.phase, g.turn, g.drawsLeft, g.kyoku, g.honba, g.roundWind, !!g.options, !!g.claim, g.players[g.seat].tiles.length, (g.nextReady || []).length]);
      if (key === state[i].key) return; state[i].key = key;
      if (g.phase === 'over') { if (i === 1) finished(g); return; }
      if (g.options) {
        const o = g.options;
        if (o.tsumo) act({ a: 'tsumo' });
        else if (o.riichi.length) act({ a: 'riichi', id: o.riichi[0] });
        else act({ a: 'discard', id: g.drawn != null && o.discard.includes(g.drawn) && Math.random() < 0.5 ? g.drawn : o.discard[Math.floor(Math.random() * o.discard.length)] });
      } else if (g.claim) act({ a: 'claim', c: g.claim.ron ? 'ron' : g.claim.pon && Math.random() < 0.3 ? 'pon' : 'pass' });
      else if (g.phase === 'ended' && !g.nextReady.includes(g.seat)) act({ a: 'next' });
    });
  }
  for (let i = 0; i < 4; i++) await wsOpen(i % 2, cookies[i], null, ws => wire(ws, i));
  const say = (i, m) => socks[i].send(JSON.stringify(m));
  await until(() => state.every(s => s.lobby), 'lobby on every socket');

  // ---- lobby and seating across instances ----
  say(0, { t: 'create', name: '<b>Test</b>', length: 'east', turnSec: 15, fakeWait: [20, 60] });   // fakeWait: keep the test fast
  await until(() => state[1].lobby.tables.some(t => t.name === '<b>Test</b>') && state[0].table, 'table to appear in the other instance\'s lobby');
  const id = state[1].lobby.tables.find(t => t.name === '<b>Test</b>').id;
  for (const i of [1, 2, 3]) { say(i, { t: 'join', id }); await until(() => state[i].table, 'join ' + i); }
  await until(() => state[0].table.seats.every(Boolean), 'all seated');
  assert.deepStrictEqual(state[0].table.seats.map(s => s.name), N);
  say(1, { t: 'seat', i: 0 });
  await until(() => state[1].errs.some(e => /taken/.test(e)), 'occupied seat refused');
  say(0, { t: 'leave' }); await until(() => state[0].table === null, 'Alice back in lobby');
  say(3, { t: 'seat', i: 0 }); await until(() => state[1].table.seats[0] && state[1].table.seats[0].name === N[3], 'Dave moved');
  say(0, { t: 'join', id }); await until(() => state[0].table && state[2].table.seats.every(Boolean), 'Alice rejoined');
  assert.deepStrictEqual(state[2].table.seats.map(s => s.name), [N[3], N[1], N[2], N[0]]);
  const teamOf = { [N[3]]: 'A', [N[1]]: 'A', [N[2]]: 'B', [N[0]]: 'B' };   // teammates sit side by side: seats 0+1 and 2+3
  say(0, { t: 'chat', text: 'good luck' });
  await until(() => state[3].table.chat.length === 1, 'chat crosses instances');
  for (const i of [0, 1, 2]) say(i, { t: 'ready', v: true });
  await until(() => state[3].table.seats.filter(s => s.ready).length === 3, 'three ready');
  assert.ok(!state[0].game, 'three ready players must not start a game');
  say(3, { t: 'ready', v: true });
  await until(() => state.every(s => s.game), 'game start on all four sockets');
  const names = state[0].game.players.map(p => p.name);
  assert.strictEqual(teamOf[names[0]], teamOf[names[1]]);
  assert.strictEqual(teamOf[names[2]], teamOf[names[3]]);
  assert.notStrictEqual(teamOf[names[0]], teamOf[names[2]]);
  say(0, { t: 'leave' });
  await until(() => state[0].errs.some(e => /in progress/.test(e)), 'cannot leave mid-game');

  // ---- mid-game: Alice's socket is cut (as Vercel does at the duration cap) and she reconnects to the OTHER instance ----
  await wait(600);
  socks[0].terminate(); state[0].game = null; state[0].key = null;
  await wait(200);
  await wsOpen(1, cookies[0], null, ws => wire(ws, 0));
  await until(() => state[0].game, 'Alice gets her game back from the other instance');
  assert.ok(state[0].game.players[state[0].game.seat].tiles.length >= 1);
  // the same account opening a second socket closes the first, even across instances
  const closed = new Promise(r => socks[0].on('close', code => r(code)));
  state[0].key = null;
  await wsOpen(0, cookies[0], null, ws => wire(ws, 0));
  assert.strictEqual(await closed, 4001);

  const final = await Promise.race([done, wait(90000).then(() => { throw new Error('game did not finish; actions sent: ' + acted + ' ' + JSON.stringify(state.map(s => [s.key, s.errs]))); })]);
  playing = false;
  assert.strictEqual(final.final.teams.length, 2);
  for (const t of final.final.teams) assert.strictEqual(teamOf[t.members[0].name], teamOf[t.members[1].name]);
  assert.ok(!JSON.stringify(final.final).includes('"key"'), 'account keys are not sent to clients');
  assert.ok(final.final.winner === 0 || final.final.winner === 1, 'there are no drawn games');
  assert.strictEqual(final.final.winner, final.final.decider[0] > final.final.decider[1] ? 0 : 1, 'winner is the Akagi-vs-Washizu comparison');
  await wait(300);
  const lb = (await get(1, 'leaderboard')).top.filter(u => N.includes(u.name));
  assert.strictEqual(lb.length, 4);
  assert.strictEqual(lb.reduce((a, u) => a + u.stats.games, 0), 4);
  assert.strictEqual(lb.reduce((a, u) => a + u.stats.wins, 0), 2, 'one team wins, so exactly two players win');
  assert.strictEqual(lb.reduce((a, u) => a + u.stats.rating, 0), 6000, 'rating is zero-sum');
  say(1, { t: 'regroup' }); await until(() => state[2].game === null && state[2].table, 'change teams returns everyone to seating');
  for (const i of [0, 1, 2, 3]) { say(i, { t: 'leave' }); await until(() => state[i].table === null, 'leave ' + i); }
  await until(() => !state[0].lobby.tables.some(t => t.id === id), 'empty table disappears from the lobby');
  let cmds = '';
  if (useRedis) { const info = await apps[0].store.r.info('stats'); cmds = ', redis commands: ' + /total_commands_processed:(\d+)/.exec(info)[1]; }
  console.log(`e2e passed (${useRedis ? 'redis' : 'memory'} store, 2 instances): full game, ${acted} actions${cmds}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
