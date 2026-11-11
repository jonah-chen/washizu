'use strict';
// Known-hand checks for the scoring engine.
const assert = require('assert');
const M = require('../lib/mahjong');

const K = s => {            // "123m456p77z" -> kinds
  const out = []; let buf = [];
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') buf.push(+ch);
    else { const base = { m: 0, p: 9, s: 18, z: 27 }[ch]; for (const n of buf) out.push(base + n - 1); buf = []; }
  }
  return out;
};
const counts = s => { const c = new Array(34).fill(0); for (const k of K(s)) c[k]++; return c; };
const ev = (hand, win, o = {}) => M.evaluate(Object.assign({
  counts: counts(hand), melds: [], winKind: K(win)[0], tsumo: false, riichi: 0, ippatsu: false,
  seatWind: 1, roundWind: 0, dora: 0, ura: 0,
}, o));
const names = r => r.yaku.map(y => y[0]).sort().join(',');

let r;
// riichi + pinfu + tanyao, ron: 3 han 30 fu
r = ev('234m345p456s67s55p8s', '8s', { riichi: 1 });
assert.strictEqual(names(r), 'Pinfu,Riichi,Tanyao'); assert.strictEqual(r.han, 3); assert.strictEqual(r.fu, 30); assert.strictEqual(r.base, 960);
// pinfu tsumo is 20 fu
r = ev('234m345p456s67s55p8s', '8s', { tsumo: true });
assert.strictEqual(r.fu, 20); assert.strictEqual(r.han, 3);
// no yaku: closed ron with a kanchan wait and nothing else
assert.strictEqual(ev('123m456p789s13s99m2s', '2s'), null);
// chiitoitsu: 25 fu
r = ev('1199m2288p3377s55z', '5z'); assert.strictEqual(r.fu, 25); assert.ok(names(r).includes('Chiitoitsu'));
// kokushi
r = ev('19m19p19s12345677z', '7z'); assert.strictEqual(r.yakuman, 1); assert.strictEqual(r.base, 8000);
// suuankou by tsumo; the same hand by ron on a shanpon wait is toitoi + sanankou
r = ev('111m333p555s777m99s', '9s', { tsumo: true }); assert.strictEqual(r.yakuman, 1);
r = ev('111m333p555s777m99s', '7m'); assert.strictEqual(r.yakuman, 0); assert.strictEqual(names(r), 'Sanankou,Toitoi');
// suuankou needs tsumo: a ron on the pair of a fully closed toitoi hand is toitoi + sanankou
r = ev('111m222p333s999m55p', '5p'); assert.strictEqual(r.yakuman, 0); assert.strictEqual(names(r), 'Sanankou,Toitoi'); assert.strictEqual(r.han, 4);
// daisangen with open pons
r = ev('123m99p555z', '9p', { melds: [{ type: 'pon', kind: 32 }, { type: 'pon', kind: 33 }] });
assert.strictEqual(r.yakuman, 1);
// open tanyao 1 han 30 fu
r = ev('234m678p55s345s', '5s', { melds: [{ type: 'chi', kind: 21 }] });
assert.strictEqual(names(r), 'Tanyao'); assert.strictEqual(r.fu, 30);
// chinitsu + ittsu closed
r = ev('123456789m11m234m', '4m'); assert.ok(names(r).includes('Chinitsu') && names(r).includes('Ittsu'));
// yakuhai: seat wind south, closed triplet, ron -> 1 han 40 fu
r = ev('222z123m456p789s99p', '9s'); assert.strictEqual(names(r), 'Seat wind'); assert.strictEqual(r.fu, 40);
// chuuren
r = ev('11123456789995m', '5m', { tsumo: true }); assert.ok(r.yakuman >= 1);
// waits: 23456m -> 1,4,7
assert.deepStrictEqual(M.waits(counts('23456m111p222s99p'), 0), K('147m'));
// dora wrap
assert.strictEqual(M.doraOf(8), 0); assert.strictEqual(M.doraOf(30), 27); assert.strictEqual(M.doraOf(33), 31);
// limits
assert.strictEqual(M.basePoints(4, 30, 0), 1920); assert.strictEqual(M.basePoints(4, 40, 0), 2000); assert.strictEqual(M.basePoints(11, 30, 0), 6000);

// ---- multi-ron: of several ron on the same discard, only the one nearest the discarder in
//      turn order wins; the rest get nothing ----
const { Game } = require('../lib/game');
const tiles = (k, n) => Array.from({ length: n }, (_, i) => k * 4 + i);
// 111m 222p 333s 999m 5p: toitoi, waiting on 5p (ron -> sanankou, since suuankou needs tsumo)
const winHand = () => [...tiles(0, 3), ...tiles(10, 3), ...tiles(20, 3), ...tiles(8, 3), ...tiles(13, 1)];
const junkHand = () => [0, 1, 2, 11, 12, 19, 20, 21, 22, 23, 24, 25, 26].map(k => k * 4);
// seat 0 discards 5p; seats 1 (d=1) and 3 (d=3) can both ron it
const multiRon = resp => {
  const g = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), noTimers: true });
  g.startHand();
  const fiveP = 13 * 4 + 1;
  g.hands[0] = junkHand(); g.hands[1] = winHand(); g.hands[2] = junkHand(); g.hands[3] = winHand();
  g.lastDiscard = { seat: 0, id: fiveP };
  g.dora = []; g.ura = [];                                          // no dora, so the score is deterministic
  g.honba = 2; g.sticks = 1; g.scores[1] -= 1000;                 // seat 1 has declared riichi (paid the stick)
  g.phase = 'claim';
  g.pending = { type: 'discard', from: 0, id: fiveP, opts: { 1: { ron: true }, 3: { ron: true } }, resp };
  g.resolve();
  return g;
};
let g = multiRon({ 1: { c: 'ron' }, 3: { c: 'ron' } });           // both ron: seat 1 is nearest
assert.strictEqual(g.result.type, 'ron');
assert.strictEqual(g.result.winners.length, 1);
assert.strictEqual(g.result.winners[0].seat, 1, 'the ron nearest the discarder wins');
assert.strictEqual(g.result.winners[0].total, 8600);               // toitoi + sanankou, 4 han 60 fu -> mangan 2000 x4 + 2 honba x300
assert.deepStrictEqual(g.result.deltas, [-8600, 9600, 0, 0]);      // +1000 riichi stick to the winner
assert.strictEqual(g.sticks, 0);
assert.strictEqual(g.scores.reduce((a, b) => a + b, 0), 100000, 'points conserved');
assert.ok(g.tempFuriten[3], 'a multi-ron loser is treated as having let the win go');
g = multiRon({ 1: { c: 'pass' }, 3: { c: 'ron' } });               // only the far seat rons: it wins
assert.strictEqual(g.result.winners[0].seat, 3);
assert.deepStrictEqual(g.result.deltas, [-8600, 0, 0, 9600]);
assert.ok(g.tempFuriten[1], 'the nearer seat that let it go is furiten');

// ---- the call wait: every discard pauses as if callers were deciding. When nobody can call
//      the pause is a short random one that still shows the full play-time clock, so the
//      timing never reveals that the tile was not wanted ----
{
  const gt = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), turnMs: 30000 });
  gt.startHand();
  const oneZ = 27 * 4;                                  // 1z: nobody has one, so nobody can call
  gt.hands[0] = [...junkHand(), oneZ];
  gt.hands[1] = gt.hands[2] = gt.hands[3] = junkHand();
  gt.drawn = oneZ; gt.computeOpts();
  const t0 = Date.now();
  gt.discard(0, oneZ, false);
  assert.strictEqual(gt.phase, 'claim');
  assert.strictEqual(Object.keys(gt.pending.opts).length, 0, 'no call is possible');
  assert.ok(gt.fakeClaim);
  assert.ok(gt.deadline - t0 >= 1000 && gt.deadline - t0 <= 3000, 'short random pause');
  assert.ok(gt.view(1).deadline - Date.now() >= 29000, 'the clock still shows the full play time');
  gt.timeout();
  assert.strictEqual(gt.phase, 'action');
  assert.strictEqual(gt.turn, 1, 'everyone is treated as having passed');

  const g2 = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), turnMs: 30000 });
  g2.startHand();
  const fourM = 3 * 4;                                  // 4m: seat 1 can chi it (2m 3m)
  g2.hands[0] = [...junkHand(), fourM];
  g2.hands[1] = g2.hands[2] = g2.hands[3] = junkHand();
  g2.drawn = fourM; g2.computeOpts();
  const t1 = Date.now();
  g2.discard(0, fourM, false);
  assert.strictEqual(g2.phase, 'claim');
  assert.ok(!g2.fakeClaim);
  assert.deepStrictEqual(Object.keys(g2.pending.opts), ['1'], 'only the chi caller is offered a call');
  assert.ok(g2.deadline - t1 <= 30000 + 5 && g2.deadline - t1 >= 0, 'a real claim gets a randomized play-time clock, never more than the turn time');
  assert.strictEqual(g2.view(1).claim.chi.length, 1);
  assert.ok(!g2.view(2).claim, 'the other seats get no call');

  const gnt = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), noTimers: true });
  gnt.startHand();
  gnt.hands[0] = [...junkHand(), oneZ];
  gnt.hands[1] = gnt.hands[2] = gnt.hands[3] = junkHand();
  gnt.drawn = oneZ; gnt.computeOpts();
  gnt.discard(0, oneZ, false);
  assert.strictEqual(gnt.phase, 'action', 'noTimers games skip the pause entirely');
}

// ---- call priority: a low-priority call waits for higher-priority callers to call or pass;
//      the highest available call stands at once; at equal priority the nearer seat wins ----
const chiPonOpts = { 1: { chi: [[2 * 4, 3 * 4]] }, 2: { pon: [4 * 4, 4 * 4 + 1] } };  // seat 1 (d=1) chis, seat 2 (d=2) pons 5m
const prio = opts => {
  const g = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), noTimers: true });
  g.startHand();
  g.hands[0] = [...junkHand(), 4 * 4];
  g.hands[1] = [8, 12, 0, 1, 2, 40, 41, 42, 50, 51, 52, 60, 61];          // the 3m 4m for the chi
  g.hands[2] = [16, 17, 0, 1, 2, 40, 41, 42, 50, 51, 52, 96, 100];        // two 5m for the pon
  g.hands[3] = junkHand();
  g.ponds[0] = [{ id: 4 * 4 }];                                 // the (simulated) discard
  g.phase = 'claim';
  g.pending = { type: 'discard', from: 0, id: 4 * 4, opts, resp: {} };
  return g;
};
{
  let g = prio(chiPonOpts);
  assert.strictEqual(g.claim(1, 'chi', 0), undefined);
  assert.strictEqual(g.phase, 'claim', 'a chi waits for the pon to call or pass');
  assert.strictEqual(g.claim(2, 'pass'), undefined);
  assert.strictEqual(g.phase, 'action', 'the pon passed, so the chi stands');
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(g.melds[1][0].type, 'chi');

  g = prio(chiPonOpts);
  assert.strictEqual(g.claim(2, 'pon'), undefined);
  assert.strictEqual(g.phase, 'action', 'the pon is the highest available call: it stands at once');
  assert.strictEqual(g.turn, 2);
  assert.strictEqual(g.melds[2][0].type, 'pon');
  assert.strictEqual(g.melds[1].length, 0, 'the still-waiting chi gets nothing');

  g = prio(chiPonOpts);
  g.claim(1, 'chi', 0);
  assert.strictEqual(g.claim(2, 'pon'), undefined);
  assert.strictEqual(g.turn, 2, 'a higher-priority call overrides a pending lower one');
  assert.strictEqual(g.melds[2][0].type, 'pon');

  const ponPonOpts = { 1: { pon: [16, 17] }, 3: { pon: [18, 19] } };
  g = prio(ponPonOpts);
  g.hands[3] = [18, 19, 0, 1, 2, 40, 41, 42, 50, 51, 52, 96, 104];
  assert.strictEqual(g.claim(3, 'pon'), undefined);
  assert.strictEqual(g.phase, 'claim', 'the farther pon waits for the nearer seat to call or pass');
  assert.strictEqual(g.claim(1, 'pass'), undefined);
  assert.strictEqual(g.phase, 'action', 'the nearer seat passed, so the farther pon stands');
  assert.strictEqual(g.turn, 3);
  assert.strictEqual(g.melds[3][0].type, 'pon');

  const gr = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), noTimers: true });
  gr.startHand();
  gr.hands[0] = [...junkHand(), 13 * 4 + 1];
  gr.hands[1] = winHand();                                             // toitoi, waiting on 5p
  gr.hands[2] = [54, 55, 0, 1, 2, 44, 48, 76, 80, 84, 88, 92, 96];      // two 5p for a pon
  gr.hands[3] = junkHand();
  gr.dora = []; gr.ura = [];
  gr.phase = 'claim';
  gr.pending = { type: 'discard', from: 0, id: 13 * 4 + 1, opts: { 1: { ron: true }, 2: { pon: [54, 55] } }, resp: {} };
  assert.strictEqual(gr.claim(1, 'ron'), undefined);
  assert.strictEqual(gr.result.type, 'ron', 'the ron is the highest available call: it stands at once');
  assert.strictEqual(gr.result.winners[0].seat, 1);
}

// ---- no West or North rounds: a hanchan is an East + South cycle, repeated for the length ----
const g3 = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), length: 'hanchan2', noTimers: true });
g3.startHand();
const rounds = [];
for (let h = 0; h < 16; h++) {                                       // 2 hanchan x 2 rounds x 4 kyoku
  const v = g3.view(1);
  rounds.push([v.roundWind, v.hanchan]);
  g3.result = { type: 'draw', deltas: [0, 0, 0, 0], winners: [] };
  g3.next();
}
assert.deepStrictEqual(rounds,
  [[0, 1], [0, 1], [0, 1], [0, 1], [1, 1], [1, 1], [1, 1], [1, 1],
   [0, 2], [0, 2], [0, 2], [0, 2], [1, 2], [1, 2], [1, 2], [1, 2]]); // East, South, then East, South again
assert.strictEqual(g3.phase, 'over');
assert.deepStrictEqual(g3.scores, [85000, 45000, 5000, -35000]);     // two settlements of +30000/+10000/-10000/-30000

// ---- free-for-all: no hanchan settlements, the highest total wins, a tie goes to the lower
//      seat (so there are no drawn games), and unclaimed riichi sticks go to the winner ----
const gffa = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), length: 'hanchan2', noTimers: true, mode: 'ffa' });
gffa.startHand();
for (let h = 0; h < 16; h++) {                                       // the same schedule as the team game above
  gffa.result = { type: 'draw', deltas: [0, 0, 0, 0], winners: [] };
  gffa.next();
}
assert.strictEqual(gffa.phase, 'over');
assert.deepStrictEqual(gffa.scores, [25000, 25000, 25000, 25000], 'free-for-all has no hanchan settlements');
assert.strictEqual(gffa.final.mode, 'ffa');
assert.strictEqual(gffa.final.winner, 0, 'a tie goes to the lower seat, so there are no drawn games');
assert.deepStrictEqual(gffa.final.standings.map(m => [m.rank, m.seat, m.won]), [[1, 0, true], [2, 1, false], [3, 2, false], [4, 3, false]]);

const gffb = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), length: 'east', noTimers: true, mode: 'ffa' });
gffb.startHand();
for (let h = 0; h < 4; h++) {                                       // an East game: four hands
  gffb.endHand({ type: 'draw', deltas: h === 3 ? [4000, -1000, -2000, -1000] : [0, 0, 0, 0], winners: [] });
  if (h === 3) gffb.sticks = 3;
  gffb.next();
}
assert.deepStrictEqual(gffb.scores, [32000, 24000, 23000, 24000], 'the unclaimed sticks go to the winner');
assert.strictEqual(gffb.final.winner, 0);
assert.deepStrictEqual(gffb.final.standings.map(m => [m.seat, m.score]), [[0, 32000], [1, 24000], [3, 24000], [2, 23000]], 'standings are by score, a tie by seat order');
const vffa = gffb.view(3);
assert.strictEqual(vffa.mode, 'ffa');
assert.deepStrictEqual(vffa.final.standings.map(m => [m.rank, m.seat, m.won]), [[1, 0, true], [2, 1, false], [3, 3, false], [4, 2, false]]);
assert.strictEqual(gffb.final.teams, undefined, 'a free-for-all final has no teams');

// the mode survives a round trip through the shared store, and old saves default to team games
assert.strictEqual(Game.fromJSON(JSON.parse(JSON.stringify(gffb))).mode, 'ffa');
assert.strictEqual(Game.fromJSON({ players: [] }).mode, 'team');
// an unknown mode is treated as a team game
assert.strictEqual(new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), noTimers: true, mode: 'duel' }).mode, 'team');

// ---- East-only is a free-for-all length: team games start with East + South ----
const P4 = [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i }));
assert.strictEqual(new Game({ players: P4, length: 'east', noTimers: true }).length, 'south');
assert.strictEqual(new Game({ players: P4, length: 'east', mode: 'ffa', noTimers: true }).length, 'east');
assert.strictEqual(new Game({ players: P4, length: 'east', mode: 'ffa', stake: 'high', noTimers: true }).stake, 'none', 'free-for-all never carries the stake');

// ---- the stake: 20 million yen for 2,000cc of blood, paid in blood and money ----
const sRon = (from, seat, pay) => ({ type: 'ron', deltas: [0, 0, 0, 0].map((_, s) => (s === from ? -pay : s === seat ? pay : 0)), from, winners: [{ seat, total: pay, yaku: [['Riichi', 1]], base: pay, hand: [], melds: [] }] });
const sDraw = () => ({ type: 'draw', deltas: [0, 0, 0, 0], winners: [], tenpai: [false, false, false, false] });
// a direct ron of 5,000 between the two: the difference moves by 10,000, so at high stakes
// (2,000cc per 20,000 points) that is 1,000cc drawn from Akagi, with no choice to be made
{
  const g = new Game({ players: P4, length: 'south', stake: 'high', noTimers: true });
  g.startHand();
  g.endHand(sRon(0, 2, 5000));
  assert.deepStrictEqual(g.winSettle, { points: 10000, dir: -1 });
  g.next();
  assert.strictEqual(g.bloodLost, 1000); assert.strictEqual(g.money, 0); assert.strictEqual(g.paidDiff, -10000);
  assert.strictEqual(g.lastPayment.cc, 1000);
}
// the same ron won by Akagi: the Akagi player chooses; the view offers the choice in yen and cc
{
  const g = new Game({ players: P4, length: 'south', stake: 'high', noTimers: true });
  g.startHand();
  g.endHand(sRon(2, 0, 5000));
  g.next();
  assert.strictEqual(g.phase, 'settle');
  assert.deepStrictEqual(g.view(0).settle, { points: 10000, yen: 10000000, cc: 1000, transfused: 0, restYen: 10000000 });
  assert.ok(g.view(1).settle, 'the choice is visible to the whole table');
  assert.strictEqual(g.settleChoice(1, 'money'), 'Only the player of Akagi makes that choice.');
  g.settleChoice(0, 'money');
  assert.strictEqual(g.money, 10000000); assert.strictEqual(g.bloodLost, 0); assert.strictEqual(g.paidDiff, 10000);
  assert.strictEqual(g.phase, 'action');   // the next hand is dealt
}
// a tsumo of 2,000 from each seat: only the slice paid between the two counts, so 4,000
{
  const g = new Game({ players: P4, length: 'south', stake: 'low', noTimers: true });
  g.startHand();
  g.endHand({ type: 'tsumo', deltas: [-2000, -2000, 6000, -2000], winners: [{ seat: 2, total: 6000, yaku: [['Pinfu', 1]], base: 2000, hand: [], melds: [] }] });
  assert.deepStrictEqual(g.winSettle, { points: 4000, dir: -1 });
  g.next();
  assert.strictEqual(g.bloodLost, 40, 'low stakes: 4,000 points is 40cc');
}
// transfusing: the blood lost comes back as far as it can (to 0cc) and the remainder is yen
{
  const g = new Game({ players: P4, length: 'south', stake: 'high', noTimers: true });
  g.startHand();
  g.endHand(sRon(0, 2, 5000)); g.next();      // 1,000cc lost
  g.endHand(sRon(2, 0, 7500)); g.next();      // 1,500cc back: 1,000 transfused, 500cc worth of yen
  assert.strictEqual(g.phase, 'settle');
  g.settleChoice(0, 'transfuse');
  assert.strictEqual(g.bloodLost, 0);
  assert.strictEqual(g.money, 500 * 10000, 'the 500cc beyond what is lost comes back as yen');
}
// indirect points wait for the hanchan end: Akagi wins 5,000 from Suzuki, then the hanchan
// settles the whole unpaid part of the Akagi-minus-Washizu difference (after the hanchan pay)
{
  const g = new Game({ players: P4, length: 'hanchan2', stake: 'high', noTimers: true });
  g.startHand();
  g.endHand({ type: 'ron', deltas: [5000, 0, 0, -5000], from: 3, winners: [{ seat: 0, total: 5000, yaku: [['Riichi', 1]], base: 5000, hand: [], melds: [] }] });
  g.next();
  assert.strictEqual(g.winSettle, null, 'winning from a partner is not a direct exchange');
  for (let h = 0; h < 7 && g.phase !== 'settle'; h++) { g.result = sDraw(); g.next(); }
  assert.strictEqual(g.phase, 'settle', 'the hanchan end settles the unpaid difference');
  assert.strictEqual(g.settle.points, 45000, 'A-W after the hanchan pay: 60,000 - 15,000');
  g.settleChoice(0, 'money');
  assert.strictEqual(g.money, 45000000); assert.strictEqual(g.paidDiff, 45000);
  assert.strictEqual(g.roundWind, 2, 'the game carries on into the next hanchan');
}
// more than 2,000cc lost at any moment: Akagi dies and the game ends at once, for his team
{
  const g = new Game({ players: P4, length: 'hanchan2', stake: 'high', noTimers: true });
  g.startHand();
  g.endHand(sRon(0, 2, 5000)); g.next();     // 1,000cc
  g.bloodLost = 1500;                        // (more hands, more blood)
  g.endHand(sRon(0, 2, 5000)); g.next();     // 1,000cc more: 2,500 -> dead
  assert.strictEqual(g.dead, true);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.final.winner, 1, 'Akagi dies: Washizu team wins');
  assert.deepStrictEqual(g.final.stake, { level: 'high', pts: 20000, blood: 2500, money: 0, dead: true });
}
// finishing the game with the stake: Akagi is ahead the whole way, takes the yen, and
// survives - so his team wins the match
{
  const g = new Game({ players: P4, length: 'south', stake: 'high', noTimers: true });
  g.startHand();
  g.endHand(sRon(2, 0, 5000));
  g.next();                                   // Akagi is ahead: the table waits on his choice
  assert.strictEqual(g.phase, 'settle');
  g.settleChoice(0, 'money');
  while (g.phase !== 'over') {                // seven more drawn hands to the end of the match
    g.endHand(sDraw());
    g.next();
    if (g.phase === 'settle') g.settleChoice(0, 'money');   // the final hanchan settles the rest
  }
  assert.strictEqual(g.dead, false);
  assert.strictEqual(g.final.winner, 0, 'he survived the match: Akagi team wins');
  assert.strictEqual(g.bloodLost, 0);
  assert.ok(g.final.stake && g.final.stake.money > 0);
}
// the stake and the blood survive a round trip through the shared store
{
  const g = new Game({ players: P4, length: 'south', stake: 'low', noTimers: true });
  g.startHand(); g.endHand(sRon(0, 2, 5000)); g.next();
  const back = Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.strictEqual(back.stake, 'low'); assert.strictEqual(back.bloodLost, 100, 'low: 10,000 points is 100cc'); assert.strictEqual(back.paidDiff, -10000);
  assert.strictEqual(Game.fromJSON({ players: [] }).stake, 'none', 'old saves have no stake');
  assert.strictEqual(Game.fromJSON({ players: [], stake: 'high' }).stake, 'high', 'a saved stake is restored');
}
console.log('engine tests passed');
