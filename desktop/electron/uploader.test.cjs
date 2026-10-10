'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const U = require('./uploader.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kapok-'));
}

async function photo(file, { w = 1200, h = 800, shade = 120, format = 'jpeg' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: shade, g: 90, b: 60 } } })
    [format]()
    .toFile(file);
  return file;
}

/** A stand-in /api/upload: parses the multipart body, dedupes by content. */
function fakeServer({ fail = [] } = {}) {
  const seen = new Set();
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const status = fail.shift();
      if (status) {
        res.writeHead(status, { 'Content-Type': 'text/html' });
        return res.end('<html>gateway</html>');
      }
      const boundary = req.headers['content-type'].split('boundary=')[1];
      const parts = body.toString('latin1').split(`--${boundary}`).slice(1, -1);
      const photos = parts.map((p) => {
        const name = /filename="([^"]+)"/.exec(p)[1];
        const content = p.split('\r\n\r\n').slice(1).join('\r\n\r\n').slice(0, -2);
        const dup = seen.has(content);
        seen.add(content);
        return { filename: name, ok: true, duplicate: dup, queued: !dup };
      });
      calls.push({ names: photos.map((p) => p.filename), length: Number(req.headers['content-length']), bytes: body.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: photos.filter((p) => !p.duplicate).length, pending: 0, photos }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

function run(up) {
  const events = { sent: [], logs: [] };
  up.on('sent', (e) => events.sent.push(e));
  up.on('log', (e) => events.logs.push(e));
  return new Promise((resolve) => up.on('done', (d) => resolve({ ...d, ...events })));
}

test('lists photos recursively, sorted, skipping hidden files and non-images', async () => {
  const dir = tmpdir();
  await photo(path.join(dir, 'b.jpg'));
  await photo(path.join(dir, 'day1', 'a.JPG'));
  await photo(path.join(dir, '.hidden.jpg'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const files = await U.listImages(dir);
  assert.deepEqual(files.map((f) => path.relative(dir, f)), ['b.jpg', path.join('day1', 'a.JPG')]);
});

test('reads upload.py state files: a folder sent from the command line is skipped', async () => {
  const dir = tmpdir();
  const f = await photo(path.join(dir, 'a.jpg'));
  const st = fs.statSync(f);
  const digest = await U.hashFile(f);
  const real = fs.realpathSync.native(f);
  // exactly what upload.py writes
  fs.writeFileSync(
    path.join(dir, U.STATE_NAME),
    JSON.stringify({ hashes: { [digest]: real }, paths: { [real]: `${(st.mtimeMs / 1000).toFixed(0)}:${st.size}|${digest}` } })
  );
  const s = new U.State(path.join(dir, U.STATE_NAME));
  assert.equal(s.knownHash(f, st), digest);
  assert.equal((await U.scanFolder(dir)).todo, 0);
});

test('compression: upright, long edge capped, much smaller; small JPEGs untouched', async () => {
  const dir = tmpdir();
  const big = await photo(path.join(dir, 'big.jpg'), { w: 6000, h: 4000 });
  const out = await U.prepare(big, 'fast');
  const meta = await sharp(out.data).metadata();
  assert.equal(Math.max(meta.width, meta.height), 2560);
  assert.ok(out.thumb.startsWith('data:image/jpeg;base64,'));

  const small = await photo(path.join(dir, 'small.jpg'), { w: 800, h: 600 });
  assert.deepEqual((await U.prepare(small, 'high')).data, fs.readFileSync(small));

  const png = await photo(path.join(dir, 'shot.png'), { w: 5000, h: 1000, format: 'png' });
  const p = await U.prepare(png, 'high');
  assert.equal(p.name, 'shot.jpg');
  assert.equal((await sharp(p.data).metadata()).format, 'jpeg');

  assert.deepEqual((await U.prepare(big, 'original')).data, fs.readFileSync(big));
});

test('compression applies EXIF orientation', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'rotated.jpg');
  // stored landscape, tagged "rotate 90": upright it is portrait
  await sharp({ create: { width: 6000, height: 3000, channels: 3, background: 'gray' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toFile(f);
  const meta = await sharp((await U.prepare(f, 'fast')).data).metadata();
  assert.deepEqual([meta.width, meta.height], [1280, 2560]);
});

test('uploads a folder in batches, then a second run sends nothing', async () => {
  const dir = tmpdir();
  for (let i = 0; i < 5; i++) await photo(path.join(dir, `p${i}.jpg`), { shade: 20 + i * 30 });
  const { server, calls, url } = await fakeServer();
  try {
    const up = new U.Uploader({ url, token: 't', folder: dir, batch: 2, workers: 2 });
    const done = run(up);
    up.run();
    const r = await done;
    assert.equal(r.fatal, null);
    assert.equal(up.stats.uploaded, 5);
    assert.deepEqual(calls.map((c) => c.names.length).sort(), [1, 2, 2]);
    for (const c of calls) assert.equal(c.length, c.bytes); // exact Content-Length
    assert.equal(r.sent.filter((e) => e.status === 'uploaded' && e.thumb).length, 5);
    assert.equal(up.stats.bytesSent, calls.reduce((n, c) => n + c.bytes, 0));

    const again = new U.Uploader({ url, token: 't', folder: dir });
    const d2 = run(again);
    again.run();
    await d2;
    assert.equal(calls.length, 3);
    assert.equal(again.stats.skipped, 5);
  } finally {
    server.close();
  }
});

test('the same photo twice in one folder goes up once', async () => {
  const dir = tmpdir();
  const a = await photo(path.join(dir, 'a.jpg'));
  fs.mkdirSync(path.join(dir, 'copy'));
  fs.copyFileSync(a, path.join(dir, 'copy', 'a-again.jpg'));
  const { server, calls, url } = await fakeServer();
  try {
    const up = new U.Uploader({ url, token: 't', folder: dir, batch: 4 });
    const done = run(up);
    up.run();
    await done;
    assert.equal(calls.flatMap((c) => c.names).length, 1);
    assert.equal(up.stats.skipped, 1);
  } finally {
    server.close();
  }
});

test('a gateway timeout splits the batch instead of failing it', async () => {
  const dir = tmpdir();
  for (let i = 0; i < 4; i++) await photo(path.join(dir, `p${i}.jpg`), { shade: 10 + i * 40 });
  const { server, calls, url } = await fakeServer({ fail: [504] });
  try {
    const up = new U.Uploader({ url, token: 't', folder: dir, batch: 4, workers: 1 });
    const done = run(up);
    up.run();
    const r = await done;
    assert.equal(r.fatal, null);
    assert.equal(up.stats.uploaded, 4);
    assert.deepEqual(calls.map((c) => c.names.length), [2, 2]);
    assert.ok(r.logs.some((l) => l.msg.includes('chia lô')));
  } finally {
    server.close();
  }
});

test('a wrong token stops the run with a clear reason', async () => {
  const dir = tmpdir();
  await photo(path.join(dir, 'a.jpg'));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Sai mã tải lên.' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const up = new U.Uploader({ url: `http://127.0.0.1:${server.address().port}`, token: 'x', folder: dir });
    const done = run(up);
    up.run();
    const r = await done;
    assert.equal(r.fatal, 'Sai mã tải lên (401).');
    assert.equal((await U.scanFolder(dir)).todo, 1); // nothing marked as sent
  } finally {
    server.close();
  }
});

test('watch mode picks up photos copied in later, until stopped', async () => {
  const dir = tmpdir();
  await photo(path.join(dir, 'first.jpg'), { shade: 30 });
  const { server, calls, url } = await fakeServer();
  try {
    const up = new U.Uploader({ url, token: 't', folder: dir, watch: true, interval: 50, settleMs: 0 });
    const done = run(up);
    up.run();
    const until = async (cond) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    };
    await until(() => calls.length === 1);
    await photo(path.join(dir, 'later.jpg'), { shade: 200 });
    await until(() => calls.length === 2);
    up.stop();
    const r = await done;
    assert.deepEqual(calls.flatMap((c) => c.names), ['first.jpg', 'later.jpg']);
    assert.equal(r.stopped, true);
    assert.equal(r.fatal, null);
  } finally {
    server.close();
  }
});

test('connection files: admin-page format, hand-written keys, BOM; bad ones explained', () => {
  assert.deepEqual(U.readServerFile('{"url":"https://anh.vn/","token":"abc","event":"Ảnh"}'), {
    url: 'https://anh.vn',
    token: 'abc',
    event: 'Ảnh',
  });
  assert.deepEqual(U.readServerFile('﻿{"server":"http://10.0.0.5:8000","upload_token":"t"}'), {
    url: 'http://10.0.0.5:8000',
    token: 't',
  });
  for (const bad of ['{"token":"t"}', '{"url":"ftp://x","token":"t"}', '{"url":"https://x"}', '[1]', 'nope']) {
    assert.throws(() => U.readServerFile(bad));
  }
});

test('server errors read in Vietnamese', () => {
  assert.equal(U.describeError(new U.HttpError(401)), 'Sai mã tải lên.');
  assert.match(U.describeError({ cause: { code: 'ECONNREFUSED' } }), /từ chối kết nối/);
});

test('faces found on this machine travel with the batch, one entry per file', async () => {
  const dir = tmpdir();
  for (let i = 0; i < 3; i++) await photo(path.join(dir, `p${i}.jpg`), { shade: 40 + i * 50 });
  let seen = null;
  const fakePost = async (url, token, files) => {
    // what postBatch would put in the "faces" field
    seen = files.map((f) => (f.faces ? { signature: f.faces.signature, n: f.faces.faces.length } : null));
    return { pending: 0, photos: files.map((f) => ({ ok: true, indexed: Boolean(f.faces) })) };
  };
  let calls = 0;
  const analyze = async (data) => {
    calls += 1;
    if (calls === 2) throw new Error('GPU hiccup'); // must not lose the photo
    return { signature: 'sig', faces: [{ bbox: [1, 2, 3, 4], det_score: 0.9, embedding: 'AA==' }], ms: 5 };
  };
  const up = new U.Uploader({ url: 'http://x', token: 't', folder: dir, batch: 3, workers: 1, post: fakePost, analyze });
  const done = run(up);
  up.run();
  const r = await done;
  assert.equal(r.fatal, null);
  assert.equal(seen.filter(Boolean).length, 2);
  assert.equal(seen.filter((x) => x === null).length, 1);
  assert.equal(up.stats.indexedHere, 2);
  assert.equal(up.stats.uploaded, 3);
});

test('the faces field reaches the server as multipart form data', async () => {
  const dir = tmpdir();
  const f = await photo(path.join(dir, 'a.jpg'));
  let body = '';
  const server = http.createServer((req, res) => {
    req.on('data', (c) => (body += c.toString('latin1')));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: 0, photos: [{ ok: true }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const items = [{ name: 'a.jpg', data: fs.readFileSync(f), faces: { signature: 'sig', faces: [{ bbox: [1, 2, 3, 4] }] } }];
    await U.postBatch(`http://127.0.0.1:${server.address().port}`, 't', items);
    const part = body.split('name="faces"\r\n\r\n')[1].split('\r\n')[0];
    assert.deepEqual(JSON.parse(part), [{ signature: 'sig', faces: [{ bbox: [1, 2, 3, 4] }] }]);
  } finally {
    server.close();
  }
});
