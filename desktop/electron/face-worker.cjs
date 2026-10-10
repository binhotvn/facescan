'use strict';
/** Runs the face model off the main thread: the window and uploads never wait on it. */
const { parentPort } = require('node:worker_threads');
const { FaceEngine } = require('./face.cjs');

let engine = null;

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'load') {
      engine = await FaceEngine.load(msg.files, msg.opts);
      parentPort.postMessage({ id: msg.id, ok: true, device: engine.device, accelerated: engine.accelerated });
    } else if (msg.type === 'analyze') {
      const t0 = performance.now();
      const r = await engine.analyze(Buffer.from(msg.data));
      const faces = r.faces.map((f) => ({
        bbox: f.bbox,
        det_score: f.det_score,
        embedding: Buffer.from(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength).toString('base64'),
      }));
      parentPort.postMessage({ id: msg.id, ok: true, faces, width: r.width, height: r.height, ms: performance.now() - t0 });
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: e.message });
  }
});
