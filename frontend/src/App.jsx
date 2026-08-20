import React, { useRef, useState } from 'react';
import { Theme, Button, InlineNotification, InlineLoading, Loading } from '@carbon/react';
import {
  Camera,
  Image as ImageIcon,
  Calendar,
  Download,
  Renew,
  Search,
} from '@carbon/icons-react';

import usePhotos from './hooks/usePhotos';
import JustifiedGrid from './components/JustifiedGrid';
import CameraModal from './components/CameraModal';
import Lightbox from './components/Lightbox';

export default function App() {
  const { photos, total, stats, loading, error, setError, pending, hasMore, loadMore, reload } =
    usePhotos();
  const [matches, setMatches] = useState(null); // null = browsing the whole gallery
  const [searching, setSearching] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [lightboxAt, setLightboxAt] = useState(null);
  const fileRef = useRef(null);

  const shown = matches ?? photos;
  const event = stats?.event;

  async function search(file) {
    if (!file) return;
    setSearching(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/search', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.statusText);
      setMatches(data.matches);
      document.querySelector('.fa-chips')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setError(e.message);
      setMatches(null);
    } finally {
      setSearching(false);
    }
  }

  async function downloadZip() {
    setZipping(true);
    try {
      const res = await fetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: matches.map((m) => m.path) }),
      });
      if (!res.ok) throw new Error('Không tạo được file .zip.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'anh-cua-toi.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setZipping(false);
    }
  }

  return (
    <Theme theme="white">
      <header className="fa-topbar">
        <a className="fa-brand" href="/">
          <img className="fa-logo" src="/ff-mark.png" alt="" aria-hidden="true" />
          <span className="fa-wordmark">FF AGENCY</span>
        </a>
      </header>

      <section className="fa-hero">
        <h1>{event?.name ?? 'Ảnh sự kiện'}</h1>
        <div className="fa-hero__actions">
          <button
            type="button"
            className="fa-cta"
            disabled={searching}
            onClick={() => setCameraOpen(true)}
          >
            <Search size={20} />
            Tìm ảnh của bạn
          </button>
          <button
            type="button"
            className="fa-cta is-ghost"
            disabled={searching}
            onClick={() => fileRef.current?.click()}
          >
            <ImageIcon size={20} />
            Tải ảnh lên
          </button>
        </div>
      </section>

      <div className="fa-facts">
        <div className="fa-facts__card">
          {/* the date half only appears when FACESCAN_EVENT_DATE is set */}
          {event?.date && (
            <>
              <div className="fa-fact">
                <span className="fa-fact__icon is-date">
                  <Calendar size={20} />
                </span>
                <span>{event.date}</span>
              </div>
              <span className="fa-fact__divider" />
            </>
          )}
          <div className="fa-fact">
            <span className="fa-fact__icon is-photos">
              <ImageIcon size={20} />
            </span>
            <span>{total.toLocaleString('vi-VN')} ảnh</span>
          </div>
        </div>
      </div>

      <main className="fa-main">
        <div className="fa-chips">
          <button
            type="button"
            className={`fa-chip${matches ? '' : ' is-active'}`}
            onClick={() => setMatches(null)}
          >
            Tất cả ảnh
          </button>
          {matches && (
            <button type="button" className="fa-chip is-active">
              Ảnh của bạn ({matches.length})
            </button>
          )}
          {matches && matches.length > 0 && (
            <div className="fa-chips__end">
              {zipping ? (
                <InlineLoading description="Đang nén ảnh…" />
              ) : (
                <Button size="sm" renderIcon={Download} onClick={downloadZip}>
                  Tải tất cả (.zip)
                </Button>
              )}
            </div>
          )}
        </div>

        {error && (
          <InlineNotification
            kind="error"
            title="Đã xảy ra lỗi"
            subtitle={error}
            onCloseButtonClick={() => setError(null)}
            lowContrast
          />
        )}

        {matches && matches.length === 0 && (
          <InlineNotification
            kind="info"
            title="Không tìm thấy ảnh nào"
            subtitle="Hãy thử ảnh rõ mặt, chụp chính diện và đủ sáng."
            hideCloseButton
            lowContrast
          />
        )}

        {!matches && pending > 0 && (
          <button type="button" className="fa-new" onClick={reload}>
            <Renew size={16} /> {pending} ảnh mới, bấm để xem
          </button>
        )}

        <p className="fa-count">
          <strong>{shown.length.toLocaleString('vi-VN')}</strong>{' '}
          {matches ? 'ảnh có bạn' : `ảnh được tìm thấy${hasMore ? ` (trong ${total})` : ''}`}
        </p>

        {loading ? (
          <div className="fa-loading">
            <Loading description="Đang tải ảnh" withOverlay={false} small />
            <p>Đang tải ảnh sự kiện…</p>
          </div>
        ) : shown.length === 0 && !matches ? (
          <div className="fa-empty">
            <ImageIcon size={32} />
            <p>Ảnh sự kiện sẽ xuất hiện ở đây ngay khi được tải lên.</p>
          </div>
        ) : (
          <JustifiedGrid
            photos={shown}
            onOpen={setLightboxAt}
            onLoadMore={loadMore}
            hasMore={!matches && hasMore}
          />
        )}
      </main>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          search(f);
        }}
      />

      {/* On phones the hero scrolls away; keep the camera one thumb-tap away */}
      <div className="fa-dock">
        <button type="button" className="fa-cta" onClick={() => setCameraOpen(true)}>
          <Camera size={20} />
          Chụp ảnh tìm ảnh của bạn
        </button>
      </div>

      {searching && (
        <div className="fa-searching" role="status" aria-live="polite">
          <div className="fa-searching__card">
            <span className="fa-spinner" aria-hidden="true" />
            <strong>Đang tìm ảnh có bạn…</strong>
            <span>Quá trình này mất vài giây.</span>
          </div>
        </div>
      )}

      <CameraModal
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onUse={(file) => {
          setCameraOpen(false);
          search(file);
        }}
      />

      {lightboxAt !== null && (
        <Lightbox
          photos={shown}
          index={lightboxAt}
          onIndex={setLightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      )}
    </Theme>
  );
}
