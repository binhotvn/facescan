import React, { useEffect, useMemo, useRef, useState } from 'react';

const GAP = 4;

/** Pack photos into full-width rows at their real aspect ratios (Google Photos style). */
function buildRows(photos, containerWidth, targetHeight) {
  if (!containerWidth) return [];
  const rows = [];
  let row = [];
  let ratioSum = 0;

  const flush = (justify) => {
    if (!row.length) return;
    const available = containerWidth - GAP * (row.length - 1);
    const height = justify ? available / ratioSum : Math.min(targetHeight, available / ratioSum);
    rows.push({
      height,
      items: row.map((p) => ({ photo: p, width: p.ratio * height, height })),
    });
    row = [];
    ratioSum = 0;
  };

  for (const p of photos) {
    row.push(p);
    ratioSum += p.ratio;
    if (ratioSum * targetHeight >= containerWidth - GAP * (row.length - 1)) flush(true);
  }
  flush(false); // trailing row keeps target height instead of stretching
  return rows;
}

export default function JustifiedGrid({ photos, onOpen, onLoadMore, hasMore }) {
  const ref = useRef(null);
  const sentinel = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return undefined;
    const io = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && onLoadMoreRef.current?.(),
      { rootMargin: '600px' } // fetch before the reader hits the bottom
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, photos.length]);

  const targetHeight = width < 700 ? 150 : 240;
  // carry the original index: the rows hold copies, so indexOf would not find them
  const sized = useMemo(
    () => photos.map((p, i) => ({ ...p, index: i, ratio: p.w && p.h ? p.w / p.h : 1.5 })),
    [photos]
  );
  const rows = useMemo(
    () => buildRows(sized, width, targetHeight),
    [sized, width, targetHeight]
  );

  return (
    <div className="fa-grid" ref={ref}>
      {rows.map((row, ri) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="fa-grid__row" key={ri} style={{ height: row.height, gap: GAP }}>
          {row.items.map(({ photo, width: w, height: h }) => (
            <button
              type="button"
              key={photo.id ?? photo.url}
              className="fa-cell"
              style={{ width: w, height: h }}
              onClick={() => onOpen(photo.index)}
            >
              <img
                src={photo.thumb}
                loading="lazy"
                alt="Ảnh sự kiện"
                width={w}
                height={h}
                onLoad={(e) => e.currentTarget.classList.add('is-loaded')}
              />
            </button>
          ))}
        </div>
      ))}
      <div ref={sentinel} className="fa-grid__sentinel" aria-hidden="true" />
    </div>
  );
}
