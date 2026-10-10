'use strict';
/**
 * Lend this machine to the server: claim photos waiting in its face queue,
 * index them here (on the GPU when there is one), and send the faces back.
 * Uses the hub's worker API, the same one worker.py speaks.
 */
const { EventEmitter } = require('node:events');

const IDLE_MIN = 2000;
const IDLE_MAX = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class QueueNode extends EventEmitter {
  constructor({ url, token, name, analyze, batch = 2 }) {
    super();
    Object.assign(this, { url: url.replace(/\/+$/, ''), token, name, analyze, batch });
    this.stats = { processed: 0, faces: 0, failed: 0, ms: 0 };
    this.stopped = false;
  }

  async _call(method, p, body) {
    const res = await fetch(this.url + p, {
      method,
      headers: { 'X-Worker-Token': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return p.startsWith('/api/worker/photo/') ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  stop() {
    this.stopped = true;
  }

  async run() {
    let idle = IDLE_MIN;
    this.emit('status', 'Đang chờ ảnh trong hàng đợi của máy chủ…');
    while (!this.stopped) {
      let jobs = [];
      try {
        jobs = (await this._call('POST', '/api/worker/claim', { worker: this.name, limit: this.batch })).jobs;
      } catch (e) {
        if (e.status === 401 || e.status === 503) {
          this.emit('status', 'Máy chủ không cho node này nhận việc (sai mã).');
          break;
        }
        this.emit('status', `Mất kết nối máy chủ, thử lại sau ${Math.round(idle / 1000)} giây`);
      }
      if (!jobs.length) {
        // say why there is nothing to do, so an idle node does not look broken
        try {
          const st = await (await fetch(`${this.url}/api/stats`, { signal: AbortSignal.timeout(15000) })).json();
          this.emit('queue', st.pending);
          this.emit('status', st.pending
            ? `Máy chủ còn ${st.pending} ảnh chờ, đang được máy khác xử lý. Sẵn sàng nhận việc.`
            : 'Hàng chờ của máy chủ đang trống. Ảnh mới cần nhận diện sẽ được xử lý tại đây.');
        } catch {
          /* the next claim reports the connection problem */
        }
        await sleep(idle);
        idle = Math.min(idle * 1.5, IDLE_MAX);
        continue;
      }
      idle = IDLE_MIN;
      for (const job of jobs) {
        if (this.stopped) break; // the lease returns the rest to the pool
        const body = { id: job.id, worker: this.name };
        try {
          const data = await this._call('GET', job.photo);
          const r = await this.analyze(data);
          Object.assign(body, { width: r.width, height: r.height, faces: r.faces, signature: r.signature });
          this.stats.ms += r.ms;
        } catch (e) {
          if (e.status === 404) continue; // deleted on the server meanwhile
          body.error = String(e.message).slice(0, 400);
        }
        try {
          const res = await this._call('POST', '/api/worker/result', body);
          if (res.stored) {
            this.stats.processed += 1;
            this.stats.faces += body.faces.length;
          } else if (body.error) this.stats.failed += 1;
        } catch {
          this.stats.failed += 1; // the lease runs out and someone else takes it
        }
        this.emit('stats', { ...this.stats });
      }
      this.emit('status', `Đã xử lý ${this.stats.processed} ảnh cho máy chủ`);
    }
    this.emit('status', 'Đã tắt chế độ node');
    this.emit('done');
  }
}

module.exports = { QueueNode };
