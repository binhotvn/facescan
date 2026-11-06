import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Logo from './Logo.jsx';
import Sorter from './Sorter.jsx';
import Viewer from './Viewer.jsx';

const api = window.kapok;
const MAX_TILES = 300;
const STORAGE_EVERY_MS = 30_000;

const STATUS = {
  uploaded: { label: 'Đã gửi', tone: 'ok' },
  duplicate: { label: 'Đã có', tone: 'muted' },
  failed: { label: 'Lỗi', tone: 'err' },
};

const QUALITY_HINT = {
  original: 'Gửi nguyên file. Chậm nhất, giữ trọn chất lượng.',
  high: 'Cạnh dài 4096px. Nhanh hơn 3–6 lần, đủ nét để in và đăng mạng xã hội.',
  fast: 'Cạnh dài 2560px. Nhanh nhất, hợp với Wi-Fi sự kiện yếu.',
};

// --- formatting -------------------------------------------------------------
const num = (n) => (n ?? 0).toLocaleString('vi-VN');

function size(bytes) {
  if (bytes == null) return '–';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toLocaleString('vi-VN', { maximumFractionDigits: gb >= 100 ? 0 : 1 })} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toLocaleString('vi-VN', { maximumFractionDigits: mb >= 10 ? 0 : 1 })} MB`;
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function tail(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

// album folders are remembered per server: album ids mean nothing elsewhere
const serverKey = (u) => (u || '').trim().replace(/\/+$/, '');

function scanText(scan) {
  return scan ? `${num(scan.total)} ảnh · ${size(scan.bytes)} · ${num(scan.todo)} chưa gửi` : 'Đang đếm ảnh…';
}

// --- small pieces -------------------------------------------------------------
function Card({ title, action, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card__head">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat${tone ? ` is-${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** One album (or "no album") and the folder on this machine that feeds it. */
function SourceRow({ label, hint, folder, scan, disabled, onPick, onClear, onDropFile, onOver }) {
  const [over, setOver] = useState(false);
  const hover = (on) => {
    setOver(on);
    onOver(on);
  };
  return (
    <li
      className={`source${folder ? ' is-set' : ''}${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!over) hover(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) hover(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        hover(false);
        onDropFile(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="source__main">
        <strong title={label}>{label}</strong>
        {folder ? (
          <>
            <span className="source__path" title={folder}>
              {tail(folder)}
            </span>
            <span className="source__sum">{scanText(scan)}</span>
          </>
        ) : (
          <span className="source__hint">{hint}</span>
        )}
      </div>
      <div className="source__actions">
        <button type="button" className="btn btn--sm" disabled={disabled} onClick={onPick}>
          {folder ? 'Đổi…' : 'Chọn thư mục…'}
        </button>
        {folder && (
          <button type="button" className="btn btn--link source__clear" disabled={disabled} onClick={onClear}>
            Bỏ
          </button>
        )}
      </div>
    </li>
  );
}

function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className={`switch${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

// --- the app ------------------------------------------------------------------
export default function App() {
  const [boot, setBoot] = useState(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [server, setServer] = useState(null); // {limits, stats, storage}
  const [serverMsg, setServerMsg] = useState(null); // {tone, text}
  const [editing, setEditing] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const [folder, setFolder] = useState(null); // photos that go into no album
  const [folders, setFolders] = useState({}); // album id -> folder on this machine
  const [scans, setScans] = useState({}); // folder -> {total, todo, bytes}
  const [newAlbum, setNewAlbum] = useState(null); // the name being typed, null when closed
  const [creating, setCreating] = useState(false);
  const [rowDrag, setRowDrag] = useState(false);
  const savedFolders = useRef({}); // every server's album folders, as saved
  const [watch, setWatch] = useState(true);
  const [quality, setQuality] = useState('high');

  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState('Sẵn sàng');
  const [stats, setStats] = useState(null);
  const [tiles, setTiles] = useState([]);
  const [filter, setFilter] = useState('all');
  const [pane, setPane] = useState('recent'); // 'recent': sent from here, 'sort': all on the server
  const [viewing, setViewing] = useState(null); // id of the tile open in the viewer
  const [logs, setLogs] = useState([]);
  const [logOpen, setLogOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState(null);
  const tileId = useRef(0);

  // faces on this machine, and lending it to the server's queue
  const [faces, setFaces] = useState({ state: 'idle' });
  const [localFaces, setLocalFaces] = useState(true);
  const [nodeOn, setNodeOn] = useState(false);
  const [node, setNode] = useState({ running: false, status: '', stats: null });
  const facesFor = useRef(null);

  const flash = useCallback((text, tone = 'info') => {
    setToast({ text, tone, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // -- server
  const connect = useCallback(async (u = url, t = token, quiet = false) => {
    u = u.trim();
    t = t.trim();
    if (!/^https?:\/\//.test(u) || !t) {
      setServerMsg({ tone: 'err', text: 'Nhập địa chỉ (bắt đầu bằng http:// hoặc https://) và mã tải lên.' });
      return;
    }
    if (!quiet) setConnecting(true);
    const r = await api.fetchServer(u, t);
    setConnecting(false);
    if (r.ok) {
      setServer(r.info);
      setServerMsg(null);
      setEditing(false);
      setFolders(savedFolders.current[serverKey(u)] || {});
      api.setConfig({ url: u, token: t });
    } else if (!quiet) {
      setServer(null);
      setServerMsg({ tone: 'err', text: r.error });
    }
  }, [url, token]);

  // -- folders: one for photos in no album, one per album on the server
  const albums = server?.albums ?? null; // null: the server has no albums yet (older version)
  const sources = useMemo(() => {
    const out = folder ? [{ folder, album: null, name: null }] : [];
    for (const a of albums ?? []) {
      if (folders[a.id]) out.push({ folder: folders[a.id], album: a.id, name: a.name });
    }
    return out;
  }, [folder, folders, albums]);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const rescan = useCallback(async () => {
    const list = sourcesRef.current;
    const entries = await Promise.all(
      // a folder inside another one is counted by its own row only
      list.map(async (s) => [s.folder, await api.scanFolder(s.folder, list.map((o) => o.folder).filter((f) => f !== s.folder))])
    );
    setScans(Object.fromEntries(entries));
  }, []);
  const sourceKey = sources.map((s) => s.folder).join('\n');
  useEffect(() => {
    rescan();
  }, [sourceKey, rescan]);

  /** Point an album (null: no album) at a folder, or at none. */
  const assign = (album, f) => {
    const owner = f && sources.find((s) => s.folder === f && s.album !== album);
    if (owner) return flash(`Thư mục này đã dùng cho “${owner.name ?? 'Chưa vào thư mục'}”.`, 'err');
    if (album == null) {
      setFolder(f);
      api.setConfig({ folder: f });
      return undefined;
    }
    const next = { ...folders };
    if (f) next[album] = f;
    else delete next[album];
    setFolders(next);
    savedFolders.current = { ...savedFolders.current, [serverKey(url)]: next };
    api.setConfig({ albumFolders: savedFolders.current });
    return undefined;
  };
  const loadFolder = (f) => assign(null, f);

  const pickFor = async (album) => {
    const f = await api.chooseFolder();
    if (f) assign(album, f);
  };

  const dropFor = async (album, file) => {
    if (!file) return;
    if (running) return flash('Đang tải lên: dừng trước khi đổi thư mục.', 'err');
    const p = api.pathFor(file);
    if ((await api.pathKind(p)) === 'folder') assign(album, p);
    else flash('Kéo một thư mục ảnh vào đây.', 'err');
  };

  // album ids come back once deleted: a new album must not inherit this one's folder
  const forgetAlbum = (album) => {
    if (folders[album]) assign(album, null);
  };

  const createAlbum = async (e) => {
    e.preventDefault();
    const name = newAlbum.trim();
    if (!name) return;
    setCreating(true);
    const r = await api.createAlbum(url.trim(), token.trim(), name);
    setCreating(false);
    if (!r.ok) return flash(r.error, 'err');
    setNewAlbum(null);
    flash(`Đã tạo thư mục “${r.album.name}”. Chọn thư mục ảnh cho nó.`, 'ok');
    await connect(url, token, true); // the new album joins the list
    return pickFor(r.album.id);
  };

  useEffect(() => {
    api.init().then((b) => {
      setBoot(b);
      setUrl(b.cfg.url || 'https://');
      setToken(b.cfg.token || '');
      setWatch(b.cfg.watch ?? true);
      setQuality(b.cfg.quality || 'high');
      setLocalFaces(b.cfg.localFaces ?? true);
      setNodeOn(Boolean(b.cfg.nodeMode));
      savedFolders.current = b.cfg.albumFolders || {};
      setFolders(savedFolders.current[serverKey(b.cfg.url)] || {});
      if (b.cfg.folder) setFolder(b.cfg.folder);
      if (b.cfg.url && b.cfg.token) connect(b.cfg.url, b.cfg.token);
      if (b.discovered) flash(`Đã tự nhập cấu hình từ ${b.discovered.file.split(/[\\/]/).pop()}`, 'ok');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // once connected: fetch the server's face models and start the engine
  useEffect(() => {
    if (!server || editing) return;
    const key = `${url}|${token}`;
    if (facesFor.current === key) return;
    facesFor.current = key;
    setFaces({ state: 'checking' });
    api.prepareFaces(url.trim(), token.trim()).then((r) => {
      if (r.ok) setFaces({ state: 'ready', device: r.device, accelerated: r.accelerated });
      else if (r.unsupported) setFaces({ state: 'unsupported' });
      else setFaces({ state: 'error', error: r.error });
    });
  }, [server, editing, url, token]);

  // node mode follows its switch once the engine is up
  useEffect(() => {
    if (faces.state !== 'ready') return;
    if (nodeOn && !node.running) api.startNode({ url: url.trim(), token: token.trim() });
    if (!nodeOn && node.running) api.stopNode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeOn, faces.state]);

  // keep disk usage and the server's counts fresh
  useEffect(() => {
    if (!server || editing) return undefined;
    const id = setInterval(() => connect(url, token, true), STORAGE_EVERY_MS);
    return () => clearInterval(id);
  }, [server, editing, url, token, connect]);

  /** A connection read from JSON (a file, the clipboard, a paste): use it. */
  const applyConfig = useCallback((r) => {
    if (!r) return;
    if (!r.ok) {
      flash(r.error, 'err');
      return;
    }
    setUrl(r.url);
    setToken(r.token);
    flash('Đã nhập cấu hình máy chủ', 'ok');
    connect(r.url, r.token);
  }, [connect, flash]);
  const importConfig = useCallback(async (file) => applyConfig(await api.importConfig(file)), [applyConfig]);
  const pasteConfig = async (text) => applyConfig(await api.pasteConfig(text));

  // the connection in use, to hand on to another machine
  const shareable = () => ({ url: url.trim(), token: token.trim(), event: server?.stats?.event?.name });
  const copyConfig = async () => {
    await api.copyConfig(shareable());
    flash('Đã sao chép JSON cấu hình. Dán vào Kapok Uploader ở máy khác.', 'ok');
  };
  const exportConfig = async () => {
    const r = await api.exportConfig(shareable());
    if (r) flash(r.ok ? `Đã lưu ${r.file}` : r.error, r.ok ? 'ok' : 'err');
  };

  // -- events from the engine
  useEffect(() => api.onEvent((ev) => {
    switch (ev.type) {
      case 'status':
        setStatus(ev.text);
        break;
      case 'stats':
        setStats(ev.stats);
        break;
      case 'log':
        setLogs((l) => [...l.slice(-499), ev]);
        break;
      case 'faces':
        setFaces((f) => ({ ...f, state: ev.state, progress: ev.progress }));
        break;
      case 'node':
        setNode((n) => ({ ...n, ...ev }));
        break;
      case 'sent':
        setTiles((t) => [{ id: tileId.current++, ...ev }, ...t].slice(0, MAX_TILES));
        break;
      case 'done':
        setRunning(false);
        setStopping(false);
        if (ev.fatal) {
          setStatus(`Dừng vì lỗi: ${ev.fatal}`);
          flash(ev.fatal, 'err');
          setLogOpen(true);
        } else if (ev.stopped) {
          setStatus('Đã dừng. Bấm Bắt đầu để gửi tiếp.');
        } else {
          setStatus('Hoàn tất.');
        }
        rescan();
        connect(url, token, true);
        break;
      default:
    }
  }), [url, token, connect, flash, rescan]);

  const start = async () => {
    if (running) {
      setStopping(true);
      await api.stop();
      return;
    }
    if (!server) return flash('Hãy kết nối máy chủ trước.', 'err');
    if (!sources.length) return flash('Hãy chọn thư mục ảnh.', 'err');
    setStats(null);
    setRunning(true);
    setStatus('Đang bắt đầu…');
    const ok = await api.start({
      url: url.trim(),
      token: token.trim(),
      sources,
      watch,
      quality,
      localFaces: localFaces && faces.state === 'ready',
      batch: Math.min(4, server.limits?.max_batch || 4),
    });
    if (!ok) setRunning(false);
  };

  // -- drag a folder (or a kapok-uploader.json) anywhere onto the window
  const onDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const p = api.pathFor(file);
    const kind = await api.pathKind(p);
    if (kind === 'folder') {
      if (running) return flash('Đang tải lên: dừng trước khi đổi thư mục.', 'err');
      loadFolder(p);
    } else if (kind === 'json') importConfig(p);
    else flash('Kéo một thư mục ảnh, hoặc file cấu hình .json.', 'err');
  };

  const counts = useMemo(() => {
    const c = { all: tiles.length, uploaded: 0, duplicate: 0, failed: 0 };
    for (const t of tiles) c[t.status] += 1;
    return c;
  }, [tiles]);
  const shown = useMemo(() => (filter === 'all' ? tiles : tiles.filter((t) => t.status === filter)), [tiles, filter]);
  // tracked by id: new photos arriving at the top do not move the one being looked at
  const viewIndex = viewing == null ? -1 : shown.findIndex((t) => t.id === viewing);
  const closeViewer = useCallback(() => setViewing(null), []);
  const stepViewer = useCallback(
    (d) =>
      setViewing((id) => {
        const next = shown[shown.findIndex((t) => t.id === id) + d];
        return next ? next.id : id;
      }),
    [shown]
  );
  const flashError = useCallback((text) => flash(text, 'err'), [flash]);
  const refreshServer = useCallback(() => connect(url, token, true), [connect, url, token]);
  const errors = logs.filter((l) => l.level === 'error').length;

  // sorting needs albums on the server and a working connection
  const sorting = pane === 'sort' && Boolean(server && albums) && !editing;
  const modes = albums ? (
    <div className="modes" role="tablist" aria-label="Ảnh">
      <button type="button" role="tab" aria-selected={!sorting} onClick={() => setPane('recent')}>
        Ảnh vừa tải lên
      </button>
      <button type="button" role="tab" aria-selected={sorting} disabled={editing} onClick={() => setPane('sort')}>
        Phân loại ảnh
      </button>
    </div>
  ) : (
    <h2>Ảnh vừa tải lên</h2>
  );

  const s = stats;
  const progress = s && s.queued ? Math.min(1, s.done / s.queued) : 0;
  const saved = s && s.originalBytes ? 1 - s.bytesQueued / s.originalBytes : 0;
  const storage = server?.storage;
  const event = server?.stats?.event?.name;

  if (!boot) return <div className="boot" />;

  return (
    <div
      className={`app is-${boot.platform}${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <Logo size={30} />
          <div>
            <strong>Kapok Uploader</strong>
            <span>{event || 'Tải ảnh sự kiện'}</span>
          </div>
        </div>
        <div className="topbar__end">
          {faces.state === 'ready' && (
            <div className={`chipinfo${faces.accelerated ? ' is-gpu' : ''}`} title="Nhận diện khuôn mặt trên máy này">
              {faces.device?.replace(/ \(.*\)$/, '')}
              {node.running ? ' · đang làm node' : ''}
            </div>
          )}
        <div className={`conn${server ? ' is-on' : ''}`}>
          <i />
          {server ? `Đã kết nối · ${host(url)}` : 'Chưa kết nối'}
        </div>
        </div>
      </header>

      <main className="layout">
        {/* ------------------------------------------------ left: 3 parts */}
        <div className="col col--left">
          <Card
            title="Máy chủ"
            action={
              server && !editing ? (
                <button type="button" className="btn btn--link" onClick={() => setEditing(true)} disabled={running}>
                  Đổi
                </button>
              ) : (
                <button type="button" className="btn btn--link" onClick={() => importConfig()}>
                  Nhập file cấu hình…
                </button>
              )
            }
          >
            {server && !editing ? (
              <div className="server-ok">
                <div>
                  <strong>{host(url)}</strong>
                  <span>
                    {num(server.stats.photos)} ảnh trên máy chủ
                    {server.stats.pending ? ` · đang nhận diện ${num(server.stats.pending)}` : ''}
                  </span>
                </div>
                {url && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => api.openUrl(url)}>
                    Mở thư viện
                  </button>
                )}
                <p className="server-json">
                  <span>Cấu hình JSON (có mã tải lên):</span>
                  <button type="button" className="btn btn--link" onClick={copyConfig}>
                    Sao chép
                  </button>
                  <button type="button" className="btn btn--link" onClick={exportConfig}>
                    Lưu file…
                  </button>
                </p>
              </div>
            ) : (
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  connect();
                }}
              >
                <label>
                  <span>Địa chỉ máy chủ</span>
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text').trim();
                      if (!text.startsWith('{')) return; // a plain address
                      e.preventDefault();
                      pasteConfig(text);
                    }}
                    placeholder="https://anh.sukien.vn"
                  />
                </label>
                <label>
                  <span>Mã tải lên</span>
                  <div className="input-with">
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                    />
                    <button type="button" className="btn btn--link" onClick={() => setShowToken((v) => !v)}>
                      {showToken ? 'Ẩn' : 'Hiện'}
                    </button>
                  </div>
                </label>
                {serverMsg && <p className={`msg is-${serverMsg.tone}`}>{serverMsg.text}</p>}
                <div className="row">
                  <button type="submit" className="btn btn--dark" disabled={connecting}>
                    {connecting ? 'Đang kết nối…' : 'Kết nối'}
                  </button>
                  <button type="button" className="btn" onClick={() => pasteConfig()}>
                    Dán JSON
                  </button>
                  {server && (
                    <button type="button" className="btn btn--link" onClick={() => setEditing(false)}>
                      Huỷ
                    </button>
                  )}
                </div>
                <p className="hint">
                  Hoặc kéo file kapok-uploader.json (tải ở trang quản trị) vào cửa sổ này, hay sao chép nội dung JSON rồi
                  bấm Dán JSON.
                </p>
              </form>
            )}
          </Card>

          <Card
            title="Thư mục ảnh"
            action={
              albums ? (
                <button
                  type="button"
                  className="btn btn--link"
                  disabled={running || newAlbum !== null}
                  onClick={() => setNewAlbum('')}
                >
                  + Thư mục mới
                </button>
              ) : (
                <button type="button" className="btn btn--link" disabled={running} onClick={() => pickFor(null)}>
                  {folder ? 'Đổi…' : 'Chọn…'}
                </button>
              )
            }
          >
            {newAlbum !== null && (
              <form className="newalbum" onSubmit={createAlbum}>
                <input
                  autoFocus
                  value={newAlbum}
                  maxLength={60}
                  placeholder="Tên thư mục, VD: Gala Dinner"
                  disabled={creating}
                  onChange={(e) => setNewAlbum(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setNewAlbum(null)}
                />
                <button type="submit" className="btn btn--primary" disabled={creating || !newAlbum.trim()}>
                  {creating ? 'Đang tạo…' : 'Tạo'}
                </button>
                <button type="button" className="btn btn--link" onClick={() => setNewAlbum(null)}>
                  Huỷ
                </button>
              </form>
            )}
            {albums ? (
              <>
                <ul className="sources">
                  <SourceRow
                    label="Chưa vào thư mục"
                    hint="Ảnh chỉ nằm trong Tất cả ảnh"
                    folder={folder}
                    scan={scans[folder]}
                    disabled={running}
                    onPick={() => pickFor(null)}
                    onClear={() => assign(null, null)}
                    onDropFile={(f) => dropFor(null, f)}
                    onOver={setRowDrag}
                  />
                  {albums.map((a) => (
                    <SourceRow
                      key={a.id}
                      label={a.name}
                      hint={`${num(a.photos)} ảnh trên máy chủ · chưa chọn thư mục ảnh`}
                      folder={folders[a.id]}
                      scan={scans[folders[a.id]]}
                      disabled={running}
                      onPick={() => pickFor(a.id)}
                      onClear={() => assign(a.id, null)}
                      onDropFile={(f) => dropFor(a.id, f)}
                      onOver={setRowDrag}
                    />
                  ))}
                </ul>
                {albums.length === 0 && (
                  <p className="hint">
                    Tạo thư mục (VD: Lễ khai mạc, Gala dinner) để khách lọc ảnh theo từng phần của sự kiện. Mỗi thư
                    mục chọn một thư mục ảnh riêng trên máy này.
                  </p>
                )}
              </>
            ) : folder ? (
              <div className="folder">
                <strong title={folder}>{folder.split(/[\\/]/).filter(Boolean).pop()}</strong>
                <span className="muted" title={folder}>
                  {tail(folder)}
                </span>
                <span className="folder__sum">{scanText(scans[folder])}</span>
              </div>
            ) : (
              <button type="button" className="dropzone" onClick={() => pickFor(null)}>
                <strong>Chọn thư mục ảnh</strong>
                <span>hoặc kéo thả thư mục vào cửa sổ</span>
              </button>
            )}

            <div className="field">
              <span className="field__label">Chất lượng tải lên</span>
              <div className="segmented" role="radiogroup">
                {Object.entries(boot.qualities).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={quality === k}
                    className={quality === k ? 'is-on' : ''}
                    disabled={running}
                    onClick={() => {
                      setQuality(k);
                      api.setConfig({ quality: k });
                    }}
                  >
                    {label.split(' · ')[0].replace(' (không nén)', '')}
                  </button>
                ))}
              </div>
              <p className="hint">{QUALITY_HINT[quality]}</p>
            </div>

            <Switch
              checked={watch}
              disabled={running}
              onChange={(v) => {
                setWatch(v);
                api.setConfig({ watch: v });
              }}
              label="Tự gửi ảnh mới chép vào thư mục"
            />
          </Card>

          <Card title="Tiến độ">
            <button
              type="button"
              className={`btn ${running ? 'btn--stop' : 'btn--primary'} btn--block`}
              onClick={start}
              disabled={stopping}
            >
              {stopping ? 'Đang dừng…' : running ? 'Dừng' : 'Bắt đầu tải lên'}
            </button>
            <p className="status">{status}</p>
            <div className={`bar${running ? ' is-live' : ''}`}>
              <span style={{ width: `${progress * 100}%` }} />
            </div>
            <dl className="stats">
              <Stat label="Đã gửi" value={num(s?.uploaded)} tone="ok" />
              <Stat label="Đã có" value={num(s?.duplicates)} />
              <Stat label="Lỗi" value={num(s?.failed)} tone={s?.failed ? 'err' : undefined} />
              <Stat label="Tốc độ" value={`${(s?.mbps ?? 0).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB/s`} />
              <Stat label="Đã truyền" value={size(s?.bytesSent ?? 0)} />
              <Stat label="Nén giảm" value={saved > 0 ? `${Math.round(saved * 100)}%` : '–'} />
            </dl>
          </Card>

          <Card title="Nhận diện khuôn mặt">
            <div className={`device is-${faces.state}`}>
              <span className="device__dot" />
              <div>
                <strong>
                  {faces.state === 'ready' && faces.device}
                  {faces.state === 'idle' && 'Chờ kết nối máy chủ'}
                  {faces.state === 'checking' && 'Đang kiểm tra model…'}
                  {faces.state === 'downloading' && `Đang tải model ${Math.round((faces.progress || 0) * 100)}%`}
                  {faces.state === 'loading' && 'Đang khởi động model…'}
                  {faces.state === 'unsupported' && 'Máy chủ chưa hỗ trợ'}
                  {faces.state === 'error' && 'Không chạy được trên máy này'}
                </strong>
                <span>
                  {faces.state === 'ready' &&
                    (faces.accelerated ? 'Tăng tốc phần cứng' : 'Không có GPU tương thích, dùng CPU')}
                  {faces.state === 'unsupported' && 'Máy chủ sẽ tự nhận diện ảnh tải lên.'}
                  {faces.state === 'error' && `${faces.error}. Máy chủ sẽ tự nhận diện.`}
                  {['idle', 'checking', 'downloading', 'loading'].includes(faces.state) &&
                    'Model lấy từ máy chủ, chỉ tải lần đầu.'}
                </span>
              </div>
            </div>
            {faces.state === 'downloading' && (
              <div className="bar">
                <span style={{ width: `${(faces.progress || 0) * 100}%` }} />
              </div>
            )}
            <div className="toggles">
              <Switch
                checked={localFaces}
                disabled={running || faces.state !== 'ready'}
                onChange={(v) => {
                  setLocalFaces(v);
                  api.setConfig({ localFaces: v });
                }}
                label="Nhận diện trên máy này khi tải lên"
              />
              <Switch
                checked={nodeOn}
                disabled={faces.state !== 'ready'}
                onChange={(v) => {
                  setNodeOn(v);
                  api.setConfig({ nodeMode: v });
                }}
                label="Làm node xử lý hàng chờ của máy chủ"
              />
              {faces.state !== 'ready' && (
                <p className="hint">
                  Cần model nhận diện chạy được trên máy này
                  {faces.state === 'unsupported' ? ' (máy chủ chưa hỗ trợ).' : '.'}
                </p>
              )}
              {faces.state === 'ready' && !nodeOn && (
                <p className="hint">
                  Máy này sẽ nhận diện giúp các ảnh đang chờ trên máy chủ, kể cả ảnh từ máy khác tải lên.
                </p>
              )}
            </div>
            {(s?.analyzed > 0 || node.running || node.stats) && (
              <div className="facestats">
                {s?.analyzed > 0 && (
                  <span>
                    Khi tải lên: <b>{num(s.facesFound)}</b> khuôn mặt trong {num(s.analyzed)} ảnh ·{' '}
                    {Math.round(s.analyzeMs / s.analyzed)} ms/ảnh
                  </span>
                )}
                {(node.running || node.stats) && (
                  <span>
                    Node đã xử lý <b>{num(node.stats?.processed)}</b> ảnh, {num(node.stats?.faces)} khuôn mặt
                    {node.pending != null ? ` · hàng chờ máy chủ: ${num(node.pending)} ảnh` : ''}
                    <em>{node.status}</em>
                  </span>
                )}
              </div>
            )}
          </Card>

          <Card title="Dung lượng máy chủ">
            {storage ? (
              <div className="storage">
                <div className="storage__head">
                  <strong>Sự kiện dùng {size(storage.photos_bytes + storage.thumbs_bytes + storage.db_bytes)}</strong>
                  <span className={storage.disk_free / storage.disk_total < 0.1 ? 'pill is-err' : 'pill is-ok'}>
                    Còn trống {size(storage.disk_free)}
                  </span>
                </div>
                <div className="disk">
                  <span className="is-event" style={{ width: `${(100 * storage.photos_bytes) / storage.disk_total}%` }} />
                  <span
                    className="is-other"
                    style={{
                      width: `${(100 * Math.max(0, storage.disk_used - storage.photos_bytes)) / storage.disk_total}%`,
                    }}
                  />
                </div>
                <p className="muted small">
                  Ảnh gốc {size(storage.photos_bytes)} ({num(storage.photo_files)} tệp) · ổ đĩa đã dùng{' '}
                  {Math.round((100 * storage.disk_used) / storage.disk_total)}% của {size(storage.disk_total)}
                </p>
              </div>
            ) : (
              <p className="muted small">
                {server ? 'Máy chủ này chưa hỗ trợ báo dung lượng.' : 'Kết nối để xem dung lượng đã dùng.'}
              </p>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------ right: 7 parts */}
        <div className="col col--right">
          <section className="card gallery">
            {sorting ? (
              <Sorter
                modes={modes}
                url={url.trim()}
                token={token.trim()}
                albums={albums}
                unsorted={server.unsorted}
                total={server.stats.photos}
                onChanged={refreshServer}
                onAlbumGone={forgetAlbum}
                locked={running}
                flash={flash}
              />
            ) : (
              <>
                <header className="card__head">
                  {modes}
                  <div className="segmented segmented--inline">
                    {[
                      ['all', 'Tất cả'],
                      ['uploaded', 'Đã gửi'],
                      ['duplicate', 'Đã có'],
                      ['failed', 'Lỗi'],
                    ].map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        className={`${filter === k ? 'is-on' : ''}${k === 'failed' && counts.failed ? ' is-err' : ''}`}
                        onClick={() => setFilter(k)}
                      >
                        {label} <b>{num(counts[k])}</b>
                      </button>
                    ))}
                  </div>
                </header>
                {shown.length ? (
                  <div className="tiles">
                    {shown.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="tile"
                        title={`${t.name}${t.error ? ` · ${t.error}` : ''}\nBấm để xem ảnh và khuôn mặt`}
                        onClick={() => setViewing(t.id)}
                      >
                        {t.thumb ? <img src={t.thumb} alt="" draggable={false} /> : <span className="tile__none">Không xem trước được</span>}
                        <span className={`badge is-${STATUS[t.status].tone}`}>{STATUS[t.status].label}</span>
                        {t.faces != null && t.status !== 'failed' && (
                          <span className="faces" title="Khuôn mặt nhận diện trên máy này">
                            {t.faces} mặt
                          </span>
                        )}
                        <span className="tile__name">
                          {t.album && <b>{t.album} · </b>}
                          {t.name}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <strong>{tiles.length ? 'Không có ảnh nào ở mục này' : 'Ảnh tải lên sẽ hiện ở đây'}</strong>
                    <span>
                      {tiles.length
                        ? 'Chọn mục khác ở phía trên.'
                        : 'Chọn thư mục ảnh rồi bấm Bắt đầu tải lên. Ảnh mới chép vào thư mục sẽ tự được gửi.'}
                      {!tiles.length && albums && ' Ảnh đã có trên máy chủ được chọn và chuyển thư mục ở tab Phân loại ảnh.'}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>

          <section className={`log${logOpen ? ' is-open' : ''}`}>
            <button type="button" className="log__head" onClick={() => setLogOpen((v) => !v)}>
              <span>Nhật ký</span>
              {errors > 0 && <span className="pill is-err">{num(errors)} lỗi</span>}
              <span className="log__last">{logs.length ? logs[logs.length - 1].msg : 'Chưa có hoạt động'}</span>
              <span className="log__toggle">{logOpen ? 'Thu gọn' : 'Mở'}</span>
            </button>
            {logOpen && (
              <div className="log__body">
                {logs.length === 0 && <p className="muted small">Chưa có hoạt động.</p>}
                {logs
                  .slice()
                  .reverse()
                  .map((l, i) => (
                    <div key={i} className={`log__line is-${l.level}`}>
                      <time>{new Date(l.at).toLocaleTimeString('vi-VN')}</time>
                      <span>{l.msg}</span>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {viewIndex >= 0 && (
        <Viewer
          tile={shown[viewIndex]}
          index={viewIndex}
          total={shown.length}
          badge={STATUS[shown[viewIndex].status]}
          revealLabel={boot.platform === 'darwin' ? 'Hiện trong Finder' : 'Hiện trong thư mục'}
          onClose={closeViewer}
          onStep={stepViewer}
          onError={flashError}
        />
      )}
      {dragging && !rowDrag && (
        <div className="dropveil">
          <div>
            <strong>Thả vào đây</strong>
            <span>
              {albums?.length
                ? 'Thư mục ảnh chưa vào thư mục nào, hoặc file cấu hình .json. Thả lên một dòng ở Thư mục ảnh để gửi vào thư mục đó.'
                : 'Thư mục ảnh để tải lên, hoặc file cấu hình .json'}
            </span>
          </div>
        </div>
      )}
      {toast && <div className={`toast is-${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
