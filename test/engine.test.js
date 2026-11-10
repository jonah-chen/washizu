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
console.log('engine tests passed');
