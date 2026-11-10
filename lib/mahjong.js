'use strict';
/*
 * Tile model
 *   id 0..135, kind = id >> 2 (0..33), copy = id & 3
 *   kinds 0-8 man, 9-17 pin, 18-26 sou, 27-30 winds (E S W N), 31-33 dragons (white green red)
 *   Washizu rule: copy 0 of every kind is opaque, copies 1-3 are glass (visible to everyone).
 */
const kindOf = id => id >> 2;
const isGlass = id => (id & 3) !== 0;
const isHonor = k => k >= 27;
const isYao = k => k >= 27 || k % 9 === 0 || k % 9 === 8;
const GREEN = new Set([19, 20, 21, 23, 25, 32]);
const ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
const DRAGON = ['White dragon', 'Green dragon', 'Red dragon'];

function doraOf(ind) {
  if (ind < 27) return Math.floor(ind / 9) * 9 + (ind % 9 + 1) % 9;
  if (ind < 31) return 27 + (ind - 27 + 1) % 4;
  return 31 + (ind - 31 + 1) % 3;
}

function canFormSets(c, i) {
  while (i < 34 && c[i] === 0) i++;
  if (i === 34) return true;
  if (c[i] >= 3) {
    c[i] -= 3; const r = canFormSets(c, i); c[i] += 3;
    if (r) return true;
  }
  if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    const r = canFormSets(c, i);
    c[i]++; c[i + 1]++; c[i + 2]++;
    if (r) return true;
  }
  return false;
}

function isChiitoi(c) {
  let p = 0;
  for (let k = 0; k < 34; k++) { if (c[k] === 2) p++; else if (c[k] !== 0) return false; }
  return p === 7;
}

function isKokushi(c) {
  let pairs = 0, total = 0;
  for (let k = 0; k < 34; k++) total += c[k];
  if (total !== 14) return false;
  for (const k of ORPHANS) {
    if (c[k] === 0 || c[k] > 2) return false;
    if (c[k] === 2) pairs++;
  }
  return pairs === 1;
}

/** Is this concealed part (counts of 14 - 3*melds tiles) a complete hand shape? */
function isComplete(c, nMelds) {
  if (nMelds === 0 && (isChiitoi(c) || isKokushi(c))) return true;
  for (let p = 0; p < 34; p++) {
    if (c[p] >= 2) {
      c[p] -= 2; const r = canFormSets(c, 0); c[p] += 2;
      if (r) return true;
    }
  }
  return false;
}

/** Kinds that complete a 13 - 3*melds tile hand. */
function waits(c, nMelds) {
  const w = [];
  for (let k = 0; k < 34; k++) {
    if (c[k] >= 4) continue;
    c[k]++;
    if (isComplete(c, nMelds)) w.push(k);
    c[k]--;
  }
  return w;
}

function findSets(c, i, acc, cb) {
  while (i < 34 && c[i] === 0) i++;
  if (i === 34) { cb(acc); return; }
  if (c[i] >= 3) {
    c[i] -= 3; acc.push({ t: 'tri', k: i });
    findSets(c, i, acc, cb);
    acc.pop(); c[i] += 3;
  }
  if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--; acc.push({ t: 'seq', k: i });
    findSets(c, i, acc, cb);
    acc.pop(); c[i]++; c[i + 1]++; c[i + 2]++;
  }
}

function decompose(c) {
  const out = [];
  for (let p = 0; p < 34; p++) {
    if (c[p] >= 2) {
      c[p] -= 2;
      findSets(c, 0, [], s => out.push({ pair: p, sets: s.slice() }));
      c[p] += 2;
    }
  }
  return out;
}

function basePoints(han, fu, yakuman) {
  if (yakuman) return 8000 * yakuman;
  if (han >= 13) return 8000;
  if (han >= 11) return 6000;
  if (han >= 8) return 4000;
  if (han >= 6) return 3000;
  if (han >= 5) return 2000;
  return Math.min(2000, fu * Math.pow(2, han + 2));
}

function limitName(han, fu, yakuman) {
  if (yakuman) return yakuman > 1 ? 'Double yakuman' : 'Yakuman';
  if (han >= 13) return 'Counted yakuman';
  if (han >= 11) return 'Sanbaiman';
  if (han >= 8) return 'Baiman';
  if (han >= 6) return 'Haneman';
  if (han >= 5 || fu * Math.pow(2, han + 2) >= 2000) return 'Mangan';
  return '';
}

/**
 * Score a complete hand. Returns null when the hand has no yaku.
 * x = { counts (concealed tiles incl. winning tile), melds [{type:'chi'|'pon'|'minkan'|'kakan'|'ankan', kind}],
 *       winKind, tsumo, riichi (0|1|2), ippatsu, haitei, houtei, rinshan, chankan, tenhou, chiihou,
 *       seatWind (0-3), roundWind (0-3), dora, ura }
 */
function evaluate(x) {
  const c = x.counts, melds = x.melds, w = x.winKind, tsumo = x.tsumo;
  const menzen = melds.every(m => m.type === 'ankan');
  const all = c.slice();
  for (const m of melds) {
    if (m.type === 'chi') { all[m.kind]++; all[m.kind + 1]++; all[m.kind + 2]++; } else all[m.kind] += 3;
  }
  const kinds = [];
  for (let k = 0; k < 34; k++) if (all[k]) kinds.push(k);

  const sit = [];
  if (x.riichi === 2) sit.push(['Double riichi', 2]); else if (x.riichi === 1) sit.push(['Riichi', 1]);
  if (x.riichi && x.ippatsu) sit.push(['Ippatsu', 1]);
  if (menzen && tsumo) sit.push(['Menzen tsumo', 1]);
  if (x.haitei) sit.push(['Haitei (last draw)', 1]);
  if (x.houtei) sit.push(['Houtei (last discard)', 1]);
  if (x.rinshan) sit.push(['Rinshan kaihou', 1]);
  if (x.chankan) sit.push(['Chankan', 1]);

  const suits = new Set(kinds.filter(k => k < 27).map(k => Math.floor(k / 9)));
  const hasHonor = kinds.some(isHonor);
  const allYao = kinds.every(isYao);
  const allSimple = kinds.every(k => !isYao(k));
  const flush = [];
  if (suits.size === 1) flush.push(hasHonor ? ['Honitsu', menzen ? 3 : 2] : ['Chinitsu', menzen ? 6 : 5]);

  const ym0 = [];
  if (x.tenhou) ym0.push('Tenhou');
  if (x.chiihou) ym0.push('Chiihou');
  if (suits.size === 0) ym0.push('Tsuuiisou');
  if (!hasHonor && allYao) ym0.push('Chinroutou');
  if (kinds.every(k => GREEN.has(k))) ym0.push('Ryuuiisou');

  let best = null;
  const finish = (yaku, fu, ym) => {
    let r;
    if (ym.length) {
      r = { yaku: ym.map(n => [n, 13]), han: 13 * ym.length, fu: 0, yakuman: ym.length };
    } else {
      if (!yaku.length) return;
      const list = yaku.slice();
      let han = list.reduce((a, y) => a + y[1], 0);
      if (x.dora) { list.push(['Dora', x.dora]); han += x.dora; }
      if (x.ura) { list.push(['Ura dora', x.ura]); han += x.ura; }
      r = { yaku: list, han, fu, yakuman: 0 };
    }
    r.base = basePoints(r.han, r.fu, r.yakuman);
    r.limit = limitName(r.han, r.fu, r.yakuman);
    if (!best || r.base > best.base || (r.base === best.base && r.han > best.han)) best = r;
  };

  if (melds.length === 0 && isKokushi(c)) finish([], 0, ym0.concat('Kokushi musou'));

  if (melds.length === 0 && isChiitoi(c)) {
    const yaku = sit.concat([['Chiitoitsu', 2]]);
    if (allSimple) yaku.push(['Tanyao', 1]);
    if (allYao) yaku.push(['Honroutou', 2]);
    yaku.push(...flush);
    finish(yaku, 25, ym0);
  }

  const mgroups = melds.map(m => m.type === 'chi'
    ? { t: 'seq', k: m.kind, open: true, kan: false }
    : { t: 'tri', k: m.kind, open: m.type !== 'ankan', kan: m.type !== 'pon' });

  for (const d of decompose(c)) {
    const places = [];
    if (d.pair === w) places.push({ p: 'pair', i: -1 });
    d.sets.forEach((s, i) => {
      if (s.t === 'tri' && s.k === w) places.push({ p: 'tri', i });
      if (s.t === 'seq' && w >= s.k && w <= s.k + 2) places.push({ p: 'seq', i });
    });
    for (const pl of places) {
      const g = d.sets.map((s, i) => ({ t: s.t, k: s.k, kan: false, open: !tsumo && pl.p === 'tri' && pl.i === i })).concat(mgroups);
      const seqs = g.filter(s => s.t === 'seq'), tris = g.filter(s => s.t === 'tri');
      const yaku = sit.slice(), ym = ym0.slice();

      let waitFu = 0, ryanmen = false;
      if (pl.p === 'pair') waitFu = 2;
      else if (pl.p === 'seq') {
        const s = d.sets[pl.i];
        if (w === s.k + 1) waitFu = 2;
        else if ((w === s.k && s.k % 9 === 6) || (w === s.k + 2 && s.k % 9 === 0)) waitFu = 2;
        else ryanmen = true;
      }
      const seatK = 27 + x.seatWind, roundK = 27 + x.roundWind;
      const yakuhaiPair = d.pair >= 31 || d.pair === seatK || d.pair === roundK;
      const pinfu = melds.length === 0 && tris.length === 0 && ryanmen && !yakuhaiPair;
      if (pinfu) yaku.push(['Pinfu', 1]);
      if (allSimple) yaku.push(['Tanyao', 1]);
      if (menzen) {
        const cnt = {};
        seqs.forEach(s => { cnt[s.k] = (cnt[s.k] || 0) + 1; });
        const pairs = Object.values(cnt).reduce((a, n) => a + Math.floor(n / 2), 0);
        if (pairs === 2) yaku.push(['Ryanpeikou', 3]); else if (pairs === 1) yaku.push(['Iipeikou', 1]);
      }
      for (const t of tris) {
        if (t.k >= 31) yaku.push([DRAGON[t.k - 31], 1]);
        if (t.k === roundK) yaku.push(['Round wind', 1]);
        if (t.k === seatK) yaku.push(['Seat wind', 1]);
      }
      const seqK = new Set(seqs.map(s => s.k));
      for (let r = 0; r < 7; r++) {
        if (seqK.has(r) && seqK.has(r + 9) && seqK.has(r + 18)) { yaku.push(['Sanshoku doujun', menzen ? 2 : 1]); break; }
      }
      for (const s of [0, 9, 18]) {
        if (seqK.has(s) && seqK.has(s + 3) && seqK.has(s + 6)) { yaku.push(['Ittsu', menzen ? 2 : 1]); break; }
      }
      const triK = new Set(tris.map(t => t.k));
      for (let r = 0; r < 9; r++) {
        if (triK.has(r) && triK.has(r + 9) && triK.has(r + 18)) { yaku.push(['Sanshoku doukou', 2]); break; }
      }
      if (tris.length === 4) yaku.push(['Toitoi', 2]);
      const ankou = tris.filter(t => !t.open).length;
      // suuankou is a tsumo win; by ron the completed triplet counts as open, so four
      // closed triplets by ron (win on the pair) is only sanankou
      if (ankou === 4 && tsumo) ym.push('Suuankou'); else if (ankou >= 3) yaku.push(['Sanankou', 2]);
      const kans = tris.filter(t => t.kan).length;
      if (kans === 4) ym.push('Suukantsu'); else if (kans === 3) yaku.push(['Sankantsu', 2]);
      const drag = tris.filter(t => t.k >= 31).length;
      const wind = tris.filter(t => t.k >= 27 && t.k < 31).length;
      if (drag === 3) ym.push('Daisangen'); else if (drag === 2 && d.pair >= 31) yaku.push(['Shousangen', 2]);
      if (wind === 4) ym.push('Daisuushii'); else if (wind === 3 && d.pair >= 27 && d.pair < 31) ym.push('Shousuushii');
      if (allYao) yaku.push(['Honroutou', 2]);
      else {
        const every = isYao(d.pair) && seqs.every(s => s.k % 9 === 0 || s.k % 9 === 6) && tris.every(t => isYao(t.k));
        if (every && seqs.length > 0) yaku.push(hasHonor ? ['Chanta', menzen ? 2 : 1] : ['Junchan', menzen ? 3 : 2]);
      }
      yaku.push(...flush);
      if (melds.length === 0 && suits.size === 1 && !hasHonor) {
        const b = [...suits][0] * 9;
        let ok = c[b] >= 3 && c[b + 8] >= 3;
        for (let r = 1; r < 8; r++) if (c[b + r] < 1) ok = false;
        if (ok) ym.push('Chuuren poutou');
      }

      let fu;
      if (pinfu) fu = tsumo ? 20 : 30;
      else {
        fu = 20 + waitFu;
        for (const t of tris) {
          let f = isYao(t.k) ? 4 : 2;
          if (!t.open) f *= 2;
          if (t.kan) f *= 4;
          fu += f;
        }
        if (d.pair >= 31) fu += 2;
        if (d.pair === seatK) fu += 2;
        if (d.pair === roundK) fu += 2;
        if (tsumo) fu += 2; else if (menzen) fu += 10;
        fu = Math.ceil(fu / 10) * 10;
        if (!menzen && fu === 20) fu = 30;
      }
      finish(yaku, fu, ym);
    }
  }
  return best;
}

module.exports = { kindOf, isGlass, isYao, doraOf, isComplete, waits, evaluate, basePoints };
