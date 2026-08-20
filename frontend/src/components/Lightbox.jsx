import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@carbon/react';
import { Download, Share, Close, ChevronLeft, ChevronRight } from '@carbon/icons-react';

const canShare = typeof navigator !== 'undefined' && !!navigator.share;

const EXIT_MS = 160;

export default function Lightbox({ photos, index, onIndex, onClose }) {
  const touchX = useRef(null);
  const [closing, setClosing] = useState(false);
  const photo = photos[index];

  // exit the way it entered, instead of the viewer vanishing on unmount
  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, EXIT_MS);
  }, [onClose]);

  const move = useCallback(
    (delta) => {
      const next = index + delta;
      if (next >= 0 && next < photos.length) onIndex(next);
    },
    [index, onIndex, photos.length]
  );

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') move(-1);
      if (e.key === 'ArrowRight') move(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, close]);

  if (!photo) return null;

  async function share() {
    try {
      const blob = await fetch(photo.medium).then((r) => r.blob());
      const file = new File([blob], photo.path.split('/').pop(), { type: 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Ảnh FF Agency' });
      } else {
        await navigator.share({ title: 'Ảnh FF Agency', url: window.location.href });
      }
    } catch {
      /* user dismissed the share sheet */
    }
  }

  return (
    <div
      className="fa-lightbox"
      data-state={closing ? 'closing' : 'open'}
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh"
      onTouchStart={(e) => {
        touchX.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (Math.abs(dx) > 50) move(dx < 0 ? 1 : -1);
        touchX.current = null;
      }}
    >
      <div className="fa-lightbox__bar">
        <span className="fa-lightbox__count">
          {index + 1} / {photos.length}
        </span>
        <button type="button" className="fa-lightbox__nav is-close" aria-label="Đóng" onClick={close}>
          <Close size={24} />
        </button>
      </div>

      <img
        className="fa-lightbox__img"
        key={photo.url} /* remount per photo so each one fades in */
        src={photo.medium}
        alt="Ảnh sự kiện"
      />

      {index > 0 && (
        <button
          type="button"
          className="fa-lightbox__nav is-prev"
          aria-label="Ảnh trước"
          onClick={() => move(-1)}
        >
          <ChevronLeft size={24} />
        </button>
      )}
      {index < photos.length - 1 && (
        <button
          type="button"
          className="fa-lightbox__nav is-next"
          aria-label="Ảnh sau"
          onClick={() => move(1)}
        >
          <ChevronRight size={24} />
        </button>
      )}

      <div className="fa-lightbox__actions">
        <Button renderIcon={Download} href={photo.download}>
          Tải ảnh
        </Button>
        {canShare && (
          <Button kind="tertiary" renderIcon={Share} onClick={share}>
            Chia sẻ
          </Button>
        )}
      </div>
    </div>
  );
}
