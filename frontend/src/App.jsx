import React, { useRef, useState } from 'react';
import { Theme, Button, InlineNotification, InlineLoading, Loading } from '@carbon/react';
import {
  Camera,
  Image as ImageIcon,
  Calendar,
  Download,
  FaceActivated,
  Renew,
  Search,
} from '@carbon/icons-react';

import usePhotos from './hooks/usePhotos';
import JustifiedGrid from './components/JustifiedGrid';
import CameraModal from './components/CameraModal';
import Lightbox from './components/Lightbox';
import logoWhite from './assets/vinhhung-logo-white.png';
import heroKv from './assets/hero-kv.webp';

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="fa-stat">
      <span className="fa-stat__icon">
        <Icon size={24} />
      </span>
      <span className="fa-stat__text">
        <span className="fa-stat__label">{label}</span>
        <strong className="fa-stat__value">{value}</strong>
      </span>
    </div>
  );
}

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
    <Theme theme="white" className="fa-page">
      <section className="fa-hero">
        <a href="/" aria-label="Vĩnh Hưng">
          <img className="fa-hero__logo" src={logoWhite} width="571" height="120" alt="" />
        </a>
        <h1>{event?.name ?? 'Ảnh sự kiện'}</h1>
        <img
          className="fa-hero__kv"
          src={heroKv}
          width="1108"
          height="854"
          fetchpriority="high"
          alt="Sự kiện tri ân khách hàng & đối tác nhân dịp 20 năm thành lập Vĩnh Hưng. 20 năm, 2006 – 2026: Vững nội lực, vươn tầm vóc"
        />
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
          <Stat icon={ImageIcon} label="Ảnh sự kiện" value={total.toLocaleString('vi-VN')} />
          <Stat
            icon={FaceActivated}
            label="Khuôn mặt"
            value={(stats?.faces ?? 0).toLocaleString('vi-VN')}
          />
          {/* only when FACESCAN_EVENT_DATE is set */}
          {event?.date && <Stat icon={Calendar} label="Thời gian" value={event.date} />}
        </div>
      </div>

      <main className="fa-main">
        <h2 className="fa-title">{matches ? 'Ảnh của bạn' : 'Thư viện ảnh'}</h2>
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
            <span className="fa-empty__icon">
              <ImageIcon size={28} />
            </span>
            <strong>Chưa có ảnh nào</strong>
            <p>Ảnh sự kiện sẽ xuất hiện ở đây ngay khi được tải lên. Hãy quay lại sau nhé!</p>
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

      <footer className="fa-footer">
        <img src={logoWhite} width="571" height="120" alt="Vĩnh Hưng" loading="lazy" />
        <strong>Công ty Cổ phần Thương mại, Tư vấn và Xây dựng Vĩnh Hưng</strong>
        <span>20 năm · 2006 – 2026 · Vững nội lực, vươn tầm vóc</span>
      </footer>

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
