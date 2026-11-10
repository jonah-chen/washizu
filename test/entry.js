'use strict';
// Checks the Vercel entry point the way the platform uses it: api/server.js must export an
// http.Server that is not listening, and without a database it must say so instead of
// pretending to work.
const assert = require('assert');
process.env.VERCEL = '1';
delete process.env.REDIS_URL; delete process.env.KV_URL;
const server = require('../api/server.js');
assert.ok(server instanceof require('http').Server && !server.listening);
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/server`;
  const r = await fetch(base + '?op=me');
  assert.strictEqual(r.status, 503);
  assert.ok(/REDIS_URL/.test((await r.json()).error));
  const cfg = require('../vercel.json');
  assert.ok(cfg.functions['api/server.js'].maxDuration >= 60);
  console.log('entry point test passed');
  process.exit(0);
});
