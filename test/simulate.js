'use strict';
// Drives whole games with four random-but-legal players and checks invariants.
const assert = require('assert');
const { Game } = require('../lib/game');
const pick = a => a[Math.floor(Math.random() * a.length)];
const N = +process.argv[2] || 150;
const stat = { hands: 0, ron: 0, tsumo: 0, draw: 0, riichi: 0, calls: 0, kans: 0, yakuman: 0, games: 0 };

for (let g = 0; g < N; g++) {
  let over = null;
  let game = new Game({ players: [0, 1, 2, 3].map(i => ({ key: 'p' + i, name: 'P' + i })), length: g % 2 ? 'south' : 'east', noTimers: true });
  game.start();
  let steps = 0;
  const must = (seat, m) => { const e = game.act(seat, m); assert.ok(!e, `${JSON.stringify(m)} -> ${e}`); };
  while (!over) {
    assert.ok(++steps < 200000, 'game does not terminate');
    // the game must survive being written to a shared store and read back between any two actions
    game = Game.fromJSON(JSON.parse(JSON.stringify(game)));
    if (game.phase === 'over') { over = game.final; break; }
    assert.strictEqual(game.scores.reduce((a, b) => a + b, 0) + game.sticks * 1000, 100000, 'points conserved');
    if (game.phase === 'action') {
      const s = game.turn, v = game.view(s), o = v.options;
      // every seat sees exactly its own opaque tiles and nobody else's
      for (let q = 0; q < 4; q++) {
        const vq = game.view(q);
        vq.players.forEach((p, i) => { if (i !== q) { assert.ok(!p.tiles); assert.ok(p.glass.every(t => t & 3)); assert.strictEqual(p.glass.length + p.hidden, game.hands[i].length); } });
        assert.ok(!('pool' in vq) && !('ura' in vq) && !('hands' in vq));
      }
      assert.strictEqual(game.hands[s].length + game.melds[s].length * 3, 14);
      if (o.tsumo) { must(s, { a: 'tsumo' }); }
      else if (o.ankan.length && Math.random() < 0.7) { stat.kans++; must(s, { a: 'ankan', kind: pick(o.ankan) }); }
      else if (o.kakan.length && Math.random() < 0.7) { stat.kans++; must(s, { a: 'kakan', kind: pick(o.kakan) }); }
      else if (o.riichi.length && Math.random() < 0.8) { stat.riichi++; must(s, { a: 'riichi', id: pick(o.riichi) }); }
      else {
        // discard heuristically: keep pairs/neighbours so hands actually finish
        const c = game.counts(s);
        const score = t => { const k = t >> 2; let x = c[k] * 3; if (k < 27) { if (k % 9 > 0) x += c[k - 1]; if (k % 9 < 8) x += c[k + 1]; } return x + Math.random(); };
        const id = o.discard.slice().sort((a, b) => score(a) - score(b))[0];
        must(s, { a: 'discard', id });
        assert.ok(game.act(s, { a: 'discard', id }), 'double discard must be rejected');
      }
    } else if (game.phase === 'claim') {
      const s = game.waitingSeats()[0], o = game.view(s).claim;
      assert.ok(o);
      if (o.ron) must(s, { a: 'claim', c: 'ron' });
      else if (o.kan && Math.random() < 0.3) { stat.kans++; must(s, { a: 'claim', c: 'kan' }); }
      else if (o.pon && Math.random() < 0.3) { stat.calls++; must(s, { a: 'claim', c: 'pon' }); }
      else if (o.chi && Math.random() < 0.2) { stat.calls++; must(s, { a: 'claim', c: 'chi', i: 0 }); }
      else must(s, { a: 'claim', c: 'pass' });
    } else if (game.phase === 'ended') {
      const r = game.result; stat.hands++; stat[r.type]++;
      assert.strictEqual(r.deltas.reduce((a, b) => a + b, 0) % 1000, 0);
      if (r.winners) for (const w of r.winners) { assert.ok(w.yaku.length && w.base > 0); if (w.yakuman) stat.yakuman++; assert.strictEqual(w.hand.length + w.melds.length * 3, 13); }
      for (let s = 0; s < 4; s++) must(s, { a: 'next' });
    } else assert.fail('unexpected phase ' + game.phase);
  }
  stat.games++;
  assert.strictEqual(over.teams.length, 2);
  assert.strictEqual(game.scores.reduce((a, b) => a + b, 0) + game.sticks * 1000, 100000);
  for (const t of over.teams) {                // partners sit opposite and a team's total is the sum of its two seats
    assert.strictEqual((t.members[0].seat + 2) % 4, t.members[1].seat);
    assert.strictEqual(t.total, t.members[0].score + t.members[1].score);
    assert.strictEqual(t.won, over.winner === t.team);
  }
  assert.ok(over.teams[0].total >= over.teams[1].total);
  assert.strictEqual(over.winner == null, over.teams[0].total === over.teams[1].total);
  if (over.winner == null) stat.drawnGames = (stat.drawnGames || 0) + 1;
}
console.log('simulation passed', JSON.stringify(stat));
