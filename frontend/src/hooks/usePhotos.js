import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SIZE = 120;
const POLL_MS = 30000;

/** How many photos the server holds in the view being shown. */
function countIn(stats, album) {
  if (album == null) return stats.photos;
  return stats.albums?.find((a) => a.id === album)?.photos ?? 0;
}

/**
 * Gallery paging (the whole event, or one album when `album` is an id), plus a
 * live count of photos that landed after the last load.
 */
export default function usePhotos(album = null) {
  const [photos, setPhotos] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(0); // new photos not shown yet
  const loadedTotal = useRef(0);
  const shownAlbum = useRef(album); // what the poll and late pages compare against
  shownAlbum.current = album;

  const fetchPage = useCallback(
    async (offset) => {
      const only = album == null ? '' : `&album=${album}`;
      const res = await fetch(`/api/photos?limit=${PAGE_SIZE}&offset=${offset}${only}`);
      if (!res.ok) throw new Error('Không tải được thư viện ảnh.');
      return res.json();
    },
    [album],
  );

  const show = useCallback((data) => {
    setPhotos(data.photos);
    setTotal(data.total);
    loadedTotal.current = data.total;
    setPending(0);
  }, []);

  const reload = useCallback(async () => show(await fetchPage(0)), [fetchPage, show]);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  // first load, and again whenever another album is picked
  useEffect(() => {
    let stale = false; // a quicker click on another album wins
    setLoading(true);
    fetchPage(0)
      .then((data) => !stale && show(data))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [fetchPage, show]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(photos.length);
      if (shownAlbum.current !== album) return; // the reader moved on meanwhile
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
  }, [album, fetchPage, loadingMore, photos.length]);

  // Photographers keep uploading during the event: count new arrivals, but let
  // the reader decide when to pull them in rather than reflowing under them.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const s = await fetch('/api/stats').then((r) => r.json());
        setStats(s);
        setPending(Math.max(0, countIn(s, shownAlbum.current) - loadedTotal.current));
      } catch {
        /* offline for a beat , try again next tick */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const hasMore = photos.length < total;
  return { photos, total, stats, loading, loadingMore, error, setError, pending, hasMore, loadMore, reload };
}
