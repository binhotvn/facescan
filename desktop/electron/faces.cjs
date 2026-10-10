'use strict';
/** The main process's handle on the face model thread. */
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class FaceService {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.device = null;
    this.signature = null;
  }

  _call(msg, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async start(files, manifest) {
    await this.stop();
    // packaged: worker threads cannot start from inside app.asar, so the worker
    // (and the native modules it loads) ship unpacked beside it
    const file = path.join(__dirname, 'face-worker.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    this.worker = new Worker(file);
    this.worker.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error));
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    const r = await this._call({
      type: 'load',
      files,
      opts: { detSize: manifest.det_size, maxEdge: manifest.max_edge, detThresh: manifest.det_thresh },
    });
    this.device = r.device;
    this.signature = manifest.signature;
    return r;
  }

  /** {signature, faces, ms} for the exact bytes being uploaded. */
  async analyze(data) {
    if (!this.worker) return null;
    const copy = new Uint8Array(data); // the caller still sends `data`; the worker gets its own
    const r = await this._call({ type: 'analyze', data: copy }, [copy.buffer]);
    return { signature: this.signature, faces: r.faces, ms: r.ms, width: r.width, height: r.height };
  }

  async stop() {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
    this.device = null;
    this.signature = null;
  }
}

module.exports = { FaceService };
