'use strict';
/** Kapok Uploader: Electron main process. The window is src/, the engine uploader.cjs. */
const { app, BrowserWindow, clipboard, dialog, ipcMain, powerSaveBlocker, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const U = require('./uploader.cjs');
const { ensureModels } = require('./models.cjs');
const { FaceService } = require('./faces.cjs');
const { QueueNode } = require('./queue-node.cjs');

const isMac = process.platform === 'darwin';
let win = null;
let uploader = null;
let keepAwake = null;
const faceService = new FaceService();
let faceKey = null; // the server + model the engine was loaded for
let queueNode = null;

// --------------------------------------------------------------------------
// settings
// --------------------------------------------------------------------------
function configFile() {
  return process.env.KAPOK_UPLOADER_CONFIG || path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return cfg;
}

/**
 * "Click and it runs": a kapok-uploader.json from the admin page, placed next
 * to the app or left in Downloads, configures the app with no typing.
 */
function discoverServerFile() {
  const exe = app.getPath('exe');
  const dirs = [
    process.env.PORTABLE_EXECUTABLE_DIR, // Windows portable .exe: the folder it was run from
    isMac ? path.resolve(exe, '../../../..') : path.dirname(exe), // beside the .app / .exe
    app.getPath('downloads'),
    app.getPath('desktop'),
  ].filter(Boolean);
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^kapok-uploader.*\.json$/i.test(n)) continue;
      const file = path.join(dir, n);
      try {
        found.push({ file, mtime: fs.statSync(file).mtimeMs, conf: U.readServerFile(fs.readFileSync(file, 'utf8')) });
      } catch {
        /* not a usable connection file */
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime); // the newest download wins
  return found[0] ? { file: found[0].file, ...found[0].conf } : null;
}

// --------------------------------------------------------------------------
// window
// --------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'Kapok Uploader',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 20 } }
      : { titleBarOverlay: { color: '#ffffff', symbolColor: '#1c1f2b', height: 60 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  // links (the gallery, the admin page) open in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!uploader) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Thoát', 'Tiếp tục tải'],
      defaultId: 1,
      cancelId: 1,
      message: 'Đang tải ảnh lên. Thoát bây giờ?',
      detail: 'Lần mở sau sẽ gửi tiếp từ chỗ đang dừng, không gửi lại ảnh đã lên.',
    });
    if (choice === 1) e.preventDefault();
    else uploader.stop();
  });
}

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('upload:event', { type, ...payload });
}

function awake(on) {
  // a sleeping laptop uploads (and indexes) nothing
  const busy = on || uploader || queueNode;
  if (busy && keepAwake === null) keepAwake = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && keepAwake !== null) {
    powerSaveBlocker.stop(keepAwake);
    keepAwake = null;
  }
}

// --------------------------------------------------------------------------
// IPC
// --------------------------------------------------------------------------
ipcMain.handle('app:init', () => {
  let cfg = loadConfig();
  let discovered = null;
  if (!cfg.url || !cfg.token) {
    discovered = discoverServerFile();
    if (discovered) cfg = saveConfig({ url: discovered.url, token: discovered.token });
  }
  return {
    cfg,
    discovered,
    version: app.getVersion(),
    platform: process.platform,
    qualities: Object.fromEntries(Object.entries(U.QUALITY).map(([k, v]) => [k, v.label])),
    uploading: Boolean(uploader),
  };
});

ipcMain.handle('config:set', (_e, patch) => saveConfig(patch));

ipcMain.handle('config:import', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Chọn file cấu hình máy chủ',
      filters: [{ name: 'Cấu hình Kapok', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  return takeServerFile(() => fs.readFileSync(file, 'utf8'));
});

/** Take a connection from JSON text: the clipboard's, or what was pasted. */
ipcMain.handle('config:paste', (_e, text) =>
  takeServerFile(() => {
    const t = (text ?? clipboard.readText()).trim();
    if (!t) throw new Error('Bộ nhớ tạm đang trống. Hãy sao chép nội dung file cấu hình JSON trước.');
    return t;
  })
);

function takeServerFile(read) {
  try {
    const conf = U.readServerFile(read());
    saveConfig({ url: conf.url, token: conf.token });
    return { ok: true, ...conf };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Hand the connection on: onto the clipboard, or into a file like the admin page's. */
ipcMain.handle('config:copy', (_e, conf) => {
  clipboard.writeText(U.serverFile(conf));
  return true;
});

ipcMain.handle('config:export', async (_e, conf) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Lưu file cấu hình máy chủ',
    defaultPath: path.join(app.getPath('downloads'), 'kapok-uploader.json'),
    filters: [{ name: 'Cấu hình Kapok', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  try {
    fs.writeFileSync(r.filePath, U.serverFile(conf));
    return { ok: true, file: r.filePath };
  } catch (e) {
    return { ok: false, error: `Không lưu được file (${e.message}).` };
  }
});

ipcMain.handle('folder:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Chọn thư mục ảnh sự kiện',
    defaultPath: loadConfig().folder || app.getPath('pictures'),
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0] || null;
});

ipcMain.handle('path:kind', (_e, p) => {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return 'folder';
    if (st.isFile() && p.toLowerCase().endsWith('.json')) return 'json';
  } catch {
    /* gone */
  }
  return 'other';
});

ipcMain.handle('folder:scan', (_e, folder, skip) => U.scanFolder(folder, skip));

ipcMain.handle('server:fetch', async (_e, url, token) => {
  try {
    return { ok: true, info: await U.fetchServer(url, token) };
  } catch (e) {
    return { ok: false, error: U.describeError(e) };
  }
});

const why = (e) => (e.fromServer ? e.message : U.describeError(e));

ipcMain.handle('album:create', async (_e, url, token, name) => {
  try {
    return { ok: true, album: await U.createAlbum(url, token, name) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
});

// -- sorting the photos already on the server into albums ------------------
ipcMain.handle('photos:list', async (_e, url, token, query) => {
  try {
    return { ok: true, ...(await U.listPhotos(url, token, query)) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
});

ipcMain.handle('photos:move', async (_e, url, token, ids, album) => {
  if (!Array.isArray(ids) || !ids.every(Number.isInteger)) return { ok: false, error: 'Danh sách ảnh không hợp lệ.' };
  try {
    return { ok: true, moved: await U.movePhotos(url, token, ids, album ?? null) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
});

ipcMain.handle('photos:delete', async (_e, url, token, ids) => {
  if (!Array.isArray(ids) || !ids.every(Number.isInteger)) return { ok: false, error: 'Danh sách ảnh không hợp lệ.' };
  try {
    return { ok: true, deleted: await U.deletePhotos(url, token, ids) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
});

ipcMain.handle('album:rename', async (_e, url, token, id, name) => {
  if (!Number.isInteger(id)) return { ok: false, error: 'Thư mục không hợp lệ.' };
  try {
    return { ok: true, album: await U.renameAlbum(url, token, id, name) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
});

ipcMain.handle('album:delete', async (_e, url, token, id) => {
  if (!Number.isInteger(id)) return { ok: false, error: 'Thư mục không hợp lệ.' };
  try {
    return { ok: true, ...(await U.deleteAlbum(url, token, id)) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
});

ipcMain.handle('upload:start', (_e, opts) => {
  if (uploader) return false;
  saveConfig({ watch: opts.watch, quality: opts.quality }); // the folders are saved as they are picked
  const analyze = opts.localFaces && faceService.worker ? (d) => faceService.analyze(d) : null;
  uploader = new U.Uploader({ ...opts, analyze });
  awake(true);
  uploader.on('status', (text) => send('status', { text }));
  uploader.on('log', (e) => send('log', e));
  uploader.on('sent', (e) => send('sent', e));
  uploader.on('stats', (s) => send('stats', { stats: s }));
  uploader.on('done', (d) => {
    uploader = null;
    awake(false);
    send('done', d);
  });
  uploader.run();
  return true;
});

// -- faces on this machine -------------------------------------------------
ipcMain.handle('faces:prepare', async (_e, url, token) => {
  try {
    const m = await ensureModels({
      url,
      token,
      dir: path.join(app.getPath('userData'), 'models'),
      onProgress: (p) => send('faces', { state: 'downloading', progress: p }),
    });
    if (!m) return { ok: false, unsupported: true };
    const key = `${url}|${m.manifest.signature}`;
    if (faceKey !== key || !faceService.worker) {
      send('faces', { state: 'loading' });
      await faceService.start(m.files, m.manifest);
      faceKey = key;
    }
    return { ok: true, device: faceService.device, accelerated: !/^CPU/.test(faceService.device) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('node:start', (_e, { url, token }) => {
  if (queueNode || !faceService.worker) return false;
  queueNode = new QueueNode({
    url,
    token,
    name: `kapok-${os.hostname().replace(/\.local$/, '')}`,
    analyze: (d) => faceService.analyze(d),
  });
  queueNode.on('status', (text) => send('node', { status: text }));
  queueNode.on('stats', (stats) => send('node', { stats }));
  queueNode.on('queue', (pending) => send('node', { pending }));
  queueNode.on('done', () => {
    queueNode = null;
    awake(false);
    send('node', { running: false });
  });
  awake(true);
  queueNode.run();
  send('node', { running: true });
  return true;
});

ipcMain.handle('node:stop', () => queueNode?.stop());

ipcMain.handle('upload:stop', () => {
  uploader?.stop();
});

// the window can only ask for photos, never any other file on the machine
const isPhoto = (file) => typeof file === 'string' && U.IMAGE_EXTS.has(path.extname(file).toLowerCase());

ipcMain.handle('photo:preview', async (_e, file) => {
  if (!isPhoto(file)) return null;
  try {
    return await U.preview(file);
  } catch {
    return null; // moved or deleted since it went up
  }
});

ipcMain.handle('photo:faces', async (_e, file, boxes, w, h) => {
  if (!isPhoto(file) || !Array.isArray(boxes) || boxes.length > 500 || !(w > 0 && h > 0)) return null;
  try {
    return await U.faceCrops(file, boxes, w, h);
  } catch {
    return null;
  }
});

ipcMain.handle('shell:openFile', async (_e, file) => {
  if (!isPhoto(file)) return 'Không phải file ảnh.';
  return shell.openPath(file); // '' when it opened, else why not
});

ipcMain.handle('shell:reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:/.test(url)) shell.openExternal(url);
});

// --------------------------------------------------------------------------
app.setName('Kapok Uploader');
if (process.env.ELECTRON_USER_DATA) app.setPath('userData', process.env.ELECTRON_USER_DATA); // tests: a clean profile
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  queueNode?.stop();
  faceService.stop();
});
