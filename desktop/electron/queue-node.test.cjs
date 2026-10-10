'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { QueueNode } = require('./queue-node.cjs');

/** A hub with `n` photos waiting; records the results it is sent. */
function hub(n) {
  const waiting = Array.from({ length: n }, (_, i) => i + 1);
  const results = [];
  const tokens = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/api/worker/')) tokens.push(req.headers['x-worker-token']);
      const json = (o) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/api/worker/claim') {
        const { limit } = JSON.parse(body);
        const jobs = waiting.splice(0, limit).map((id) => ({ id, photo: `/api/worker/photo/${id}` }));
        return json({ jobs, lease_seconds: 300 });
      }
      if (req.url.startsWith('/api/worker/photo/')) {
        res.writeHead(200);
        return res.end(Buffer.from(`photo-${req.url.split('/').pop()}`));
      }
      if (req.url === '/api/worker/result') {
        results.push(JSON.parse(body));
        return json({ stored: true });
      }
      if (req.url === '/api/stats') return json({ pending: waiting.length });
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, results, tokens, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

test('node mode drains the hub queue with faces found here', async () => {
  const { server, results, tokens, url } = await hub(5);
  try {
    const node = new QueueNode({
      url,
      token: 'upl0ad',
      name: 'kapok-test',
      analyze: async (data) => ({
        signature: 'sig',
        width: 100,
        height: 80,
        ms: 3,
        faces: [{ bbox: [1, 2, 3, 4], det_score: 0.9, embedding: Buffer.from(data).toString('base64') }],
      }),
    });
    const statuses = [];
    node.on('status', (s) => statuses.push(s));
    node.on('stats', (s) => s.processed === 5 && setTimeout(() => node.stop(), 50));
    await node.run();
    assert.equal(results.length, 5);
    assert.deepEqual(results.map((r) => r.id), [1, 2, 3, 4, 5]);
    assert.ok(results.every((r) => r.signature === 'sig' && r.worker === 'kapok-test' && r.faces.length === 1));
    assert.ok(tokens.every((t) => t === 'upl0ad'));
    assert.equal(node.stats.processed, 5);
  } finally {
    server.close();
  }
});

test('an idle node says the queue is empty instead of looking stuck', async () => {
  const { server, url } = await hub(0);
  try {
    const node = new QueueNode({ url, token: 't', name: 'n', analyze: async () => null });
    const seen = [];
    node.on('status', (s) => {
      seen.push(s);
      if (/trống/.test(s)) node.stop();
    });
    node.on('queue', (p) => seen.push(`queue=${p}`));
    await node.run();
    assert.ok(seen.includes('queue=0'));
    assert.ok(seen.some((s) => /Hàng chờ của máy chủ đang trống/.test(s)));
  } finally {
    server.close();
  }
});
