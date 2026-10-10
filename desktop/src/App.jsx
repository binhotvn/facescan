import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Logo from './Logo.jsx';

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

  const [folder, setFolder] = useState(null);
  const [scan, setScan] = useState(null);
  const [watch, setWatch] = useState(true);
  const [quality, setQuality] = useState('high');

  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState('Sẵn sàng');
  const [stats, setStats] = useState(null);
  const [tiles, setTiles] = useState([]);
  const [filter, setFilter] = useState('all');
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
      api.setConfig({ url: u, token: t });
    } else if (!quiet) {
      setServer(null);
      setServerMsg({ tone: 'err', text: r.error });
    }
  }, [url, token]);

  const loadFolder = useCallback(async (f) => {
    setFolder(f);
    setScan(null);
    api.setConfig({ folder: f });
    setScan(await api.scanFolder(f));
  }, []);

  useEffect(() => {
    api.init().then((b) => {
      setBoot(b);
      setUrl(b.cfg.url || 'https://');
      setToken(b.cfg.token || '');
      setWatch(b.cfg.watch ?? true);
      setQuality(b.cfg.quality || 'high');
      setLocalFaces(b.cfg.localFaces ?? true);
      setNodeOn(Boolean(b.cfg.nodeMode));
      if (b.cfg.folder) loadFolder(b.cfg.folder);
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

  const importConfig = useCallback(async (file) => {
    const r = await api.importConfig(file);
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
        if (folder) api.scanFolder(folder).then(setScan);
        connect(url, token, true);
        break;
      default:
    }
  }), [folder, url, token, connect, flash]);

  const start = async () => {
    if (running) {
      setStopping(true);
      await api.stop();
      return;
    }
    if (!server) return flash('Hãy kết nối máy chủ trước.', 'err');
    if (!folder) return flash('Hãy chọn thư mục ảnh.', 'err');
    setStats(null);
    setRunning(true);
    setStatus('Đang bắt đầu…');
    const ok = await api.start({
      url: url.trim(),
      token: token.trim(),
      folder,
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
  const shown = filter === 'all' ? tiles : tiles.filter((t) => t.status === filter);
  const errors = logs.filter((l) => l.level === 'error').length;

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
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://anh.sukien.vn" />
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
                  {server && (
                    <button type="button" className="btn btn--link" onClick={() => setEditing(false)}>
                      Huỷ
                    </button>
                  )}
                </div>
                <p className="hint">Hoặc kéo file kapok-uploader.json (tải ở trang quản trị) vào cửa sổ này.</p>
              </form>
            )}
          </Card>

          <Card
            title="Thư mục ảnh"
            action={
              <button
                type="button"
                className="btn btn--link"
                disabled={running}
                onClick={async () => {
                  const f = await api.chooseFolder();
                  if (f) loadFolder(f);
                }}
              >
                {folder ? 'Đổi…' : 'Chọn…'}
              </button>
            }
          >
            {folder ? (
              <div className="folder">
                <strong title={folder}>{folder.split(/[\\/]/).filter(Boolean).pop()}</strong>
                <span className="muted" title={folder}>
                  {tail(folder)}
                </span>
                <span className="folder__sum">
                  {scan
                    ? `${num(scan.total)} ảnh · ${size(scan.bytes)} · ${num(scan.todo)} chưa gửi`
                    : 'Đang đếm ảnh…'}
                </span>
              </div>
            ) : (
              <button
                type="button"
                className="dropzone"
                onClick={async () => {
                  const f = await api.chooseFolder();
                  if (f) loadFolder(f);
                }}
              >
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
          <Card
            className="gallery"
            title="Ảnh vừa tải lên"
            action={
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
            }
          >
            {shown.length ? (
              <div className="tiles">
                {shown.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="tile"
                    title={`${t.name}${t.error ? ` · ${t.error}` : ''}\nBấm để mở trong thư mục`}
                    onClick={() => api.reveal(t.file)}
                  >
                    {t.thumb ? <img src={t.thumb} alt="" draggable={false} /> : <span className="tile__none">Không xem trước được</span>}
                    <span className={`badge is-${STATUS[t.status].tone}`}>{STATUS[t.status].label}</span>
                    {t.faces != null && t.status !== 'failed' && (
                      <span className="faces" title="Khuôn mặt nhận diện trên máy này">
                        {t.faces} mặt
                      </span>
                    )}
                    <span className="tile__name">{t.name}</span>
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
                </span>
              </div>
            )}
          </Card>

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

      {dragging && (
        <div className="dropveil">
          <div>
            <strong>Thả vào đây</strong>
            <span>Thư mục ảnh để tải lên, hoặc file cấu hình .json</span>
          </div>
        </div>
      )}
      {toast && <div className={`toast is-${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
