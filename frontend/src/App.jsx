import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Theme,
  Header,
  HeaderName,
  Button,
  Tag,
  Tile,
  InlineNotification,
  InlineLoading,
  Modal,
  Loading,
} from '@carbon/react';
import { Camera, Image as ImageIcon, ArrowLeft } from '@carbon/icons-react';

const PAGE_SIZE = 120;

export default function App() {
  const [stats, setStats] = useState(null);
  const [gallery, setGallery] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState(null); // null = showing the whole gallery
  const [error, setError] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);

  const loadPage = useCallback(async (offset = 0) => {
    const res = await fetch(`/api/photos?limit=${PAGE_SIZE}&offset=${offset}`);
    const data = await res.json();
    setTotal(data.total);
    setGallery((prev) => (offset === 0 ? data.photos : [...prev, ...data.photos]));
  }, []);

  useEffect(() => {
    Promise.all([
      fetch('/api/stats').then((r) => r.json()).then(setStats),
      loadPage(0),
    ])
      .catch(() => setError('Không tải được thư viện ảnh.'))
      .finally(() => setLoading(false));
  }, [loadPage]);

  async function runSearch(file) {
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
    } catch (err) {
      setError(err.message);
      setMatches(null);
    } finally {
      setSearching(false);
    }
  }

  async function openCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      streamRef.current = stream;
      setCameraOpen(true);
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
    } catch (err) {
      setError(`Không mở được máy ảnh: ${err.message}`);
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
  }

  function capture() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        closeCamera();
        runSearch(new File([blob], 'selfie.jpg', { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92
    );
  }

  const photos = matches ?? gallery;
  const showLoadMore = !matches && gallery.length < total;

  return (
    <Theme theme="g100">
      <Header aria-label="FF Agency">
        <HeaderName href="/" prefix="FF">
          Agency
        </HeaderName>
      </Header>

      <main className="fa-main">
        <div className="fa-bar">
          <div className="fa-bar__text">
            <h1>{matches ? `Tìm thấy ${matches.length} ảnh có bạn` : 'Ảnh sự kiện'}</h1>
            <p>
              {matches
                ? 'Bấm vào ảnh để xem cỡ lớn hoặc tải về.'
                : stats
                  ? `${stats.photos} ảnh · ${stats.faces} khuôn mặt. Tải lên ảnh chân dung để tìm ảnh có bạn.`
                  : 'Đang tải…'}
            </p>
          </div>

          <div className="fa-bar__actions">
            {searching ? (
              <InlineLoading description="Đang tìm ảnh có bạn…" />
            ) : matches ? (
              <Button kind="tertiary" renderIcon={ArrowLeft} onClick={() => setMatches(null)}>
                Xem tất cả ảnh
              </Button>
            ) : (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    runSearch(f);
                  }}
                />
                <Button renderIcon={ImageIcon} onClick={() => fileRef.current?.click()}>
                  Tải ảnh lên để tìm
                </Button>
                <Button kind="tertiary" renderIcon={Camera} onClick={openCamera}>
                  Chụp ảnh
                </Button>
              </>
            )}
          </div>
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
            subtitle="Hãy thử ảnh chân dung rõ mặt, chụp chính diện."
            hideCloseButton
            lowContrast
          />
        )}

        {loading ? (
          <Loading description="Đang tải ảnh" withOverlay={false} />
        ) : photos.length === 0 && !matches ? (
          <Tile className="fa-empty">
            <h4>Thư viện đang trống</h4>
            <p>Thêm ảnh vào thư mục photos/ rồi chạy lệnh lập chỉ mục.</p>
          </Tile>
        ) : (
          <div className="fa-gallery">
            {photos.map((p) => (
              <button
                type="button"
                key={p.url}
                className="fa-cell"
                onClick={() => setLightbox(p)}
              >
                <img src={p.thumb} loading="lazy" alt="Ảnh sự kiện" />
                {p.score != null && (
                  <Tag className="fa-cell__tag" type="green" size="sm">
                    {Math.round(p.score * 100)}%
                  </Tag>
                )}
              </button>
            ))}
          </div>
        )}

        {showLoadMore && (
          <div className="fa-more">
            <Button kind="ghost" onClick={() => loadPage(gallery.length)}>
              Tải thêm ảnh ({gallery.length}/{total})
            </Button>
          </div>
        )}
      </main>

      <Modal
        open={cameraOpen}
        modalHeading="Chụp ảnh chân dung"
        primaryButtonText="Chụp"
        secondaryButtonText="Huỷ"
        onRequestSubmit={capture}
        onRequestClose={closeCamera}
      >
        {cameraOpen && <video className="fa-video" ref={videoRef} autoPlay playsInline muted />}
      </Modal>

      <Modal
        open={!!lightbox}
        passiveModal
        modalHeading="Ảnh sự kiện"
        onRequestClose={() => setLightbox(null)}
        size="lg"
      >
        {lightbox && (
          <>
            <img className="fa-full" src={lightbox.url} alt="Ảnh sự kiện cỡ lớn" />
            <Button
              className="fa-download"
              kind="tertiary"
              href={lightbox.url}
              target="_blank"
              rel="noreferrer"
            >
              Mở ảnh gốc
            </Button>
          </>
        )}
      </Modal>
    </Theme>
  );
}
