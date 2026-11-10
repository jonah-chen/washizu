'use strict';
const crypto = require('crypto');
const M = require('./mahjong');
const { kindOf, isGlass } = M;

const ceil100 = x => Math.ceil(x / 100) * 100;
const glassFirst = (a, b) => (isGlass(b) - isGlass(a)) || a - b;
const byKind = (a, b) => a - b;

const ROLES = ['Akagi', 'Yasuoka', 'Washizu', 'Suzuki'];           // fixed role of each seat, in play order
// A hanchan is an East round followed by a South round: there are no West or North rounds, so
// hanchan2 plays East, South, East, South. The values are the number of rounds to play.
const LENGTHS = { east: 0, south: 1, hanchan2: 3, hanchan4: 7, hanchan6: 11 };
const HANCHAN_PAY = [30000, 10000, -10000, -30000];               // 20000 per place, 1st to 4th

/**
 * One table's game: four fixed roles, played in the order Akagi -> Yasuoka -> Washizu -> Suzuki.
 * The mahjong rules are the same in both game modes, chosen when the table is created:
 * In team games (the default) Akagi & Yasuoka (seats 0-1) team up against Washizu & Suzuki
 * (seats 2-3). The game always runs to its full length - East-only, East + South, or 2/4/6
 * hanchan - and nobody is out for going negative. A hanchan is an East round followed by a
 * South round (there are no West or North rounds), so hanchan2 plays East, South, East, South.
 * At the end of every hanchan (except in East-only games) the places are paid 20000 apart:
 * +30000, +10000, -10000, -30000.
 * When a team game ends, Akagi & Yasuoka win if Akagi has more points than Washizu;
 * otherwise Washizu & Suzuki win.
 * In free-for-all games everyone plays for themselves: there are no hanchan settlements,
 * the game ends after its last scheduled hand, and the player with the most points wins -
 * a tie going to the lower seat, so (as in team games) there are no drawn games.
 * If several players ron the same discard, only the one nearest the discarder in turn order
 * wins; the rest get nothing.
 * After every discard the table pauses as if callers were deciding: the clock is the full
 * play time, and when no call is possible the pause is a short random one with everyone
 * treated as having passed, so the timing never reveals whether the tile was wanted.
 * A call stands as soon as nobody still waiting can outrank it - ron beats pon and kan,
 * which beat chi, and at equal priority the seat nearer the discarder wins - so the
 * highest available call is processed at once.
 * The server owns every tile; clients only ever receive `view(seat)`.
 */
class Game {
  constructor({ players, length = 'east', turnMs, noTimers, fakeWaitMs = [1000, 3000], mode = 'team' }) {
    this.players = players;                       // [{key, name}] in seat order (A, Y, W, S); seat 0 deals first
    this.mode = mode === 'ffa' ? 'ffa' : 'team';  // 'team': 2v2; 'ffa': everyone plays for themselves
    this.length = LENGTHS[length] != null ? length : 'east';
    this.maxRound = LENGTHS[this.length];
    this.turnMs = turnMs || 30000;
    this.noTimers = !!noTimers;
    this.fakeWaitMs = fakeWaitMs;                 // [min, max] pause when nobody can call a discard
    this.online = [true, true, true, true];        // refreshed by the host before every operation; never stored
    this.scores = [25000, 25000, 25000, 25000];
    this.roundWind = 0; this.kyoku = 0; this.dealer = 0; this.honba = 0; this.sticks = 0;
    this.evN = 0; this.ev = null; this.phase = 'init'; this.deadline = null;
  }

  start() { this.startHand(); }

  /* The whole game is plain data, so it can live in a shared store between function instances. */
  toJSON() {
    const o = Object.assign({}, this);
    delete o.online;
    o.nextReady = this.nextReady ? [...this.nextReady] : null;
    return o;
  }
  static fromJSON(o) {
    const g = Object.assign(Object.create(Game.prototype), o);
    g.mode = o.mode === 'ffa' ? 'ffa' : 'team';   // games saved before modes existed were team games
    g.nextReady = o.nextReady ? new Set(o.nextReady) : undefined;
    g.online = [true, true, true, true];
    return g;
  }
  event(seat, text) { this.ev = { n: ++this.evN, seat, text }; }

  /* ---------- clock ----------
   * The game only records a deadline. Whoever hosts it calls timeout() once the deadline has passed. */
  arm(ms) { this.deadline = this.noTimers ? null : Date.now() + ms; }
  waitingSeats() {
    if (this.phase === 'action') return [this.turn];
    if (this.phase === 'claim') return Object.keys(this.pending.opts).map(Number).filter(s => !this.pending.resp[s]);
    return [];
  }
  armForPhase() {
    if (this.phase === 'action') {
      const o = this.opts, s = this.turn;
      if (this.riichi[s] && !o.tsumo && !o.ankan.length) { this.short = false; return this.arm(900); }  // locked hand: auto-discard
      this.short = !this.online[s];                 // an absent player gets a short clock
      return this.arm(this.short ? 1500 : this.turnMs);
    }
    if (this.phase === 'claim') {
      this.short = !this.waitingSeats().some(s => this.online[s]);
      return this.arm(this.short ? 1200 : this.turnMs);   // a caller gets the full play-time clock
    }
    this.short = false;
    if (this.phase === 'ended') return this.arm(30000);
    this.deadline = null;
  }
  /* Nobody can call the discarded tile, but the table still pauses as if callers were
     deciding: a short random moment, then everyone is treated as having passed. The
     displayed clock shows the full play time (see view), so the pause never reveals
     that no one wanted the tile. */
  fakeClaimWait() {
    this.fakeClaim = true; this.short = false; this.phase = 'claim';
    this.arm(this.fakeWaitMs[0] + Math.random() * (this.fakeWaitMs[1] - this.fakeWaitMs[0]));
  }
  connectionChanged(seat) {
    // Someone came back while the game was rushing them: give them a normal clock again.
    if (this.short && this.online[seat] && this.waitingSeats().includes(seat)) this.armForPhase();
    if (this.phase === 'ended') this.checkNext();
  }
  timeout() {
    if (this.phase === 'action') {
      const o = this.opts;
      const id = this.drawn != null && o.discard.includes(this.drawn) ? this.drawn : o.discard[o.discard.length - 1];
      this.discard(this.turn, id, false, true);
    } else if (this.phase === 'claim') {
      for (const s of this.waitingSeats()) this.pending.resp[s] = { c: 'pass' };
      this.resolve();
    } else if (this.phase === 'ended') this.next();
  }

  /* ---------- helpers ---------- */
  teamTotal(t) { return this.scores[t * 2] + this.scores[t * 2 + 1]; }
  counts(seat, extra) {
    const c = new Array(34).fill(0);
    for (const id of this.hands[seat]) c[id >> 2]++;
    if (extra != null) c[extra]++;
    return c;
  }
  meldInfo(seat) {
    return this.melds[seat].map(m => ({ type: m.type, kind: Math.min(...m.tiles.map(kindOf)) }));
  }
  doraCount(seat, extra, inds) {
    const ks = this.hands[seat].map(kindOf);
    if (extra != null) ks.push(extra);
    for (const m of this.melds[seat]) ks.push(...m.tiles.map(kindOf));
    let n = 0;
    for (const ind of inds) { const d = M.doraOf(kindOf(ind)); n += ks.filter(k => k === d).length; }
    return n;
  }
  waitsOf(seat) { return M.waits(this.counts(seat), this.melds[seat].length); }
  isFuriten(seat) {
    if (this.tempFuriten[seat] || this.riichiFuriten[seat]) return true;
    const w = this.waitsOf(seat);
    return this.ponds[seat].some(p => w.includes(p.id >> 2));
  }
  winInfo(seat, winKind, tsumo, o = {}) {
    const c = this.counts(seat, tsumo ? null : winKind);
    if (!M.isComplete(c, this.melds[seat].length)) return null;
    const first = this.noCalls && this.discardCount[seat] === 0;
    const extra = tsumo ? null : winKind;
    return M.evaluate({
      counts: c, melds: this.meldInfo(seat), winKind, tsumo,
      riichi: this.riichi[seat], ippatsu: this.ippatsu[seat],
      haitei: tsumo && this.drawsLeft === 0 && !this.afterKan,
      houtei: !tsumo && !o.chankan && this.drawsLeft === 0,
      rinshan: tsumo && this.afterKan, chankan: !!o.chankan,
      tenhou: tsumo && first && seat === this.dealer,
      chiihou: tsumo && first && seat !== this.dealer,
      seatWind: (seat - this.dealer + 4) % 4, roundWind: this.roundWind % 2,   // a hanchan is an East + South pair
      dora: o.score ? this.doraCount(seat, extra, this.dora) : 0,
      ura: o.score && this.riichi[seat] ? this.doraCount(seat, extra, this.ura) : 0,
    });
  }

  /* ---------- hand flow ---------- */
  startHand() {
    const ids = Array.from({ length: 136 }, (_, i) => i);
    for (let i = 135; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    this.pool = ids;                               // the bag: tiles come out by pop()
    this.hands = [[], [], [], []];
    for (let n = 0; n < 13; n++) for (let s = 0; s < 4; s++) this.hands[s].push(this.pool.pop());
    this.dora = [this.pool.pop()]; this.ura = [this.pool.pop()];
    this.drawsLeft = 70;
    this.melds = [[], [], [], []]; this.ponds = [[], [], [], []];
    this.riichi = [0, 0, 0, 0]; this.ippatsu = [false, false, false, false];
    this.tempFuriten = [false, false, false, false]; this.riichiFuriten = [false, false, false, false];
    this.discardCount = [0, 0, 0, 0]; this.noCalls = true; this.kanCount = 0;
    this.result = null; this.pending = null; this.fakeClaim = false; this.riichiPending = null; this.kuikae = [];
    this.lastDiscard = null; this.ev = null;
    this.draw(this.dealer, false);
  }

  draw(seat, rinshan) {
    const t = this.pool.pop();
    this.drawsLeft--;
    this.hands[seat].push(t);
    this.drawn = t; this.afterKan = rinshan; this.turn = seat; this.kuikae = [];
    this.phase = 'action';
    this.computeOpts();
    this.armForPhase();
  }

  revealDora() { this.dora.push(this.pool.pop()); this.ura.push(this.pool.pop()); }

  computeOpts() {
    const s = this.turn, h = this.hands[s], nm = this.melds[s].length;
    const o = { discard: [], riichi: [], tsumo: false, ankan: [], kakan: [] };
    if (this.drawn == null) {                      // just called pon/chi: discard only
      o.discard = h.filter(t => !this.kuikae.includes(t >> 2));
      if (!o.discard.length) o.discard = h.slice();
      this.opts = o; return;
    }
    o.tsumo = !!this.winInfo(s, this.drawn >> 2, true);
    const c = this.counts(s);
    const canKan = this.drawsLeft > 0 && this.kanCount < 4;
    if (this.riichi[s]) {
      o.discard = [this.drawn];
      const k = this.drawn >> 2;
      if (canKan && c[k] === 4) {                  // closed kan after riichi only if the waits stay identical
        c[k]--; const before = M.waits(c, nm).join();
        c[k] -= 3; const after = M.waits(c, nm + 1).join();
        c[k] += 4;
        if (before && before === after) o.ankan = [k];
      }
    } else {
      o.discard = h.slice();
      if (canKan) {
        for (let k = 0; k < 34; k++) if (c[k] === 4) o.ankan.push(k);
        for (const m of this.melds[s]) if (m.type === 'pon' && c[m.tiles[0] >> 2] >= 1) o.kakan.push(m.tiles[0] >> 2);
      }
      const menzen = this.melds[s].every(m => m.type === 'ankan');
      if (menzen && this.scores[s] >= 1000 && this.drawsLeft >= 4) {
        for (let k = 0; k < 34; k++) {
          if (!c[k]) continue;
          c[k]--;
          if (M.waits(c, nm).length) o.riichi.push(...h.filter(t => t >> 2 === k));
          c[k]++;
        }
      }
    }
    this.opts = o;
  }

  /* ---------- player actions ---------- */
  act(seat, m) {
    if (!m || typeof m !== 'object') return 'Bad message';
    let err;
    switch (m.a) {
      case 'discard': err = this.discard(seat, m.id, false); break;
      case 'riichi': err = this.discard(seat, m.id, true); break;
      case 'tsumo': err = this.tsumo(seat); break;
      case 'ankan': err = this.ankan(seat, m.kind); break;
      case 'kakan': err = this.kakan(seat, m.kind); break;
      case 'claim': err = this.claim(seat, m.c, m.i); break;
      case 'next': err = this.readyNext(seat); break;
      default: err = 'Unknown action';
    }
    return err;
  }

  discard(seat, id, riichi) {
    if (this.phase !== 'action' || this.turn !== seat) return 'It is not your turn.';
    const o = this.opts;
    if (!Number.isInteger(id) || !(riichi ? o.riichi : o.discard).includes(id)) return 'You cannot discard that tile.';
    const hand = this.hands[seat];
    hand.splice(hand.indexOf(id), 1);
    const first = this.noCalls && this.discardCount[seat] === 0;
    this.ponds[seat].push({ id, riichi: !!riichi, tsumogiri: id === this.drawn });
    if (riichi) { this.riichi[seat] = first ? 2 : 1; this.riichiPending = seat; this.event(seat, 'Riichi'); }
    else this.ippatsu[seat] = false;
    this.discardCount[seat]++;
    this.tempFuriten[seat] = false;
    this.drawn = null; this.afterKan = false; this.kuikae = [];
    this.lastDiscard = { seat, id };
    const k = id >> 2, opts = {};
    let ronOpen = false;
    for (let d = 1; d < 4; d++) {
      const s = (seat + d) % 4, h = this.hands[s], c = {};
      if (!ronOpen && !this.isFuriten(s) && this.winInfo(s, k, false)) { c.ron = true; ronOpen = true; }  // only the nearest seat can win it
      if (this.drawsLeft > 0 && !this.riichi[s]) {
        const same = h.filter(t => t >> 2 === k).sort(glassFirst);
        if (same.length >= 2) c.pon = same.slice(0, 2);
        if (same.length === 3 && this.kanCount < 4) c.kan = same;
        if (d === 1 && k < 27) {
          const lo = Math.floor(k / 9) * 9, hi = lo + 8, chi = [];
          for (const [a, b] of [[k - 2, k - 1], [k - 1, k + 1], [k + 1, k + 2]]) {
            if (a < lo || b > hi) continue;
            const ta = h.filter(t => t >> 2 === a).sort(glassFirst)[0];
            const tb = h.filter(t => t >> 2 === b).sort(glassFirst)[0];
            if (ta != null && tb != null) chi.push([ta, tb]);
          }
          if (chi.length) c.chi = chi;
        }
      }
      if (Object.keys(c).length) opts[s] = c;
    }
    this.pending = { type: 'discard', from: seat, id, opts, resp: {} };
    if (!Object.keys(opts).length) {
      if (this.noTimers) this.resolve();
      else this.fakeClaimWait();                  // nobody can call: a short random pause, as if everyone passed
    } else { this.fakeClaim = false; this.phase = 'claim'; this.armForPhase(); }
  }

  claim(seat, c, i) {
    if (this.phase !== 'claim') return 'There is nothing to call.';
    const p = this.pending, o = p.opts[seat];
    if (!o || p.resp[seat]) return 'There is nothing to call.';
    if (c === 'pass') p.resp[seat] = { c };
    else if (c === 'ron' && o.ron) p.resp[seat] = { c };
    else if (c === 'pon' && o.pon) p.resp[seat] = { c, tiles: o.pon };
    else if (c === 'kan' && o.kan) p.resp[seat] = { c, tiles: o.kan };
    else if (c === 'chi' && o.chi && o.chi[i]) p.resp[seat] = { c, tiles: o.chi[i] };
    else return 'You cannot make that call.';
    // A made call stands as soon as nobody still waiting can outrank it. A higher priority
    // level (ron over pon/kan over chi) always has to be given its chance first, so a low
    // priority call waits for the higher callers to call or pass. At equal priority the
    // seat nearer the discarder in turn order wins, so the highest available call is
    // processed at once without waiting on lower-priority callers.
    const level = { pass: 0, chi: 1, pon: 2, kan: 2, ron: 3 };
    const dist = s => (s - p.from + 4) % 4;
    let best = -1, bestAt = 4;
    for (const [s, r] of Object.entries(p.resp)) {
      const l = level[r.c];
      if (l > best || (l === best && dist(+s) < bestAt)) { best = l; bestAt = dist(+s); }
    }
    const waiting = this.waitingSeats();
    const heldUp = waiting.some(s => {
      const w = p.opts[s];
      const l = w.ron ? 3 : (w.pon || w.kan) ? 2 : 1;
      return l > best || (l === best && dist(s) < bestAt);
    });
    if (!waiting.length || !heldUp) this.resolve();
  }

  resolve() {
    const p = this.pending; this.pending = null;
    const k = p.id >> 2;
    let ron = null;
    for (let d = 1; d < 4; d++) {
      const s = (p.from + d) % 4;
      if (p.resp[s] && p.resp[s].c === 'ron' && ron == null) ron = s;   // closest to the discarder in turn order
      else if (this.waitsOf(s).includes(k)) {       // let a winning tile go by: furiten (also for multi-ron losers)
        if (this.riichi[s]) this.riichiFuriten[s] = true; else this.tempFuriten[s] = true;
      }
    }
    // several players may ron the same discard, but only the nearest one wins; the rest get nothing
    if (ron != null) { this.riichiPending = null; return this.winRon(ron, p.from, p.id, p.type === 'kakan'); }
    if (p.type === 'kakan') return this.finishKakan(p.from, p.id);
    if (this.riichiPending != null) {
      const s = this.riichiPending; this.riichiPending = null;
      this.scores[s] -= 1000; this.sticks++; this.ippatsu[s] = true;
    }
    let call = null;
    for (const s of Object.keys(p.resp)) { const r = p.resp[s]; if (r.c === 'pon' || r.c === 'kan') call = { s: +s, r }; }
    if (!call) for (const s of Object.keys(p.resp)) { const r = p.resp[s]; if (r.c === 'chi') call = { s: +s, r }; }
    if (call) return this.doCall(call.s, call.r.c, call.r.tiles, p.from, p.id);
    if (this.drawsLeft === 0) return this.exhaustive();
    this.draw((p.from + 1) % 4, false);
  }

  doCall(seat, c, tiles, from, id) {
    const h = this.hands[seat], k = id >> 2;
    for (const t of tiles) h.splice(h.indexOf(t), 1);
    const pond = this.ponds[from]; pond[pond.length - 1].called = true;
    this.noCalls = false; this.ippatsu = [false, false, false, false];
    this.turn = seat;
    if (c === 'kan') {
      this.melds[seat].push({ type: 'minkan', tiles: [...tiles, id], from, called: id });
      this.kanCount++; this.revealDora(); this.event(seat, 'Kan');
      return this.draw(seat, true);
    }
    this.melds[seat].push({ type: c, tiles: [...tiles, id], from, called: id });
    this.event(seat, c === 'pon' ? 'Pon' : 'Chi');
    this.drawn = null; this.afterKan = false;
    this.kuikae = [k];                              // no swap-calling
    if (c === 'chi') {
      const ks = tiles.map(kindOf).sort(byKind);
      if (k < ks[0] && k % 9 <= 5) this.kuikae.push(k + 3);
      if (k > ks[1] && k % 9 >= 3) this.kuikae.push(k - 3);
    }
    this.phase = 'action';
    this.computeOpts();
    this.armForPhase();
  }

  ankan(seat, kind) {
    if (this.phase !== 'action' || this.turn !== seat || !this.opts.ankan.includes(kind)) return 'You cannot declare that kan.';
    const h = this.hands[seat];
    const tiles = h.filter(t => t >> 2 === kind);
    this.hands[seat] = h.filter(t => t >> 2 !== kind);
    this.melds[seat].push({ type: 'ankan', tiles, from: seat });
    this.kanCount++; this.noCalls = false; this.ippatsu = [false, false, false, false];
    this.revealDora(); this.event(seat, 'Kan');
    this.draw(seat, true);
  }

  kakan(seat, kind) {
    if (this.phase !== 'action' || this.turn !== seat || !this.opts.kakan.includes(kind)) return 'You cannot declare that kan.';
    const h = this.hands[seat];
    const id = h.find(t => t >> 2 === kind);
    h.splice(h.indexOf(id), 1);
    this.drawn = null;
    this.event(seat, 'Kan');
    const opts = {};
    for (let d = 1; d < 4; d++) {
      const s = (seat + d) % 4;
      if (!this.isFuriten(s) && this.winInfo(s, kind, false, { chankan: true })) opts[s] = { ron: true };
    }
    this.pending = { type: 'kakan', from: seat, id, opts, resp: {} };
    if (!Object.keys(opts).length) {
      if (this.noTimers) this.resolve();
      else this.fakeClaimWait();                  // nobody can rob it: a short random pause, as if everyone passed
    } else { this.fakeClaim = false; this.phase = 'claim'; this.armForPhase(); }
  }

  finishKakan(seat, id) {
    const m = this.melds[seat].find(x => x.type === 'pon' && x.tiles[0] >> 2 === id >> 2);
    m.type = 'kakan'; m.tiles.push(id);
    this.kanCount++; this.noCalls = false; this.ippatsu = [false, false, false, false];
    this.revealDora();
    this.draw(seat, true);
  }

  tsumo(seat) {
    if (this.phase !== 'action' || this.turn !== seat || !this.opts.tsumo) return 'You cannot win on this tile.';
    const r = this.winInfo(seat, this.drawn >> 2, true, { score: true });
    const deltas = [0, 0, 0, 0];
    for (let o = 0; o < 4; o++) {
      if (o === seat) continue;
      const pay = ceil100(r.base * (seat === this.dealer || o === this.dealer ? 2 : 1)) + 100 * this.honba;
      deltas[o] -= pay; deltas[seat] += pay;
    }
    const total = deltas[seat];
    deltas[seat] += this.sticks * 1000; this.sticks = 0;
    this.event(seat, 'Tsumo');
    this.endHand({
      type: 'tsumo', deltas, renchan: seat === this.dealer,
      winners: [Object.assign({ seat, hand: this.hands[seat].filter(t => t !== this.drawn).sort(byKind), melds: this.melds[seat], winTile: this.drawn, total }, r)],
    });
  }

  /* Only one player can win a discard: if several ron it, the one nearest the discarder in
     turn order takes the points (plus honba and the riichi sticks) and the rest get nothing. */
  winRon(seat, from, id, chankan) {
    const r = this.winInfo(seat, id >> 2, false, { score: true, chankan });
    const pay = ceil100(r.base * (seat === this.dealer ? 6 : 4)) + 300 * this.honba;
    const deltas = [0, 0, 0, 0];
    deltas[from] -= pay;
    deltas[seat] += pay + this.sticks * 1000; this.sticks = 0;
    const winner = Object.assign({ seat, hand: this.hands[seat].slice().sort(byKind), melds: this.melds[seat], winTile: id, total: pay }, r);
    this.event(seat, 'Ron');
    this.endHand({ type: 'ron', from, deltas, winners: [winner], renchan: seat === this.dealer });
  }

  exhaustive() {
    const tenpai = [0, 1, 2, 3].map(s => this.waitsOf(s).length > 0);
    const n = tenpai.filter(Boolean).length, deltas = [0, 0, 0, 0];
    if (n > 0 && n < 4) for (let s = 0; s < 4; s++) deltas[s] = tenpai[s] ? 3000 / n : -3000 / (4 - n);
    this.endHand({
      type: 'draw', tenpai, deltas, renchan: tenpai[this.dealer],
      hands: [0, 1, 2, 3].map(s => (tenpai[s] ? { hand: this.hands[s].slice().sort(byKind), melds: this.melds[s] } : null)),
    });
  }

  endHand(res) {
    for (let s = 0; s < 4; s++) this.scores[s] += res.deltas[s];
    res.dora = this.dora.slice();
    res.ura = res.winners && res.winners.some(w => this.riichi[w.seat]) ? this.ura.slice() : null;
    this.result = res; this.pending = null; this.phase = 'ended';
    this.nextReady = new Set();
    this.armForPhase();
  }

  readyNext(seat) {
    if (this.phase !== 'ended') return;   // a late or repeated click: nothing to do
    this.nextReady.add(seat);
    this.checkNext();
  }
  checkNext() {
    if (this.phase !== 'ended') return;
    const need = [0, 1, 2, 3].filter(s => this.online[s]);
    if (need.length && need.every(s => this.nextReady.has(s))) this.next();
  }

  next() {
    const res = this.result, keep = res.renchan;
    if (res.type === 'draw' || keep) this.honba++; else this.honba = 0;
    const last = this.roundWind === this.maxRound && this.kyoku === 3;
    if (!keep) {
      this.kyoku++;
      if (this.kyoku === 4) { this.kyoku = 0; this.roundWind++; }
      if (this.roundWind > this.maxRound) return this.finish();
      // team games only: a hanchan (an East + South pair) just ended
      if (this.mode === 'team' && this.kyoku === 0 && this.roundWind % 2 === 0) this.hanchanSettle();
      this.dealer = (this.dealer + 1) % 4;
    } else if (last) {
      if (this.mode === 'ffa') return this.finish();  // free-for-all ends with the last hand
      // The last hand of the game was a dealer win. If the dealer's side is on top in the
      // Akagi-vs-Washizu comparison, the game is over; otherwise the dealer keeps dealing.
      if ((this.scores[0] > this.scores[2] ? 0 : 1) === this.dealer % 2) return this.finish();
    }
    this.startHand();
  }

  /* A hanchan is an East round followed by a South round. When one ends, the four places are
     paid 20000 apart. Equal scores settle by seat order (A, Y, W, S). */
  hanchanSettle() {
    const order = [0, 1, 2, 3].sort((a, b) => this.scores[b] - this.scores[a] || a - b);
    order.forEach((s, i) => { this.scores[s] += HANCHAN_PAY[i]; });
  }

  finish() {
    this.deadline = null;
    if (this.mode === 'ffa') {
      // The player with the most points wins. A tie goes to the lower seat, so - as in
      // team games, where Washizu & Suzuki win whenever Akagi is not ahead - there are
      // no drawn games. Leftover riichi sticks go to the winner.
      const order = [0, 1, 2, 3].sort((a, b) => this.scores[b] - this.scores[a] || a - b);
      if (this.sticks) { this.scores[order[0]] += this.sticks * 1000; this.sticks = 0; }
      this.final = {
        mode: 'ffa', winner: order[0],
        standings: order.map((seat, i) => ({
          rank: i + 1, seat, key: this.players[seat].key, name: this.players[seat].name,
          score: this.scores[seat], won: i === 0,
        })),
      };
    } else {
      if (this.length !== 'east') this.hanchanSettle();      // the final hanchan ends with the game
      const winner = this.scores[0] > this.scores[2] ? 0 : 1;   // Akagi & Yasuoka only if Akagi outpoints Washizu
      if (this.sticks) {                                     // unclaimed riichi sticks go to the winning team
        const lo = winner * 2, hi = lo + 1;
        const seat = this.scores[lo] >= this.scores[hi] ? lo : hi;
        this.scores[seat] += this.sticks * 1000; this.sticks = 0;
      }
      this.final = {
        mode: 'team',
        winner,
        decider: [this.scores[0], this.scores[2]],           // Akagi's points vs Washizu's decide the game
        teams: [0, 1].map(t => ({
          team: t, total: this.teamTotal(t), won: winner === t,
          members: [t * 2, t * 2 + 1].map(seat => ({ seat, key: this.players[seat].key, name: this.players[seat].name, score: this.scores[seat] })),
        })),
      };
    }
    this.phase = 'over';
  }

  /* ---------- what one seat is allowed to know ---------- */
  view(seat) {
    const hanchans = Math.ceil((this.maxRound + 1) / 2);
    const v = {
      seat, phase: this.phase, roundWind: this.roundWind % 2, kyoku: this.kyoku, honba: this.honba, sticks: this.sticks,
      dealer: this.dealer, turn: this.turn, drawsLeft: this.drawsLeft, dora: this.dora,
      deadline: this.phase === 'claim' && this.fakeClaim ? Date.now() + this.turnMs : this.deadline,
      lastDiscard: this.lastDiscard, ev: this.ev, length: this.length, mode: this.mode,
      hanchans, hanchan: Math.min(Math.floor(this.roundWind / 2) + 1, hanchans),
      players: this.players.map((p, s) => {
        const h = this.hands[s];
        const o = {
          name: p.name, role: ROLES[s], score: this.scores[s], wind: (s - this.dealer + 4) % 4, riichi: !!this.riichi[s],
          online: this.online[s], melds: this.melds[s], pond: this.ponds[s],
        };
        if (s === seat) { o.tiles = h.slice().sort(byKind); }
        else { o.glass = h.filter(isGlass).sort(byKind); o.hidden = h.length - o.glass.length; }
        return o;
      }),
    };
    if (this.phase === 'action' && this.turn === seat) { v.options = this.opts; v.drawn = this.drawn; }
    if (this.phase === 'claim') {
      const o = this.pending.opts[seat];
      if (o && !this.pending.resp[seat]) v.claim = o;
      v.claimTile = this.pending.id;
    }
    if (this.phase !== 'over' && this.hands[seat].length % 3 === 1 && this.waitsOf(seat).length) v.furiten = this.isFuriten(seat);
    if (this.phase === 'ended' || this.phase === 'over') {
      v.result = this.result;
      v.nextReady = this.nextReady ? [...this.nextReady] : [];
    }
    if (this.phase === 'over') v.final = this.final.mode === 'ffa'
      ? { mode: 'ffa', winner: this.final.winner, standings: this.final.standings.map(m => ({ rank: m.rank, seat: m.seat, name: m.name, score: m.score, won: m.won })) }
      : { mode: 'team', winner: this.final.winner, decider: this.final.decider, teams: this.final.teams.map(t => ({ team: t.team, total: t.total, won: t.won, members: t.members.map(m => ({ seat: m.seat, name: m.name, score: m.score })) })) };
    return v;
  }
}

module.exports = { Game };
