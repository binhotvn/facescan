import React, { memo, useCallback, useEffect, useState } from 'react';
import { Button, InlineNotification, Loading, Modal } from '@carbon/react';
import { CheckmarkFilled, Renew, TrashCan } from '@carbon/icons-react';

const PAGE_SIZE = 120;

const Tile = memo(function Tile({ photo, selected, onToggle }) {
  return (
    <button
      type="button"
      className={`fa-manage__tile${selected ? ' is-selected' : ''}`}
      onClick={() => onToggle(photo.id)}
      aria-pressed={selected}
      title={photo.path.split('/').pop()}
    >
      <img src={photo.thumb} alt="" loading="lazy" decoding="async" />
      {photo.faces == null && <span className="fa-manage__badge">Đang nhận diện</span>}
      <CheckmarkFilled size={24} className="fa-manage__check" />
    </button>
  );
});

/** The admin's view of the gallery: pick photos and take them down. */
export default function AdminPhotos({ token, onUnauthorized, onChanged }) {
  const [photos, setPhotos] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (offset) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/photos?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error('Không tải được thư viện ảnh.');
      const data = await res.json();
      setTotal(data.total);
      setPhotos((prev) => {
        if (offset === 0) return data.photos;
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...data.photos.filter((p) => !seen.has(p.id))];
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch('/api/photos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Upload-Token': token },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 503) {
        onUnauthorized(data.detail || 'Phiên đăng nhập đã hết hạn.');
        return;
      }
      if (!res.ok) throw new Error(data.detail || 'Không xoá được ảnh.');
      setPhotos((prev) => prev.filter((p) => !selected.has(p.id)));
      setTotal((n) => n - data.deleted);
      setSelected(new Set());
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  const count = selected.size;

  return (
    <section className="fa-manage">
      <div className="fa-manage__bar">
        <span>
          {count > 0 ? (
            <>
              Đã chọn <strong>{count}</strong> ảnh
            </>
          ) : (
            <>
              <strong>{total.toLocaleString('vi-VN')}</strong> ảnh · bấm vào ảnh để chọn
            </>
          )}
        </span>
        <div className="fa-manage__bar-end">
          {count > 0 ? (
            <>
              <Button size="sm" kind="ghost" onClick={() => setSelected(new Set())}>
                Bỏ chọn
              </Button>
              <Button
                size="sm"
                kind="danger"
                renderIcon={TrashCan}
                onClick={() => setConfirming(true)}
              >
                Xoá {count} ảnh
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              kind="ghost"
              renderIcon={Renew}
              onClick={() => load(0)}
              disabled={loading}
            >
              Làm mới
            </Button>
          )}
        </div>
      </div>

      {error && (
        <InlineNotification
          kind="error"
          title={error}
          onCloseButtonClick={() => setError(null)}
          lowContrast
        />
      )}

      {photos.length === 0 && !loading ? (
        <p className="fa-manage__empty">Chưa có ảnh nào.</p>
      ) : (
        <div className="fa-manage__grid">
          {photos.map((p) => (
            <Tile key={p.id} photo={p} selected={selected.has(p.id)} onToggle={toggle} />
          ))}
        </div>
      )}

      {loading && (
        <div className="fa-loading">
          <Loading withOverlay={false} small description="Đang tải ảnh" />
        </div>
      )}
      {!loading && photos.length < total && (
        <Button kind="tertiary" className="fa-manage__more" onClick={() => load(photos.length)}>
          Xem thêm ảnh ({(total - photos.length).toLocaleString('vi-VN')})
        </Button>
      )}

      <Modal
        open={confirming}
        danger
        modalHeading={`Xoá ${count} ảnh?`}
        primaryButtonText={deleting ? 'Đang xoá…' : 'Xoá vĩnh viễn'}
        primaryButtonDisabled={deleting}
        secondaryButtonText="Huỷ"
        onRequestClose={() => !deleting && setConfirming(false)}
        onRequestSubmit={remove}
        size="xs"
      >
        <p>Ảnh sẽ bị gỡ khỏi thư viện và xoá khỏi máy chủ. Không thể hoàn tác.</p>
      </Modal>
    </section>
  );
}
