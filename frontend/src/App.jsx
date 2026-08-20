import React, { useEffect, useRef, useState } from 'react';
import {
  Theme,
  Header,
  HeaderName,
  Grid,
  Column,
  FileUploaderDropContainer,
  Button,
  Slider,
  Tag,
  Tile,
  ClickableTile,
  InlineNotification,
  InlineLoading,
  Modal,
} from '@carbon/react';
import { Camera, Search, FaceSatisfied } from '@carbon/icons-react';

export default function App() {
  const [stats, setStats] = useState(null);
  const [queryFile, setQueryFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [threshold, setThreshold] = useState(0.35);
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState(null);
  const [error, setError] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => previewUrl && URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function setQuery(file) {
    setQueryFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setMatches(null);
    setError(null);
  }

  async function openCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
      });
      streamRef.current = stream;
      setCameraOpen(true);
      // video element mounts with the modal on next tick
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
    } catch (err) {
      setError(`Camera error: ${err.message}`);
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
        setQuery(new File([blob], 'selfie.jpg', { type: 'image/jpeg' }));
        closeCamera();
      },
      'image/jpeg',
      0.92
    );
  }

  async function search() {
    if (!queryFile) return;
    setSearching(true);
    setError(null);
    setMatches(null);
    const form = new FormData();
    form.append('file', queryFile);
    try {
      const res = await fetch(`/api/search?threshold=${threshold}`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.statusText);
      setMatches(data.matches);
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <Theme theme="g100">
      <Header aria-label="FaceScan">
        <HeaderName href="/" prefix="Face">
          Scan
        </HeaderName>
      </Header>
      <main className="facescan-main">
        <Grid>
          <Column lg={16} md={8} sm={4} className="facescan-hero">
            <h1>Find your race photos</h1>
            <p style={{ marginTop: '0.5rem', color: 'var(--cds-text-secondary)' }}>
              Upload a selfie or take a photo — we&apos;ll find every event picture you
              appear in.
              {stats && ` ${stats.photos} photos with ${stats.faces} faces indexed.`}
            </p>
          </Column>

          <Column lg={8} md={8} sm={4}>
            <FileUploaderDropContainer
              labelText="Drag and drop a selfie here or click to upload"
              accept={['image/jpeg', 'image/png', 'image/webp']}
              multiple={false}
              onAddFiles={(evt, { addedFiles }) => {
                if (addedFiles?.[0]) setQuery(addedFiles[0]);
              }}
            />
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'center',
                marginTop: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <Button kind="tertiary" renderIcon={Camera} onClick={openCamera}>
                Use camera
              </Button>
              {previewUrl && (
                <img className="facescan-preview" src={previewUrl} alt="Your selfie" />
              )}
            </div>
          </Column>

          <Column lg={8} md={8} sm={4}>
            <Slider
              labelText="Match strictness (higher = fewer, surer matches)"
              min={0.25}
              max={0.55}
              step={0.01}
              value={threshold}
              onChange={({ value }) => setThreshold(value)}
            />
            <div style={{ marginTop: '1.5rem' }}>
              {searching ? (
                <InlineLoading description="Searching all event photos…" />
              ) : (
                <Button renderIcon={Search} disabled={!queryFile} onClick={search}>
                  Find my photos
                </Button>
              )}
            </div>
          </Column>

          {error && (
            <Column lg={16} md={8} sm={4}>
              <InlineNotification
                kind="error"
                title="Search failed"
                subtitle={error}
                onCloseButtonClick={() => setError(null)}
              />
            </Column>
          )}

          {matches && matches.length === 0 && (
            <Column lg={16} md={8} sm={4}>
              <InlineNotification
                kind="info"
                title="No matches"
                subtitle="Try lowering the match strictness, or a clearer photo."
                hideCloseButton
              />
            </Column>
          )}

          {matches && matches.length > 0 && (
            <>
              <Column lg={16} md={8} sm={4}>
                <h4 style={{ margin: '1rem 0' }}>
                  <FaceSatisfied style={{ verticalAlign: '-0.2em' }} /> Found you in{' '}
                  {matches.length} photo{matches.length > 1 ? 's' : ''}
                </h4>
              </Column>
              {matches.map((m) => (
                <Column key={m.url} lg={4} md={4} sm={2} style={{ marginBottom: '1rem' }}>
                  <ClickableTile
                    className="facescan-card"
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      className="facescan-result-img"
                      src={m.thumb || m.url}
                      loading="lazy"
                      alt="Matched event photo"
                    />
                    <Tag className="facescan-score" type="green" size="sm">
                      {Math.round(m.score * 100)}%
                    </Tag>
                  </ClickableTile>
                </Column>
              ))}
            </>
          )}
        </Grid>
      </main>

      <Modal
        open={cameraOpen}
        modalHeading="Take a selfie"
        primaryButtonText="Take photo"
        secondaryButtonText="Cancel"
        onRequestSubmit={capture}
        onRequestClose={closeCamera}
      >
        {cameraOpen && (
          <Tile>
            <video className="facescan-video" ref={videoRef} autoPlay playsInline muted />
          </Tile>
        )}
      </Modal>
    </Theme>
  );
}
