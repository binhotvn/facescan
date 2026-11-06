'use strict';
/**
 * The upload engine: finds photos in one or more folders, compresses them, and
 * pushes them to a FaceScan server's /api/upload in batches. Each folder can
 * feed an album on the server ("Lễ khai mạc", "Gala dinner"...).
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
/**
 * Every photo under root, sorted like upload.py (by full path). Folders in
 * `skip` are left out: another source feeds them into their own album.
 */
async function listImages(root, skip = []) {
  const out = [];
  const skipped = new Set(skip.map((d) => path.resolve(d)));
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
      if (e.isDirectory()) {
        if (!skipped.has(path.resolve(p))) await walk(p);
      } else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
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

/** A viewing copy of a photo for the window: upright, long edge capped. */
async function preview(file, edge = 2048) {
  const { data, info } = await getSharp()(file, { failOn: 'none' })
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { src: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height };
}

/**
 * Each face cut from the original at full resolution, square, with some hair
 * and chin around the box. Boxes are in the sent photo's pixels (w x h), which
 * may be a downscaled copy of the original.
 */
async function faceCrops(file, boxes, w, h, size = 144) {
  const s = getSharp();
  // decode once: every crop comes from the same upright pixels
  const { data, info } = await s(file, { failOn: 'none' }).rotate().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const kx = info.width / w;
  const ky = info.height / h;
  return Promise.all(
    boxes.map(async ([x0, y0, x1, y1]) => {
      const side = Math.max((x1 - x0) * kx, (y1 - y0) * ky) * 1.4;
      // a face at the edge gets a crop clamped to the photo
      const left = Math.min(info.width - 1, Math.max(0, Math.round(((x0 + x1) / 2) * kx - side / 2)));
      const top = Math.min(info.height - 1, Math.max(0, Math.round(((y0 + y1) / 2) * ky - side / 2)));
      const region = {
        left,
        top,
        width: Math.max(1, Math.min(info.width - left, Math.round(side))),
        height: Math.max(1, Math.min(info.height - top, Math.round(side))),
      };
      const crop = await s(data, raw).extract(region).resize(size, size, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
      return `data:image/jpeg;base64,${crop.toString('base64')}`;
    })
  );
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
function postBatch(baseUrl, token, files, { timeoutMs = 900_000, onBytes = () => {}, signal, album = null } = {}) {
  const boundary = `----kapok${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  if (album != null) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="album"\r\n\r\n${album}\r\n`));
  }
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
    if (err.status === 404 && err.detail) return err.detail; // e.g. the album was deleted
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

/**
 * The folders to send: [{folder, album, name}], album null for none. A folder
 * listed twice goes once, under the first album it was given.
 */
function normalizeSources(sources, folder) {
  const list = sources?.length ? sources : [{ folder, album: null }];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const key = path.resolve(s.folder);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ folder: s.folder, album: s.album ?? null, name: s.name || null });
  }
  // each folder leaves out any other source's folder inside it
  for (const s of out) {
    s.skip = out.filter((o) => o !== s && isInside(o.folder, s.folder)).map((o) => o.folder);
  }
  return out;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class Uploader extends EventEmitter {
  /**
   * Events: 'status' (text), 'log' ({level, msg}), 'sent' ({file, name, status,
   * error, thumb, album}), 'stats' (snapshot), 'done' ({fatal}).
   *
   * `sources` lists the folders to send, each into its album; `folder` alone
   * is the same as one source with no album.
   */
  constructor({
    url,
    token,
    folder,
    sources = null,
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
    Object.assign(this, { url, token, watch, quality, workers, batch, retries });
    Object.assign(this, { timeoutMs, interval, settleMs, post, analyze });
    // one state file per folder, the same one upload.py keeps there
    this.sources = normalizeSources(sources, folder).map((s) => ({
      ...s,
      state: new State(path.join(s.folder, STATE_NAME)),
    }));
    this.stats = {
      found: 0,
      queued: 0,
      prepared: 0, // hashed, compressed and (when on) indexed here, ready to send
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

  /**
   * Preparing a photo (and finding its faces here) takes seconds, and nothing
   * goes on the wire until a batch is ready: count it, so the run never looks stuck.
   */
  _progress() {
    if (this.stopped || this.fatal) return;
    const { prepared, queued } = this.stats;
    if (prepared < queued) {
      const work = this.analyze ? 'Đang nén và nhận diện khuôn mặt' : 'Đang nén';
      this.status(`${work} ${prepared}/${queued} ảnh…`);
    } else {
      this.status('Đang gửi lên máy chủ…');
    }
  }

  stop() {
    this.stopped = true;
    if (!this.fatal) this.fatal = 'stopped';
    this.status('Đang dừng…');
  }

  _saveStates() {
    for (const s of this.sources) s.state.save();
  }

  // -- one pass over a list of files ({file, src})
  async _plan(files) {
    const todo = [];
    for (const { file, src } of files) {
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (src.state.knownHash(file, stat)) this._add({ skipped: 1 });
      else todo.push({ file, src, size: stat.size });
    }
    return todo;
  }

  _groups(items) {
    const out = [];
    let cur = [];
    let bytes = 0;
    for (const it of items) {
      // the first photo goes alone: something reaches the server within seconds
      const cap = out.length ? this.batch : 1;
      // one request carries one album
      const full = cur.length >= cap || bytes + it.size > MAX_BATCH_BYTES || it.src !== cur[0]?.src;
      if (cur.length && full) {
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
      this._progress();
      let stat;
      let digest;
      try {
        stat = await fsp.stat(it.file);
        digest = await hashFile(it.file);
      } catch (e) {
        this._add({ failed: 1, prepared: 1 });
        this.log(`${path.basename(it.file)}: ${e.message}`, 'error');
        this.emit('sent', { file: it.file, name: path.basename(it.file), album: it.src.name, status: 'failed', error: e.message });
        continue;
      }
      if (it.src.state.seen(digest) || this.inFlight.has(digest)) {
        it.src.state.notePath(it.file, stat, digest);
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
        this._add({ originalBytes: stat.size, bytesQueued: prep.data.length, prepared: 1 });
      } catch (e) {
        this.inFlight.delete(digest);
        this._add({ failed: 1, prepared: 1 });
        this.log(`${path.basename(it.file)}: không đọc được ảnh`, 'error');
        this.emit('sent', { file: it.file, name: path.basename(it.file), album: it.src.name, status: 'failed', error: 'Không đọc được ảnh' });
      }
    }
    this._progress();
    return ready;
  }

  async _send(items, depth = 0) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this.fatal) return this._release(items);
      let sentNow = 0;
      try {
        const result = await this.post(this.url, this.token, items, {
          album: items[0].src.album,
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
          for (const it of items) this.emit('sent', { ...this._shown(it), status: 'failed', error: why });
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

  /** What the window shows for a photo: its preview, and the faces found here (null if none ran). */
  _shown(it) {
    const f = it.faces;
    return {
      file: it.file,
      name: path.basename(it.file),
      album: it.src.name,
      thumb: it.thumb,
      faces: f ? f.faces.length : null,
      // boxes are in the sent photo's pixels, so they need its size to be drawn
      boxes: f ? f.faces.map((x) => x.bbox) : null,
      width: f?.width ?? null,
      height: f?.height ?? null,
    };
  }

  _record(items, result) {
    // the server answers in the order the files were sent
    const photos = result.photos || [];
    items.forEach((it, i) => {
      const entry = photos[i] || {};
      const name = path.basename(it.file);
      if (entry.ok) {
        it.src.state.mark(it.file, it.stat, it.digest);
        const status = entry.duplicate ? 'duplicate' : 'uploaded';
        this._add(entry.duplicate ? { duplicates: 1 } : { uploaded: 1 });
        if (entry.indexed) this._add({ indexedHere: 1 });
        this.emit('sent', { ...this._shown(it), status, indexedHere: Boolean(entry.indexed) });
      } else {
        this._add({ failed: 1 });
        this.log(`${name}: ${entry.error || 'bị từ chối'}`, 'error');
        this.emit('sent', { ...this._shown(it), status: 'failed', error: entry.error || 'Bị từ chối' });
      }
      this.inFlight.delete(it.digest);
    });
    if (typeof result.pending === 'number') this._add({ pending: result.pending - this.stats.pending });
    items[0]?.src.state.save();
  }

  /** Upload a list of {file, src} with `workers` batches in flight. False if stopped by an error. */
  async runFiles(files) {
    const todo = await this._plan(files);
    if (!todo.length) return !this.fatal;
    this._add({ queued: todo.length });
    this._progress();
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
    this._saveStates();
    return !this.fatal;
  }

  /** Every photo in every source folder, tagged with where it goes. */
  async _list() {
    const out = [];
    for (const src of this.sources) {
      for (const file of await listImages(src.folder, src.skip)) out.push({ file, src });
    }
    return out;
  }

  async run() {
    try {
      this.status(this.sources.length > 1 ? `Đang quét ${this.sources.length} thư mục…` : 'Đang quét thư mục…');
      const files = await this._list();
      this._add({ found: files.length });
      let ok = await this.runFiles(files);
      while (ok && this.watch && !this.stopped) {
        this.status(
          this.sources.length > 1
            ? `Đang theo dõi ${this.sources.length} thư mục, ảnh mới sẽ tự gửi`
            : 'Đang theo dõi thư mục, ảnh mới sẽ tự gửi'
        );
        this.emit('stats', this.snapshot());
        await sleep(this.interval);
        if (this.stopped) break;
        const now = Date.now();
        const fresh = [];
        for (const f of await this._list()) {
          try {
            const st = await fsp.stat(f.file);
            // a file still being copied in must stop growing first
            if (now - st.mtimeMs >= this.settleMs && !f.src.state.knownHash(f.file, st)) fresh.push(f);
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
      this._saveStates();
      clearTimeout(this._statsTimer);
      this.emit('stats', this.snapshot());
      this.emit('done', { fatal: this.fatal === 'stopped' ? null : this.fatal, stopped: this.stopped });
    }
  }
}

// --------------------------------------------------------------------------
// folder summary, server, connection file
// --------------------------------------------------------------------------
async function scanFolder(folder, skip = []) {
  const state = new State(path.join(folder, STATE_NAME));
  let total = 0;
  let todo = 0;
  let bytes = 0;
  for (const f of await listImages(folder, skip)) {
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

async function apiGet(base, p, token, timeoutMs = 15_000, { method = 'GET', body } = {}) {
  const res = await fetch(base.replace(/\/+$/, '') + p, {
    method,
    headers: { 'X-Upload-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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
  // an older server has neither: the window then hides what needs them
  const optional = (p) =>
    apiGet(base, p, token).catch((e) => {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    });
  const [storage, albums] = await Promise.all([optional('/api/admin/storage'), optional('/api/albums')]);
  return { limits, stats, storage, albums: albums?.albums ?? null, unsorted: albums?.unsorted ?? null };
}

/** The server's own words when it has some (a name taken, an album gone), else the usual. */
async function withDetail(call) {
  try {
    return await call();
  } catch (e) {
    const own = e instanceof HttpError && typeof e.detail === 'string' && e.detail;
    if (own && e.status !== 401 && e.status !== 503) throw Object.assign(new Error(e.detail), { fromServer: true });
    throw e;
  }
}

/** Make an album on the server; it answers with {id, name, photos}. */
function createAlbum(base, token, name) {
  return withDetail(() => apiGet(base, '/api/albums', token, 15_000, { method: 'POST', body: { name } }));
}

/**
 * A page of the photos already on the server, newest first: all of them, the
 * ones in no album (`album` 0) or one album's. Thumbnails come back as full URLs.
 */
async function listPhotos(base, token, { album = null, offset = 0, limit = 300 } = {}) {
  const only = album == null ? '' : `&album=${album}`;
  const page = await apiGet(base, `/api/photos?limit=${limit}&offset=${offset}${only}`, token);
  const root = base.replace(/\/+$/, '');
  return {
    total: page.total,
    photos: page.photos.map((p) => ({
      id: p.id,
      name: path.basename(p.path).replace(/^\d{8}-\d{6}-[0-9a-f]{8}-/, ''), // drop the upload stamp
      thumb: root + p.thumb,
      album: p.album ?? null,
      faces: p.faces ?? null,
    })),
  };
}

const MOVE_BATCH = 500; // the server's cap per call

/** File photos into an album (null: into none). How many the server moved. */
function movePhotos(base, token, ids, album) {
  return withDetail(async () => {
    let moved = 0;
    for (let i = 0; i < ids.length; i += MOVE_BATCH) {
      const body = { ids: ids.slice(i, i + MOVE_BATCH), album };
      moved += (await apiGet(base, '/api/photos/album', token, 30_000, { method: 'POST', body })).moved;
    }
    return moved;
  });
}

/** Rename an album; the server answers with {id, name, photos}. */
function renameAlbum(base, token, id, name) {
  return withDetail(() => apiGet(base, `/api/albums/${id}`, token, 15_000, { method: 'PATCH', body: { name } }));
}

/** Remove an album. Its photos stay on the server, in no album. */
function deleteAlbum(base, token, id) {
  return withDetail(() => apiGet(base, `/api/albums/${id}`, token, 15_000, { method: 'DELETE' }));
}

/** Take photos off the server for good. How many the server deleted. */
function deletePhotos(base, token, ids) {
  return withDetail(async () => {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += MOVE_BATCH) {
      const body = { ids: ids.slice(i, i + MOVE_BATCH) };
      deleted += (await apiGet(base, '/api/photos/delete', token, 60_000, { method: 'POST', body })).deleted;
    }
    return deleted;
  });
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

/** The same file the admin page hands out, to pass a connection on to another machine. */
function serverFile({ url, token, event }) {
  const out = { url: String(url || '').trim().replace(/\/+$/, ''), token: String(token || '').trim() };
  if (event) out.event = String(event);
  return `${JSON.stringify(out, null, 2)}\n`;
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
  preview,
  faceCrops,
  postBatch,
  HttpError,
  explain,
  isFatal,
  Uploader,
  scanFolder,
  fetchServer,
  createAlbum,
  renameAlbum,
  deleteAlbum,
  listPhotos,
  movePhotos,
  deletePhotos,
  describeError,
  readServerFile,
  serverFile,
};
