import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SIZE = 120;
const POLL_MS = 30000;

/** Gallery paging plus a live count of photos that landed after the last load. */
export default function usePhotos() {
  const [photos, setPhotos] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(0); // new photos not shown yet
  const loadedTotal = useRef(0);

  const fetchPage = useCallback(async (offset) => {
    const res = await fetch(`/api/photos?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) throw new Error('Không tải được thư viện ảnh.');
    return res.json();
  }, []);

  const reload = useCallback(async () => {
    const data = await fetchPage(0);
    setPhotos(data.photos);
    setTotal(data.total);
    loadedTotal.current = data.total;
    setPending(0);
  }, [fetchPage]);

  useEffect(() => {
    Promise.all([
      fetch('/api/stats').then((r) => r.json()).then(setStats),
      reload(),
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(photos.length);
      // offset paging shifts when photos are added mid-scroll; drop any repeats
      setPhotos((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...data.photos.filter((p) => !seen.has(p.id))];
      });
      setTotal(data.total);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, photos.length]);

  // Photographers keep uploading during the event: count new arrivals, but let
  // the reader decide when to pull them in rather than reflowing under them.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const s = await fetch('/api/stats').then((r) => r.json());
        setStats(s);
        setPending(Math.max(0, s.photos - loadedTotal.current));
      } catch {
        /* offline for a beat — try again next tick */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const hasMore = photos.length < total;
  return { photos, total, stats, loading, loadingMore, error, setError, pending, hasMore, loadMore, reload };
}
