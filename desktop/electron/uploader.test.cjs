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
      let album = null;
      const photos = [];
      for (const p of parts) {
        const name = /filename="([^"]+)"/.exec(p)?.[1];
        const content = p.split('\r\n\r\n').slice(1).join('\r\n\r\n').slice(0, -2);
        if (!name) {
          if (/name="album"/.test(p)) album = Number(content);
          continue;
        }
        const dup = seen.has(content);
        seen.add(content);
        photos.push({ filename: name, ok: true, duplicate: dup, queued: !dup });
      }
      calls.push({ names: photos.map((p) => p.filename), album, length: Number(req.headers['content-length']), bytes: body.length });
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

  // the viewer's copy too: upright, so the face boxes land where the faces are
  const view = await U.preview(f);
  assert.deepEqual([view.width, view.height], [1024, 2048]);
  assert.ok(view.src.startsWith('data:image/jpeg;base64,'));
});

test('face crops come from the original, at boxes given in the sent copy', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'big.jpg');
  // a red "face" at 3000..3400 x 2000..2400 of a 6000x4000 original
  const red = await sharp({ create: { width: 400, height: 400, channels: 3, background: 'red' } }).png().toBuffer();
  await sharp({ create: { width: 6000, height: 4000, channels: 3, background: 'gray' } })
    .composite([{ input: red, left: 3000, top: 2000 }])
    .jpeg()
    .toFile(f);
  const k = 2560 / 6000; // sent at 'fast': 2560 x 1707
  const face = [3000 * k, 2000 * k, 3400 * k, 2400 * k];
  const edge = [2540, 1690, 2560, 1707]; // in the corner: the crop is clamped, not an error
  const crops = await U.faceCrops(f, [face, edge], 2560, 1707);
  assert.equal(crops.length, 2);
  const img = Buffer.from(crops[0].split(',')[1], 'base64');
  const { data, info } = await sharp(img).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [144, 144]);
  const mid = (72 * 144 + 72) * 3;
  assert.ok(data[mid] > 200 && data[mid + 1] < 60, `centre is red: ${[...data.subarray(mid, mid + 3)]}`);
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

test('the first photo goes up alone, and the status counts photos being prepared', async () => {
  const dir = tmpdir();
  for (let i = 0; i < 5; i++) await photo(path.join(dir, `p${i}.jpg`), { shade: 15 + i * 45 });
  const { server, calls, url } = await fakeServer();
  try {
    const analyze = async () => null; // on, but finds nothing
    const up = new U.Uploader({ url, token: 't', folder: dir, batch: 4, workers: 1, analyze });
    const statuses = [];
    up.on('status', (s) => statuses.push(s));
    const done = run(up);
    up.run();
    await done;
    assert.deepEqual(calls.map((c) => c.names.length), [1, 4]);
    for (let n = 0; n < 5; n++) assert.ok(statuses.includes(`Đang nén và nhận diện khuôn mặt ${n}/5 ảnh…`), `${n}/5`);
    assert.equal(statuses.at(-1), 'Đang gửi lên máy chủ…');
  } finally {
    server.close();
  }
});

test('each folder goes up into its own album, a folder inside another left to its own', async () => {
  const root = tmpdir();
  await photo(path.join(root, 'arrival.jpg'), { shade: 20 });
  await photo(path.join(root, 'gala', 'toast.jpg'), { shade: 80 });
  await photo(path.join(root, 'gala', 'dance.jpg'), { shade: 140 });
  const awards = tmpdir();
  await photo(path.join(awards, 'cup.jpg'), { shade: 200 });
  const { server, calls, url } = await fakeServer();
  try {
    const sources = [
      { folder: root, album: null },
      { folder: path.join(root, 'gala'), album: 7, name: 'Gala Dinner' },
      { folder: awards, album: 9, name: 'Lễ Trao Giải' },
      { folder: awards, album: 3 }, // the same folder twice: its first album wins
    ];
    const up = new U.Uploader({ url, token: 't', sources, batch: 4, workers: 1 });
    const done = run(up);
    up.run();
    const r = await done;
    assert.equal(r.fatal, null);

    const into = {};
    for (const c of calls) for (const n of c.names) into[n] = c.album;
    assert.deepEqual(into, { 'arrival.jpg': null, 'dance.jpg': 7, 'toast.jpg': 7, 'cup.jpg': 9 });
    assert.equal(up.stats.uploaded, 4); // the gala photos went once, not also with the root
    assert.deepEqual(r.sent.map((e) => e.album).sort(), ['Gala Dinner', 'Gala Dinner', 'Lễ Trao Giải', null].sort());

    // and each folder remembers its own: a second run sends nothing
    const again = new U.Uploader({ url, token: 't', sources, batch: 4, workers: 1 });
    const done2 = run(again);
    again.run();
    await done2;
    assert.equal(again.stats.skipped, 4);
    assert.equal(calls.length, 3 + 0); // root alone, gala, awards
    assert.deepEqual(await U.scanFolder(root, [path.join(root, 'gala')]), { total: 1, todo: 0, bytes: fs.statSync(path.join(root, 'arrival.jpg')).size });
  } finally {
    server.close();
  }
});

test('an album deleted on the server stops the run with the server\'s reason', async () => {
  const dir = tmpdir();
  await photo(path.join(dir, 'a.jpg'));
  const post = async () => {
    throw new U.HttpError(404, 'Thư mục này không còn trên máy chủ (có thể đã bị xoá).');
  };
  const up = new U.Uploader({ url: 'http://x', token: 't', sources: [{ folder: dir, album: 5 }], post });
  const done = run(up);
  up.run();
  const r = await done;
  assert.equal(r.fatal, 'Thư mục này không còn trên máy chủ (có thể đã bị xoá).');
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
  for (let i = 0; i < 5; i++) await photo(path.join(dir, `p${i}.jpg`), { shade: 10 + i * 40 });
  // the lone first photo goes through; the batch of four after it times out
  const { server, calls, url } = await fakeServer({ fail: [null, 504] });
  try {
    const up = new U.Uploader({ url, token: 't', folder: dir, batch: 4, workers: 1 });
    const done = run(up);
    up.run();
    const r = await done;
    assert.equal(r.fatal, null);
    assert.equal(up.stats.uploaded, 5);
    assert.deepEqual(calls.map((c) => c.names.length), [1, 2, 2]);
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

test('connection JSON: what is exported reads back the same', () => {
  const text = U.serverFile({ url: ' https://ff.example.com/ ', token: ' abc ', event: 'Gala' });
  assert.deepEqual(JSON.parse(text), { url: 'https://ff.example.com', token: 'abc', event: 'Gala' });
  assert.deepEqual(U.readServerFile(text), { url: 'https://ff.example.com', token: 'abc', event: 'Gala' });
  assert.equal(JSON.parse(U.serverFile({ url: 'https://x', token: 't' })).event, undefined, 'no event: left out');
});

test('server errors read in Vietnamese', () => {
  assert.equal(U.describeError(new U.HttpError(401)), 'Sai mã tải lên.');
  assert.match(U.describeError({ cause: { code: 'ECONNREFUSED' } }), /từ chối kết nối/);
});

test('faces found on this machine travel with the batch, one entry per file', async () => {
  const dir = tmpdir();
  for (let i = 0; i < 3; i++) await photo(path.join(dir, `p${i}.jpg`), { shade: 40 + i * 50 });
  const seen = [];
  const fakePost = async (url, token, files) => {
    // what postBatch would put in the "faces" field
    seen.push(...files.map((f) => (f.faces ? { signature: f.faces.signature, n: f.faces.faces.length } : null)));
    return { pending: 0, photos: files.map((f) => ({ ok: true, indexed: Boolean(f.faces) })) };
  };
  let calls = 0;
  const analyze = async (data) => {
    calls += 1;
    if (calls === 2) throw new Error('GPU hiccup'); // must not lose the photo
    const faces = [{ bbox: [1, 2, 3, 4], det_score: 0.9, embedding: 'AA==' }];
    return { signature: 'sig', faces, ms: 5, width: 1200, height: 800 };
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
  // the window gets the boxes (not the embeddings) to draw on the photo
  const drawn = r.sent.filter((e) => e.boxes);
  assert.equal(drawn.length, 2);
  assert.deepEqual(drawn.map((e) => [e.boxes, e.width, e.height]), [
    [[[1, 2, 3, 4]], 1200, 800],
    [[[1, 2, 3, 4]], 1200, 800],
  ]);
  assert.equal(r.sent.find((e) => !e.boxes).faces, null);
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

test('sorting: lists server photos with full thumbnail URLs, files them 500 at a time', async () => {
  const moves = [];
  const deletes = [];
  const queries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-upload-token'] !== 't') return reply(401, { detail: 'Sai mã tải lên.' });
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/photos') {
        queries.push(Object.fromEntries(u.searchParams));
        return reply(200, {
          total: 2,
          photos: [
            { id: 7, path: '/data/uploads/20261015-101500-0a1b2c3d-IMG_0007.jpg', thumb: '/photo?path=a&size=sm', album: 3, faces: 4 },
            { id: 6, path: '/data/photos/old.jpg', thumb: '/photo?path=b&size=sm', album: null, faces: null },
          ],
        });
      }
      if (u.pathname.startsWith('/api/albums/')) {
        const id = Number(u.pathname.split('/').pop());
        if (id === 99) return reply(404, { detail: 'Thư mục này không còn trên máy chủ.' });
        if (req.method === 'DELETE') return reply(200, { deleted: id, unsorted: 3 });
        const { name } = JSON.parse(Buffer.concat(chunks).toString());
        if (name === 'Gala') return reply(409, { detail: 'Đã có thư mục “Gala”.' });
        return reply(200, { id, name, photos: 3 });
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (u.pathname === '/api/photos/delete') {
        deletes.push(body.ids.length);
        return reply(200, { deleted: body.ids.length });
      }
      if (body.album === 99) return reply(404, { detail: 'Thư mục này không còn trên máy chủ.' });
      moves.push(body);
      return reply(200, { moved: body.ids.length });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const page = await U.listPhotos(url, 't', { album: 0, offset: 300, limit: 300 });
    assert.deepEqual(queries[0], { limit: '300', offset: '300', album: '0' });
    assert.equal(page.total, 2);
    assert.deepEqual(page.photos[0], {
      id: 7,
      name: 'IMG_0007.jpg',
      thumb: `${url.slice(0, -1)}/photo?path=a&size=sm`,
      album: 3,
      faces: 4,
    });
    assert.equal(page.photos[1].name, 'old.jpg');

    await U.listPhotos(url, 't');
    assert.equal(queries[1].album, undefined, 'no album: every photo');

    const ids = Array.from({ length: 1201 }, (_, i) => i + 1);
    assert.equal(await U.movePhotos(url, 't', ids, 5), 1201);
    assert.deepEqual(moves.map((m) => [m.ids.length, m.album]), [[500, 5], [500, 5], [201, 5]]);

    await U.movePhotos(url, 't', [1], null);
    assert.equal(moves.at(-1).album, null, 'null takes photos out of every album');

    await assert.rejects(U.movePhotos(url, 't', [1], 99), (e) => e.fromServer && /không còn/.test(e.message));
    await assert.rejects(U.movePhotos(url, 'bad', [1], 5), (e) => e instanceof U.HttpError && e.status === 401);

    assert.equal(await U.deletePhotos(url, 't', ids), 1201);
    assert.deepEqual(deletes, [500, 500, 201], 'deleted in batches the server takes');

    assert.deepEqual(await U.renameAlbum(url, 't', 5, 'Tiệc tối'), { id: 5, name: 'Tiệc tối', photos: 3 });
    await assert.rejects(U.renameAlbum(url, 't', 5, 'Gala'), (e) => e.fromServer && /Đã có/.test(e.message));
    assert.deepEqual(await U.deleteAlbum(url, 't', 5), { deleted: 5, unsorted: 3 });
    await assert.rejects(U.deleteAlbum(url, 't', 99), (e) => e.fromServer && /không còn/.test(e.message));
  } finally {
    server.close();
  }
});
