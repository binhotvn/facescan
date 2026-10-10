'use strict';
/**
 * Face detection + embedding on this machine, matching the server exactly.
 *
 * The server (facescan/engine.py + InsightFace buffalo_l) does:
 *   1. cap the photo's long edge at max_edge (2560)
 *   2. SCRFD (det_10g) at det_size 1024: fit top-left into a 1024x1024 canvas,
 *      (px - 127.5) / 128, RGB; threshold 0.5, NMS 0.4
 *   3. align each face to the ArcFace 112x112 template from its 5 landmarks
 *      (least-squares similarity transform, bilinear warp)
 *   4. ArcFace (w600k_r50): (px - 127.5) / 127.5, RGB -> 512-d, L2-normalised
 *   5. boxes are mapped back to the uploaded image's own pixels
 * This file repeats those steps so a face found here is interchangeable with a
 * face the server finds itself. The models are the server's own files.
 *
 * Inference runs through ONNX Runtime on the best accelerator available:
 * CoreML (Apple GPU / Neural Engine) on macOS, DirectML (any DirectX 12 GPU:
 * NVIDIA, AMD, Intel) on Windows, CPU everywhere else.
 */
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const ARCFACE_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

function providerPlan(platform = process.platform) {
  if (platform === 'darwin') return [['coreml', 'cpu'], 'Apple GPU / Neural Engine (CoreML)'];
  if (platform === 'win32') return [['dml', 'cpu'], 'GPU (DirectML)'];
  return [['cpu'], 'CPU'];
}

async function createSession(file, preferred) {
  // try the accelerator first; a GPU driver problem must never stop the app
  for (const eps of [preferred, ['cpu']]) {
    try {
      const session = await ort.InferenceSession.create(file, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });
      return { session, accelerated: eps[0] !== 'cpu' };
    } catch (e) {
      if (eps[0] === 'cpu') throw e;
    }
  }
  throw new Error('unreachable');
}

// --------------------------------------------------------------------------
// pixels
// --------------------------------------------------------------------------
/** Decode to RGB with the long edge capped, as engine.downscale does. */
async function decode(data, maxEdge) {
  const img = sharp(data, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const ow = meta.autoOrient?.width ?? meta.width;
  const oh = meta.autoOrient?.height ?? meta.height;
  const scale = maxEdge / Math.max(ow, oh);
  let pipeline = img.removeAlpha().toColourspace('srgb');
  let w = ow;
  let h = oh;
  if (scale < 1) {
    w = Math.round(ow * scale);
    h = Math.round(oh * scale);
    pipeline = pipeline.resize(w, h, { kernel: 'linear', fit: 'fill', fastShrinkOnLoad: false });
  }
  const { data: px, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { px, w: info.width, h: info.height, scale: scale < 1 ? w / ow : 1, ow, oh };
}

/**
 * The SCRFD input: the image fitted top-left into size x size (cv2.resize,
 * INTER_LINEAR), zero-padded, normalised, channels-first.
 */
function detBlob({ px, w, h }, size) {
  const imRatio = h / w;
  let nw;
  let nh;
  if (imRatio > 1) {
    nh = size;
    nw = Math.trunc(nh / imRatio);
  } else {
    nw = size;
    nh = Math.trunc(nw * imRatio);
  }
  const detScale = nh / h;
  const plane = size * size;
  const blob = new Float32Array(3 * plane).fill((0 - 127.5) / 128); // padding is black
  const sx = w / nw;
  const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let y0 = Math.floor(fy);
    if (y0 >= h - 1) {
      y0 = h - 1;
      fy = y0;
    }
    const y1 = Math.min(y0 + 1, h - 1);
    const wy = fy - y0;
    for (let x = 0; x < nw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      if (x0 >= w - 1) {
        x0 = w - 1;
        fx = x0;
      }
      const x1 = Math.min(x0 + 1, w - 1);
      const wx = fx - x0;
      const a = (y0 * w + x0) * 3;
      const b = (y0 * w + x1) * 3;
      const c = (y1 * w + x0) * 3;
      const d = (y1 * w + x1) * 3;
      const o = y * size + x;
      for (let ch = 0; ch < 3; ch++) {
        const top = px[a + ch] + (px[b + ch] - px[a + ch]) * wx;
        const bot = px[c + ch] + (px[d + ch] - px[c + ch]) * wx;
        const v = Math.round(top + (bot - top) * wy); // cv2.resize yields uint8
        blob[ch * plane + o] = (v - 127.5) / 128;
      }
    }
  }
  return { blob, detScale };
}

// --------------------------------------------------------------------------
// SCRFD decode
// --------------------------------------------------------------------------
function decodeScrfd(outs, names, size, threshold) {
  const strides = [8, 16, 32];
  const fmc = 3;
  const cand = [];
  for (let i = 0; i < fmc; i++) {
    const stride = strides[i];
    const scores = outs[names[i]].data;
    const boxes = outs[names[i + fmc]].data;
    const kps = outs[names[i + fmc * 2]].data;
    const fw = Math.floor(size / stride);
    const anchors = scores.length / (fw * Math.floor(size / stride));
    for (let k = 0; k < scores.length; k++) {
      const s = scores[k];
      if (s < threshold) continue;
      const cell = Math.floor(k / anchors);
      const cx = (cell % fw) * stride;
      const cy = Math.floor(cell / fw) * stride;
      const bb = [
        cx - boxes[k * 4] * stride,
        cy - boxes[k * 4 + 1] * stride,
        cx + boxes[k * 4 + 2] * stride,
        cy + boxes[k * 4 + 3] * stride,
      ];
      const pts = [];
      for (let p = 0; p < 5; p++) pts.push([cx + kps[k * 10 + p * 2] * stride, cy + kps[k * 10 + p * 2 + 1] * stride]);
      cand.push({ score: s, bbox: bb, kps: pts });
    }
  }
  return cand;
}

function nms(dets, thresh = 0.4) {
  const order = dets.slice().sort((a, b) => b.score - a.score); // stable, like np.argsort(kind='stable')
  const area = (d) => (d.bbox[2] - d.bbox[0] + 1) * (d.bbox[3] - d.bbox[1] + 1);
  const keep = [];
  const dropped = new Set();
  for (let i = 0; i < order.length; i++) {
    if (dropped.has(i)) continue;
    const a = order[i];
    keep.push(a);
    for (let j = i + 1; j < order.length; j++) {
      if (dropped.has(j)) continue;
      const b = order[j];
      const w = Math.max(0, Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]) + 1);
      const h = Math.max(0, Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]) + 1);
      const inter = w * h;
      if (inter / (area(a) + area(b) - inter) > thresh) dropped.add(j);
    }
  }
  return keep;
}

// --------------------------------------------------------------------------
// alignment
// --------------------------------------------------------------------------
/** Least-squares similarity transform src -> dst (skimage's, without reflection). */
function similarity(src, dst) {
  const n = src.length;
  let msx = 0;
  let msy = 0;
  let mdx = 0;
  let mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i][0];
    msy += src[i][1];
    mdx += dst[i][0];
    mdy += dst[i][1];
  }
  msx /= n;
  msy /= n;
  mdx /= n;
  mdy /= n;
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - msx;
    const ys = src[i][1] - msy;
    const xd = dst[i][0] - mdx;
    const yd = dst[i][1] - mdy;
    num1 += xs * xd + ys * yd;
    num2 += xs * yd - ys * xd;
    den += xs * xs + ys * ys;
  }
  const a = num1 / den;
  const b = num2 / den;
  return [a, -b, mdx - (a * msx - b * msy), b, a, mdy - (b * msx + a * msy)];
}

/** cv2.warpAffine(img, M, (112, 112), borderValue=0) into an ArcFace blob slot. */
function warpInto(blob, offset, { px, w, h }, M, size = 112) {
  const [a, b, c, d, e, f] = M;
  const det = a * e - b * d;
  // inverse map: destination pixel -> source position
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  const ic = -(ia * c + ib * f);
  const ifo = -(id * c + ie * f);
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = ia * x + ib * y + ic;
      const sy = id * x + ie * y + ifo;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const wx = sx - x0;
      const wy = sy - y0;
      const o = y * size + x;
      for (let ch = 0; ch < 3; ch++) {
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : px[(yy * w + xx) * 3 + ch]);
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * wx;
        const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * wx;
        const v = Math.round(top + (bot - top) * wy);
        blob[offset + ch * plane + o] = (v - 127.5) / 127.5;
      }
    }
  }
}

// --------------------------------------------------------------------------
// the engine
// --------------------------------------------------------------------------
class FaceEngine {
  /** files: {detection, recognition} paths; opts from the server's manifest. */
  static async load(files, { detSize = 1024, maxEdge = 2560, detThresh = 0.5, platform } = {}) {
    const [eps, label] = providerPlan(platform);
    const det = await createSession(files.detection, eps);
    const rec = await createSession(files.recognition, eps);
    const eng = new FaceEngine();
    Object.assign(eng, { det: det.session, rec: rec.session, detSize, maxEdge, detThresh });
    eng.accelerated = det.accelerated && rec.accelerated;
    eng.device = eng.accelerated ? label : 'CPU';
    // CoreML/DirectML compile on the first run: pay that now, not on the first photo
    const zeros = (shape) => new ort.Tensor('float32', new Float32Array(shape.reduce((a, b) => a * b)), shape);
    await eng.det.run({ [eng.det.inputNames[0]]: zeros([1, 3, detSize, detSize]) });
    await eng.rec.run({ [eng.rec.inputNames[0]]: zeros([1, 3, 112, 112]) });
    await eng.rec.run({ [eng.rec.inputNames[0]]: zeros([6, 3, 112, 112]) });
    return eng;
  }

  /**
   * Faces in one encoded photo (the exact bytes being uploaded), in that
   * photo's pixel coordinates: [{bbox, det_score, embedding: Float32Array}].
   */
  async analyze(data) {
    const img = await decode(data, this.maxEdge);
    const { blob, detScale } = detBlob(img, this.detSize);
    const input = new ort.Tensor('float32', blob, [1, 3, this.detSize, this.detSize]);
    const outs = await this.det.run({ [this.det.inputNames[0]]: input });
    const cand = decodeScrfd(outs, this.det.outputNames, this.detSize, this.detThresh).map((c) => ({
      score: c.score,
      bbox: c.bbox.map((v) => v / detScale),
      kps: c.kps.map(([x, y]) => [x / detScale, y / detScale]),
    }));
    const faces = nms(cand);
    if (!faces.length) return { faces: [], width: img.ow, height: img.oh };

    const S = 112;
    const embeddings = [];
    for (let i = 0; i < faces.length; i += 16) {
      const chunk = faces.slice(i, i + 16);
      const recBlob = new Float32Array(chunk.length * 3 * S * S);
      chunk.forEach((f, j) => warpInto(recBlob, j * 3 * S * S, img, similarity(f.kps, ARCFACE_DST), S));
      const t = new ort.Tensor('float32', recBlob, [chunk.length, 3, S, S]);
      const out = await this.rec.run({ [this.rec.inputNames[0]]: t });
      const all = out[this.rec.outputNames[0]].data;
      const dim = all.length / chunk.length;
      for (let j = 0; j < chunk.length; j++) {
        const v = Float32Array.from(all.subarray(j * dim, (j + 1) * dim));
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let k = 0; k < dim; k++) v[k] /= norm;
        embeddings.push(v);
      }
    }
    return {
      width: img.ow,
      height: img.oh,
      faces: faces.map((f, i) => ({
        // detection ran on the capped copy: back to the uploaded photo's pixels
        bbox: f.bbox.map((v) => v / img.scale),
        det_score: f.score,
        embedding: embeddings[i],
      })),
    };
  }
}

module.exports = { FaceEngine, providerPlan, similarity, nms, detBlob, decode, ARCFACE_DST };
