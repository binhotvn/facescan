'use strict';
/** Download the server's face models once, verified, into a local cache. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

async function getManifest(base, token) {
  const res = await fetch(base.replace(/\/+$/, '') + '/api/models', {
    headers: { 'X-Upload-Token': token },
    signal: AbortSignal.timeout(120_000), // the first call may build the detector copy
  });
  if (res.status === 503 || res.status === 404) return null; // no model on that server
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function download(url, token, dest, expected, onBytes) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'X-Upload-Token': token } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const part = `${dest}.part`;
      const out = fs.createWriteStream(part);
      const hash = crypto.createHash('sha256');
      res.on('data', (c) => {
        hash.update(c);
        onBytes(c.length);
      });
      res.pipe(out);
      out.on('finish', () => {
        if (hash.digest('hex') !== expected) {
          fs.rmSync(part, { force: true });
          return reject(new Error('model file damaged in transit'));
        }
        fs.renameSync(part, dest);
        resolve(dest);
      });
      res.on('error', reject);
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * {manifest, files: {detection, recognition}} with both files on disk, or null
 * when the server offers no model. Files are named by their sha256, so a model
 * change on the server simply downloads the new one.
 */
async function ensureModels({ url, token, dir, onProgress = () => {} }) {
  const manifest = await getManifest(url, token);
  if (!manifest) return null;
  fs.mkdirSync(dir, { recursive: true });
  const roles = Object.entries(manifest.files);
  const total = roles.reduce((n, [, f]) => n + f.size, 0);
  let done = 0;
  const files = {};
  for (const [role, f] of roles) {
    const dest = path.join(dir, `${f.sha256}.onnx`);
    let have = false;
    try {
      have = fs.statSync(dest).size === f.size;
    } catch {
      /* not cached */
    }
    if (!have) {
      await download(`${url.replace(/\/+$/, '')}/api/models/${role}`, token, dest, f.sha256, (n) => {
        done += n;
        onProgress(done / total);
      });
    } else {
      done += f.size;
    }
    files[role] = dest;
  }
  onProgress(1);
  return { manifest, files };
}

module.exports = { ensureModels, getManifest };
