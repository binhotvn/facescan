import React from 'react';
import { DataBase } from '@carbon/icons-react';

export function formatSize(bytes) {
  if (bytes == null) return '–';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toLocaleString('vi-VN', { maximumFractionDigits: gb >= 100 ? 0 : 1 })} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toLocaleString('vi-VN', { maximumFractionDigits: mb >= 10 ? 0 : 1 })} MB`;
}

/** How much of the server's disk the event uses, and what is left. */
export default function StorageCard({ storage }) {
  if (!storage) return null;
  const { disk_total: total, disk_used: used, disk_free: free } = storage;
  const event = storage.photos_bytes + storage.thumbs_bytes + storage.db_bytes;
  const pct = (n) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  const usedPct = Math.round((used / total) * 100);
  const tight = free / total < 0.1;

  return (
    <section className="fa-storage" aria-label="Dung lượng máy chủ">
      <div className="fa-storage__head">
        <span className="fa-storage__icon">
          <DataBase size={20} />
        </span>
        <div>
          <span className="fa-storage__label">Dung lượng máy chủ</span>
          <strong>
            Sự kiện dùng {formatSize(event)} · ổ đĩa đã dùng {usedPct}%
          </strong>
        </div>
        <span className={`fa-storage__free${tight ? ' is-tight' : ''}`}>
          Còn trống {formatSize(free)}
        </span>
      </div>

      {/* the event's share of the disk, inside everything else on it */}
      <div className="fa-storage__bar" role="img" aria-label={`Đã dùng ${usedPct}% ổ đĩa`}>
        <span className="is-photos" style={{ inlineSize: pct(storage.photos_bytes) }} />
        <span
          className="is-cache"
          style={{ inlineSize: pct(storage.thumbs_bytes + storage.db_bytes) }}
        />
        <span className="is-other" style={{ inlineSize: pct(Math.max(0, used - event)) }} />
      </div>

      <ul className="fa-storage__legend">
        <li>
          <i className="is-photos" /> Ảnh gốc {formatSize(storage.photos_bytes)} (
          {storage.photo_files.toLocaleString('vi-VN')} tệp)
        </li>
        <li>
          <i className="is-cache" /> Ảnh thu nhỏ + dữ liệu{' '}
          {formatSize(storage.thumbs_bytes + storage.db_bytes)}
        </li>
        <li>
          <i className="is-other" /> Khác trên ổ {formatSize(Math.max(0, used - event))}
        </li>
        <li>
          <i className="is-free" /> Tổng ổ đĩa {formatSize(total)}
        </li>
      </ul>
    </section>
  );
}
