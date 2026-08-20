import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Button } from '@carbon/react';
import { Renew } from '@carbon/icons-react';

/** Photo-booth style capture: mirrored preview, face guide, countdown, review. */
export default function CameraModal({ open, onClose, onUse }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [facing, setFacing] = useState('user');
  const [countdown, setCountdown] = useState(null);
  const [shot, setShot] = useState(null); // {file, url}
  const [error, setError] = useState(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open || shot) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (e) {
        setError(`Không mở được máy ảnh: ${e.message}`);
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [open, facing, shot, stop]);

  useEffect(() => {
    if (countdown === null) return undefined;
    if (countdown === 0) {
      grab();
      return undefined;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  function grab() {
    setCountdown(null);
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    // un-mirror: the preview is flipped for the user, the file should not be
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        const file = new File([blob], 'selfie.jpg', { type: 'image/jpeg' });
        stop();
        setShot({ file, url: URL.createObjectURL(file) });
      },
      'image/jpeg',
      0.92
    );
  }

  function reset() {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setCountdown(null);
  }

  function close() {
    stop();
    reset();
    setError(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      passiveModal
      size="lg"
      modalHeading={shot ? 'Ảnh của bạn' : 'Chụp ảnh chân dung'}
      onRequestClose={close}
      className="fa-camera-modal"
    >
      {error && <p className="fa-camera__error">{error}</p>}

      <div className="fa-camera">
        {shot ? (
          <img className="fa-camera__shot" src={shot.url} alt="Ảnh vừa chụp" />
        ) : (
          <>
            <video
              ref={videoRef}
              className={`fa-camera__video${facing === 'user' ? ' is-mirrored' : ''}`}
              autoPlay
              playsInline
              muted
            />
            <svg className="fa-camera__guide" viewBox="0 0 100 100" preserveAspectRatio="none">
              <ellipse cx="50" cy="46" rx="26" ry="34" />
            </svg>
            {countdown > 0 && <div className="fa-camera__count">{countdown}</div>}
            <p className="fa-camera__hint">Đưa mặt vào khung</p>
          </>
        )}
      </div>

      <div className="fa-camera__actions">
        {shot ? (
          <>
            <Button kind="tertiary" onClick={reset}>
              Chụp lại
            </Button>
            <Button
              onClick={() => {
                const { file } = shot;
                reset();
                onUse(file);
              }}
            >
              Tìm ảnh của tôi
            </Button>
          </>
        ) : (
          <>
            <Button
              kind="ghost"
              hasIconOnly
              renderIcon={Renew}
              iconDescription="Đổi camera trước/sau"
              onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
            />
            <button
              type="button"
              className="fa-shutter"
              aria-label="Chụp ảnh"
              disabled={countdown !== null}
              onClick={() => setCountdown(3)}
            />
            <span className="fa-camera__spacer" />
          </>
        )}
      </div>
    </Modal>
  );
}
