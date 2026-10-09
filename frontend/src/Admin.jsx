import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Theme, Button, PasswordInput, InlineNotification, ProgressBar, Tag } from '@carbon/react';
import { CloudUpload, Folder, Image as ImageIcon, Logout, Renew } from '@carbon/icons-react';

import AdminPhotos from './components/AdminPhotos';
import logo from './assets/vinhhung-logo.png';

const TOKEN_KEY = 'facescan.uploadToken';
const IMAGE_RE = /\.(jpe?g|png|webp|bmp)$/i;
// One request is built in memory and proxies cap request bodies (Cloudflare's
// free tier at 100MB), same budget upload.py keeps to.
const MAX_BATCH_BYTES = 48 * 1024 * 1024;
const PARALLEL = 2;
const STATS_POLL_MS = 3000;
// A whole card's worth of photos can be queued at once; past this many rows the
// list shows the problems and the newest, and counts the rest.
const LIST_LIMIT = 300;

const STATUS = {
  waiting: { label: 'Chờ', type: 'gray' },
  uploading: { label: 'Đang tải', type: 'blue' },
  done: { label: 'Đã nhận', type: 'green' },
  duplicate: { label: 'Đã có', type: 'cool-gray' },
  error: { label: 'Lỗi', type: 'red' },
};

const Row = memo(function Row({ item }) {
  const name = item.file.webkitRelativePath || item.file.name;
  return (
    <li>
      <span className="fa-admin__name" title={name}>
        {name}
      </span>
      <span className="fa-admin__size">{formatBytes(item.file.size)}</span>
      <Tag size="sm" type={STATUS[item.status].type}>
        {STATUS[item.status].label}
      </Tag>
      {item.error && <span className="fa-admin__error">{item.error}</span>}
    </li>
  );
});

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token just lasts for this tab */
  }
}

function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function checkToken(token) {
  const res = await fetch('/api/upload/check', { headers: { 'X-Upload-Token': token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Không kết nối được máy chủ.');
  return data;
}

/** POST one batch with XHR, since fetch cannot report upload progress. */
function sendBatch(files, token, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Upload-Token', token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* proxy error pages are HTML */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else
        reject(
          Object.assign(new Error(data.detail || `Lỗi máy chủ (${xhr.status}).`), {
            status: xhr.status,
          }),
        );
    };
    xhr.onerror = () => reject(new Error('Mất kết nối.'));
    xhr.send(form);
  });
}

/** Files from a drop, walking into dropped folders. */
async function droppedFiles(dataTransfer) {
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];

  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries hands back at most ~100 at a time; call until empty
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return out;
}

export default function Admin() {
  const [token, setToken] = useState(readToken);
  const [limits, setLimits] = useState(null); // set once the token checks out
  const [draft, setDraft] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('upload');
  const progressFrame = useRef(0);
  const sentBytes = useRef(new Map()); // batch id -> bytes on the wire so far
  const [progressBytes, setProgressBytes] = useState(0);
  const [runBytes, setRunBytes] = useState(0);
  const pickFiles = useRef(null);
  const pickFolder = useRef(null);
  const nextId = useRef(0);

  const signOut = useCallback((message = null) => {
    writeToken('');
    setToken('');
    setLimits(null);
    setError(message);
  }, []);

  const signIn = useCallback(
    async (candidate) => {
      setSigningIn(true);
      setError(null);
      try {
        const data = await checkToken(candidate);
        writeToken(candidate);
        setToken(candidate);
        setLimits(data);
      } catch (e) {
        signOut(e.message);
      } finally {
        setSigningIn(false);
      }
    },
    [signOut],
  );

  // a remembered token is re-checked, not trusted
  useEffect(() => {
    if (token) signIn(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshStats = useCallback(
    () =>
      fetch('/api/stats')
        .then((r) => r.json())
        .then(setStats)
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    if (!limits) return undefined;
    const tick = refreshStats;
    tick();
    const id = setInterval(tick, STATS_POLL_MS);
    return () => clearInterval(id);
  }, [limits, refreshStats]);

  // XHR progress fires many times a second per batch; paint it once a frame
  const showProgress = useCallback(() => {
    if (progressFrame.current) return;
    progressFrame.current = requestAnimationFrame(() => {
      progressFrame.current = 0;
      setProgressBytes([...sentBytes.current.values()].reduce((a, b) => a + b, 0));
    });
  }, []);

  useEffect(() => {
    if (!busy) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const patch = (ids, fields) =>
    setItems((prev) => prev.map((it) => (ids.has(it.id) ? { ...it, ...fields(it) } : it)));

  const run = useCallback(
    async (queue) => {
      if (!queue.length || !limits) return;
      setBusy(true);
      setError(null);
      sentBytes.current.clear();
      setProgressBytes(0);
      setRunBytes(queue.reduce((n, it) => n + it.file.size, 0));

      const batches = [];
      let cur = [];
      let curBytes = 0;
      for (const it of queue) {
        if (
          cur.length &&
          (cur.length >= limits.max_batch || curBytes + it.file.size > MAX_BATCH_BYTES)
        ) {
          batches.push(cur);
          cur = [];
          curBytes = 0;
        }
        cur.push(it);
        curBytes += it.file.size;
      }
      if (cur.length) batches.push(cur);

      let stop = false;
      async function worker() {
        while (batches.length && !stop) {
          const batch = batches.shift();
          const key = batch[0].id;
          const ids = new Set(batch.map((it) => it.id));
          const bytes = batch.reduce((n, it) => n + it.file.size, 0);
          patch(ids, () => ({ status: 'uploading', error: null }));
          try {
            const data = await sendBatch(
              batch.map((it) => it.file),
              token,
              (frac) => {
                sentBytes.current.set(key, frac * bytes);
                showProgress();
              },
            );
            // the server answers in the order the files were sent
            const byId = new Map(batch.map((it, i) => [it.id, data.photos?.[i]]));
            setItems((prev) =>
              prev.map((it) => {
                if (!ids.has(it.id)) return it;
                const r = byId.get(it.id);
                if (!r) return { ...it, status: 'error', error: 'Không có phản hồi.', retry: true };
                // the server read the file and refused it: it would refuse it again
                if (!r.ok) return { ...it, status: 'error', error: r.error, retry: false };
                return { ...it, status: r.duplicate ? 'duplicate' : 'done', error: null };
              }),
            );
          } catch (e) {
            patch(ids, () => ({ status: 'error', error: e.message, retry: true }));
            if (e.status === 401 || e.status === 503) {
              stop = true;
              signOut(e.message);
            }
          } finally {
            sentBytes.current.set(key, bytes);
            showProgress();
          }
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      setBusy(false);
      refreshStats();
    },
    [limits, token, signOut, showProgress, refreshStats],
  );

  function add(fileList) {
    const files = [...fileList].filter((f) => IMAGE_RE.test(f.name) && !f.name.startsWith('.'));
    if (!files.length) {
      setError('Không có ảnh JPG, PNG, WEBP hoặc BMP nào trong mục đã chọn.');
      return;
    }
    const added = files.map((file) => {
      const tooBig = limits && file.size > limits.max_photo_bytes;
      return {
        id: nextId.current++,
        file,
        status: tooBig ? 'error' : 'waiting',
        error: tooBig ? `Ảnh quá lớn (tối đa ${formatBytes(limits.max_photo_bytes)}).` : null,
        retry: false,
      };
    });
    setItems((prev) => [...added, ...prev]);
  }

  // The one place runs start: whatever is waiting goes as soon as nothing is in
  // flight, so files added mid-run, retries and a re-sign-in all queue up here.
  useEffect(() => {
    if (busy || !limits) return;
    const waiting = items.filter((it) => it.status === 'waiting');
    if (waiting.length) run(waiting);
  }, [busy, items, limits, run]);

  function retryFailed() {
    const failed = items.filter((it) => it.status === 'error' && it.retry);
    const ids = new Set(failed.map((it) => it.id));
    patch(ids, () => ({ status: 'waiting', error: null }));
  }

  const counts = useMemo(() => {
    const c = {};
    for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  }, [items]);

  const list = useMemo(() => {
    if (items.length <= LIST_LIMIT) return items.map((it) => <Row key={it.id} item={it} />);
    const failed = items.filter((it) => it.status === 'error');
    const rest = items
      .filter((it) => it.status !== 'error')
      .slice(0, Math.max(0, LIST_LIMIT - failed.length));
    return [...failed, ...rest].map((it) => <Row key={it.id} item={it} />);
  }, [items]);
  const retryable = items.some((it) => it.status === 'error' && it.retry);

  const header = (
    <header className="fa-topbar">
      <a className="fa-brand" href="/">
        <img className="fa-logo" src={logo} alt="Vĩnh Hưng" />
      </a>
      <div className="fa-topbar__end">
        <a href="/" className="fa-topbar__link">
          Xem thư viện
        </a>
        {limits && (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Logout}
            onClick={() => signOut()}
            disabled={busy}
          >
            Đăng xuất
          </Button>
        )}
      </div>
    </header>
  );

  if (!limits) {
    return (
      <Theme theme="white" className="fa-admin-page">
        {header}
        <main className="fa-admin">
          <form
            className="fa-admin__card fa-admin__signin"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) signIn(draft.trim());
            }}
          >
            <h1>Tải ảnh sự kiện</h1>
            <p>Nhập mã tải lên do ban tổ chức cung cấp.</p>
            <PasswordInput
              id="upload-token"
              labelText="Mã tải lên"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="current-password"
              disabled={signingIn}
            />
            {error && <InlineNotification kind="error" title={error} hideCloseButton lowContrast />}
            <Button type="submit" disabled={signingIn || !draft.trim()}>
              {signingIn ? 'Đang kiểm tra…' : 'Đăng nhập'}
            </Button>
          </form>
        </main>
      </Theme>
    );
  }

  const finished = (counts.done || 0) + (counts.duplicate || 0) + (counts.error || 0);

  return (
    <Theme theme="white" className="fa-admin-page">
      {header}
      <main className="fa-admin">
        <div className="fa-admin__head">
          <h1>Quản trị ảnh sự kiện</h1>
          {stats && (
            <p>
              {stats.photos.toLocaleString('vi-VN')} ảnh trong thư viện
              {stats.pending > 0 && ` · đang nhận diện khuôn mặt ${stats.pending} ảnh`}
            </p>
          )}
        </div>

        <div className="fa-chips fa-admin__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'upload'}
            className={`fa-chip${tab === 'upload' ? ' is-active' : ''}`}
            onClick={() => setTab('upload')}
          >
            Tải ảnh lên{busy ? ' (đang tải…)' : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'photos'}
            className={`fa-chip${tab === 'photos' ? ' is-active' : ''}`}
            onClick={() => setTab('photos')}
          >
            Quản lý ảnh
          </button>
        </div>

        {tab === 'photos' && (
          <AdminPhotos token={token} onUnauthorized={signOut} onChanged={refreshStats} />
        )}

        <div className="fa-admin__panel" hidden={tab !== 'upload'}>
          <div
            className={`fa-drop${dragging ? ' is-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragging(false);
              add(await droppedFiles(e.dataTransfer));
            }}
          >
            <CloudUpload size={32} />
            <strong>Kéo thả ảnh hoặc thư mục vào đây</strong>
            <span>
              JPG, PNG, WEBP · tối đa {formatBytes(limits.max_photo_bytes)} mỗi ảnh. Ảnh trùng sẽ
              được bỏ qua.
            </span>
            <div className="fa-drop__actions">
              <Button size="md" renderIcon={ImageIcon} onClick={() => pickFiles.current?.click()}>
                Chọn ảnh
              </Button>
              <Button
                size="md"
                kind="tertiary"
                renderIcon={Folder}
                onClick={() => pickFolder.current?.click()}
              >
                Chọn thư mục
              </Button>
            </div>
          </div>

          <input
            ref={pickFiles}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/bmp"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={pickFolder}
            type="file"
            webkitdirectory=""
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />

          {error && (
            <InlineNotification
              kind="error"
              title={error}
              onCloseButtonClick={() => setError(null)}
              lowContrast
            />
          )}

          {items.length > 0 && (
            <section className="fa-admin__card">
              <div className="fa-admin__summary">
                <span>
                  <strong>{finished}</strong>/{items.length} ảnh
                </span>
                {counts.done > 0 && <Tag type="green">{counts.done} đã nhận</Tag>}
                {counts.duplicate > 0 && <Tag type="cool-gray">{counts.duplicate} đã có</Tag>}
                {counts.error > 0 && <Tag type="red">{counts.error} lỗi</Tag>}
                <div className="fa-admin__summary-end">
                  {!busy && retryable && (
                    <Button size="sm" kind="tertiary" renderIcon={Renew} onClick={retryFailed}>
                      Thử lại ảnh lỗi
                    </Button>
                  )}
                  {!busy && (
                    <Button size="sm" kind="ghost" onClick={() => setItems([])}>
                      Xoá danh sách
                    </Button>
                  )}
                </div>
              </div>

              {busy && (
                <ProgressBar
                  label="Đang tải lên"
                  helperText={`${formatBytes(progressBytes)} / ${formatBytes(runBytes || 1)}`}
                  value={Math.min(progressBytes, runBytes)}
                  max={runBytes || 1}
                />
              )}

              <ul className="fa-admin__list">{list}</ul>
              {items.length > LIST_LIMIT && (
                <p className="fa-admin__more">
                  Đang hiện {list.length.toLocaleString('vi-VN')} trên{' '}
                  {items.length.toLocaleString('vi-VN')} ảnh (ảnh lỗi luôn hiện đầu tiên).
                </p>
              )}
            </section>
          )}
        </div>
      </main>
    </Theme>
  );
}
