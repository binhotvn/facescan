import React, { useState } from 'react';
import { Button, InlineNotification, Modal, TextInput } from '@carbon/react';
import { ArrowDown, ArrowUp, Checkmark, Close, Edit, FolderAdd, TrashCan } from '@carbon/icons-react';

import { adminFetch, signedOut } from '../adminApi';

/**
 * The albums guests browse by, as chips on the gallery ("Lễ khai mạc", "Gala
 * dinner"...): make them, name them, put them in order, take them away.
 */
export default function AdminAlbums({ token, albums, onChanged, onUnauthorized }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // {id, name}
  const [removing, setRemoving] = useState(null); // the album asked about

  async function call(method, url, body) {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(token, method, url, body);
      onChanged();
      return true;
    } catch (e) {
      if (signedOut(e)) onUnauthorized(e.message);
      else setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(e) {
    e.preventDefault();
    if (draft.trim() && (await call('POST', '/api/albums', { name: draft }))) setDraft('');
  }

  async function rename(e) {
    e.preventDefault();
    if (await call('PATCH', `/api/albums/${editing.id}`, { name: editing.name })) setEditing(null);
  }

  function move(index, by) {
    const ids = albums.map((a) => a.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    call('PUT', '/api/albums/order', { ids });
  }

  async function remove() {
    if (await call('DELETE', `/api/albums/${removing.id}`)) setRemoving(null);
  }

  return (
    <section className="fa-albums">
      <form className="fa-albums__new" onSubmit={create}>
        <TextInput
          id="album-name"
          labelText="Thư mục mới"
          placeholder="VD: Lễ khai mạc, Gala dinner"
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <Button type="submit" renderIcon={FolderAdd} disabled={busy || !draft.trim()}>
          Tạo thư mục
        </Button>
      </form>

      {error && (
        <InlineNotification
          kind="error"
          title={error}
          onCloseButtonClick={() => setError(null)}
          lowContrast
        />
      )}

      {albums.length === 0 ? (
        <p className="fa-albums__empty">
          Chưa có thư mục nào. Tạo thư mục để khách lọc ảnh theo từng phần của sự kiện.
        </p>
      ) : (
        <ol className="fa-albums__list">
          {albums.map((a, i) => (
            <li key={a.id}>
              <span className="fa-albums__order">
                <Button
                  kind="ghost"
                  size="sm"
                  hasIconOnly
                  renderIcon={ArrowUp}
                  iconDescription="Đưa lên trước"
                  tooltipPosition="right"
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                />
                <Button
                  kind="ghost"
                  size="sm"
                  hasIconOnly
                  renderIcon={ArrowDown}
                  iconDescription="Đưa xuống sau"
                  tooltipPosition="right"
                  disabled={busy || i === albums.length - 1}
                  onClick={() => move(i, 1)}
                />
              </span>

              {editing?.id === a.id ? (
                <form className="fa-albums__rename" onSubmit={rename}>
                  <TextInput
                    id={`album-${a.id}`}
                    labelText="Tên thư mục"
                    hideLabel
                    size="sm"
                    value={editing.name}
                    maxLength={60}
                    autoFocus
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                    disabled={busy}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    hasIconOnly
                    renderIcon={Checkmark}
                    iconDescription="Lưu"
                    disabled={busy || !editing.name.trim()}
                  />
                  <Button
                    kind="ghost"
                    size="sm"
                    hasIconOnly
                    renderIcon={Close}
                    iconDescription="Huỷ"
                    onClick={() => setEditing(null)}
                  />
                </form>
              ) : (
                <span className="fa-albums__name">
                  <strong>{a.name}</strong>
                  <span>{a.photos.toLocaleString('vi-VN')} ảnh</span>
                </span>
              )}

              {editing?.id !== a.id && (
                <span className="fa-albums__actions">
                  <Button
                    kind="ghost"
                    size="sm"
                    renderIcon={Edit}
                    disabled={busy}
                    onClick={() => setEditing({ id: a.id, name: a.name })}
                  >
                    Đổi tên
                  </Button>
                  <Button
                    kind="danger--ghost"
                    size="sm"
                    hasIconOnly
                    renderIcon={TrashCan}
                    iconDescription="Xoá thư mục"
                    tooltipPosition="left"
                    disabled={busy}
                    onClick={() => setRemoving(a)}
                  />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <p className="fa-albums__hint">
        Thư mục có ảnh hiện thành nút lọc trên trang thư viện, theo đúng thứ tự này. Chọn thư mục
        khi tải ảnh lên, hoặc chuyển ảnh vào thư mục ở tab Quản lý ảnh. Trong app Kapok Uploader,
        mỗi thư mục chọn được một thư mục ảnh riêng trên máy.
      </p>

      <Modal
        open={removing !== null}
        danger
        modalHeading={`Xoá thư mục “${removing?.name ?? ''}”?`}
        primaryButtonText={busy ? 'Đang xoá…' : 'Xoá thư mục'}
        primaryButtonDisabled={busy}
        secondaryButtonText="Huỷ"
        onRequestClose={() => !busy && setRemoving(null)}
        onRequestSubmit={remove}
        size="xs"
      >
        <p>
          {removing?.photos
            ? `${removing.photos.toLocaleString('vi-VN')} ảnh trong thư mục không bị xoá: chúng vẫn nằm trong Tất cả ảnh.`
            : 'Thư mục đang trống.'}
        </p>
      </Modal>
    </section>
  );
}
