import React, { useEffect, useRef, useState } from 'react';

const api = window.kapok;

/** A sent photo, large, with the faces this machine found on it. */
export default function Viewer({ tile, index, total, badge, revealLabel, onClose, onStep, onError }) {
  const [photo, setPhoto] = useState(undefined); // undefined while loading, null if the file is gone
  const [crops, setCrops] = useState(null);
  const [hot, setHot] = useState(null);
  const strip = useRef(null);

  // boxes are in the sent photo's pixels: without its size they cannot be placed
  const { width: w, height: h } = tile;
  const boxes = tile.boxes && w && h ? tile.boxes : null;

  useEffect(() => {
    let live = true;
    setPhoto(undefined);
    setCrops(null);
    setHot(null);
    // the viewing copy first, then the faces cut sharp from the original
    api.preview(tile.file).then((p) => {
      if (!live) return;
      setPhoto(p);
      if (p && boxes?.length) api.faceCrops(tile.file, boxes, w, h).then((c) => live && setCrops(c));
    });
    return () => {
      live = false;
    };
    // a tile's faces never change: its file is the whole identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.file]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onStep(-1);
      else if (e.key === 'ArrowRight') onStep(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);

  // pointing at a face on the photo brings its crop into view
  useEffect(() => {
    if (hot != null) strip.current?.children[hot]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [hot]);

  const openOriginal = async () => {
    const why = await api.openFile(tile.file);
    if (why) onError(`Không mở được file gốc: ${why}`);
  };

  const pct = (v, of) => `${(100 * v) / of}%`;
  const hover = (i) => ({
    onMouseEnter: () => setHot(i),
    onMouseLeave: () => setHot(null),
    onFocus: () => setHot(i),
    onBlur: () => setHot(null),
  });

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={tile.name} onClick={onClose}>
      <div className="viewer__panel" onClick={(e) => e.stopPropagation()}>
        <header className="viewer__head">
          <span className={`badge is-${badge.tone}`}>{badge.label}</span>
          <strong className="viewer__name" title={tile.file}>
            {tile.name}
          </strong>
          <span className="muted small">
            {index + 1}/{total}
          </span>
          <div className="viewer__actions">
            <button type="button" className="btn btn--sm" onClick={() => onStep(-1)} disabled={index === 0} aria-label="Ảnh trước">
              ‹
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onStep(1)}
              disabled={index === total - 1}
              aria-label="Ảnh sau"
            >
              ›
            </button>
            <button type="button" className="btn btn--sm" onClick={() => api.reveal(tile.file)} disabled={photo === null}>
              {revealLabel}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={openOriginal} disabled={photo === null}>
              Mở file gốc
            </button>
            <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Đóng">
              ✕
            </button>
          </div>
        </header>

        {tile.error && <p className="viewer__error">{tile.error}</p>}

        <div className="viewer__stage">
          {photo === undefined && <span className="muted">Đang mở ảnh…</span>}
          {photo === null && <span className="muted">Không mở được ảnh. File gốc có thể đã bị chuyển đi hoặc xoá.</span>}
          {photo && (
            <div className="viewer__frame" style={{ '--ar': photo.width / photo.height }}>
              <img src={photo.src} alt={tile.name} draggable={false} />
              {boxes?.map(([x0, y0, x1, y1], i) => (
                <span
                  key={i}
                  className={`viewer__box${hot === i ? ' is-hot' : ''}`}
                  style={{ left: pct(x0, w), top: pct(y0, h), width: pct(x1 - x0, w), height: pct(y1 - y0, h) }}
                  {...hover(i)}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="viewer__faces">
          {boxes == null ? (
            <p className="muted small">Ảnh này không được nhận diện trên máy này. Máy chủ sẽ tự tìm khuôn mặt.</p>
          ) : boxes.length === 0 ? (
            <p className="muted small">Không thấy khuôn mặt nào trong ảnh.</p>
          ) : (
            <>
              <p className="small">
                <strong>{boxes.length} khuôn mặt</strong>
                <span className="muted"> · rê chuột lên một khuôn mặt để thấy vị trí của nó trong ảnh</span>
              </p>
              <div className="viewer__strip" ref={strip}>
                {boxes.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`viewer__face${hot === i ? ' is-hot' : ''}`}
                    aria-label={`Khuôn mặt ${i + 1}`}
                    {...hover(i)}
                  >
                    {crops?.[i] && <img src={crops[i]} alt="" draggable={false} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
