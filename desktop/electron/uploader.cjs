'use strict';
/**
 * The upload engine: finds photos in a folder, compresses them, and pushes them
 * to a FaceScan server's /api/upload in batches.
 *
 * Kept free of Electron so it can be tested with plain `node --test`.
 *
 * It shares upload.py's state file (.facescan-upload.json, same layout), so a
 * folder already sent with the command-line client is not sent again, and the
 * other way round.
 *
 * Smoothness is the point:
 *  - compression runs in libvips (sharp) on its own thread pool, never on the
 *    event loop, so the window stays responsive;
 *  - each worker prepares its next batch (hash + compress) while the others
 *    are on the wire, so the network is never idle waiting for the CPU;
 *  - progress counts bytes actually written to the socket, not finished files.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const STATE_NAME = '.facescan-upload.json';
// One request is built in memory and proxies cap request bodies (Cloudflare's
// free tier at 100MB). Same budget as upload.py.
const MAX_BATCH_BYTES = 48 * 1024 * 1024;
const RETRY_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Compression presets. `edge` caps the long side; null sends the original file. */
const QUALITY = {
  original: { edge: null, quality: null, label: 'Gốc (không nén)' },
  high: { edge: 4096, quality: 88, label: 'Cao · 4096px' },
  fast: { edge: 2560, quality: 82, label: 'Nhanh · 2560px' },
};

// --------------------------------------------------------------------------
// files
// --------------------------------------------------------------------------
/** Every photo under root, sorted like upload.py (by full path). */
async function listImages(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await walk(root);
  return out.sort();
}

/** upload.py's file_key: whole-second mtime and size. */
function fileKey(stat) {
  return `${(stat.mtimeMs / 1000).toFixed(0)}:${stat.size}`;
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p, { highWaterMark: 1 << 20 })
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// --------------------------------------------------------------------------
// state: what has already gone up (upload.py's format)
// --------------------------------------------------------------------------
class State {
  constructor(file) {
    this.file = file;
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run, or a damaged file: start clean */
    }
    this.hashes = raw.hashes || {}; // hash -> first path seen
    this.paths = raw.paths || {}; // path -> "key|hash"
    this.dirty = false;
  }

  /** Cached hash for an unchanged file, else null (caller must hash). */
  knownHash(p, stat) {
    const entry = this.paths[realpath(p)];
    if (!entry) return null;
    const i = entry.indexOf('|');
    return entry.slice(0, i) === fileKey(stat) ? entry.slice(i + 1) : null;
  }

  seen(digest) {
    return Object.prototype.hasOwnProperty.call(this.hashes, digest);
  }

  mark(p, stat, digest) {
    const real = realpath(p);
    if (!this.seen(digest)) this.hashes[digest] = real;
    this.paths[real] = `${fileKey(stat)}|${digest}`;
    this.dirty = true;
  }

  notePath(p, stat, digest) {
    this.paths[realpath(p)] = `${fileKey(stat)}|${digest}`;
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ hashes: sorted(this.hashes), paths: sorted(this.paths) }, null, 1));
    fs.renameSync(tmp, this.file); // atomic: quitting mid-write never leaves half a file
    this.dirty = false;
  }
}

// --------------------------------------------------------------------------
// compression
// --------------------------------------------------------------------------
let sharp = null;
function getSharp() {
  if (!sharp) {
    sharp = require('sharp');
    sharp.cache(false); // every photo is read once; caching only holds memory
  }
  return sharp;
}

/**
 * The bytes to send for one photo, plus a small preview.
 * Upright (EXIF orientation applied), long edge capped, re-encoded with
 * mozjpeg. A photo already smaller than the cap and already a JPEG is sent
 * untouched: re-encoding it would only lose quality.
 */
async function prepare(file, preset, { thumbSize = 320 } = {}) {
  const q = QUALITY[preset] || QUALITY.high;
  const s = getSharp();
  const ext = path.extname(file).toLowerCase();
  let data;
  let name = path.basename(file);

  if (q.edge) {
    const img = s(file, { failOn: 'none', sequentialRead: true });
    const meta = await img.metadata();
    const w = meta.autoOrient?.width ?? meta.width ?? 0;
    const h = meta.autoOrient?.height ?? meta.height ?? 0;
    const small = Math.max(w, h) <= q.edge;
    if (small && (ext === '.jpg' || ext === '.jpeg') && !(meta.orientation > 1)) {
      data = await fsp.readFile(file);
    } else {
      data = await img
        .rotate()
        .resize({ width: q.edge, height: q.edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: q.quality, mozjpeg: true })
        .toBuffer();
      if (ext !== '.jpg' && ext !== '.jpeg') name = name.replace(/\.[^.]+$/, '.jpg');
    }
  } else {
    data = await fsp.readFile(file);
  }

  let thumb = null;
  try {
    // from the (usually much smaller) bytes being sent: nearly free
    const t = await s(data, { failOn: 'none' })
      .rotate()
      .resize(thumbSize, thumbSize, { fit: 'cover' })
      .jpeg({ quality: 72 })
      .toBuffer();
    thumb = `data:image/jpeg;base64,${t.toString('base64')}`;
  } catch {
    /* a preview is never worth an error */
  }
  return { data, name, thumb };
}

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, detail) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

/**
 * POST one multipart batch. Written by hand rather than with fetch so the
 * Content-Length is exact (some proxies refuse chunked uploads) and progress
 * can count bytes as the socket takes them.
 */
function postBatch(baseUrl, token, files, { timeoutMs = 900_000, onBytes = () => {}, signal } = {}) {
  const boundary = `----kapok${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const f of files) {
    const type = f.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const safe = f.name.replace(/["\r\n]/g, '_');
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safe}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`
      ),
      f.data,
      Buffer.from('\r\n')
    );
  }
  if (files.some((f) => f.faces)) {
    // faces found on this machine, one entry per file (null where none ran)
    const faces = files.map((f) => (f.faces ? { signature: f.faces.signature, faces: f.faces.faces } : null));
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="faces"\r\n\r\n`),
      Buffer.from(JSON.stringify(faces)),
      Buffer.from('\r\n')
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const length = parts.reduce((n, b) => n + b.length, 0);
  const url = new URL(baseUrl.replace(/\/+$/, '') + '/api/upload');
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        agent: agents[url.protocol],
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': length,
          'X-Upload-Token': token,
        },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            /* proxy error pages are HTML */
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && body) resolve(body);
          else reject(new HttpError(res.statusCode, body?.detail || ''));
        });
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    // write piecewise so progress follows the socket, not the buffer copy
    let i = 0;
    const pump = () => {
      while (i < parts.length) {
        const chunk = parts[i++];
        const ok = req.write(chunk, () => onBytes(chunk.length));
        if (!ok) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

function explain(err) {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'Sai mã tải lên (401).';
    if (err.status === 413) return 'Lô ảnh quá lớn (413).';
    if (err.status === 503 && err.detail) return `Máy chủ tắt tải ảnh lên: ${err.detail}`;
    return err.message;
  }
  if (err?.code === 'ETIMEDOUT') return 'Quá thời gian chờ máy chủ';
  if (err?.code === 'ECONNREFUSED') return 'Máy chủ từ chối kết nối';
  if (err?.code === 'ENOTFOUND') return 'Không tìm thấy máy chủ';
  if (err?.code === 'ECONNRESET') return 'Mất kết nối';
  return err?.message || String(err);
}

/** A 503 from our own app means uploads are off; from a proxy it is transient. */
function isFatal(err) {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 503) return Boolean(err.detail);
  return !RETRY_CODES.has(err.status);
}

// --------------------------------------------------------------------------
// the uploader
// --------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Uploader extends EventEmitter {
  /**
   * Events: 'status' (text), 'log' ({level, msg}), 'sent' ({file, name, status,
   * error, thumb}), 'stats' (snapshot), 'done' ({fatal}).
   */
  constructor({
    url,
    token,
    folder,
    watch = false,
    quality = 'high',
    workers = 3,
    batch = 4,
    retries = 2,
    timeoutMs = 900_000,
    interval = 3000,
    settleMs = 1500,
    post = postBatch,
    analyze = null, // async (bytes) => {signature, faces, ms}: index on this machine
  }) {
    super();
    Object.assign(this, { url, token, folder, watch, quality, workers, batch, retries });
    Object.assign(this, { timeoutMs, interval, settleMs, post, analyze });
    this.state = new State(path.join(folder, STATE_NAME));
    this.stats = {
      found: 0,
      queued: 0,
      uploaded: 0,
      duplicates: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      bytesSent: 0,
      bytesQueued: 0,
      originalBytes: 0,
      facesFound: 0, // faces this machine found
      analyzed: 0, // photos indexed here
      analyzeMs: 0,
      indexedHere: 0, // photos the server took with our faces, skipping its queue
      started: Date.now(),
    };
    this.fatal = null;
    this.stopped = false;
    this.inFlight = new Set();
    this.controllers = new Set();
    this._statsTimer = null;
  }

  // -- reporting
  log(msg, level = 'info') {
    this.emit('log', { level, msg, at: Date.now() });
  }

  status(text) {
    this.emit('status', text);
  }

  _add(fields) {
    for (const [k, v] of Object.entries(fields)) this.stats[k] += v;
    if (!this._statsTimer) {
      // at most ~10 updates a second: the window repaints, the CPU does not notice
      this._statsTimer = setTimeout(() => {
        this._statsTimer = null;
        this.emit('stats', this.snapshot());
      }, 100);
    }
  }

  snapshot() {
    const s = this.stats;
    const elapsed = (Date.now() - s.started) / 1000;
    const done = s.uploaded + s.duplicates + s.failed;
    return { ...s, done, rate: elapsed > 0.5 ? done / elapsed : 0, mbps: elapsed > 0.5 ? s.bytesSent / elapsed / 1e6 : 0 };
  }

  stop() {
    this.stopped = true;
    if (!this.fatal) this.fatal = 'stopped';
    this.status('Đang dừng…');
  }

  // -- one pass over a list of files
  async _plan(files) {
    const todo = [];
    for (const f of files) {
      let stat;
      try {
        stat = await fsp.stat(f);
      } catch {
        continue;
      }
      if (this.state.knownHash(f, stat)) this._add({ skipped: 1 });
      else todo.push({ file: f, size: stat.size });
    }
    return todo;
  }

  _groups(items) {
    const out = [];
    let cur = [];
    let bytes = 0;
    for (const it of items) {
      if (cur.length && (cur.length >= this.batch || bytes + it.size > MAX_BATCH_BYTES)) {
        out.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(it);
      bytes += it.size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Hash and compress a batch, dropping anything already sent. */
  async _prepare(group) {
    const ready = [];
    for (const it of group) {
      if (this.fatal) return ready;
      let stat;
      let digest;
      try {
        stat = await fsp.stat(it.file);
        digest = await hashFile(it.file);
      } catch (e) {
        this._add({ failed: 1 });
        this.log(`${path.basename(it.file)}: ${e.message}`, 'error');
        this.emit('sent', { file: it.file, name: path.basename(it.file), status: 'failed', error: e.message });
        continue;
      }
      if (this.state.seen(digest) || this.inFlight.has(digest)) {
        this.state.notePath(it.file, stat, digest);
        this._add({ skipped: 1, queued: -1 });
        continue;
      }
      this.inFlight.add(digest);
      try {
        const prep = await prepare(it.file, this.quality);
        let faces = null;
        if (this.analyze) {
          try {
            faces = await this.analyze(prep.data);
            if (faces) this._add({ analyzed: 1, facesFound: faces.faces.length, analyzeMs: faces.ms || 0 });
          } catch (e) {
            this.log(`${path.basename(it.file)}: nhận diện trên máy lỗi (${e.message}), để máy chủ làm`, 'error');
          }
        }
        ready.push({ ...it, stat, digest, ...prep, faces });
        this._add({ originalBytes: stat.size, bytesQueued: prep.data.length });
      } catch (e) {
        this.inFlight.delete(digest);
        this._add({ failed: 1 });
        this.log(`${path.basename(it.file)}: không đọc được ảnh`, 'error');
        this.emit('sent', { file: it.file, name: path.basename(it.file), status: 'failed', error: 'Không đọc được ảnh' });
      }
    }
    return ready;
  }

  async _send(items, depth = 0) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this.fatal) return this._release(items);
      let sentNow = 0;
      try {
        const result = await this.post(this.url, this.token, items, {
          timeoutMs: this.timeoutMs,
          onBytes: (n) => {
            sentNow += n;
            this._add({ bytesSent: n });
          },
        });
        this._record(items, result);
        return;
      } catch (err) {
        this._add({ bytesSent: -sentNow }); // that attempt's bytes did not land
        const why = explain(err);
        if (isFatal(err)) {
          this.fatal = why;
          this.log(why, 'error');
          return this._release(items);
        }
        const splittable = items.length > 1 && depth < 3;
        const slow = (err instanceof HttpError && [408, 502, 504].includes(err.status)) || err?.code === 'ETIMEDOUT';
        if (slow && splittable) {
          // a gateway timeout means the batch was too slow for the proxy: halve it
          this.log(`${why}, chia lô ${items.length} ảnh làm đôi`, 'error');
          this.batch = Math.max(1, Math.min(this.batch, Math.floor(items.length / 2)));
          const half = Math.floor(items.length / 2);
          await this._send(items.slice(0, half), depth + 1);
          await this._send(items.slice(half), depth + 1);
          return;
        }
        if (attempt === this.retries) {
          this._add({ failed: items.length });
          this.log(`Bỏ qua ${items.length} ảnh: ${why}`, 'error');
          for (const it of items) {
            this.emit('sent', { file: it.file, name: path.basename(it.file), status: 'failed', error: why, thumb: it.thumb });
          }
          return this._release(items);
        }
        const wait = Math.min(2 ** attempt, 30);
        this.log(`Thử lại sau ${wait} giây (${why})`, 'error');
        await sleep(wait * 1000);
      }
    }
  }

  _release(items) {
    for (const it of items) this.inFlight.delete(it.digest);
  }

  _record(items, result) {
    // the server answers in the order the files were sent
    const photos = result.photos || [];
    items.forEach((it, i) => {
      const entry = photos[i] || {};
      const name = path.basename(it.file);
      if (entry.ok) {
        this.state.mark(it.file, it.stat, it.digest);
        const status = entry.duplicate ? 'duplicate' : 'uploaded';
        this._add(entry.duplicate ? { duplicates: 1 } : { uploaded: 1 });
        if (entry.indexed) this._add({ indexedHere: 1 });
        const faces = it.faces ? it.faces.faces.length : null;
        this.emit('sent', { file: it.file, name, status, thumb: it.thumb, faces, indexedHere: Boolean(entry.indexed) });
      } else {
        this._add({ failed: 1 });
        this.log(`${name}: ${entry.error || 'bị từ chối'}`, 'error');
        this.emit('sent', { file: it.file, name, status: 'failed', error: entry.error || 'Bị từ chối', thumb: it.thumb });
      }
      this.inFlight.delete(it.digest);
    });
    if (typeof result.pending === 'number') this._add({ pending: result.pending - this.stats.pending });
    this.state.save();
  }

  /** Upload a list of files with `workers` batches in flight. False if stopped by an error. */
  async runFiles(files) {
    const todo = await this._plan(files);
    if (!todo.length) return !this.fatal;
    this._add({ queued: todo.length });
    this.status(`Đang gửi ${todo.length} ảnh…`);
    const groups = this._groups(todo);
    let next = 0;
    // Each worker prepares its next batch while the others upload theirs:
    // compression and network overlap instead of taking turns.
    const worker = async () => {
      while (next < groups.length && !this.fatal) {
        const group = groups[next++];
        const ready = await this._prepare(group);
        if (ready.length && !this.fatal) await this._send(ready);
        else this._release(ready);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.workers, groups.length) }, worker));
    this.state.save();
    return !this.fatal;
  }

  async run() {
    try {
      this.status('Đang quét thư mục…');
      const files = await listImages(this.folder);
      this._add({ found: files.length });
      let ok = await this.runFiles(files);
      while (ok && this.watch && !this.stopped) {
        this.status(`Đang theo dõi thư mục, ảnh mới sẽ tự gửi`);
        this.emit('stats', this.snapshot());
        await sleep(this.interval);
        if (this.stopped) break;
        const now = Date.now();
        const fresh = [];
        for (const f of await listImages(this.folder)) {
          try {
            const st = await fsp.stat(f);
            // a file still being copied in must stop growing first
            if (now - st.mtimeMs >= this.settleMs && !this.state.knownHash(f, st)) fresh.push(f);
          } catch {
            /* vanished between listing and stat */
          }
        }
        if (fresh.length) ok = await this.runFiles(fresh);
      }
    } catch (e) {
      this.fatal = this.fatal || e.message;
      this.log(`Lỗi: ${e.message}`, 'error');
    } finally {
      this.state.save();
      clearTimeout(this._statsTimer);
      this.emit('stats', this.snapshot());
      this.emit('done', { fatal: this.fatal === 'stopped' ? null : this.fatal, stopped: this.stopped });
    }
  }
}

// --------------------------------------------------------------------------
// folder summary, server, connection file
// --------------------------------------------------------------------------
async function scanFolder(folder) {
  const state = new State(path.join(folder, STATE_NAME));
  let total = 0;
  let todo = 0;
  let bytes = 0;
  for (const f of await listImages(folder)) {
    let st;
    try {
      st = await fsp.stat(f);
    } catch {
      continue;
    }
    total += 1;
    bytes += st.size;
    if (!state.knownHash(f, st)) todo += 1;
  }
  return { total, todo, bytes };
}

async function apiGet(base, p, token, timeoutMs = 15_000) {
  const res = await fetch(base.replace(/\/+$/, '') + p, {
    headers: { 'X-Upload-Token': token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).detail || '';
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, detail);
  }
  return res.json();
}

function describeError(e) {
  if (e instanceof HttpError) {
    if (e.status === 401) return 'Sai mã tải lên.';
    if (e.status === 503) return 'Máy chủ chưa bật tải ảnh lên (chưa đặt FACESCAN_UPLOAD_TOKEN).';
    if (e.status === 404) return 'Địa chỉ này không phải máy chủ ảnh (hoặc phiên bản cũ).';
    return `Máy chủ báo lỗi HTTP ${e.status}.`;
  }
  if (e?.name === 'TimeoutError') return 'Máy chủ không trả lời (quá thời gian).';
  const code = e?.cause?.code || e?.code;
  if (code === 'ECONNREFUSED') return 'Máy chủ từ chối kết nối. Kiểm tra địa chỉ và cổng.';
  if (code === 'ENOTFOUND') return 'Không tìm thấy máy chủ. Kiểm tra địa chỉ.';
  return `Không kết nối được máy chủ (${e?.message || e}).`;
}

async function fetchServer(base, token) {
  const [limits, stats] = await Promise.all([
    apiGet(base, '/api/upload/check', token),
    apiGet(base, '/api/stats', token),
  ]);
  let storage = null;
  try {
    storage = await apiGet(base, '/api/admin/storage', token);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e; // an older server has none
  }
  return { limits, stats, storage };
}

/** A connection file from the admin page: {"url": ..., "token": ...}. */
function readServerFile(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, '')); // Notepad saves a BOM
  } catch {
    throw new Error('File không phải JSON hợp lệ.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('File cấu hình phải là một đối tượng JSON.');
  }
  const url = String(data.url || data.server || '').trim();
  const token = String(data.token || data.upload_token || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('File cấu hình thiếu địa chỉ máy chủ (url).');
  if (!token) throw new Error('File cấu hình thiếu mã tải lên (token).');
  const out = { url: url.replace(/\/+$/, ''), token };
  if (data.event) out.event = String(data.event);
  return out;
}

module.exports = {
  IMAGE_EXTS,
  STATE_NAME,
  QUALITY,
  listImages,
  fileKey,
  hashFile,
  State,
  prepare,
  postBatch,
  HttpError,
  explain,
  isFatal,
  Uploader,
  scanFolder,
  fetchServer,
  describeError,
  readServerFile,
};
