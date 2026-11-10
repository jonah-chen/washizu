'use strict';
// Checks the Vercel entry point the way the platform uses it: server.mjs must default-export an
// http.Server that is not listening, and without a database it must say so instead of
// pretending to work.
const assert = require('assert');
process.env.VERCEL = '1';
delete process.env.REDIS_URL; delete process.env.KV_URL;
(async () => {
  const server = (await import('../server.mjs')).default;
  assert.ok(server instanceof require('http').Server && !server.listening);
  assert.strictEqual(require('../package.json').main, 'server.mjs');
  await new Promise(r => server.listen(0, r));
  // every request reaches this one function, whatever its path
  const base = `http://localhost:${server.address().port}`;
  const r = await fetch(base + '/api/server?op=me');
  assert.strictEqual(r.status, 503);
  assert.ok(/REDIS_URL/.test((await r.json()).error));
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes('Washizu Mahjong'));
  console.log('entry point test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
