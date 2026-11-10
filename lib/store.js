'use strict';
/*
 * Shared state. Two interchangeable backends:
 *   RedisStore  - used when REDIS_URL (or KV_URL) is set. Required on Vercel, where every
 *                 function instance must see the same accounts, tables and games.
 *   MemoryStore - used otherwise. Fine for one process on your own machine; nothing is saved.
 * Everything the app needs is the small async API below, so the rest of the code never
 * touches Redis directly.
 */
const crypto = require('crypto');
const PREFIX = 'gm:';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Base {
  /** Run fn while holding a short-lived named lock, so two instances never edit one table at once. */
  async lock(name, fn) {
    const key = 'lock:' + name, token = crypto.randomBytes(8).toString('hex');
    const until = Date.now() + 8000;
    while (!(await this.set(key, token, { nx: true, px: 8000 }))) {
      if (Date.now() > until) throw new Error('lock timeout: ' + name);
      await sleep(15 + Math.random() * 35);
    }
    try { return await fn(); } finally { await this.delIfEq(key, token); }
  }
}

class MemoryStore extends Base {
  constructor() { super(); this.kv = new Map(); this.exp = new Map(); this.sets = new Map(); this.z = new Map(); this.subs = []; this.kind = 'memory'; }
  _live(k) { const e = this.exp.get(k); if (e != null && e <= Date.now()) { this.kv.delete(k); this.exp.delete(k); } }
  async get(k) { this._live(k); return this.kv.has(k) ? this.kv.get(k) : null; }
  async set(k, v, o = {}) {
    this._live(k);
    if (o.nx && this.kv.has(k)) return false;
    this.kv.set(k, String(v));
    const ms = o.px || (o.ex ? o.ex * 1000 : 0);
    if (ms) this.exp.set(k, Date.now() + ms); else this.exp.delete(k);
    return true;
  }
  async del(k) { this.kv.delete(k); this.exp.delete(k); }
  async delIfEq(k, v) { if ((await this.get(k)) === v) await this.del(k); }
  async mget(ks) { return Promise.all(ks.map(k => this.get(k))); }
  async expire(k, s) { this._live(k); if (this.kv.has(k)) this.exp.set(k, Date.now() + s * 1000); }
  async incr(k, ex) { const n = (+(await this.get(k)) || 0) + 1; const e = this.exp.get(k); this.kv.set(k, String(n)); if (n === 1) this.exp.set(k, Date.now() + ex * 1000); else if (e) this.exp.set(k, e); return n; }
  async sadd(k, m) { if (!this.sets.has(k)) this.sets.set(k, new Set()); this.sets.get(k).add(m); }
  async srem(k, m) { const s = this.sets.get(k); if (s) s.delete(m); }
  async smembers(k) { return [...(this.sets.get(k) || [])]; }
  _z(k) { if (!this.z.has(k)) this.z.set(k, new Map()); return this.z.get(k); }
  async zadd(k, score, m) { this._z(k).set(m, score); }
  async zscores(k, ms) { const z = this._z(k); return ms.map(m => (z.has(m) ? z.get(m) : null)); }
  async zcount(k, min) { let n = 0; for (const s of this._z(k).values()) if (s >= min) n++; return n; }
  async zprune(k, below) { const z = this._z(k); for (const [m, s] of z) if (s < below) z.delete(m); }
  async ztop(k, n) { return [...this._z(k)].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]); }
  async publish(msg) { const s = JSON.stringify(msg); for (const f of this.subs) setImmediate(() => f(JSON.parse(s))); }
  subscribe(f) { this.subs.push(f); return () => { this.subs = this.subs.filter(x => x !== f); }; }
  async close() {}
}

class RedisStore extends Base {
  constructor(url) {
    super();
    const Redis = require('ioredis');
    const opts = { maxRetriesPerRequest: 3, connectTimeout: 8000, keyPrefix: PREFIX };
    this.r = new Redis(url, opts);
    this.sub = null; this.url = url; this.Redis = Redis; this.kind = 'redis';
    this.r.on('error', e => console.error('redis:', e.message));
  }
  async get(k) { return this.r.get(k); }
  async set(k, v, o = {}) {
    const a = [k, v];
    if (o.px) a.push('PX', o.px); else if (o.ex) a.push('EX', o.ex);
    if (o.nx) a.push('NX');
    return (await this.r.set(...a)) === 'OK';
  }
  async del(k) { await this.r.del(k); }
  async delIfEq(k, v) { await this.r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, k, v); }
  async mget(ks) { return ks.length ? this.r.mget(...ks) : []; }
  async expire(k, s) { await this.r.expire(k, s); }
  async incr(k, ex) { const n = await this.r.incr(k); if (n === 1) await this.r.expire(k, ex); return n; }
  async sadd(k, m) { await this.r.sadd(k, m); }
  async srem(k, m) { await this.r.srem(k, m); }
  async smembers(k) { return this.r.smembers(k); }
  async zadd(k, score, m) { await this.r.zadd(k, score, m); }
  async zscores(k, ms) { if (!ms.length) return []; return (await this.r.zmscore(k, ...ms)).map(s => (s == null ? null : +s)); }
  async zcount(k, min) { return this.r.zcount(k, min, '+inf'); }
  async zprune(k, below) { await this.r.zremrangebyscore(k, '-inf', '(' + below); }
  async ztop(k, n) { return this.r.zrevrange(k, 0, n - 1); }
  async publish(msg) { await this.r.publish(PREFIX + 'events', JSON.stringify(msg)); }
  subscribe(f) {
    if (!this.sub) {
      this.sub = new this.Redis(this.url, { connectTimeout: 8000 });
      this.sub.on('error', e => console.error('redis sub:', e.message));
      this.sub.subscribe(PREFIX + 'events').catch(e => console.error('redis subscribe:', e.message));
      this.handlers = [];
      this.sub.on('message', (_c, raw) => { let m; try { m = JSON.parse(raw); } catch { return; } for (const h of this.handlers) h(m); });
    }
    this.handlers.push(f);
    return () => { this.handlers = this.handlers.filter(x => x !== f); };
  }
  async close() { this.r.disconnect(); if (this.sub) this.sub.disconnect(); }
}

function createStore() {
  const url = process.env.REDIS_URL || process.env.KV_URL;
  if (url) return new RedisStore(url);
  if (process.env.VERCEL) return null;          // on Vercel an in-memory store would silently lose everything
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, RedisStore };
