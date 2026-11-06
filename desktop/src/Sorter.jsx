import React, { useCallback, useEffect, useRef, useState } from 'react';

const api = window.kapok;
const PAGE = 300;
const num = (n) => (n ?? 0).toLocaleString('vi-VN');

/** Where a view's photos live, for messages: "vào “Gala Dinner”", "khỏi thư mục". */
const intoText = (name) => (name == null ? 'ra khỏi thư mục' : `vào “${name}”`);

/**
 * Every photo already on the server, to pick out and file into albums: click
 * to pick, Shift+click for a run, drag across to pick many, then choose the
 * album at the bottom. The last move can be taken back. Picked photos can also
 * be deleted from the server, and the album on show renamed or removed.
 */
export default function Sorter({ modes, url, token, albums, unsorted, total, onChanged, onAlbumGone, locked, flash }) {
  const [view, setView] = useState(null); // null: every photo, 0: in no album, else an album id
  const [photos, setPhotos] = useState([]);
  const [count, setCount] = useState(0); // in this view, on the server
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState(null); // the album being named, null when closed
  const [undo, setUndo] = useState(null); // {text, groups: [[album, ids]]}
  const [sure, setSure] = useState(false); // asking before deleting the picked photos
  const [rename, setRename] = useState(null); // the album's new name being typed, null when closed
  const [dropping, setDropping] = useState(false); // asking before removing the album on show
  const req = useRef(0);
  const anchor = useRef(null); // the last photo picked by a plain click, for Shift+click
  const paint = useRef(null); // while dragging across photos: true picks, false drops

  const nameOf = useCallback((id) => albums.find((a) => a.id === id)?.name ?? null, [albums]);

  const load = useCallback(async () => {
    const my = ++req.current; // a later click on another view wins
    setLoading(true);
    setError(null);
    const r = await api.listPhotos(url, token, { album: view, limit: PAGE });
    if (my !== req.current) return;
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setPhotos(r.photos);
    setCount(r.total);
  }, [url, token, view]);

  useEffect(() => {
    setPicked(new Set());
    anchor.current = null;
    load();
  }, [load]);

  useEffect(() => {
    setRename(null);
    setDropping(false);
  }, [view]);

  // nothing picked: nothing to delete
  useEffect(() => {
    if (picked.size === 0) setSure(false);
  }, [picked]);

  // the album being shown was deleted elsewhere
  useEffect(() => {
    if (view && !albums.some((a) => a.id === view)) setView(null);
  }, [albums, view]);

  const loadMore = async () => {
    const my = req.current;
    setLoadingMore(true);
    const r = await api.listPhotos(url, token, { album: view, offset: photos.length, limit: PAGE });
    setLoadingMore(false);
    if (my !== req.current) return;
    if (!r.ok) return flash(r.error, 'err');
    // new uploads shift the pages: skip what is already here
    setPhotos((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      return [...prev, ...r.photos.filter((p) => !seen.has(p.id))];
    });
    setCount(r.total);
    return undefined;
  };

  // -- picking
  const set = (ids, on) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const down = (e, i) => {
    if (e.button !== 0) return;
    const id = photos[i].id;
    if (e.shiftKey && anchor.current != null) {
      const from = photos.findIndex((p) => p.id === anchor.current);
      if (from >= 0) {
        const [a, b] = from < i ? [from, i] : [i, from];
        set(photos.slice(a, b + 1).map((p) => p.id), true);
        return;
      }
    }
    const on = !picked.has(id);
    set([id], on);
    anchor.current = id;
    paint.current = on;
  };

  const over = (i) => {
    if (paint.current != null) set([photos[i].id], paint.current);
  };

  useEffect(() => {
    const stop = () => {
      paint.current = null;
    };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  const pickAll = () => set(photos.map((p) => p.id), true);
  const clear = () => setPicked(new Set());

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') {
        setSure(false);
        clear();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (picked.size) setSure(true);
      } else if (e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        set(photos.map((p) => p.id), true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos, picked]);

  // -- filing
  /** Move photos and keep the window in step without reloading what is on screen. */
  const file = async (ids, album) => {
    const r = await api.movePhotos(url, token, ids, album);
    if (!r.ok) {
      flash(r.error, 'err');
      onChanged(); // an album deleted elsewhere leaves the list
      return false;
    }
    const moved = new Set(ids);
    if (view === null) {
      setPhotos((prev) => prev.map((p) => (moved.has(p.id) ? { ...p, album } : p)));
    } else if (view !== (album ?? 0)) {
      setPhotos((prev) => prev.filter((p) => !moved.has(p.id)));
      setCount((c) => Math.max(0, c - ids.length));
    }
    onChanged();
    return true;
  };

  const moveTo = async (album, name = nameOf(album)) => {
    const ids = [...picked];
    const before = new Map(); // album each photo came from, to take the move back
    for (const p of photos) {
      if (!picked.has(p.id) || p.album === album) continue;
      before.set(p.album, [...(before.get(p.album) ?? []), p.id]);
    }
    setBusy(true);
    const ok = await file(ids, album);
    setBusy(false);
    if (!ok) return;
    const text = `Đã chuyển ${num(ids.length)} ảnh ${intoText(name)}.`;
    setUndo({ text, groups: [...before] }); // shown above the photos
    clear();
  };

  const takeBack = async () => {
    const { groups } = undo;
    setUndo(null);
    setBusy(true);
    for (const [album, ids] of groups) {
      const r = await api.movePhotos(url, token, ids, album);
      if (!r.ok) {
        flash(`Không hoàn tác được: ${r.error}`, 'err');
        break;
      }
    }
    setBusy(false);
    onChanged();
    load(); // photos may come back into this view
  };

  const createAndMove = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    const r = await api.createAlbum(url, token, name);
    setBusy(false);
    if (!r.ok) {
      flash(r.error, 'err');
      return;
    }
    setNewName(null);
    await moveTo(r.album.id, r.album.name);
  };

  // -- deleting photos: for good, there is no taking it back
  const deletePicked = async () => {
    const ids = [...picked];
    setBusy(true);
    const r = await api.deletePhotos(url, token, ids);
    setBusy(false);
    setSure(false);
    if (!r.ok) {
      flash(r.error, 'err');
      load(); // some batches may have gone through
      onChanged();
      return;
    }
    const gone = new Set(ids);
    setPhotos((prev) => prev.filter((p) => !gone.has(p.id)));
    setCount((c) => Math.max(0, c - r.deleted));
    setUndo(null); // a move that touched these photos can no longer be taken back whole
    clear();
    flash(`Đã xoá ${num(r.deleted)} ảnh khỏi máy chủ.`, 'ok');
    onChanged();
  };

  // -- the album on show
  const shown = view ? albums.find((a) => a.id === view) : null;

  const saveName = async (e) => {
    e.preventDefault();
    const name = rename.trim();
    if (!shown || !name || name === shown.name) {
      setRename(null);
      return;
    }
    setBusy(true);
    const r = await api.renameAlbum(url, token, shown.id, name);
    setBusy(false);
    if (!r.ok) {
      flash(r.error, 'err');
      onChanged();
      return;
    }
    setRename(null);
    flash(`Đã đổi tên thành “${r.album.name}”.`, 'ok');
    onChanged();
  };

  const dropAlbum = async () => {
    if (!shown) return;
    const { id, name } = shown;
    setBusy(true);
    const r = await api.deleteAlbum(url, token, id);
    setBusy(false);
    setDropping(false);
    if (!r.ok) {
      flash(r.error, 'err');
      onChanged();
      return;
    }
    setUndo(null); // its moves pointed at an album that is gone
    onAlbumGone(id);
    setView(null);
    flash(`Đã xoá thư mục “${name}”. ${num(r.unsorted)} ảnh trong đó về Chưa vào thư mục.`, 'ok');
    onChanged();
  };

  const views = [
    [null, 'Tất cả', total],
    [0, 'Chưa vào thư mục', unsorted],
    ...albums.map((a) => [a.id, a.name, a.photos]),
  ];
  const n = picked.size;

  return (
    <>
      <header className="card__head">
        {modes}
        <div className="segmented segmented--inline sorter__views" role="tablist" aria-label="Xem ảnh trong">
          {views.map(([id, label, c]) => (
            <button
              key={id ?? 'all'}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={view === id ? 'is-on' : ''}
              onClick={() => setView(id)}
            >
              {label} <b>{c == null ? '' : num(c)}</b>
            </button>
          ))}
        </div>
      </header>

      <div className="sortbar">
        <span className="sortbar__text">
          {n > 0 ? (
            <>
              <strong>{num(n)} ảnh đã chọn</strong>
              <button type="button" className="btn btn--link" onClick={clear}>
                Bỏ chọn
              </button>
            </>
          ) : rename !== null ? (
            <form className="movebar__new" onSubmit={saveName}>
              <input
                autoFocus
                value={rename}
                maxLength={60}
                aria-label="Tên mới của thư mục"
                disabled={busy}
                onChange={(e) => setRename(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setRename(null)}
              />
              <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !rename.trim()}>
                Lưu tên
              </button>
              <button type="button" className="btn btn--link" onClick={() => setRename(null)}>
                Huỷ
              </button>
            </form>
          ) : dropping && shown ? (
            <>
              <strong>
                Xoá thư mục “{shown.name}”? {num(shown.photos)} ảnh trong đó vẫn còn trên máy chủ, về Chưa vào thư mục.
              </strong>
              <button type="button" className="btn btn--sm btn--stop" disabled={busy} onClick={dropAlbum}>
                Xoá thư mục
              </button>
              <button type="button" className="btn btn--link" onClick={() => setDropping(false)}>
                Huỷ
              </button>
            </>
          ) : undo ? (
            <>
              {undo.text}
              {undo.groups.length > 0 && (
                <button type="button" className="btn btn--link" onClick={takeBack} disabled={busy}>
                  Hoàn tác
                </button>
              )}
            </>
          ) : (
            'Bấm để chọn ảnh, Shift+bấm để chọn liền một dải, hoặc giữ chuột kéo qua nhiều ảnh.'
          )}
        </span>
        {shown && n === 0 && rename === null && !dropping && (
          <>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setRename(shown.name)}>
              Đổi tên thư mục
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || locked}
              title={locked ? 'Đang tải lên: dừng trước khi xoá thư mục.' : undefined}
              onClick={() => setDropping(true)}
            >
              Xoá thư mục
            </button>
          </>
        )}
        <button type="button" className="btn btn--sm" onClick={pickAll} disabled={!photos.length}>
          Chọn tất cả{count > photos.length ? ` ${num(photos.length)} ảnh đang hiện` : ''}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={loading}
          onClick={() => {
            clear();
            load();
          }}
        >
          Tải lại
        </button>
      </div>

      {error ? (
        <div className="empty">
          <strong>Không tải được ảnh trên máy chủ</strong>
          <span>{error}</span>
          <button type="button" className="btn" onClick={load}>
            Thử lại
          </button>
        </div>
      ) : loading && photos.length === 0 ? (
        <div className="empty">
          <span>Đang tải ảnh trên máy chủ…</span>
        </div>
      ) : photos.length === 0 ? (
        <div className="empty">
          <strong>{view === null ? 'Máy chủ chưa có ảnh nào' : 'Không có ảnh nào ở đây'}</strong>
          <span>
            {view === 0
              ? 'Mọi ảnh đều đã vào thư mục.'
              : view === null
                ? 'Ảnh tải lên sẽ hiện ở đây để phân loại.'
                : 'Chọn ảnh ở Tất cả hoặc Chưa vào thư mục rồi chuyển vào đây.'}
          </span>
        </div>
      ) : (
        <div className={`tiles${n ? ' is-picking' : ''}${loading ? ' is-loading' : ''}`}>
          {photos.map((p, i) => {
            const on = picked.has(p.id);
            const album = view === null && p.album ? nameOf(p.album) : null;
            return (
              <button
                key={p.id}
                type="button"
                className={`tile pick${on ? ' is-on' : ''}`}
                aria-pressed={on}
                title={album ? `${album} · ${p.name}` : p.name}
                onPointerDown={(e) => down(e, i)}
                onPointerEnter={() => over(i)}
                onClick={(e) => e.detail === 0 && set([p.id], !on)} // keyboard: Space / Enter
              >
                <img src={p.thumb} alt="" loading="lazy" draggable={false} />
                <span className="pick__check" aria-hidden="true" />
                {p.faces > 0 && <span className="faces">{p.faces} mặt</span>}
                <span className="tile__name">
                  {album && <b>{album} · </b>}
                  {p.name}
                </span>
              </button>
            );
          })}
          {count > photos.length && (
            <button type="button" className="btn tiles__more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Đang tải…' : `Xem thêm (${num(count - photos.length)} ảnh nữa)`}
            </button>
          )}
        </div>
      )}

      {n > 0 && sure && (
        <footer className="movebar" aria-label="Xoá ảnh đã chọn">
          <span className="movebar__label">
            Xoá hẳn {num(n)} ảnh khỏi máy chủ? Khách sẽ không còn thấy, và không hoàn tác được.
          </span>
          <button type="button" className="btn btn--sm btn--stop" disabled={busy} onClick={deletePicked}>
            {busy ? 'Đang xoá…' : `Xoá ${num(n)} ảnh`}
          </button>
          <button type="button" className="btn btn--link" disabled={busy} onClick={() => setSure(false)}>
            Huỷ
          </button>
        </footer>
      )}

      {n > 0 && !sure && (
        <footer className="movebar" aria-label="Chuyển ảnh đã chọn">
          <span className="movebar__label">Chuyển {num(n)} ảnh vào</span>
          {albums.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn btn--sm"
              disabled={busy || view === a.id}
              onClick={() => moveTo(a.id)}
            >
              {a.name}
            </button>
          ))}
          {newName === null ? (
            <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => setNewName('')}>
              + Thư mục mới
            </button>
          ) : (
            <form className="movebar__new" onSubmit={createAndMove}>
              <input
                autoFocus
                value={newName}
                maxLength={60}
                placeholder="Tên thư mục, VD: Gala Dinner"
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setNewName(null)}
              />
              <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !newName.trim()}>
                Tạo và chuyển
              </button>
              <button type="button" className="btn btn--link" onClick={() => setNewName(null)}>
                Huỷ
              </button>
            </form>
          )}
          {view !== 0 && (
            <button type="button" className="btn btn--link movebar__out" disabled={busy} onClick={() => moveTo(null)}>
              Bỏ khỏi thư mục
            </button>
          )}
          <button
            type="button"
            className={`btn btn--sm btn--stop${view === 0 ? ' movebar__out' : ''}`}
            disabled={busy}
            onClick={() => {
              setNewName(null);
              setSure(true);
            }}
          >
            Xoá ảnh
          </button>
        </footer>
      )}
    </>
  );
}
