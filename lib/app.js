'use strict';
/*
 * The whole server as one http.Server that keeps nothing important in memory.
 * Accounts, sessions, tables and games live in the store (Redis on Vercel), so any number of
 * function instances can serve the same game: an instance loads the table, applies one action
 * under a lock, saves it, and publishes the new state; every instance forwards that state to
 * the players whose sockets it happens to hold.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const { createStore } = require('./store');

const scrypt = promisify(crypto.scrypt);
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_S = 30 * 24 * 3600;
const TABLE_TTL = 900;            // seconds a table survives with nobody connected to it
const FRESH_MS = 30000;           // a player is "online" if their socket checked in this recently
const GHOST_MS = 60000;           // ...and is dropped from a waiting table after this long
const NOOP = Symbol('noop');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function createApp(opts = {}) {
  const store = 'store' in opts ? opts.store : createStore();
  const secureCookie = process.env.SECURE_COOKIE === '1' || !!process.env.VERCEL;
  const local = new Map();        // user key -> { ws, key, name, conn, tableId, score, queue }
  const timers = new Map();       // table id -> { deadline, handle }
  const intervals = [];

  /* ---------------- accounts ---------------- */
  const publicUser = u => ({ name: u.name, stats: u.stats });
  const getUser = async key => { const j = await store.get('u:' + key); return j ? JSON.parse(j) : null; };
  const putUser = (key, u) => store.set('u:' + key, JSON.stringify(u));
  const hashPassword = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  async function sessionUser(req) {
    const tok = parseCookies(req).sid;
    if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
    const key = await store.get('s:' + tok);
    if (!key) return null;
    const user = await getUser(key);
    return user ? { key, user } : null;
  }
  const cookie = (tok, maxAge) => `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  async function startSession(key) {
    const tok = crypto.randomBytes(32).toString('hex');
    await store.set('s:' + tok, key, { ex: SESSION_S });
    return cookie(tok, SESSION_S);
  }
  function clientIp(req) {
    const fwd = process.env.VERCEL && req.headers['x-forwarded-for'];
    return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  }

  /* ---------------- http ---------------- */
  function json(res, code, body, headers) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers));
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('json'));
      if (req.body && typeof req.body === 'object') return resolve(req.body);   // already parsed by the platform
      let buf = '';
      req.on('data', d => { buf += d; if (buf.length > 10000) { reject(new Error('big')); req.destroy(); } });
      req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  async function api(req, res, op) {
    if (!store) return json(res, 503, { error: 'No database is connected. Add a Redis database to this project so that REDIS_URL is set, then redeploy.' });
    if (req.method === 'GET' && op === 'me') {
      const s = await sessionUser(req);
      return json(res, 200, { user: s ? publicUser(s.user) : null });
    }
    if (req.method === 'GET' && op === 'leaderboard') {
      const keys = await store.ztop('lb', 20);
      const rows = await store.mget(keys.map(k => 'u:' + k));
      return json(res, 200, { top: rows.filter(Boolean).map(j => publicUser(JSON.parse(j))) });
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Send JSON.' }); }

    if (op === 'logout') {
      const tok = parseCookies(req).sid;
      if (tok && /^[0-9a-f]{64}$/.test(tok)) await store.del('s:' + tok);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
    if (op === 'register' || op === 'login') {
      if ((await store.incr('rl:' + clientIp(req), 600)) > 30) return json(res, 429, { error: 'Too many attempts. Wait ten minutes and try again.' });
      const name = typeof body.username === 'string' ? body.username.trim() : '';
      const pw = typeof body.password === 'string' ? body.password : '';
      const key = name.toLowerCase();
      if (op === 'register') {
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return json(res, 400, { error: 'Names are 3 to 16 letters, digits or underscores.' });
        if (pw.length < 8 || pw.length > 200) return json(res, 400, { error: 'Passwords need at least 8 characters.' });
        const salt = crypto.randomBytes(16).toString('hex');
        const user = { name, salt, hash: await hashPassword(pw, salt), created: Date.now(), stats: { games: 0, wins: 0, rating: 1500 } };
        if (!(await store.set('u:' + key, JSON.stringify(user), { nx: true }))) return json(res, 409, { error: 'That name is taken.' });
        return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': await startSession(key) });
      }
      const u = /^[a-z0-9_]{3,16}$/.test(key) ? await getUser(key) : null;
      const hash = await hashPassword(pw, u ? u.salt : 'no-such-user');
      if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) {
        return json(res, 401, { error: 'Wrong name or password.' });
      }
      return json(res, 200, { user: publicUser(u) }, { 'Set-Cookie': await startSession(key) });
    }
    json(res, 404, { error: 'Not found.' });
  }

  // API calls arrive as /api/server?op=login, on Vercel and locally; /api/login works too.
  function routeOp(req) {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith('/api/')) return null;
    return u.searchParams.get('op') || u.pathname.slice(5);
  }

  const server = http.createServer((req, res) => {
    const op = routeOp(req);
    if (op != null) return api(req, res, op).catch(e => { console.error(e); json(res, 500, { error: 'Server error.' }); });
    // Static files. On Vercel the CDN normally serves public/ before a request gets here.
    const url = req.url.split('?')[0];
    const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
      res.end(data);
    });
  });

  /* ---------------- presence ---------------- */
  const stamp = () => Date.now() + Math.random();          // unique score per check-in
  async function checkIn(c) { c.score = stamp(); await store.zadd('online', c.score, c.key); }
  async function presence(keys) {                           // -> { fresh: {key: bool}, ghost: {key: bool} }
    const ks = keys.filter(Boolean), now = Date.now(), fresh = {}, ghost = {};
    const scores = await store.zscores('online', ks);
    ks.forEach((k, i) => { const s = scores[i]; fresh[k] = local.has(k) || (s != null && now - s < FRESH_MS); ghost[k] = !fresh[k] && (s == null || now - s > GHOST_MS); });
    return { fresh, ghost };
  }

  /* ---------------- tables ---------------- */
  const playing = t => !!t.game && t.game.phase !== 'over';
  async function loadTable(id) { const j = typeof id === 'string' ? await store.get('t:' + id) : null; return j ? JSON.parse(j) : null; }
  async function currentTableId(key) {
    const id = await store.get('ut:' + key);
    if (!id) return null;
    const t = await loadTable(id);
    if (t && t.seats.includes(key)) return id;
    await store.del('ut:' + key);
    return null;
  }

  /**
   * Load a table, let fn change it, save it and tell every instance. fn gets { t, game, fresh }
   * and returns an error string, NOOP (nothing changed), or nothing. Runs under a lock.
   */
  async function withTable(id, fn) {
    let out = null;
    const err = await store.lock('t:' + id, async () => {
      const t = await loadTable(id);
      if (!t) return 'That table has closed.';
      const p = await presence(t.seats);
      const ctx = { t, game: t.game ? Game.fromJSON(t.game) : null, fresh: p.fresh, deleted: false, lobby: false };
      const setOnline = () => { if (ctx.game) ctx.game.online = t.seats.map(k => !!p.fresh[k]); };
      setOnline();
      if (!playing(t)) {                                    // tidy away players who vanished from a waiting table
        for (const k of t.seats) if (k && p.ghost[k]) { removeSeat(ctx, k); await store.del('ut:' + k); }
      }
      const r = await fn(ctx, setOnline);
      if (r === NOOP) { out = { t, game: ctx.game, fresh: p.fresh, noop: true }; return; }
      if (r) return r;
      if (ctx.deleted || t.seats.every(s => !s)) {
        await store.del('t:' + id); await store.srem('tables', id);
        out = { t: null, lobby: true }; return;
      }
      if (ctx.game && ctx.game.phase === 'over' && !ctx.game.recorded) { ctx.game.recorded = true; await recordResult(ctx.game.final); }
      t.game = ctx.game ? ctx.game.toJSON() : null;
      await store.set('t:' + id, JSON.stringify(t), { ex: TABLE_TTL });
      out = { t, fresh: p.fresh, lobby: ctx.lobby };
    });
    if (err) return { err };
    if (out.noop) return out;
    await store.publish({ k: 'table', id, t: out.t, fresh: out.fresh || {} });
    if (out.lobby) lobbyChanged();
    return out;
  }
  function removeSeat(ctx, key) {
    const t = ctx.t;
    t.seats[t.seats.indexOf(key)] = null; delete t.names[key]; t.ready = [];
    ctx.game = null; ctx.lobby = true;
    if (t.host === key) t.host = t.seats.find(Boolean) || null;
  }
  async function recordResult(final) {
    const [hi, lo] = final.teams;
    const swing = 20 + Math.min(20, Math.round((hi.total - lo.total) / 4000));
    for (const team of final.teams) {
      for (const m of team.members) {
        const u = await getUser(m.key);
        if (!u) continue;
        u.stats.games++;
        if (final.winner != null) { if (team.won) { u.stats.wins++; u.stats.rating += swing; } else u.stats.rating -= swing; }
        await putUser(m.key, u);
        await store.zadd('lb', u.stats.rating, m.key);
      }
    }
  }

  async function createTable(c, m) {
    if (await currentTableId(c.key)) return 'Leave your current table first.';
    if ((await store.smembers('tables')).length >= 200) return 'The lobby is full. Try again later.';
    const t = {
      id: crypto.randomBytes(4).toString('hex'), host: c.key,
      name: (typeof m.name === 'string' ? m.name.trim().slice(0, 30) : '') || `${c.name}'s table`,
      length: ['east', 'south', 'hanchan2', 'hanchan4', 'hanchan6'].includes(m.length) ? m.length : 'east', turnSec: [15, 30, 60].includes(m.turnSec) ? m.turnSec : 30,
      // optional test hook: shorten the random pause made when nobody can call a discard
      fakeWait: Array.isArray(m.fakeWait) && m.fakeWait.length === 2 && m.fakeWait.every(n => Number.isInteger(n) && n >= 0 && n <= 10000) ? m.fakeWait : undefined,
      seats: [c.key, null, null, null], names: { [c.key]: c.name }, ready: [], chat: [], game: null,
    };
    await store.set('t:' + t.id, JSON.stringify(t), { ex: TABLE_TTL });
    await store.sadd('tables', t.id);
    await store.set('ut:' + c.key, t.id);
    await store.publish({ k: 'table', id: t.id, t, fresh: { [c.key]: true } });
    lobbyChanged();
  }
  async function joinTable(c, id) {
    if (await currentTableId(c.key)) return 'Leave your current table first.';
    return (await withTable(id, async ctx => {
      const t = ctx.t;
      if (playing(t)) return 'That game has already started.';
      const i = t.seats.indexOf(null);
      if (i < 0) return 'That table is full.';
      ctx.game = null; t.ready = [];
      t.seats[i] = c.key; t.names[c.key] = c.name; ctx.fresh[c.key] = true; ctx.lobby = true;
      await store.set('ut:' + c.key, id);
    })).err;
  }
  // The socket remembers which table it was last sent, which saves two reads per action.
  // Each handler still checks, under the lock, that the player really is seated there.
  const tableOf = async c => c.tableId || currentTableId(c.key);
  const NOT_SEATED = 'You are not at a table.';

  async function leaveTable(key, hint) {
    const id = hint || await currentTableId(key);
    if (!id) return NOT_SEATED;
    return (await withTable(id, async ctx => {
      if (!ctx.t.seats.includes(key)) return NOT_SEATED;
      if (playing(ctx.t)) return 'The game is still in progress.';
      removeSeat(ctx, key);
      await store.del('ut:' + key);
    })).err;
  }
  // Seats 0 and 2 are one team, seats 1 and 3 the other. Moving to an open seat is how a player picks a side.
  async function moveSeat(c, i) {
    const id = await tableOf(c), key = c.key;
    if (!id) return NOT_SEATED;
    return (await withTable(id, ctx => {
      const t = ctx.t;
      if (!t.seats.includes(key)) return NOT_SEATED;
      if (playing(t)) return 'The game is still in progress.';
      if (![0, 1, 2, 3].includes(i) || t.seats[i]) return 'That seat is taken.';
      ctx.game = null; t.ready = [];
      t.seats[t.seats.indexOf(key)] = null; t.seats[i] = key; ctx.lobby = true;
    })).err;
  }
  async function regroup(c) {
    const id = await tableOf(c);
    if (!id) return NOT_SEATED;
    return (await withTable(id, ctx => {
      if (!ctx.t.seats.includes(c.key)) return NOT_SEATED;
      if (playing(ctx.t) || !ctx.game) return 'There is no finished game to leave.';
      ctx.game = null; ctx.t.ready = [];
    })).err;
  }
  async function setReady(c, v) {
    const id = await tableOf(c), key = c.key;
    if (!id) return NOT_SEATED;
    return (await withTable(id, (ctx, setOnline) => {
      const t = ctx.t;
      if (!t.seats.includes(key)) return NOT_SEATED;
      if (playing(t)) return 'There is nothing to ready up for.';
      t.ready = t.ready.filter(k => k !== key);
      if (v) t.ready.push(key);
      if (!(t.seats.every(Boolean) && t.seats.every(k => t.ready.includes(k)))) return;
      // Start. The seats ARE the fixed roles, so the table keeps its seating order:
      // whoever took seat 0 plays Akagi and deals first, and partners stay side by side.
      t.ready = []; ctx.lobby = true;
      ctx.game = new Game({ players: t.seats.map(k => ({ key: k, name: t.names[k] })), length: t.length, turnMs: t.turnSec * 1000, fakeWaitMs: t.fakeWait || [1000, 3000] });
      setOnline();
      ctx.game.start();
    })).err;
  }
  async function chat(c, text) {
    if (typeof text !== 'string' || !(text = text.trim().slice(0, 200))) return;
    const id = await tableOf(c);
    if (!id) return;
    return (await withTable(id, ctx => {
      if (!ctx.t.seats.includes(c.key)) return NOT_SEATED;
      ctx.t.chat.push({ name: c.name, text, ts: Date.now() });
      if (ctx.t.chat.length > 40) ctx.t.chat.shift();
    })).err;
  }
  async function act(c, m) {
    const id = await tableOf(c);
    if (!id) return 'You are not in a game.';
    return (await withTable(id, ctx => {
      const seat = ctx.t.seats.indexOf(c.key);
      return ctx.game && seat >= 0 ? ctx.game.act(seat, m) : 'You are not in a game.';
    })).err;
  }
  // A player's connection came or went: let a running game shorten or restore their clock.
  async function connectionChanged(key, id) {
    return withTable(id, ctx => {
      const seat = ctx.t.seats.indexOf(key);
      if (seat < 0) return NOOP;
      if (ctx.game && ctx.game.phase !== 'over') ctx.game.connectionChanged(seat);
    }).catch(e => console.error('presence update', e.message));
  }

  /* ---------------- pushing state to sockets ---------------- */
  const sendTo = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
  function tableInfo(t, fresh) {
    return {
      id: t.id, name: t.name, length: t.length, turnSec: t.turnSec, host: t.names[t.host] || '', playing: playing(t),
      seats: t.seats.map(k => (k ? { name: t.names[k], ready: t.ready.includes(k), online: !!fresh[k] } : null)), chat: t.chat,
    };
  }
  function deliverTable(id, t, fresh) {
    const mine = [...local.values()].filter(c => c.tableId === id);
    const seated = t ? t.seats.filter(k => k && local.has(k)) : [];
    if (!mine.length && !seated.length) return clearTimer(id);
    let game = null;
    if (t) {
      for (const k of seated) fresh[k] = true;
      if (t.game) { game = Game.fromJSON(t.game); game.online = t.seats.map(k => !!fresh[k]); }
      const info = tableInfo(t, fresh);
      t.seats.forEach((k, i) => {
        const c = k && local.get(k);
        if (c) { c.tableId = id; sendTo(c, { t: 'table', table: info, game: game ? game.view(i) : null, now: Date.now() }); }
      });
    }
    for (const c of mine) {
      if (!t || !t.seats.includes(c.key)) { c.tableId = null; sendTo(c, { t: 'table', table: null, game: null }); sendLobby(c); }
    }
    if (game && game.deadline && seated.length) armTimer(id, game.deadline); else clearTimer(id);
  }

  async function lobbyInfo() {
    const ids = await store.smembers('tables');
    const rows = await store.mget(ids.map(id => 't:' + id));
    const tables = [];
    for (let i = 0; i < ids.length; i++) {
      if (!rows[i]) { await store.srem('tables', ids[i]); continue; }       // expired while nobody was there
      const t = JSON.parse(rows[i]);
      tables.push({ id: t.id, name: t.name, length: t.length, turnSec: t.turnSec, seats: t.seats.map(k => (k ? t.names[k] : null)), playing: playing(t) });
    }
    return { online: await store.zcount('online', Date.now() - FRESH_MS), tables };
  }
  async function sendLobby(c) { try { sendTo(c, { t: 'lobby', lobby: await lobbyInfo() }); } catch (e) { console.error('lobby', e.message); } }
  let lobbyTimer = null;
  function lobbyChanged() {                                   // coalesce bursts, compute once, share with all instances
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(async () => {
      lobbyTimer = null;
      try { await store.publish({ k: 'lobby', lobby: await lobbyInfo() }); } catch (e) { console.error('lobby', e.message); }
    }, 150);
  }

  /* ---------------- turn clocks ----------------
   * Every instance holding a socket for a table watches that table's deadline. When it passes,
   * they race for the lock; the first applies the timeout and the rest see there is nothing to do. */
  function clearTimer(id) { const x = timers.get(id); if (x) { clearTimeout(x.handle); timers.delete(id); } }
  function armTimer(id, deadline) {
    const x = timers.get(id);
    if (x && x.deadline === deadline) return;
    clearTimer(id);
    const handle = setTimeout(() => { timers.delete(id); fireTimer(id).catch(e => console.error('clock', e.message)); },
      Math.max(0, deadline - Date.now()) + 20 + Math.random() * 120);
    timers.set(id, { deadline, handle });
  }
  async function fireTimer(id) {
    const r = await withTable(id, ctx => {
      const g = ctx.game;
      if (!g || !g.deadline || g.phase === 'over') return NOOP;
      if (g.deadline > Date.now()) return NOOP;               // someone already moved things on
      g.timeout();
    });
    if (r.noop && r.game && r.game.deadline && r.t.seats.some(k => k && local.has(k))) armTimer(id, r.game.deadline);
  }

  /* ---------------- sockets ---------------- */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', async (req, socket, head) => {
    const refuse = () => { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); };
    socket.on('error', () => {});
    try {
      const p = req.url.split('?')[0], origin = req.headers.origin;
      let ok = !!store && (p === '/ws' || p === '/api/server');
      if (ok && origin) {
        try { const h = new URL(origin).host; ok = h === req.headers.host || h === req.headers['x-forwarded-host']; } catch { ok = false; }
      }
      const s = ok ? await sessionUser(req) : null;
      if (!s) return refuse();
      wss.handleUpgrade(req, socket, head, ws => connect(ws, s.key, s.user));
    } catch (e) { console.error('upgrade', e.message); refuse(); }
  });

  async function handle(c, m) {
    if (m.t === 'create') return createTable(c, m);
    if (m.t === 'join') return joinTable(c, m.id);
    if (m.t === 'leave') return leaveTable(c.key, c.tableId);
    if (m.t === 'seat') return moveSeat(c, m.i);
    if (m.t === 'regroup') return regroup(c);
    if (m.t === 'ready') return setReady(c, !!m.v);
    if (m.t === 'chat') return chat(c, m.text);
    if (m.t === 'act') return act(c, m);
  }

  function connect(ws, key, user) {
    const c = { ws, key, name: user.name, conn: crypto.randomBytes(6).toString('hex'), tableId: null, score: 0, queue: Promise.resolve() };
    const old = local.get(key);
    if (old) old.ws.close(4001, 'Opened in another window');
    local.set(key, c);
    let tokens = 60, last = Date.now();          // flood guard: bursts of 60, refilling 30 a second
    ws.on('message', raw => {
      const now = Date.now();
      tokens = Math.min(60, tokens + (now - last) * 0.03); last = now;
      if (--tokens < 0) return ws.close(4002, 'Too many messages');
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      c.queue = c.queue.then(async () => {      // one action at a time per player, in order
        let err;
        try { err = await handle(c, m); } catch (e) { console.error('message failed', e); err = 'Server error. Try that again.'; }
        if (err) sendTo(c, { t: 'err', msg: err });
      });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (local.get(key) !== c) return;          // replaced by a newer socket on this instance
      local.delete(key);
      // Nothing is marked offline here. On Vercel a socket is cut every few minutes and the browser
      // reconnects at once, possibly to another instance; a player only counts as gone when their
      // check-ins stop for 30 seconds. A waiting-room seat is freed a little after that.
      const id = c.tableId;
      if (!id) return;
      const timer = setTimeout(async () => {
        try {
          if (local.has(key) || (await presence([key])).fresh[key]) return;
          const t = await loadTable(id);
          if (t && t.seats.includes(key) && !playing(t)) await leaveTable(key);
          else if (t) await connectionChanged(key, id);
        } catch (e) { console.error('grace', e.message); }
      }, FRESH_MS + 12000);
      timer.unref();
    });
    c.queue = c.queue.then(async () => {
      try {
        await checkIn(c);
        await store.publish({ k: 'kick', user: key, conn: c.conn });   // close this account's socket on any other instance
        sendTo(c, { t: 'hello', me: publicUser(user) });
        const id = await currentTableId(key);
        if (id) { c.tableId = id; await connectionChanged(key, id); } else await sendLobby(c);
        lobbyChanged();
      } catch (e) { console.error('connect', e); sendTo(c, { t: 'err', msg: 'The server could not load your game. Reload the page.' }); }
    });
  }

  if (store) {
    store.subscribe(m => {
      try {
        if (m.k === 'table') deliverTable(m.id, m.t, m.fresh || {});
        else if (m.k === 'lobby') { for (const c of local.values()) if (!c.tableId) sendTo(c, { t: 'lobby', lobby: m.lobby }); }
        else if (m.k === 'kick') { const c = local.get(m.user); if (c && c.conn !== m.conn) { local.delete(m.user); c.ws.close(4001, 'Opened in another window'); } }
      } catch (e) { console.error('event', e); }
    });
    // Check in every connected player, and keep the tables they sit at from expiring.
    intervals.push(setInterval(async () => {
      try {
        const ids = new Set();
        for (const c of local.values()) { await checkIn(c); if (c.tableId) ids.add(c.tableId); }
        for (const id of ids) await store.expire('t:' + id, TABLE_TTL);
        if (local.size) await store.zprune('online', Date.now() - 2 * GHOST_MS);
      } catch (e) { console.error('heartbeat', e.message); }
    }, 10000));
    intervals.forEach(i => i.unref());
  }

  async function close() {
    intervals.forEach(clearInterval); clearTimeout(lobbyTimer);
    for (const id of [...timers.keys()]) clearTimer(id);
    for (const c of local.values()) c.ws.terminate();
    await new Promise(r => server.close(r));
  }
  return { server, store, close };
}

module.exports = { createApp };
