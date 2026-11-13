'use strict';
// Cloudflare Turnstile on login and register.
//   node test/turnstile.js           parent: no secret — the check must be skipped
// The parent then runs itself with the 'case' argument: TURNSTILE_SECRET set and the
// siteverify endpoint stubbed, so no network is touched and no real keys are needed.
const assert = require('assert');

if (process.argv[2] === 'case') {
  process.env.TURNSTILE_SECRET = 'test-secret';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/siteverify')) {
      calls.push(new URLSearchParams(o.body));
      return { json: async () => ({ success: calls[calls.length - 1].get('response') === 'good-token', 'error-codes': [] }) };
    }
    return realFetch(url, o);
  };
  const { createApp } = require('../lib/app');
  const { MemoryStore } = require('../lib/store');
  const app = createApp({ store: new MemoryStore() });
  const post = (op, body) => fetch(`http://127.0.0.1:${app.server.address().port}/api/server?op=${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  (async () => {
    await new Promise(r => app.server.listen(0, r));
    const r1 = await post('register', { username: 'tina_bot', password: 'longenough' });
    assert.strictEqual(r1.status, 400, 'no token is rejected');
    assert.ok((await r1.json()).error.includes('bot check'));
    const r2 = await post('register', { username: 'tina_bot', password: 'longenough', cfTurnstileResponse: 'bad-token' });
    assert.strictEqual(r2.status, 400, 'an invalid token is rejected');
    const r3 = await post('register', { username: 'tina_bot', password: 'longenough', cfTurnstileResponse: 'good-token' });
    assert.strictEqual(r3.status, 200, 'a valid token passes');
    assert.ok(/HttpOnly/.test(r3.headers.get('set-cookie')));
    const r4 = await post('login', { username: 'tina_bot', password: 'wrong password', cfTurnstileResponse: 'good-token' });
    assert.strictEqual(r4.status, 401, 'the token is checked, then the password');
    assert.strictEqual(calls.length, 3, 'a siteverify call per token; a missing one is refused locally');
    assert.strictEqual(calls[0].get('secret'), 'test-secret');
    assert.strictEqual(calls[0].get('remoteip'), '127.0.0.1', 'the client address goes as remoteip');
    await app.close();
    console.log('turnstile (secret set) passed');
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
} else {
  delete process.env.TURNSTILE_SECRET;
  const { spawn } = require('child_process');
  const { createApp } = require('../lib/app');
  const { MemoryStore } = require('../lib/store');
  const app = createApp({ store: new MemoryStore() });
  const post = op => fetch(`http://127.0.0.1:${app.server.address().port}/api/server?op=${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'no_check', password: 'longenough' }) });
  (async () => {
    await new Promise(r => app.server.listen(0, r));
    assert.strictEqual((await post('register')).status, 200, 'without the secret, no token is needed');
    await app.close();
    await new Promise((res, rej) => {
      const child = spawn(process.execPath, [__filename, 'case'], { stdio: 'inherit' });
      child.on('exit', code => (code === 0 ? res() : rej(new Error('the secret-set case failed'))));
    });
    console.log('turnstile test passed');
  })().catch(e => { console.error(e); process.exit(1); });
}